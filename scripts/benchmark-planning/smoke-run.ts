import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  collectPlanningArtifacts,
  planningArtifactsNeedDecoder,
  parsePlanningArtifactBundle,
} from '../../src/delivery/evidence-artifacts.js';
import {
  admitProviderArtifactBindings,
  parseLiveProviderProvenance,
  providerEvidenceNeedsDecoder,
  PROVIDER_PROVENANCE_ARTIFACT,
  type LiveProvenanceExpectation,
} from '../../src/delivery/live-provenance-admission.js';
import type { LiveProviderProvenance } from '../../src/delivery/live-provenance.js';
import { DeliveryError } from '../../src/delivery/contract.js';
import {
  decodeApprovedPlanningArtifacts,
  type EvidenceDecoderContext,
} from '../../src/delivery/evidence-decoder-registry.js';
import type { ExecutionControl } from '../../src/runtime/execution-control.js';
import type { EvidenceDecoderExecutor } from '../../src/delivery/evidence-decoder.js';
import { fileSha256, sha256 } from '../../src/core/digest.js';
import { readRunRecords } from '../../src/core/run-store.js';
import { killTree, spawnOwned, terminateOwned, waitForExit } from '../../src/runtime/exec.js';
import { isAlive, procStartToken } from '../../src/runtime/proc.js';
import {
  benchmarkChildEnvironment,
  declaredFile,
  verifyBenchmarkOutputLocation,
  verifyBenchmarkWorkspace,
} from './benchmark.js';
import type {
  PlanningSmokeResults,
  PlanningSmokeSentinel,
  PlanningSmokeSentinelResult,
} from './model.js';
import {
  DEFAULT_SMOKE_MANIFEST_FILE,
  SMOKE_RESULTS_FILE,
  evaluatePlanningSmokeSentinel,
  loadPlanningSmoke,
} from './smoke.js';
import {
  SMOKE_ATTEMPTS_FILE,
  acquireSmokeOwnership,
  readSmokeAttempts,
  smokeAttemptAlive,
  smokeAttemptIdentity,
  writeSmokeAttempts,
  writeSmokeJson,
  type SmokeAttempt,
  type SmokeAttemptState,
} from './smoke-attempts.js';

const DEFAULT_SCENARIO_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_ATTEMPT_LIMIT = 2;
const TERMINATION_GRACE_MS = 1000;

export interface SmokeAttemptEvent {
  readonly phase: 'started' | 'finished';
  readonly attempt: SmokeAttempt;
}

export interface RunPlanningSmokeOptions {
  readonly providerProvenance?: Pick<
    LiveProvenanceExpectation,
    'controllerDigest' | 'profileDigest'
  >;
  readonly decoderContext?: EvidenceDecoderContext;
  readonly decoderExecution?: ExecutionControl;
  readonly manifestFile?: string;
  readonly outputDir: string;
  readonly repositoryRoot: string;
  readonly signal?: AbortSignal;
  readonly scenarioTimeoutMs?: number;
  readonly attemptLimit?: number;
  readonly executionControlFile?: string;
  readonly privateOutput?: boolean;
  readonly remainingActiveMs?: () => number;
  readonly onAttempt?: (event: SmokeAttemptEvent) => Promise<void>;
}

export interface SmokeScenarioExecution {
  readonly workspaceRevision: string;
  readonly attemptIdentity: string;
  readonly repositoryRoot: string;
  readonly sentinel: PlanningSmokeSentinel;
  readonly inputFile: string;
  readonly workDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onSpawn: (pid: number) => void;
  readonly outputFile?: string;
}

