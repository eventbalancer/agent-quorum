import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRuntime } from '../../src/providers/runtime.js';
import type { ProviderTaskRequest } from '../../src/providers/provider.js';
import type { CommandInput } from '../../src/delivery/commands.js';
import { runDeliveryCommand } from '../../src/delivery/commands.js';
import { parseCodexProxyArgs } from '../../src/delivery/codex-shim.js';
import { createLiveProviderBroker } from '../../src/delivery/live-provider.js';
import { executeConfinedSmokeScenario } from '../../src/delivery/live-executor.js';
import {
  PROVIDER_FRAME_PREFIX,
  PROVIDER_MESSAGE_BYTES,
  providerChannel,
} from '../../src/delivery/provider-channel.js';
import { executeSmokeScenario } from '../../scripts/benchmark-planning/smoke-run.js';
import { loadPlanningSmoke } from '../../scripts/benchmark-planning/smoke.js';
import { deliveryMandate } from '../helpers/delivery.js';

const directories: string[] = [];
const providerConfigText = readFileSync(
  'benchmarks/planning/provider-config.balanced.json',
  'utf8',
);
const sentinel = loadPlanningSmoke('benchmarks/planning/smoke-manifest.json').manifest.sentinels[0];
if (sentinel === undefined) {
  throw new Error('missing fixture sentinel');
}
const schema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};
const request = { model: 'gpt-5.6-luna', reasoning: 'low', prompt: 'fixture prompt', schema };
function temporary(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'delivery-live-'));
  directories.push(root);
  return root;
}
afterEach(() => {
  directories.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe('confined live provider boundary', () => {
  it('accepts only data for the exact sentinel model/quality and uses fresh supervised providerRun', async () => {
    const root = temporary();
    const mandate = deliveryMandate(root);
    const beforeSpawn = vi.fn();
    const invoke = vi.fn((runtime: ProviderRuntime, call: ProviderTaskRequest) => {
      expect(runtime.retry.retryCount).toBe(0);
      expect(call.cwd).toBe(root);
      expect(call.task).toBe('delivery-live-smoke');
      expect(call.isolatedUserConfig).toBe(true);
      expect(call.codexPermissionProfile).toBe('agent-quorum-delivery');
      expect(call.execution?.beforeSpawn).toBe(beforeSpawn);
      expect(call.execution?.attemptTimeoutMs).toBe(mandate.profile.bounds.providerTimeoutMs);
      writeFileSync(call.outFile, JSON.stringify({ ok: true }));
      expect(call.validateOutput?.(call.outFile)).toBe(true);
      writeFileSync(call.outFile, JSON.stringify({ forbidden: true }));
      expect(call.validateOutput?.(call.outFile)).toBe(false);
      writeFileSync(call.outFile, JSON.stringify({ ok: true }));
      return Promise.resolve(0);
    });
    const broker = createLiveProviderBroker(
      mandate,
      { beforeSpawn },
      providerConfigText,
      root,
      'quick',
      invoke,
    );
    expect(await broker(request, new AbortController().signal)).toEqual({
      status: 0,
      output: '{"ok":true}',
    });
    await expect(
      broker({ ...request, cwd: '/host' }, new AbortController().signal),
    ).rejects.toThrow('invalid-confined-provider-request');
    await expect(
      broker({ ...request, reasoning: 'high' }, new AbortController().signal),
    ).rejects.toThrow('profile-mismatch');
    await expect(
      broker({ ...request, model: 'outside-profile' }, new AbortController().signal),
    ).rejects.toThrow('profile-mismatch');
    await expect(
      broker(
        { ...request, prompt: 'x'.repeat(PROVIDER_MESSAGE_BYTES) },
        new AbortController().signal,
      ),
    ).rejects.toThrow('invalid-confined-provider-request');
    expect(invoke).toHaveBeenCalledTimes(1);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(broker(request, cancelled.signal)).rejects.toThrow('aborted');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('refuses provider profiles that include an unsupported runner', () => {
    const root = temporary();
    expect(() => createLiveProviderBroker(deliveryMandate(root), {}, '{}', root, 'quick')).toThrow(
      'provider-unsupported',
    );
  });

  it('rejects CLI configuration/authority flags and retains only schema/prompt/output data', () => {
    const root = temporary();
    const schemaFile = path.join(root, 'schema.json');
    writeFileSync(schemaFile, JSON.stringify(schema));
    const outputFile = path.join(root, 'output.json');
    const args = [
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      '-m',
      request.model,
      '-c',
      'model_reasoning_effort="low"',
      '--output-schema',
      schemaFile,
      '-o',
      outputFile,
      '--',
      request.prompt,
    ];
    expect(parseCodexProxyArgs(args)).toEqual({ call: request, outputFile });
    expect(() =>
      parseCodexProxyArgs(args.map((arg) => (arg === 'read-only' ? 'danger-full-access' : arg))),
    ).toThrow('unsupported');
    expect(() =>
      parseCodexProxyArgs(
        args.map((arg) => (arg.startsWith('model_reasoning') ? 'approval_policy="never"' : arg)),
      ),
    ).toThrow('configuration');
    expect(() => parseCodexProxyArgs(['exec', 'resume', ...args.slice(1)])).toThrow('unsupported');
  });

  it('multiplexes bounded provider messages and cancels pending work on disconnect', async () => {
    const send = vi.fn();
    let received: AbortSignal | undefined;
    const handler = vi.fn((_value: unknown, signal: AbortSignal) => {
      received = signal;
      return new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve({ status: 1, output: '' });
          },
          { once: true },
        );
      });
    });
    const channel = providerChannel(handler, send);
    const id = randomUUID();
    expect(channel.consume('ordinary log')).toBe(false);
    expect(channel.consume(`${PROVIDER_FRAME_PREFIX}${JSON.stringify({ id, request })}`)).toBe(
      true,
    );
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    channel.consume(`${PROVIDER_FRAME_PREFIX}${JSON.stringify({ id, cancel: true })}`);
    expect(received?.aborted).toBe(true);
    await channel.close();
    expect(send).not.toHaveBeenCalled();
    const oversized = providerChannel(
      () => Promise.resolve({ status: 0, output: 'x'.repeat(PROVIDER_MESSAGE_BYTES) }),
      send,
    );
    oversized.consume(`${PROVIDER_FRAME_PREFIX}${JSON.stringify({ id: randomUUID(), request })}`);
    await expect.poll(() => send.mock.calls.length).toBe(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ response: { status: 1, output: '' } });
    await oversized.close();
  });

  it('handles a real local multiplex transport without disclosing provider frames as logs', async () => {
    const id = randomUUID();
    const script = `process.stdout.write('ordinary log\\n' + ${JSON.stringify(PROVIDER_FRAME_PREFIX + JSON.stringify({ id, request }) + '\n')}); require('node:readline').createInterface({input:process.stdin}).on('line', line => { const v=JSON.parse(line); if(v.type==='provider-response'){process.stdout.write(v.response.output);process.exit(0)}})`;
    const handler = vi.fn(() => Promise.resolve({ status: 0, output: 'bounded result' }));
    const result = await runDeliveryCommand({
      command: process.execPath,
      args: ['-e', script],
      cwd: temporary(),
      execution: { deadlineEpochMs: Date.now() + 5000 },
      keepAlive: true,
      providerRequests: handler,
    });
    expect(handler).toHaveBeenCalledWith(request, expect.any(AbortSignal));
    expect(result).toEqual({ exitCode: 0, stdout: 'ordinary log\nbounded result', stderr: '' });
  });

  it('mounts same-path artifacts, protects input snapshots and never forwards guardian credentials', async () => {
    const root = temporary();
    const candidate = path.join(root, 'candidate');
    const workDir = path.join(root, 'attempt/run');
    mkdirSync(candidate);
    writeFileSync(path.join(candidate, 'input.md'), 'fixture input');
    mkdirSync(path.dirname(workDir));
    const mandate = {
      ...deliveryMandate(root),
      profile: {
        ...deliveryMandate(root).profile,
        executor: { kind: 'docker' as const, image: `fixture@sha256:${'a'.repeat(64)}` },
      },
    };
    const onSpawn = vi.fn();
    const controlSpawn = vi.fn();
    const run = vi.fn(async (input: CommandInput) => {
      expect(input.command).toBe('docker');
      expect(input.args).toContain(`type=bind,source=${candidate},target=${candidate},readonly`);
      expect(input.args).toContain(
        `type=bind,source=${path.dirname(workDir)}/input.md,target=${path.dirname(workDir)}/input.md,readonly`,
      );
      expect(input.args.join(' ')).not.toContain('owner-secret');
      expect(input.args.join(' ')).not.toContain('EXECUTION_CONTROL');
      expect(input.execution.env?.GH_TOKEN).toBeUndefined();
      expect(input.keepAlive).toBe(true);
      expect(input.providerRequests).toBeTypeOf('function');
      await input.execution.onSpawn?.({
        command: 'docker',
        cwd: root,
        pid: 123,
        pgid: '123',
        procStartToken: 'fixture',
      });
      return { exitCode: 0, stdout: 'fixture', stderr: '' };
    });
    const outputFile = path.join(root, 'process.log');
    expect(
      await executeConfinedSmokeScenario(
        mandate,
        { onSpawn: controlSpawn },
        providerConfigText,
        {
          repositoryRoot: candidate,
          workspaceRevision: 'a'.repeat(40),
          attemptIdentity: 'b'.repeat(64),
          sentinel,
          inputFile: path.join(candidate, 'input.md'),
          workDir,
          environment: {
            AGENT_QUORUM_EXECUTION_CONTROL_FILE: '/owner-secret',
            GH_TOKEN: 'owner-secret',
          },
          timeoutMs: 1000,
          onSpawn,
          outputFile,
        },
        run,
      ),
    ).toBe(0);
    expect(onSpawn).toHaveBeenCalledWith(123);
    expect(controlSpawn).toHaveBeenCalledTimes(1);
    expect(readFileSync(outputFile, 'utf8')).toBe('fixture');
    await expect(
      executeSmokeScenario({
        repositoryRoot: candidate,
        workspaceRevision: 'a'.repeat(40),
        attemptIdentity: 'b'.repeat(64),
        sentinel,
        inputFile: '/input',
        workDir,
        environment: { AGENT_QUORUM_EXECUTION_CONTROL_FILE: '/owner-secret' },
        timeoutMs: 1000,
        onSpawn,
      }),
    ).rejects.toThrow('requires a confined provider broker');
    expect(onSpawn).toHaveBeenCalledTimes(1);
  });
});

