import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readExecutionHandoff } from '../src/runtime/execution-handoff.js';
import type { EvidenceDecoderContext } from '../src/delivery/evidence-decoder-registry.js';
import { DeliveryLedger } from '../src/delivery/ledger.js';
import { RepositoryBroker } from '../src/delivery/commands.js';
import type { ExecutionControl } from '../src/runtime/execution-control.js';
import { DeliveryError, digest, type Mandate } from '../src/delivery/contract.js';
import { verifyFrozenRuntime } from '../src/delivery/activation.js';
import { executeConfinedSmokeScenario } from '../src/delivery/live-executor.js';
import { planningDecoderContext } from '../src/delivery/evidence-decoder-registry.js';
import { declaredFile } from './benchmark-planning/benchmark.js';
import { fileSha256 } from '../src/core/digest.js';
import { SMOKE_ATTEMPTS_FILE } from './benchmark-planning/smoke-attempts.js';
import { runPlanningSmoke } from './benchmark-planning/smoke-run.js';
import { loadPlanningSmoke, SMOKE_RESULTS_FILE } from './benchmark-planning/smoke.js';

export interface DeliverySmokeRequest {
  readonly stateDirectory: string;
  readonly issue: number;
  readonly repositoryRoot: string;
  readonly outputDir: string;
  readonly scenarioTimeoutMs: number;
  readonly attemptLimit: number;
  readonly executionControlFile: string;
  readonly remainingActiveMs: number;
  readonly decoderContext?: EvidenceDecoderContext;
}

const REQUEST_KEYS = [
  'stateDirectory',
  'issue',
  'repositoryRoot',
  'outputDir',
  'scenarioTimeoutMs',
  'attemptLimit',
  'executionControlFile',
  'remainingActiveMs',
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveBound(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
  );
}

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value);
}

function readPrivateRequest(file: string): unknown {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error('delivery smoke request must be an owner-only regular file', { cause: error });
  }
  try {
    const metadata = fstatSync(descriptor);
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile() ||
      currentUid === undefined ||
      metadata.uid !== currentUid ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > 65536
    ) {
      throw new Error('delivery smoke request must be an owner-only regular file');
    }
    return JSON.parse(readFileSync(descriptor, 'utf8')) as unknown;
  } finally {
    closeSync(descriptor);
  }
}

function isDecoderContext(value: unknown): value is EvidenceDecoderContext {
  return (
    isObject(value) &&
    Object.keys(value).length === 4 &&
    absolutePath(value.registryRoot) &&
    typeof value.producerRevision === 'string' &&
    /^[a-f0-9]{40}$/.test(value.producerRevision) &&
    typeof value.policyDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.policyDigest) &&
    positiveBound(value.timeoutMs)
  );
}

export function readDeliverySmokeRequest(file: string): DeliverySmokeRequest {
  const value = readPrivateRequest(file);
  if (
    !isObject(value) ||
    Object.keys(value).some((key) => ![...REQUEST_KEYS, 'decoderContext'].includes(key)) ||
    !REQUEST_KEYS.every((key) => Object.hasOwn(value, key)) ||
    !absolutePath(value.stateDirectory) ||
    !positiveBound(value.issue) ||
    !absolutePath(value.repositoryRoot) ||
    !absolutePath(value.outputDir) ||
    !absolutePath(value.executionControlFile) ||
    !positiveBound(value.scenarioTimeoutMs) ||
    !positiveBound(value.attemptLimit) ||
    !positiveBound(value.remainingActiveMs) ||
    (value.decoderContext !== undefined && !isDecoderContext(value.decoderContext))
  ) {
    throw new Error('delivery smoke request has unsupported fields or invalid explicit bounds');
  }
  return {
    stateDirectory: value.stateDirectory,
    issue: value.issue,
    repositoryRoot: value.repositoryRoot,
    outputDir: value.outputDir,
    scenarioTimeoutMs: value.scenarioTimeoutMs,
    attemptLimit: value.attemptLimit,
    executionControlFile: value.executionControlFile,
    remainingActiveMs: value.remainingActiveMs,
    ...(value.decoderContext === undefined ? {} : { decoderContext: value.decoderContext }),
  };
}