export interface PlanningSmokeDependencies {
  readonly executeScenario: (options: SmokeScenarioExecution) => Promise<number>;
  readonly verifyWorkspace: (
    ...args: Parameters<typeof verifyBenchmarkWorkspace>
  ) => string | Promise<string>;
  readonly now: () => number;
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function executeSmokeScenario(options: SmokeScenarioExecution): Promise<number> {
  if (options.environment.AGENT_QUORUM_EXECUTION_CONTROL_FILE !== undefined) {
    throw new Error('supervised candidate smoke requires a confined provider broker');
  }
  if (signalAborted(options.signal)) {
    return 143;
  }
  const args = [
    'exec',
    'tsx',
    path.join(options.repositoryRoot, 'scripts', 'benchmark-planning', 'smoke-api-runner.ts'),
    options.sentinel.inputMode,
    options.inputFile,
    options.sentinel.quality,
    String(options.sentinel.maxIterations),
    options.workDir,
    path.join(path.dirname(options.workDir), 'api-result.json'),
  ];
  const outputFd =
    options.outputFile === undefined ? undefined : openSync(options.outputFile, 'wx', 0o600);
  const child = spawnOwned(
    'pnpm',
    args,
    {
      cwd: options.repositoryRoot,
      env: options.environment,
      stdio: outputFd === undefined ? 'inherit' : ['ignore', outputFd, outputFd],
    },
    true,
  );
  const exited = waitForExit(child);
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  const interruption = { occurred: false };
  const terminationGraceMs = Math.min(TERMINATION_GRACE_MS, options.timeoutMs / 2);
  const interrupt = () => {
    interruption.occurred = true;
    killTree(child, 'SIGTERM');
    terminationTimer ??= setTimeout(() => {
      killTree(child, 'SIGKILL');
    }, terminationGraceMs);
  };
  const deadline = setTimeout(interrupt, Math.max(1, options.timeoutMs - terminationGraceMs));
  options.signal?.addEventListener('abort', interrupt, { once: true });
  try {
    if (child.pid !== undefined) {
      options.onSpawn(child.pid);
    }
    if (signalAborted(options.signal)) {
      interrupt();
    }
    const exitCode = await exited;
    await terminateOwned(child, 0);
    return interruption.occurred ? 143 : exitCode;
  } catch (error) {
    interrupt();
    await exited;
    await terminateOwned(child, 0);
    throw error;
  } finally {
    clearTimeout(deadline);
    if (terminationTimer !== undefined) {
      clearTimeout(terminationTimer);
    }
    options.signal?.removeEventListener('abort', interrupt);
    if (outputFd !== undefined) {
      closeSync(outputFd);
    }
  }
}

const DEFAULT_DEPENDENCIES: PlanningSmokeDependencies = {
  executeScenario: executeSmokeScenario,
  verifyWorkspace: verifyBenchmarkWorkspace,
  now: Date.now,
};

function boundedPositive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`${name} must be a positive finite bounded integer`);
  }
  return value;
}

function recoveredExitCode(attempt: SmokeAttempt): number {
  if (attempt.exitCode !== undefined) {
    return attempt.exitCode;
  }
  const records = readRunRecords(path.join(path.dirname(attempt.workDir), 'state')).filter(
    (record) => path.resolve(record.workDir) === attempt.workDir,
  );
  if (
    records.some(
      (record) =>
        record.state === 'running' &&
        isAlive(record.pid) &&
        (procStartToken(record.pid) === undefined ||
          procStartToken(record.pid) === record.procStartToken),
    )
  ) {
    throw new Error(
      'planning smoke has unfinished live provider work; reconcile it before retrying',
    );
  }
  const finished = records.filter((record) => record.state === 'finished');
  return finished.length === 1 ? (finished[0]?.exitCode ?? 1) : 1;
}

function recoveredFinishedAt(attempt: SmokeAttempt, now: number): number | undefined {
  if (attempt.finishedAt !== undefined) {
    return attempt.finishedAt;
  }
  const records = readRunRecords(path.join(path.dirname(attempt.workDir), 'state')).filter(
    (record) => path.resolve(record.workDir) === attempt.workDir && record.state === 'finished',
  );
  const endedAt = records.length === 1 ? records[0]?.endedAt : undefined;
  const timestamp = endedAt === undefined ? NaN : Date.parse(endedAt);
  return Number.isSafeInteger(timestamp) && timestamp >= attempt.startedAt && timestamp <= now
    ? timestamp
    : undefined;
}

async function resultForAttempt(
  attempt: SmokeAttempt,
  sentinel: PlanningSmokeSentinel,
  outputDir: string,
  inputFile: string,
  options: RunPlanningSmokeOptions,
): Promise<PlanningSmokeSentinelResult> {
  if (smokeAttemptAlive(attempt)) {
    throw new Error('planning smoke scenario is still owned by a live process');
  }
  const result = await evaluateSmokeWithDecoder({
    sentinel,
    outputDir,
    workDir: attempt.workDir,
    exitCode:
      attempt.exitCode === undefined && options.decoderContext !== undefined
        ? 0
        : recoveredExitCode(attempt),
    inputFile,
    options,
    attempt,
  });
  if (
    attempt.artifactBundleSha256 !== undefined &&
    result.artifactBundleSha256 !== attempt.artifactBundleSha256
  ) {
    return {
      ...result,
      passed: false,
      failures: [...result.failures, 'original scenario artifacts changed after completion'],
    };
  }
  return result;
}

