import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readMcpConfiguration, verifyProviderConfinement } from '../../src/delivery/activation.js';
import type { CommandInput, CommandResult } from '../../src/delivery/commands.js';
import { PROVIDER_CONFINEMENT_PROGRAM } from '../../src/delivery/provider-confinement-program.js';
import {
  codexSandboxProbeArgs,
  supervisedCodexPolicy,
} from '../../src/providers/supervised-policy.js';
import {
  ExecutionControlError,
  type ExecutionControl,
} from '../../src/runtime/execution-control.js';
import { deliveryMandate } from '../helpers/delivery.js';

const mocks = vi.hoisted(() => ({
  command: vi.fn<(input: CommandInput) => Promise<CommandResult>>(),
  configuration: vi.fn(),
}));
vi.mock('../../src/delivery/commands.js', () => ({ runDeliveryCommand: mocks.command }));
vi.mock('../../src/delivery/config-attestation.js', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import('../../src/delivery/config-attestation.js')>()),
    readCodexConfigurationDigest: mocks.configuration,
  };
});

const platform = process.platform;
const directories: string[] = [];
const admitted = {
  allowed: true,
  denied_read: true,
  denied_write: true,
  denied_network: true,
};
const success = {
  exitCode: 0,
  stdout: '',
  stderr: '',
};

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  mocks.configuration.mockResolvedValue('fixture-configuration');
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporary(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'provider-confinement-test-'));
  directories.push(directory);
  return directory;
}

function command(input: CommandInput): CommandResult {
  if (input.command === '/usr/bin/cc') {
    const source = input.args[5];
    const output = input.args[7];
    expect(source).toBeDefined();
    expect(output).toBeDefined();
    expect(readFileSync(source ?? '', 'utf8')).toBe(PROVIDER_CONFINEMENT_PROGRAM);
    writeFileSync(output ?? '', 'fixture executable', { mode: 0o700 });
    return success;
  }
  if (input.args[0] === 'sandbox') {
    return { ...success, stdout: JSON.stringify(admitted) };
  }
  if (input.args.includes('mcp')) {
    const isDisabled = input.args.some((arg) => arg.startsWith('mcp_servers='));
    return { ...success, stdout: JSON.stringify([{ name: 'fixture', enabled: !isDisabled }]) };
  }
  throw new Error('Unexpected confinement command');
}

async function fixture() {
  const root = temporary();
  const runtimeRoot = path.join(root, 'frozen', 'runtime');
  mkdirSync(runtimeRoot, { recursive: true });
  mocks.command.mockImplementation((input) => {
    return Promise.resolve(command(input));
  });
  const configuration = await readMcpConfiguration(root, {});
  mocks.command.mockClear();
  mocks.configuration.mockClear();
  return {
    ...deliveryMandate(root),
    runtimeRoot,
    mcpServerNames: configuration.names,
    mcpConfigurationDigest: configuration.configurationDigest,
  };
}