export function assertFrozenSmokeInputs(
  mandate: Mandate,
  repositoryRoot: string,
): { manifestFile: string; providerConfigText: string } {
  const frozenRoot = path.join(mandate.runtimeRoot, 'benchmarks/planning');
  const frozen = loadPlanningSmoke(path.join(frozenRoot, 'smoke-manifest.json'));
  const candidateRoot = path.join(repositoryRoot, 'benchmarks/planning');
  const manifestFile = path.join(candidateRoot, 'smoke-manifest.json');
  const manifest: unknown = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (
    !isObject(manifest) ||
    typeof manifest.workspaceRevision !== 'string' ||
    !/^[a-f0-9]{40}$/.test(manifest.workspaceRevision) ||
    digest(manifest) !==
      digest({ ...frozen.manifest, workspaceRevision: manifest.workspaceRevision })
  ) {
    throw new DeliveryError('smoke-assurance-contract-changed');
  }
  const inputs = [
    'smoke-manifest.schema.json',
    frozen.manifest.providerConfig,
    ...frozen.manifest.sentinels.map((sentinel) => sentinel.input),
  ];
  for (const input of inputs) {
    if (
      fileSha256(declaredFile(frozenRoot, input)) !== fileSha256(declaredFile(candidateRoot, input))
    ) {
      throw new DeliveryError('frozen-smoke-input-changed');
    }
  }
  return {
    manifestFile,
    providerConfigText: readFileSync(
      declaredFile(frozenRoot, frozen.manifest.providerConfig),
      'utf8',
    ),
  };
}

export async function verifyDeliverySmokeWorkspace(
  ledger: DeliveryLedger,
  execution: ExecutionControl,
  issue: number,
  repositoryRoot: string,
  expectedRevision: string,
  manifestFile: string,
): Promise<string> {
  const mandate = ledger.assertAuthorized('verify', issue);
  if (
    ledger.issue(issue)?.worktree !== repositoryRoot ||
    !/^[a-f0-9]{40}$/.test(expectedRevision)
  ) {
    throw new DeliveryError('live-workspace-outside-mandate');
  }
  const relativeManifest = path.relative(repositoryRoot, path.resolve(manifestFile));
  if (
    relativeManifest === '' ||
    relativeManifest === '..' ||
    relativeManifest.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeManifest)
  ) {
    throw new DeliveryError('live-manifest-outside-workspace');
  }
  const repository = new RepositoryBroker(ledger, mandate, execution);
  const git = (args: readonly string[]) => repository.git(repositoryRoot, args, issue);
  if ((await git(['status', '--porcelain=v1', '--untracked-files=all'])) !== '') {
    throw new DeliveryError('live-workspace-must-be-clean');
  }
  const revision = await git(['rev-parse', 'HEAD']);
  const expected = await git(['rev-parse', '--verify', `${expectedRevision}^{commit}`]);
  if (!/^[a-f0-9]{40}$/.test(revision) || expected !== expectedRevision) {
    throw new DeliveryError('live-workspace-revision-unavailable');
  }
  if (
    revision !== expectedRevision &&
    (await git([
      'diff',
      '--name-only',
      expectedRevision,
      revision,
      '--',
      '.',
      `:(exclude)${relativeManifest.split(path.sep).join('/')}`,
    ])) !== ''
  ) {
    throw new DeliveryError('live-source-differs-from-pinned-revision');
  }
  return revision;
}

