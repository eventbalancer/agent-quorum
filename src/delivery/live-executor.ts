import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileSha256, sha256 } from '../core/digest.js';
import { LiveProviderJournal } from './live-provenance.js';
import { providerRun } from '../providers/provider.js';
import { isQuality } from '../core/quality.js';
import type { ExecutionControl } from '../runtime/execution-control.js';
import { repositoryEnvironment, runDeliveryCommand } from './commands.js';
import { dockerExecutorArgs } from './confined-executor.js';
import { DeliveryError, type Mandate } from './contract.js';
import { frozenGateArgs } from './gate-toolchain.js';
import { createLiveProviderBroker } from './live-provider.js';

export interface ConfinedSmokeScenario {
  readonly repositoryRoot: string;
  readonly workspaceRevision: string;
  readonly attemptIdentity: string;
  readonly sentinel: {
    readonly id: string;
    readonly inputMode: string;
    readonly quality: string;
    readonly maxIterations: number;
  };
  readonly inputFile: string;
  readonly workDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onSpawn: (pid: number) => void;
  readonly outputFile?: string;
}

export async function executeConfinedSmokeScenario(
  mandate: Mandate,
  execution: ExecutionControl,
  providerConfigText: string,
  scenario: ConfinedSmokeScenario,
  run = runDeliveryCommand,
): Promise<number> {
  const executor = mandate.profile.executor;
  if (
    executor === undefined ||
    !isQuality(scenario.sentinel.quality) ||
    !Number.isSafeInteger(scenario.timeoutMs) ||
    scenario.timeoutMs <= 0
  ) {
    throw new DeliveryError('confined-live-executor-unavailable', true);
  }
  const artifactRoot = path.dirname(scenario.workDir);
  const forwarded: Record<string, string> = {
    PATH: '/aq-harness/src/delivery/shims:/usr/local/bin:/usr/bin:/bin',
    HOME: path.join(artifactRoot, 'home'),
    AGENT_QUORUM_CONFIG_OVERRIDE_JSON: providerConfigText,
    AGENT_QUORUM_HOME: path.join(artifactRoot, 'home'),
    AGENT_QUORUM_STATE_DIR: path.join(artifactRoot, 'state'),
    AGENT_QUORUM_WORK_DIR: scenario.workDir,
    AGENT_QUORUM_RUN_NAME: scenario.environment.AGENT_QUORUM_RUN_NAME ?? 'delivery-smoke',
    AGENT_QUORUM_CLARIFY: '0',
  };
  const signal =
    scenario.signal === undefined
      ? execution.signal
      : AbortSignal.any(
          execution.signal === undefined ? [scenario.signal] : [scenario.signal, execution.signal],
        );
  const deadlineEpochMs = Math.min(
    execution.deadlineEpochMs ?? Infinity,
    Date.now() + scenario.timeoutMs,
  );
  const controlled: ExecutionControl = {
    ...execution,
    ...(signal === undefined ? {} : { signal }),
    deadlineEpochMs,
    attemptTimeoutMs: scenario.timeoutMs,
    onSpawn: async (process) => {
      await execution.onSpawn?.(process);
      scenario.onSpawn(process.pid);
    },
  };
  const args = dockerExecutorArgs(
    {
      image: executor.image,
      worktree: scenario.repositoryRoot,
      runtimeRoot: mandate.runtimeRoot,
      readOnlyWorktree: true,
      artifactRoot,
      environment: forwarded,
    },
    [
      '--provider-proxy',
      ...frozenGateArgs('/aq-harness', '/aq-toolchain', scenario.repositoryRoot, ['live']),
      '/aq-harness/dist/delivery/live-driver.js',
      scenario.repositoryRoot,
      scenario.sentinel.inputMode,
      scenario.inputFile,
      scenario.sentinel.quality,
      String(scenario.sentinel.maxIterations),
      scenario.workDir,
      path.join(artifactRoot, 'api-result.json'),
    ],
  );
  const journal = new LiveProviderJournal(
    {
      id: scenario.sentinel.id,
      inputMode: scenario.sentinel.inputMode,
      quality: scenario.sentinel.quality,
      maxIterations: scenario.sentinel.maxIterations,
      inputSha256: fileSha256(scenario.inputFile),
      workDir: scenario.workDir,
      repositoryRoot: scenario.repositoryRoot,
      controllerDigest: mandate.controllerDigest,
      profileDigest: mandate.profileDigest,
      providerConfigSha256: sha256(providerConfigText),
      workspaceRevision: scenario.workspaceRevision,
      attemptIdentity: scenario.attemptIdentity,
    },
    mandate.runtimeRoot,
  );
  let result;
  try {
    result = await run({
      command: 'docker',
      args,
      cwd: mandate.runtimeRoot,
      execution: { ...controlled, env: repositoryEnvironment(artifactRoot) },
      keepAlive: true,
      providerRequests: createLiveProviderBroker(
        mandate,
        {
          ...execution,
          ...(signal === undefined ? {} : { signal }),
          deadlineEpochMs,
        },
        providerConfigText,
        scenario.repositoryRoot,
        scenario.sentinel.quality,
        providerRun,
        journal,
      ),
    });
  } catch (error) {
    journal.finish(1);
    throw error;
  }
  journal.finish(result.exitCode);
  if (scenario.outputFile !== undefined) {
    writeFileSync(scenario.outputFile, `${result.stdout}${result.stderr}`, {
      mode: 0o600,
      flag: 'wx',
    });
  }
  return result.exitCode;
}