function replaceAttempt(state: SmokeAttemptState, attempt: SmokeAttempt): SmokeAttemptState {
  return {
    ...state,
    attempts: state.attempts.map((previous) =>
      previous.scenarioId === attempt.scenarioId && previous.attemptNumber === attempt.attemptNumber
        ? attempt
        : previous,
    ),
  };
}

interface PendingScenario {
  readonly sentinel: PlanningSmokeSentinel;
  readonly identity: string;
  readonly inputFile: string;
}

export async function runPlanningSmoke(
  options: RunPlanningSmokeOptions,
  dependencies: PlanningSmokeDependencies = DEFAULT_DEPENDENCIES,
): Promise<PlanningSmokeResults> {
  const smoke = loadPlanningSmoke(options.manifestFile);
  const outputDir = path.resolve(options.outputDir);
  const repositoryRoot = realpathSync(options.repositoryRoot);
  const scenarioTimeoutMs = boundedPositive(
    options.scenarioTimeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS,
    'scenario timeout',
  );
  const decoderAllowanceMs =
    options.decoderContext === undefined
      ? 0
      : boundedPositive(options.decoderContext.timeoutMs, 'decoder timeout');
  const scenarioAllowanceMs = scenarioTimeoutMs + decoderAllowanceMs;
  const attemptLimit = boundedPositive(
    options.attemptLimit ?? DEFAULT_ATTEMPT_LIMIT,
    'scenario attempt limit',
  );
  verifyBenchmarkOutputLocation(repositoryRoot, outputDir);
  const candidateRevision = await dependencies.verifyWorkspace(
    repositoryRoot,
    smoke.manifest.workspaceRevision,
    options.manifestFile ?? DEFAULT_SMOKE_MANIFEST_FILE,
  );
  const releaseOwnership = acquireSmokeOwnership(outputDir);
  try {
    if (
      !existsSync(path.join(outputDir, SMOKE_ATTEMPTS_FILE)) &&
      readdirSync(outputDir).some((entry) => entry !== '.smoke-owner.json')
    ) {
      throw new Error(
        'planning smoke output has no admissible attempt history; use a new output directory',
      );
    }
    const providerConfigText = readFileSync(
      declaredFile(smoke.root, smoke.manifest.providerConfig),
      'utf8',
    );
    const providerConfigSha256 = sha256(providerConfigText);
    let state = readSmokeAttempts(outputDir, smoke.manifest.suiteId);
    const results = new Map<string, PlanningSmokeSentinelResult>();
    const pending: PendingScenario[] = [];
    for (const sentinel of smoke.manifest.sentinels) {
      const inputFile = declaredFile(smoke.root, sentinel.input);
      const identity = smokeAttemptIdentity({
        workspaceRevision: smoke.manifest.workspaceRevision,
        suiteId: smoke.manifest.suiteId,
        sentinel,
        inputSha256: fileSha256(inputFile),
        providerConfigSha256,
      });
      const matching = state.attempts.filter(
        (attempt) => attempt.scenarioId === sentinel.id && attempt.identity === identity,
      );
      for (const attempt of matching.toReversed()) {
        const result = await resultForAttempt(attempt, sentinel, outputDir, inputFile, options);
        if (result.passed) {
          const finishedAt = recoveredFinishedAt(attempt, dependencies.now());
          const recovered = {
            ...attempt,
            ...(finishedAt === undefined ? {} : { finishedAt }),
            exitCode: result.exitCode,
            result,
            ...(result.artifactBundleSha256 === undefined
              ? {}
              : { artifactBundleSha256: result.artifactBundleSha256 }),
          };
          state = replaceAttempt(state, recovered);
          results.set(sentinel.id, result);
          break;
        }
      }
      if (!results.has(sentinel.id)) {
        const attempts = state.attempts.filter((attempt) => attempt.scenarioId === sentinel.id);
        if (attempts.some(smokeAttemptAlive)) {
          throw new Error('planning smoke cannot replace an active scenario');
        }
        if (attempts.length >= attemptLimit) {
          throw new Error(`planning smoke attempt limit exhausted for ${sentinel.id}`);
        }
        pending.push({ sentinel, identity, inputFile });
      }
    }
    writeSmokeAttempts(outputDir, state);
    const remaining = options.remainingActiveMs?.();
    if (
      remaining !== undefined &&
      (!Number.isFinite(remaining) || remaining < pending.length * scenarioAllowanceMs)
    ) {
      throw new Error('remaining active budget cannot fit the required planning smoke scenarios');
    }
    const aggregate = (): PlanningSmokeResults => {
      const tasks = smoke.manifest.sentinels.flatMap((sentinel) => {
        const result = results.get(sentinel.id);
        return result === undefined ? [] : [result];
      });
      return {
        schemaVersion: 1,
        suiteId: smoke.manifest.suiteId,
        workspaceRevision: smoke.manifest.workspaceRevision,
        providerConfigSha256,
        passed:
          tasks.length === smoke.manifest.sentinels.length && tasks.every((task) => task.passed),
        tasks,
      };
    };
    for (const scenario of pending) {
      if (signalAborted(options.signal)) {
        throw new Error('planning smoke was cancelled before starting a scenario');
      }
      const currentRemaining = options.remainingActiveMs?.();
      if (
        currentRemaining !== undefined &&
        (!Number.isFinite(currentRemaining) || currentRemaining < scenarioAllowanceMs)
      ) {
        throw new Error(
          'remaining active budget cannot fit the next required planning smoke scenario',
        );
      }
      const attemptNumber =
        state.attempts.filter((attempt) => attempt.scenarioId === scenario.sentinel.id).length + 1;
      const taskRoot = path.join(
        outputDir,
        scenario.sentinel.id,
        `attempt-${String(attemptNumber)}`,
      );
      const workDir = path.join(taskRoot, 'run');
      let attempt: SmokeAttempt = {
        scenarioId: scenario.sentinel.id,
        attemptNumber,
        identity: scenario.identity,
        workspaceRevision: smoke.manifest.workspaceRevision,
        candidateRevision,
        workDir,
        startedAt: dependencies.now(),
      };
      state = { ...state, attempts: [...state.attempts, attempt] };
      writeSmokeAttempts(outputDir, state);
      await options.onAttempt?.({ phase: 'started', attempt });
      mkdirSync(path.dirname(taskRoot), { recursive: true });
      mkdirSync(taskRoot);
      writeFileSync(path.join(taskRoot, 'input.md'), readFileSync(scenario.inputFile), {
        mode: 0o400,
        flag: 'wx',
      });
      const environment = benchmarkChildEnvironment({
        ambientEnv: process.env,
        providerConfigText,
        homeDir: path.join(taskRoot, 'home'),
        stateDir: path.join(taskRoot, 'state'),
        workDir,
        runName: `smoke-${scenario.sentinel.id}`,
      });
      if (options.executionControlFile !== undefined) {
        environment.AGENT_QUORUM_EXECUTION_CONTROL_FILE = path.resolve(
          options.executionControlFile,
        );
      }
      const onSpawn = (pid: number) => {
        const processStart = procStartToken(pid);
        attempt = {
          ...attempt,
          pid,
          ...(processStart === undefined ? {} : { processStartToken: processStart }),
        };
        state = replaceAttempt(state, attempt);
        writeSmokeAttempts(outputDir, state);
      };
      const exitCode = await dependencies.executeScenario({
        workspaceRevision: attempt.workspaceRevision,
        attemptIdentity: attempt.identity,
        repositoryRoot,
        sentinel: scenario.sentinel,
        inputFile: scenario.inputFile,
        workDir,
        environment,
        timeoutMs: scenarioTimeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onSpawn,
        ...(options.privateOutput === true
          ? { outputFile: path.join(taskRoot, 'process.log') }
          : {}),
      });
      const observedRevision = await dependencies.verifyWorkspace(
        repositoryRoot,
        smoke.manifest.workspaceRevision,
        options.manifestFile ?? DEFAULT_SMOKE_MANIFEST_FILE,
      );
      if (observedRevision !== candidateRevision) {
        throw new Error('planning smoke candidate changed during scenario execution');
      }
      const result = await evaluateSmokeWithDecoder({
        sentinel: scenario.sentinel,
        outputDir,
        workDir,
        exitCode,
        inputFile: scenario.inputFile,
        options,
        attempt,
      });
      attempt = {
        ...attempt,
        finishedAt: dependencies.now(),
        exitCode,
        result,
        ...(result.artifactBundleSha256 === undefined
          ? {}
          : { artifactBundleSha256: result.artifactBundleSha256 }),
      };
      state = replaceAttempt(state, attempt);
      writeSmokeAttempts(outputDir, state);
      results.set(scenario.sentinel.id, result);
      writeSmokeJson(path.join(outputDir, SMOKE_RESULTS_FILE), aggregate());
      await options.onAttempt?.({ phase: 'finished', attempt });
    }
    const result = aggregate();
    writeSmokeJson(path.join(outputDir, SMOKE_RESULTS_FILE), result);
    return result;
  } finally {
    releaseOwnership();
  }
}