describe('native provider confinement admission', () => {
  it('compiles frozen source, applies the exact worker policy, and checks MCP disablement', async () => {
    const mandate = await fixture();
    let expectedPolicy: ReturnType<typeof supervisedCodexPolicy> | undefined;
    mocks.command.mockImplementation((input) => {
      if (input.args[0] === 'sandbox') {
        expectedPolicy = supervisedCodexPolicy(
          input.cwd,
          [mandate.runtimeRoot, path.dirname(mandate.runtimeRoot)],
          mandate.mcpServerNames,
        );
      }
      return Promise.resolve(command(input));
    });
    expect(await verifyProviderConfinement(mandate, {})).toBe(true);
    const calls = mocks.command.mock.calls.map(([input]) => input);
    expect(calls.map((input) => input.command)).toEqual(['codex', '/usr/bin/cc', 'codex', 'codex']);
    const probe = calls[2];
    expect(probe).toBeDefined();
    if (probe === undefined || expectedPolicy === undefined) {
      throw new Error('Missing sandbox probe');
    }
    const actualCandidate = probe.cwd;
    const expectedConfig = expectedPolicy.codexConfig;
    const probeCommand = probe.args.slice(probe.args.indexOf('--') + 1);
    expect(probe.args).toEqual(codexSandboxProbeArgs(expectedPolicy, probeCommand));
    expect(probe.args).toContain('--include-managed-config');
    expect(probeCommand).toHaveLength(4);
    expect(path.dirname(probeCommand[0] ?? '')).toBe(actualCandidate);
    expect(path.dirname(path.dirname(probeCommand[2] ?? ''))).toBe(path.dirname(actualCandidate));
    expect(expectedConfig.join(' ')).not.toContain('/controls');
    expect(calls[3]?.args).toEqual([
      ...expectedConfig.flatMap((entry) => ['-c', entry]),
      'mcp',
      'list',
      '--json',
    ]);
    expect(existsSync(path.dirname(actualCandidate))).toBe(false);
    expect(mocks.configuration).toHaveBeenCalledOnce();
  });

  it.each([undefined, 5000])(
    'preserves inherited ownership and cancellation with an attempt cap of %s',
    async (attemptTimeoutMs) => {
      const mandate = await fixture();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const execution: ExecutionControl = {
        signal: new AbortController().signal,
        processGroup: 'shared',
        deadlineEpochMs: now + 10_000,
        terminateGraceMs: 50,
        beforeSpawn: vi.fn(),
        onSpawn: vi.fn(),
        codexDeniedMcpServers: ['fixture'],
        ...(attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs }),
        env: { HOME: os.homedir(), GH_TOKEN: 'private-token', NODE_OPTIONS: 'untrusted' },
      };
      expect(await verifyProviderConfinement(mandate, execution)).toBe(true);
      const calls = mocks.command.mock.calls.slice(1).map(([input]) => input);
      for (const input of calls) {
        expect(input.execution).toMatchObject({
          ...execution,
          deadlineEpochMs: now + Math.min(10_000, attemptTimeoutMs ?? 15_000),
          attemptTimeoutMs: attemptTimeoutMs ?? 15_000,
          env: { HOME: os.homedir() },
        });
        expect(input.execution.signal).toBe(execution.signal);
        expect(input.execution.beforeSpawn).toBe(execution.beforeSpawn);
        expect(input.execution.onSpawn).toBe(execution.onSpawn);
        expect(input.execution.env?.GH_TOKEN).toBeUndefined();
        expect(input.execution.env?.NODE_OPTIONS).toBeUndefined();
      }
      expect(calls[1]?.execution).toBe(calls[0]?.execution);
      expect(calls[2]?.execution).toBe(calls[0]?.execution);
    },
  );

  it.each([0, 1, 127])(
    'reports a sanitized compiler blocker for unusable compiler output (%i)',
    async (exitCode) => {
      const mandate = await fixture();
      mocks.command.mockImplementation((input) => {
        return Promise.resolve(
          input.command === '/usr/bin/cc'
            ? { exitCode, stdout: '', stderr: 'private compiler diagnostic' }
            : command(input),
        );
      });
      await expect(verifyProviderConfinement(mandate, {})).rejects.toThrow(
        'native-confinement-compiler-unavailable',
      );
      expect(mocks.command).toHaveBeenCalledTimes(2);
      expect(existsSync(mocks.command.mock.calls[1]?.[0].cwd ?? '')).toBe(false);
    },
  );

  it.each(['aborted', 'deadline'] as const)(
    'propagates %s during compilation and cleans scratch',
    async (reason) => {
      const mandate = await fixture();
      const error = new ExecutionControlError(reason);
      mocks.command.mockImplementation((input) => {
        return input.command === '/usr/bin/cc'
          ? Promise.reject(error)
          : Promise.resolve(command(input));
      });
      await expect(verifyProviderConfinement(mandate, {})).rejects.toBe(error);
      expect(mocks.command).toHaveBeenCalledTimes(2);
      expect(existsSync(mocks.command.mock.calls[1]?.[0].cwd ?? '')).toBe(false);
    },
  );

  it.each([
    { label: 'nonzero exit', exitCode: 1, stdout: JSON.stringify(admitted) },
    { label: 'missing fields', exitCode: 0, stdout: '{}' },
    {
      label: 'string truth',
      exitCode: 0,
      stdout: JSON.stringify({ ...admitted, allowed: 'true' }),
    },
    ...Object.keys(admitted).map((key) => ({
      label: key,
      exitCode: 0,
      stdout: JSON.stringify({ ...admitted, [key]: false }),
    })),
  ])('rejects $label before the final MCP check', async ({ exitCode, stdout }) => {
    const mandate = await fixture();
    mocks.command.mockImplementation((input) => {
      return Promise.resolve(
        input.args[0] === 'sandbox' ? { exitCode, stdout, stderr: '' } : command(input),
      );
    });
    expect(await verifyProviderConfinement(mandate, {})).toBe(false);
    expect(mocks.command).toHaveBeenCalledTimes(3);
  });

  it.each(['', 'not-json', 'null'])('rejects malformed evidence %j', async (stdout) => {
    const mandate = await fixture();
    mocks.command.mockImplementation((input) => {
      return Promise.resolve(input.args[0] === 'sandbox' ? { ...success, stdout } : command(input));
    });
    await expect(verifyProviderConfinement(mandate, {})).rejects.toThrow();
    expect(mocks.command).toHaveBeenCalledTimes(3);
  });

  it('rejects active MCP tools after successful native assertions', async () => {
    const mandate = await fixture();
    mocks.command.mockImplementation((input) => {
      return Promise.resolve(
        input.args.some((arg) => arg.startsWith('mcp_servers=')) && input.args.includes('mcp')
          ? { ...success, stdout: '[{"name":"fixture","enabled":true}]' }
          : command(input),
      );
    });
    expect(await verifyProviderConfinement(mandate, {})).toBe(false);
    expect(mocks.command).toHaveBeenCalledTimes(4);
  });

  it('rejects changed effective configuration before compiling', async () => {
    const mandate = await fixture();
    mocks.configuration.mockResolvedValue('changed-configuration');
    await expect(verifyProviderConfinement(mandate, {})).rejects.toThrow(
      'managed-tool-configuration-changed',
    );
    expect(mocks.command).toHaveBeenCalledTimes(1);
  });

  it.runIf(platform === 'darwin')(
    'compiles the actual program and rejects accessible or absent canaries without network access',
    () => {
      const root = temporary();
      const source = path.join(root, 'probe.c');
      const binary = path.join(root, 'probe');
      writeFileSync(
        source,
        '#include <sys/socket.h>\n#include <unistd.h>\n#define connect(...) (_exit(125), -1)\n' +
          PROVIDER_CONFINEMENT_PROGRAM,
      );
      const compiled = spawnSync(
        '/usr/bin/cc',
        ['-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', binary],
        {
          encoding: 'utf8',
          timeout: 15_000,
          killSignal: 'SIGKILL',
        },
      );
      expect(compiled.status, compiled.stderr).toBe(0);
      const allowed = path.join(root, 'allowed');
      const forbidden = path.join(root, 'forbidden');
      writeFileSync(allowed, 'owned evidence');
      writeFileSync(forbidden, 'accessible fixture');
      for (const target of [forbidden, path.join(root, 'missing')]) {
        const result = spawnSync(binary, [allowed, target, path.join(root, 'write-probe')], {
          encoding: 'utf8',
          timeout: 5000,
          killSignal: 'SIGKILL',
        });
        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          allowed: true,
          denied_read: false,
          denied_write: false,
          denied_network: false,
        });
      }
    },
  );
});
