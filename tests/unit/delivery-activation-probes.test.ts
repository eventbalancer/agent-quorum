import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionControlError } from '../../src/runtime/execution-control.js';
import type { CommandInput } from '../../src/delivery/commands.js';
import { digest } from '../../src/delivery/contract.js';
import {
  frozenRuntimeEntries,
  runActivationProbes,
  smokeProbeProfiles,
} from '../../src/delivery/activation.js';
import { deliveryFixture } from '../helpers/delivery.js';

const mocks = vi.hoisted(() => ({
  provider: vi.fn(),
  command: vi.fn(),
  executor: vi.fn(),
  work: vi.fn(),
  review: vi.fn(),
}));
vi.mock('../../src/providers/provider.js', () => ({ providerRun: mocks.provider }));
vi.mock('../../src/delivery/commands.js', () => ({ runDeliveryCommand: mocks.command }));
vi.mock('../../src/delivery/executor-probe.js', () => ({ probeDockerExecutor: mocks.executor }));
vi.mock('../../src/delivery/worker.js', () => ({
  CodexDeliveryWorker: class {
    work = mocks.work;
    review = mocks.review;
  },
}));
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.clearAllMocks();
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => {
      cleanup();
    });
});

function fixture() {
  const result = deliveryFixture();
  cleanups.push(() => {
    result.ledger.close();
    rmSync(result.root, { recursive: true, force: true });
  });
  const roles = Object.fromEntries(
    ['creator', 'critic', 'fixer', 'reviewer', 'translator', 'judge'].map((role) => [
      role,
      { runner: 'codex', model: `fixture-${role}` },
    ]),
  );
  const benchmark = path.join(result.root, 'benchmarks/planning');
  mkdirSync(benchmark, { recursive: true });
  writeFileSync(path.join(benchmark, 'config.json'), JSON.stringify({ roles }));
  writeFileSync(
    path.join(benchmark, 'smoke-manifest.json'),
    JSON.stringify({
      providerConfig: 'config.json',
      sentinels: [{ quality: 'quick' }, { quality: 'balanced' }],
    }),
  );
  const planningFile = path.join(result.root, '.delivery-planning.json');
  writeFileSync(planningFile, JSON.stringify({ roles }));
  const profile = {
    ...result.mandate.profile,
    planning: { ...result.mandate.profile.planning, configFile: planningFile },
    executor: { kind: 'docker', image: `fixture@sha256:${'a'.repeat(64)}` },
  } as const;
  const mandate = {
    ...result.mandate,
    profile,
    profileDigest: digest(profile),
    controllerDigest: digest(frozenRuntimeEntries(result.root)),
  };
  result.ledger.changeMode('prepared', 'fixture');
  result.ledger.prepare(mandate);
  mocks.executor.mockResolvedValue(true);
  mocks.provider.mockImplementation((_runtime: unknown, request: { outFile: string }) => {
    writeFileSync(request.outFile, '{"ok":true}');
    return Promise.resolve(0);
  });
  mocks.work.mockResolvedValue({
    invocationId: 'worker-distinct',
    result: { action: 'ready', edits: [] },
  });
  mocks.review.mockResolvedValue({ invocationId: 'reviewer-distinct', result: { approved: true } });
  mocks.command.mockImplementation(async (input: CommandInput) => {
    if (input.command === process.execPath) {
      await input.execution.onSpawn?.({
        pid: 99999999,
        pgid: '99999999',
        procStartToken: 'fixture',
        command: input.command,
        cwd: input.cwd,
      });
      throw new ExecutionControlError('deadline');
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return { ...result, mandate };
}

describe('bounded activation capability probes', () => {
  it('probes every frozen design and smoke configuration and an independent reviewer before admission', async () => {
    const { ledger, mandate } = fixture();
    const configurations = smokeProbeProfiles(mandate.runtimeRoot);
    await runActivationProbes(ledger, digest(mandate), {}, () => Promise.resolve(true));
    expect(mocks.provider.mock.calls.length).toBeGreaterThanOrEqual(configurations.length);
    const observed = mocks.provider.mock.calls.map((call) => {
      const request = call[1] as { model: string; reasoning: string };
      return `${request.model}:${request.reasoning}`;
    });
    expect(new Set(observed).size).toBe(observed.length);
    for (const profile of configurations) {
      expect(observed).toContain(`${profile.model}:${profile.reasoning}`);
    }
    expect(mocks.work).toHaveBeenCalledOnce();
    expect(mocks.review).toHaveBeenCalledOnce();
    expect(ledger.get('activation-probes')).toMatchObject({
      passed: true,
      workerInvocation: 'worker-distinct',
      reviewerInvocation: 'reviewer-distinct',
    });
    expect(ledger.mode()).toBe('prepared');
  });

  it('stops before provider invocations when effective executor confinement fails', async () => {
    const { ledger, mandate } = fixture();
    mocks.executor.mockResolvedValue(false);
    await expect(
      runActivationProbes(ledger, digest(mandate), {}, () => Promise.resolve(true)),
    ).rejects.toThrow('candidate-executor-confinement-probe-failed');
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(ledger.get('activation-probes')).toMatchObject({ passed: false });
  });

  it('stops before authentication, providers, and workers when provider confinement fails', async () => {
    const { ledger, mandate } = fixture();
    const confinement = vi.fn().mockResolvedValue(false);
    await expect(runActivationProbes(ledger, digest(mandate), {}, confinement)).rejects.toThrow(
      'effective-confinement-probe-failed',
    );
    expect(mocks.executor).toHaveBeenCalledOnce();
    expect(confinement).toHaveBeenCalledWith(mandate, {});
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.work).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(ledger.get('activation-probes')).toMatchObject({ passed: false });
  });

  it('rejects schema-support failure and a non-independent reviewer', async () => {
    const { ledger, mandate } = fixture();
    mocks.provider.mockResolvedValueOnce(1);
    await expect(
      runActivationProbes(ledger, digest(mandate), {}, () => Promise.resolve(true)),
    ).rejects.toThrow('planning-role-schema-probe-failed');
    mocks.review.mockResolvedValue({ invocationId: 'worker-distinct', result: { approved: true } });
    await expect(
      runActivationProbes(ledger, digest(mandate), {}, () => Promise.resolve(true)),
    ).rejects.toThrow('independent-review-probe-failed');
    expect(ledger.get('activation-probes')).toMatchObject({ passed: false });
  });
});