export async function runDeliverySmokeCli(args: readonly string[]): Promise<number> {
  if (args.length !== 2 || args[0] !== '--request' || args[1] === undefined) {
    throw new Error('usage: delivery-smoke --request <private-json-file>');
  }
  const request = readDeliverySmokeRequest(args[1]);
  const ledger = new DeliveryLedger(request.stateDirectory, true);
  try {
    const mandate = ledger.assertAuthorized('verify', request.issue);
    verifyFrozenRuntime(mandate);
    const issue = ledger.issue(request.issue);
    const implementation = ledger.get<string>(`live-implementation:${request.issue}`);
    if (
      issue?.worktree !== request.repositoryRoot ||
      implementation === undefined ||
      request.scenarioTimeoutMs !== mandate.profile.bounds.liveScenarioTimeoutMs ||
      request.attemptLimit !==
        mandate.profile.bounds.liveStartsPerScenario +
          ledger.counter(`attempt-grant:live:${request.issue}`)
    ) {
      throw new DeliveryError('live-request-outside-current-mandate');
    }
    const execution = readExecutionHandoff(request.executionControlFile);
    const deadline = Math.min(
      execution.deadlineEpochMs ?? Infinity,
      Date.now() + request.remainingActiveMs,
    );
    const frozen = assertFrozenSmokeInputs(mandate, request.repositoryRoot);
    const decoderContext = planningDecoderContext(mandate, ledger.directory, implementation);
    if (
      request.decoderContext !== undefined &&
      digest(request.decoderContext) !== digest(decoderContext)
    ) {
      throw new DeliveryError('live-decoder-context-outside-mandate');
    }
    const results = await runPlanningSmoke(
      {
        repositoryRoot: request.repositoryRoot,
        manifestFile: frozen.manifestFile,
        outputDir: request.outputDir,
        scenarioTimeoutMs: request.scenarioTimeoutMs,
        attemptLimit: request.attemptLimit,
        executionControlFile: request.executionControlFile,
        privateOutput: true,
        providerProvenance: {
          controllerDigest: mandate.controllerDigest,
          profileDigest: mandate.profileDigest,
        },
        decoderContext,
        decoderExecution: execution,
        remainingActiveMs: () =>
          Math.max(
            0,
            Math.min(deadline - Date.now(), ledger.budget(request.issue, Date.now()).availableMs),
          ),
      },
      {
        executeScenario: (scenario) =>
          executeConfinedSmokeScenario(mandate, execution, frozen.providerConfigText, scenario),
        verifyWorkspace: (root, expected, manifest) =>
          verifyDeliverySmokeWorkspace(ledger, execution, request.issue, root, expected, manifest),
        now: Date.now,
      },
    );
    const summary = {
      schemaVersion: 1,
      passed: results.passed,
      workspaceRevision: results.workspaceRevision,
      receiptSha256: fileSha256(path.join(request.outputDir, SMOKE_RESULTS_FILE)),
      attemptsSha256: fileSha256(path.join(request.outputDir, SMOKE_ATTEMPTS_FILE)),
      scenarios: results.tasks.map((task) => ({ id: task.taskId, passed: task.passed })),
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return results.passed ? 0 : 1;
  } finally {
    ledger.close();
  }
}

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('budget')) {
    return 'live-budget-insufficient';
  }
  if (message.includes('attempt limit')) {
    return 'live-attempt-limit';
  }
  if (message.includes('cancelled')) {
    return 'live-cancelled';
  }
  if (/workspace|pinned|candidate changed/.test(message)) {
    return 'live-source-unpinned-or-changed';
  }
  if (/owned|ownership|live process/.test(message)) {
    return 'live-work-owned';
  }
  if (/request|usage:/.test(message)) {
    return 'invalid-live-request';
  }
  if (/incompatible|corrupt|admissible/.test(message)) {
    return 'live-evidence-incompatible';
  }
  return 'live-verification-blocked';
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  try {
    process.exitCode = await runDeliverySmokeCli(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, passed: false, reason: failureReason(error) })}\n`,
    );
    process.exitCode = 2;
  }
}