export async function evaluateSmokeWithDecoder(
  input: Parameters<typeof evaluateSmokeWithDecoderUnchecked>[0],
): Promise<PlanningSmokeSentinelResult> {
  try {
    return await evaluateSmokeWithDecoderUnchecked(input);
  } catch (error) {
    if (!(error instanceof DeliveryError) || !error.code.startsWith('live-provider-')) throw error;
    const result = evaluatePlanningSmokeSentinel(input);
    return { ...result, passed: false, failures: [...result.failures, error.code] };
  }
}

async function evaluateSmokeWithDecoderUnchecked(input: {
  readonly sentinel: PlanningSmokeSentinel;
  readonly outputDir: string;
  readonly workDir: string;
  readonly exitCode: number;
  readonly inputFile: string;
  readonly decoderExecutor?: EvidenceDecoderExecutor;
  readonly attempt?: SmokeAttempt;
  readonly options: Pick<
    RunPlanningSmokeOptions,
    'decoderContext' | 'decoderExecution' | 'providerProvenance'
  >;
}): Promise<PlanningSmokeSentinelResult> {
  const current = evaluatePlanningSmokeSentinel(input);
  if (input.exitCode !== 0 || !existsSync(input.workDir)) {
    return current;
  }
  const artifacts = collectPlanningArtifacts(
    input.workDir,
    path.join(path.dirname(input.workDir), 'state'),
    input.inputFile,
  );
  const artifactBundleSha256 = sha256(artifacts);
  const bundle = parsePlanningArtifactBundle(artifacts);
  const provenanceText = bundle.files[PROVIDER_PROVENANCE_ARTIFACT];
  let provenance: LiveProviderProvenance | undefined;
  if (input.options.providerProvenance !== undefined || provenanceText !== undefined) {
    if (provenanceText === undefined) throw new DeliveryError('live-provider-provenance-missing');
    provenance = parseLiveProviderProvenance(provenanceText, {
      ...input.options.providerProvenance,
      id: input.sentinel.id,
      inputMode: input.sentinel.inputMode,
      quality: input.sentinel.quality,
      maxIterations: input.sentinel.maxIterations,
      inputSha256: fileSha256(input.inputFile),
      workDir: input.workDir,
      ...(input.attempt === undefined
        ? {}
        : {
            workspaceRevision: input.attempt.workspaceRevision,
            attemptIdentity: input.attempt.identity,
          }),
    });
  }
  const incompatible =
    planningArtifactsNeedDecoder(artifacts) ||
    (provenance !== undefined && providerEvidenceNeedsDecoder(provenance));
  if (current.passed && !incompatible) {
    if (provenance !== undefined) admitProviderArtifactBindings(input.workDir, provenance);
    return { ...current, artifactBundleSha256 };
  }
  if (!incompatible) {
    return current;
  }
  if (input.options.decoderContext === undefined || input.options.decoderExecution === undefined) {
    throw new Error('incompatible planning evidence requires an approved decoder');
  }
  let evaluated: PlanningSmokeSentinelResult | undefined;
  await decodeApprovedPlanningArtifacts(
    input.options.decoderContext,
    artifacts,
    input.options.decoderExecution,
    (workDir) => {
      const projected = evaluatePlanningSmokeSentinel({
        sentinel: input.sentinel,
        outputDir: path.dirname(workDir),
        workDir,
        exitCode: input.exitCode,
      });
      if (!projected.passed) {
        throw new Error('decoded planning evidence failed frozen sentinel assertions');
      }
      if (provenance !== undefined) {
        const projectedProvenance = JSON.parse(
          readFileSync(path.join(path.dirname(workDir), PROVIDER_PROVENANCE_ARTIFACT), 'utf8'),
        ) as LiveProviderProvenance;
        admitProviderArtifactBindings(workDir, projectedProvenance);
      }
      evaluated = projected;
    },
    input.decoderExecutor,
  );
  if (evaluated === undefined) {
    throw new Error('decoded planning evidence was not evaluated');
  }
  return {
    ...evaluated,
    artifactBundleSha256,
    finalPlan: path.relative(input.outputDir, path.join(input.workDir, 'plan.final.md')),
    finalPlanSha256: fileSha256(path.join(input.workDir, 'plan.final.md')),
  };
}