describe('container activation evidence', () => {
  it('checks the exact installed digest and offline Linux dependency capability in the frozen wrapper', async () => {
    const { probeDockerExecutor } = await import('../../src/delivery/executor-probe.js');
    const root = temporary();
    const original = deliveryMandate(root);
    const image = `fixture@sha256:${'b'.repeat(64)}`;
    const mandate = {
      ...original,
      profile: { ...original.profile, executor: { kind: 'docker' as const, image } },
    };
    writeFileSync(path.join(root, 'package.json'), '{"packageManager":"pnpm@11.5.3"}');
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'fixture lockfile');
    const calls: CommandInput[] = [];
    const run = vi.fn((input: CommandInput) => {
      calls.push(input);
      if (input.args.includes('inspect')) {
        return Promise.resolve({ exitCode: 0, stdout: JSON.stringify([image]), stderr: '' });
      }
      expect(
        readFileSync(
          path.join(input.args[input.args.indexOf('--workdir') + 1] ?? '', 'pnpm-lock.yaml'),
          'utf8',
        ),
      ).toBe('fixture lockfile');
      expect(input.args).toContain('/aq-harness/src/delivery/container-watchdog.py');
      expect(input.args.join(' ')).toContain(
        "['install','--frozen-lockfile','--offline','--ignore-scripts']",
      );
      expect(input.args.join(' ')).toContain('/proc/1/fd/0');
      expect(input.keepAlive).toBe(true);
      return Promise.resolve({ exitCode: 0, stdout: '{"passed":true}', stderr: '' });
    });
    expect(await probeDockerExecutor(mandate, {}, run)).toBe(true);
    expect(calls).toHaveLength(2);
    const missing = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify(['other@sha256:' + 'c'.repeat(64)]),
        stderr: '',
      }),
    );
    expect(await probeDockerExecutor(mandate, {}, missing)).toBe(false);
    expect(missing).toHaveBeenCalledTimes(1);
  });
});
