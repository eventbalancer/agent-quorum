import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, type RoleMatrixEntry } from '../core/config.js';
import { resolveWatchdogKnobs } from '../core/knobs.js';
import { providerRun } from '../providers/provider.js';
import { Scratch } from '../runtime/scratch.js';
import { isAlive } from '../runtime/proc.js';
import {
  assertExecutionAllowed,
  ExecutionControlError,
  type ExecutionControl,
} from '../runtime/execution-control.js';
import { RUNNER_META, resolveRunnerBinaries } from '../providers/registry.js';
import {
  codexSandboxProbeArgs,
  supervisedCodexEnvironment,
  supervisedCodexInspectionPolicy,
  supervisedCodexPolicy,
} from '../providers/supervised-policy.js';
import {
  contentDigest,
  DAY_LIMIT_MS,
  DELIVERY_OPERATIONS,
  DELIVERY_REPOSITORY,
  DeliveryError,
  digest,
  ISSUE_LIMIT_MS,
  parseDeliveryProfile,
  POLICY_VERSION,
  REPAIR_LIMIT,
  type DeliveryProfile,
  type Mandate,
} from './contract.js';
import { runDeliveryCommand, type CommandInput, type CommandResult } from './commands.js';
import {
  createGhTransport,
  DeliveryGitHub,
  type GitHubTransport,
  type RequiredCheck,
} from './github.js';
import {
  acquireRepositoryOwner,
  currentProcessOwner,
  deliveryLaunchArguments,
  launchAgentDocument,
  runGuardianStep,
} from './guardian.js';
import { DeliveryLedger } from './ledger.js';
import { CodexDeliveryWorker } from './worker.js';
import { VERIFICATION_POLICY_FILES } from './verification-policy.js';
import { probeDockerExecutor } from './executor-probe.js';
import { canonicalConfiguration, readCodexConfigurationDigest } from './config-attestation.js';
import { PROVIDER_CONFINEMENT_PROGRAM } from './provider-confinement-program.js';

const CONFINEMENT_PROBE_TIMEOUT_MS = 15_000;

const FROZEN_DIRECTORIES = [
  'src',
  'scripts',
  'skills',
  'docs',
  'benchmarks',
  '.agents/skills',
  '.claude/commands',
  '.github',
  '.githooks',
  'node_modules',
  'dist',
];
const FROZEN_FILES = [
  ...VERIFICATION_POLICY_FILES,
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.build.json',
  'eslint.config.ts',
  'vitest.config.ts',
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'LICENSE',
  'config.example.json',
  '.delivery-planning.json',
];

interface FrozenEntry {
  readonly file: string;
  readonly mode: number;
  readonly digest: string;
  readonly kind: 'file' | 'symlink';
}

export interface PreparationResult {
  readonly digest: string;
  readonly mandate: Mandate;
  readonly blockers: readonly string[];
}

export interface ActivationHost {
  readonly signal?: AbortSignal;
  readonly readConfiguration?: typeof readCodexConfigurationDigest;
  readonly run?: (input: CommandInput) => Promise<CommandResult>;
  readonly transport?: GitHubTransport;
  readonly runtimeParent?: string;
  readonly now?: () => number;
}

interface PrepareDeliveryInput {
  readonly root: string;
  readonly profileFile: string;
  readonly execution?: ExecutionControl;
}

interface DeliveryActivationHost extends ActivationHost {
  readonly probe?: (ledger: DeliveryLedger, authorizedDigest: string) => Promise<number>;
  readonly install?: typeof installDeliveryLaunchAgent;
}

interface LaunchAgentHost {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly directory?: string;
  readonly run?: typeof runDeliveryCommand;
}

interface GitHubActivationEvidence {
  readonly actor: string;
  readonly checks: readonly RequiredCheck[];
  readonly blockers: readonly string[];
  readonly workflowTreeSha: string;
}

interface McpConfiguration {
  readonly names: readonly string[];
  readonly configurationDigest: string;
}

export function frozenRuntimeEntries(root: string): FrozenEntry[] {
  const entries: FrozenEntry[] = [];
  const visit = (relative: string) => {
    const absolute = path.join(root, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(absolute);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new DeliveryError('frozen-runtime-symlink-escapes', true);
      }
      entries.push({
        file: relative,
        mode: stat.mode & 0o777,
        kind: 'symlink',
        digest: contentDigest(readlinkSync(absolute)),
      });
    } else if (stat.isDirectory()) {
      for (const child of readdirSync(absolute).sort()) {
        visit(path.join(relative, child));
      }
    } else if (stat.isFile()) {
      entries.push({
        file: relative,
        mode: stat.mode & 0o777,
        kind: 'file',
        digest: contentDigest(readFileSync(absolute)),
      });
    } else {
      throw new DeliveryError('unsupported-frozen-runtime-entry', true);
    }
  };
  for (const relative of new Set([...FROZEN_DIRECTORIES, ...FROZEN_FILES])) {
    if (existsSync(path.join(root, relative))) {
      visit(relative);
    }
  }
  return entries.sort((left, right) => left.file.localeCompare(right.file));
}

export function verifyFrozenRuntime(mandate: Mandate): void {
  if (digest(frozenRuntimeEntries(mandate.runtimeRoot)) !== mandate.controllerDigest) {
    throw new DeliveryError('frozen-runtime-changed', true);
  }
  if (digest(mandate.profile) !== mandate.profileDigest) {
    throw new DeliveryError('frozen-profile-changed', true);
  }
}

async function checkedRun(
  input: CommandInput,
  run: (input: CommandInput) => Promise<CommandResult>,
): Promise<string> {
  const result = await run(input);
  if (result.exitCode !== 0) {
    throw new DeliveryError('activation-command-failed', true);
  }
  return result.stdout.trim();
}

function responseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeliveryError('invalid-activation-evidence', true);
  }
  return value as Record<string, unknown>;
}

async function githubActivationEvidence(
  root: string,
  transport: GitHubTransport,
  frozenChecks?: readonly RequiredCheck[],
): Promise<GitHubActivationEvidence> {
  if (!path.isAbsolute(root)) {
    throw new DeliveryError('activation-root-must-be-absolute', true);
  }
  const identity = responseObject(await transport.request({ method: 'GET', path: 'user' }));
  if (typeof identity.login !== 'string' || identity.login === '') {
    throw new DeliveryError('github-actor-unavailable', true);
  }
  const client = new DeliveryGitHub({ repository: DELIVERY_REPOSITORY, transport });
  let checks = frozenChecks;
  if (checks === undefined) {
    const currentChecks = await client.getChecks(await client.getMain());
    checks = currentChecks
      .filter((check) => check.appId === 15368 && check.context.startsWith('check ('))
      .map((check) => ({ context: check.context, appId: check.appId }));
  }
  const workflowTreeSha = await client.getWorkflowTreeSha(await client.getMain());
  const producerBlockers = await client.assessWorkflowProvenance(workflowTreeSha);
  const result = await client.inspectPrerequisites(checks, workflowTreeSha);
  return {
    actor: identity.login,
    checks: result.requiredChecks,
    blockers: [...result.blockers, ...producerBlockers],
    workflowTreeSha,
  };
}

export async function prepareDelivery(
  ledger: DeliveryLedger,
  input: PrepareDeliveryInput,
  host: ActivationHost = {},
): Promise<PreparationResult> {
  if (!['prepared', 'blocked', 'stopped', 'revoked'].includes(ledger.mode())) {
    throw new DeliveryError('prepare-requires-inactive-delivery', true);
  }
  try {
    return await prepareDeliveryCandidate(ledger, input, host);
  } catch (error) {
    const code = error instanceof DeliveryError ? error.code : 'preparation-evidence-unavailable';
    ledger.set('activation-blockers', [code]);
    if (!['revoked', 'stopped', 'paused', 'pausing'].includes(ledger.mode())) {
      ledger.changeMode('blocked', code);
    }
    throw error;
  }
}

async function prepareDeliveryCandidate(
  ledger: DeliveryLedger,
  input: PrepareDeliveryInput,
  host: ActivationHost = {},
): Promise<PreparationResult> {
  if (!['prepared', 'blocked', 'stopped', 'revoked'].includes(ledger.mode())) {
    throw new DeliveryError('prepare-requires-inactive-delivery', true);
  }
  const root = realpathSync(input.root);
  const run = host.run ?? runDeliveryCommand;
  const parsed: unknown = JSON.parse(readFileSync(input.profileFile, 'utf8'));
  const profile = parseDeliveryProfile(parsed);
  const execution = input.execution ?? {
    deadlineEpochMs: Date.now() + profile.bounds.commandTimeoutMs,
  };
  const command = (args: readonly string[]) =>
    checkedRun({ command: 'git', args, cwd: root, execution }, run);
  if ((await command(['status', '--porcelain', '--untracked-files=all'])) !== '') {
    throw new DeliveryError('prepare-requires-clean-committed-source', true);
  }
  const remote = await command(['remote', 'get-url', 'origin']);
  if (
    !/^(?:https:\/\/github\.com\/|git@github\.com:)eventbalancer\/agent-quorum(?:\.git)?$/u.test(
      remote,
    )
  ) {
    throw new DeliveryError('delivery-repository-mismatch', true);
  }
  const revision = await command(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/u.test(revision)) {
    throw new DeliveryError('implementation-revision-unavailable', true);
  }
  const planningFile = path.resolve(
    path.dirname(path.resolve(input.profileFile)),
    profile.planning.configFile,
  );
  const planningJson = readFileSync(planningFile, 'utf8');
  const planningValue: unknown = JSON.parse(planningJson);
  resolveConfig({
    home: path.join(ledger.directory, 'empty-home'),
    env: {},
    overrides: { config: responseObject(planningValue) },
  });
  const runtimeParent =
    host.runtimeParent ?? path.join(os.homedir(), '.agent-quorum', 'delivery', 'runtimes');
  const runtimeRoot = path.join(runtimeParent, `${revision.slice(0, 12)}-${randomUUID()}`);
  if (runtimeRoot === root || runtimeRoot.startsWith(`${root}${path.sep}`)) {
    throw new DeliveryError('runtime-must-be-outside-source', true);
  }
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  for (const relative of [
    ...FROZEN_DIRECTORIES.filter((entry) => !['dist', 'node_modules'].includes(entry)),
    ...FROZEN_FILES.filter((entry) => entry !== '.delivery-planning.json'),
  ]) {
    const source = path.join(root, relative);
    if (existsSync(source)) {
      cpSync(source, path.join(runtimeRoot, relative), { recursive: true, verbatimSymlinks: true });
    }
  }
  writeFileSync(path.join(runtimeRoot, '.delivery-planning.json'), planningJson, { mode: 0o600 });
  await checkedRun(
    {
      command: 'pnpm',
      args: ['install', '--offline', '--frozen-lockfile', '--ignore-scripts'],
      cwd: runtimeRoot,
      execution,
    },
    run,
  );
  await checkedRun({ command: 'pnpm', args: ['run', 'build'], cwd: runtimeRoot, execution }, run);
  if (!existsSync(path.join(runtimeRoot, 'dist/delivery/main.js'))) {
    throw new DeliveryError('frozen-controller-build-unavailable', true);
  }
  const frozenProfile: DeliveryProfile = {
    ...profile,
    planning: {
      ...profile.planning,
      configFile: path.join(runtimeRoot, '.delivery-planning.json'),
    },
  };
  const transport =
    host.transport ?? createGhTransport({ cwd: root, timeoutMs: profile.bounds.commandTimeoutMs });
  const evidence = await githubActivationEvidence(root, transport);
  const mcp = await readMcpConfiguration(
    root,
    execution,
    run,
    host.readConfiguration ?? readCodexConfigurationDigest,
  );
  const mandate: Mandate = {
    version: 1,
    repository: DELIVERY_REPOSITORY,
    base: 'main',
    sourceRoot: root,
    runtimeRoot,
    controllerDigest: digest(frozenRuntimeEntries(runtimeRoot)),
    profileDigest: digest(frozenProfile),
    policyVersion: POLICY_VERSION,
    profile: frozenProfile,
    requiredChecks: evidence.checks,
    actor: evidence.actor,
    mcpServerNames: mcp.names,
    mcpConfigurationDigest: mcp.configurationDigest,
    workflowTreeSha: evidence.workflowTreeSha,
    issueLimitMs: ISSUE_LIMIT_MS,
    dailyLimitMs: DAY_LIMIT_MS,
    repairLimit: REPAIR_LIMIT,
    timezone: 'Europe/Moscow',
    operations: [...DELIVERY_OPERATIONS],
    releases: false,
    createdAt: new Date((host.now ?? Date.now)()).toISOString(),
  };
  if (
    (await command(['status', '--porcelain', '--untracked-files=all'])) !== '' ||
    (await command(['rev-parse', 'HEAD'])) !== revision
  ) {
    throw new DeliveryError('implementation-changed-during-preparation', true);
  }
  const mandateDigest = ledger.prepare(mandate);
  ledger.set('implementation-revision', revision);
  ledger.set('activation-blockers', evidence.blockers);
  if (evidence.blockers.length > 0) {
    ledger.changeMode('blocked', 'activation-prerequisites-unavailable');
  }
  return { digest: mandateDigest, mandate, blockers: evidence.blockers };
}

export async function activateDelivery(
  ledger: DeliveryLedger,
  authorizedDigest: string,
  host: DeliveryActivationHost = {},
): Promise<void> {
  if (
    authorizedDigest !== digest(ledger.mandate()) ||
    !['prepared', 'blocked'].includes(ledger.mode())
  ) {
    throw new DeliveryError('activation-digest-or-mode-mismatch', true);
  }
  try {
    await activatePreparedDelivery(ledger, authorizedDigest, host);
  } catch (error) {
    const code = error instanceof DeliveryError ? error.code : 'activation-evidence-unavailable';
    ledger.set('activation-blockers', [code]);
    if (!['revoked', 'stopped', 'paused', 'pausing'].includes(ledger.mode())) {
      ledger.changeMode('blocked', code);
    }
    throw error;
  }
}

async function activatePreparedDelivery(
  ledger: DeliveryLedger,
  authorizedDigest: string,
  host: DeliveryActivationHost = {},
): Promise<void> {
  const mandate = ledger.mandate();
  if (authorizedDigest !== digest(mandate) || !['prepared', 'blocked'].includes(ledger.mode())) {
    throw new DeliveryError('activation-digest-or-mode-mismatch', true);
  }
  verifyFrozenRuntime(mandate);
  const evidence = await githubActivationEvidence(
    mandate.sourceRoot,
    host.transport ?? createGhTransport({ cwd: mandate.sourceRoot }),
    mandate.requiredChecks,
  );
  const blockers = [...evidence.blockers];
  if (
    evidence.workflowTreeSha !== mandate.workflowTreeSha ||
    evidence.actor !== mandate.actor ||
    digest(evidence.checks) !== digest(mandate.requiredChecks)
  ) {
    blockers.push('GitHub actor or required checks changed; prepare a new mandate.');
  }
  ledger.set('activation-blockers', blockers);
  if (blockers.length > 0) {
    throw new DeliveryError('activation-prerequisites-unavailable', true);
  }
  const release = acquireRepositoryOwner(currentProcessOwner());
  try {
    const code = await (
      host.probe ??
      ((current, authorized) =>
        runGuardianStep(current, {
          preflightDigest: authorized,
          ...(host.signal === undefined ? {} : { signal: host.signal }),
        }))
    )(ledger, authorizedDigest);
    const receipt = ledger.get<{ digest: string; passed: boolean }>('activation-probes');
    if (code !== 0 || receipt?.digest !== authorizedDigest || !receipt.passed) {
      throw new DeliveryError('activation-probes-failed', true);
    }
    try {
      await (host.install ?? installDeliveryLaunchAgent)(mandate, ledger.directory, () => {
        verifyFrozenRuntime(mandate);
        if (
          digest(ledger.mandate()) !== authorizedDigest ||
          !['prepared', 'blocked'].includes(ledger.mode()) ||
          host.signal?.aborted === true
        ) {
          throw new DeliveryError('preflight-authorization-changed', true);
        }
        ledger.changeMode('active', 'explicit-activation');
        release();
      });
    } catch {
      throw new DeliveryError('guardian-installation-failed', true);
    }
  } finally {
    release();
  }
}

export async function installDeliveryLaunchAgent(
  mandate: Mandate,
  stateDirectory: string,
  beforeBootstrap: () => void | Promise<void>,
  host: LaunchAgentHost = {},
): Promise<void> {
  const uid = host.uid ?? process.getuid?.();
  if ((host.platform ?? process.platform) !== 'darwin' || uid === undefined) {
    throw new DeliveryError('launchagent-unavailable', true);
  }
  const directory = host.directory ?? path.join(os.homedir(), 'Library', 'LaunchAgents');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'com.agent-quorum.delivery.plist');
  if (existsSync(file) && !readFileSync(file, 'utf8').includes(stateDirectory)) {
    throw new DeliveryError('existing-launchagent-target-mismatch', true);
  }
  writeFileSync(file, launchAgentDocument(mandate, stateDirectory), { mode: 0o600 });
  const target = `gui/${uid}`;
  const service = `${target}/com.agent-quorum.delivery`;
  const run = host.run ?? runDeliveryCommand;
  const execution = { deadlineEpochMs: Date.now() + mandate.profile.bounds.commandTimeoutMs };
  const loaded = await run({
    command: 'launchctl',
    args: ['print', service],
    cwd: stateDirectory,
    execution,
  });
  if (loaded.exitCode === 0) {
    await checkedRun(
      {
        command: 'launchctl',
        args: ['bootout', service],
        cwd: stateDirectory,
        execution,
      },
      run,
    );
  }
  await beforeBootstrap();
  await checkedRun(
    { command: 'launchctl', args: ['bootstrap', target, file], cwd: stateDirectory, execution },
    run,
  );
  const registered = await checkedRun(
    { command: 'launchctl', args: ['print', service], cwd: stateDirectory, execution },
    run,
  );
  const argumentsBlock = /^[ \t]*arguments = \{\r?\n([\s\S]*?)\r?\n[ \t]*\}/m.exec(registered);
  const args = argumentsBlock?.[1]?.split(/\r?\n/).map((line) => line.trim());
  const workingDirectory = registered
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('working directory = '));
  if (
    digest(args ?? []) !== digest(deliveryLaunchArguments(mandate, stateDirectory)) ||
    workingDirectory !== `working directory = ${mandate.runtimeRoot}`
  ) {
    throw new DeliveryError('launchagent-registration-mismatch', true);
  }
}

export async function runActivationProbes(
  ledger: DeliveryLedger,
  authorizedDigest: string,
  execution: ExecutionControl,
  confinement: (mandate: Mandate, execution: ExecutionControl) => Promise<boolean>,
): Promise<void> {
  const mandate = ledger.mandate();
  if (digest(mandate) !== authorizedDigest || !['prepared', 'blocked'].includes(ledger.mode())) {
    throw new DeliveryError('preflight-authorization-changed', true);
  }
  ledger.set('activation-probes', { digest: authorizedDigest, passed: false });
  verifyFrozenRuntime(mandate);
  if (mandate.profile.executor === undefined) {
    throw new DeliveryError('private-fixture-network-executor-required', true);
  }
  if (!(await probeDockerExecutor(mandate, execution))) {
    throw new DeliveryError('candidate-executor-confinement-probe-failed', true);
  }
  if (!(await confinement(mandate, execution))) {
    throw new DeliveryError('effective-confinement-probe-failed', true);
  }
  const config = resolveConfig({
    home: path.join(mandate.runtimeRoot, '.empty-home'),
    env: {},
    overrides: {
      cli: { quality: mandate.profile.planning.quality },
      config: JSON.parse(readFileSync(mandate.profile.planning.configFile, 'utf8')) as Record<
        string,
        unknown
      >,
    },
  }).config;
  const profiles = planningProbeProfiles([
    ...Object.values(config.matrix),
    ...smokeProbeProfiles(mandate.runtimeRoot),
  ]);
  const binaries = resolveRunnerBinaries();
  const runners = new Set([
    'codex',
    ...Object.values(config.matrix).map((entry) => entry.runner),
  ] as const);
  for (const runner of runners) {
    const meta = RUNNER_META[runner];
    const result = await runDeliveryCommand({
      command: binaries[runner],
      args: meta.auth.args,
      cwd: mandate.runtimeRoot,
      execution: { ...execution, env: supervisedCodexEnvironment(execution.env ?? process.env) },
    });
    if (result.exitCode !== 0) {
      throw new DeliveryError('supported-provider-authentication-unavailable', true);
    }
  }
  const probeDirectory = mkdtempSync(path.join(os.tmpdir(), 'aq-delivery-provider-probe-'));
  const scratch = Scratch.create('delivery-schema-probes');
  try {
    const schemaFile = path.join(scratch.dir, 'probe.schema.json');
    const skillFile = path.join(scratch.dir, 'probe.md');
    writeFileSync(
      schemaFile,
      JSON.stringify({
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean', const: true } },
      }),
    );
    writeFileSync(
      skillFile,
      'Return only the schema object with ok true. This is a capability probe; no repository work or tools are authorized.',
    );
    for (const [index, profile] of profiles.entries()) {
      const outputFile = path.join(scratch.dir, `role-${index}.json`);
      const boundedExecution = {
        ...execution,
        deadlineEpochMs: Math.min(
          execution.deadlineEpochMs ?? Infinity,
          Date.now() + mandate.profile.bounds.providerTimeoutMs,
        ),
      };
      const status = await providerRun(
        {
          scratch,
          projectRoot: probeDirectory,
          retry: {
            retryCount: mandate.profile.bounds.providerRetries,
            retryDelaySeconds: mandate.profile.bounds.providerRetryDelayMs / 1000,
          },
          streamKnobs: resolveWatchdogKnobs(config).stream,
          matrix: config.matrix,
          sessionMode: 0,
          creatorSessionFile: '',
          markdownSchemaPath: schemaFile,
          binaries,
          livenessHeartbeatSeconds: 0,
          claudeThinkingEvery: 0,
          execution: boundedExecution,
        },
        {
          task: `activation-role-${index}`,
          ...profile,
          mode: 'json',
          outFile: outputFile,
          schemaFile,
          skillFile,
          promptText: 'Return {"ok":true}.',
          cwd: probeDirectory,
          execution: boundedExecution,
          ...supervisedCodexPolicy(
            probeDirectory,
            [mandate.runtimeRoot, path.dirname(mandate.runtimeRoot)],
            mandate.mcpServerNames,
          ),
        },
      );
      if (
        status !== 0 ||
        digest(JSON.parse(readFileSync(outputFile, 'utf8')) as unknown) !== digest({ ok: true })
      ) {
        throw new DeliveryError('planning-role-schema-probe-failed', true);
      }
    }
  } finally {
    scratch.sweep();
  }
  const worker = new CodexDeliveryWorker(mandate);
  const result = await worker.work({
    issue: 0,
    cwd: probeDirectory,
    prompt:
      'Activation schema probe only. Return action ready, no edits, no findings, no dependencies, and rationale activation schema probe. No repository work is authorized.',
    outputFile: path.join(probeDirectory, 'worker.json'),
    execution,
  });
  const review = await worker.review({
    issue: 0,
    cwd: probeDirectory,
    prompt:
      'Independent activation schema probe only. Return approved true, no findings, no acceptance evidence, no adjacent findings, liveReuseApproved false, and empty interveningDiffDigest. No repository work is authorized.',
    outputFile: path.join(probeDirectory, 'reviewer.json'),
    execution,
  });
  if (
    result.invocationId === review.invocationId ||
    result.result.edits.length > 0 ||
    result.result.action !== 'ready' ||
    !review.result.approved
  ) {
    throw new DeliveryError('independent-review-probe-failed', true);
  }
  let spawnedPid: number | undefined;
  let timeControlTerminated: boolean;
  try {
    const timeControl = await runDeliveryCommand({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: probeDirectory,
      execution: {
        ...execution,
        deadlineEpochMs: Math.min(execution.deadlineEpochMs ?? Infinity, Date.now() + 1500),
        terminateGraceMs: 0,
        onSpawn: async (child) => {
          spawnedPid = child.pid;
          await execution.onSpawn?.(child);
        },
      },
    });
    timeControlTerminated = timeControl.exitCode !== 0;
  } catch (error) {
    if (!(error instanceof ExecutionControlError) || error.reason !== 'deadline') {
      throw error;
    }
    timeControlTerminated = true;
  }
  assertExecutionAllowed(execution);
  if (spawnedPid === undefined || !timeControlTerminated || isAlive(spawnedPid)) {
    throw new DeliveryError('time-control-probe-failed', true);
  }
  ledger.set('activation-probes', {
    digest: authorizedDigest,
    passed: true,
    workerInvocation: result.invocationId,
    reviewerInvocation: review.invocationId,
    completedAt: new Date().toISOString(),
  });
  ledger.event('activation-probes-passed', { digest: authorizedDigest }, true);
}

export function smokeProbeProfiles(runtimeRoot: string): RoleMatrixEntry[] {
  const root = path.join(runtimeRoot, 'benchmarks/planning');
  const manifest = responseObject(
    JSON.parse(readFileSync(path.join(root, 'smoke-manifest.json'), 'utf8')) as unknown,
  );
  if (typeof manifest.providerConfig !== 'string' || !Array.isArray(manifest.sentinels)) {
    throw new DeliveryError('frozen-smoke-profiles-unavailable', true);
  }
  const configFile = realpathSync(path.resolve(root, manifest.providerConfig));
  if (!configFile.startsWith(`${realpathSync(root)}${path.sep}`)) {
    throw new DeliveryError('frozen-smoke-profile-path-escapes', true);
  }
  const config = responseObject(JSON.parse(readFileSync(configFile, 'utf8')) as unknown);
  return planningProbeProfiles(
    manifest.sentinels.flatMap((sentinel: unknown) => {
      const value = responseObject(sentinel);
      if (
        typeof value.quality !== 'string' ||
        !['quick', 'balanced', 'thorough'].includes(value.quality)
      ) {
        throw new DeliveryError('frozen-smoke-quality-unavailable', true);
      }
      return Object.values(
        resolveConfig({
          home: path.join(runtimeRoot, '.empty-home'),
          env: {},
          overrides: { config, cli: { quality: value.quality } },
        }).config.matrix,
      );
    }),
  );
}

export function planningProbeProfiles(entries: readonly RoleMatrixEntry[]): RoleMatrixEntry[] {
  if (entries.some((entry) => entry.runner !== 'codex')) {
    throw new DeliveryError('planning-provider-confinement-unsupported', true);
  }
  return [...new Map(entries.map((entry) => [digest(entry), entry])).values()];
}

export async function readMcpConfiguration(
  root: string,
  execution: ExecutionControl,
  run: (input: CommandInput) => Promise<CommandResult> = runDeliveryCommand,
  readConfiguration: typeof readCodexConfigurationDigest = readCodexConfigurationDigest,
): Promise<McpConfiguration> {
  const policy = supervisedCodexInspectionPolicy(root);
  const result = await checkedRun(
    {
      command: 'codex',
      args: [...policy.codexConfig.flatMap((entry) => ['-c', entry]), 'mcp', 'list', '--json'],
      cwd: root,
      execution: { ...execution, env: supervisedCodexEnvironment(execution.env ?? process.env) },
    },
    run,
  );
  const values: unknown = JSON.parse(result);
  if (!Array.isArray(values)) {
    throw new DeliveryError('mcp-configuration-unavailable', true);
  }
  const entries = values.map((value: unknown) => responseObject(value));
  if (
    entries.some((entry) => typeof entry.name !== 'string' || typeof entry.enabled !== 'boolean')
  ) {
    throw new DeliveryError('mcp-configuration-unavailable', true);
  }
  const sorted = entries.sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const effectiveConfiguration = await readConfiguration(root, execution, policy.codexConfig);
  return {
    names: sorted.map((entry) => String(entry.name)),
    configurationDigest: digest(
      canonicalConfiguration({ servers: sorted, effectiveConfiguration }),
    ),
  };
}

export async function verifyMcpConfiguration(
  mandate: Mandate,
  execution: ExecutionControl = {
    deadlineEpochMs: Date.now() + Math.min(4000, mandate.profile.bounds.commandTimeoutMs),
  },
): Promise<void> {
  const current = await readMcpConfiguration(mandate.sourceRoot, execution);
  if (
    current.configurationDigest !== mandate.mcpConfigurationDigest ||
    digest(current.names) !== digest(mandate.mcpServerNames)
  ) {
    throw new DeliveryError('managed-tool-configuration-changed', true);
  }
}

export async function verifyProviderConfinement(
  mandate: Mandate,
  execution: ExecutionControl,
): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false;
  }
  await verifyMcpConfiguration(mandate, execution);
  const probeRoot = mkdtempSync(path.join(os.tmpdir(), 'aq-delivery-confinement-'));
  const timeoutMs = Math.min(
    CONFINEMENT_PROBE_TIMEOUT_MS,
    mandate.profile.bounds.commandTimeoutMs,
    execution.attemptTimeoutMs ?? Infinity,
  );
  const bounded: ExecutionControl = {
    ...execution,
    env: supervisedCodexEnvironment(execution.env ?? process.env),
    attemptTimeoutMs: timeoutMs,
    deadlineEpochMs: Math.min(execution.deadlineEpochMs ?? Infinity, Date.now() + timeoutMs),
  };
  try {
    const candidate = path.join(probeRoot, 'candidate');
    const controls = path.join(probeRoot, 'controls');
    mkdirSync(candidate, { mode: 0o700 });
    mkdirSync(controls, { mode: 0o700 });
    const allowed = path.join(candidate, 'evidence.txt');
    const forbidden = path.join(controls, 'canary.txt');
    writeFileSync(allowed, 'owned evidence');
    writeFileSync(forbidden, 'private canary');
    const forbiddenPaths = [mandate.runtimeRoot, path.dirname(mandate.runtimeRoot)];
    const policy = supervisedCodexInspectionPolicy(
      candidate,
      forbiddenPaths,
      mandate.mcpServerNames,
    );
    const source = path.join(probeRoot, 'confinement.c');
    const binary = path.join(candidate, 'confinement-probe');
    writeFileSync(source, PROVIDER_CONFINEMENT_PROGRAM);
    const compiled = await runDeliveryCommand({
      command: '/usr/bin/cc',
      args: ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', binary],
      cwd: candidate,
      execution: bounded,
    });
    const metadata = lstatSync(binary, { throwIfNoEntry: false });
    const isExecutable = metadata?.isFile() === true && (metadata.mode & 0o111) !== 0;
    if (compiled.exitCode !== 0 || !isExecutable) {
      throw new DeliveryError('native-confinement-compiler-unavailable', true);
    }
    const result = await runDeliveryCommand({
      command: 'codex',
      args: codexSandboxProbeArgs(policy, [
        binary,
        allowed,
        forbidden,
        path.join(candidate, 'write-probe'),
      ]),
      cwd: candidate,
      execution: bounded,
    });
    if (result.exitCode !== 0) {
      return false;
    }
    const observed = responseObject(JSON.parse(result.stdout) as unknown);
    if (
      !['allowed', 'denied_read', 'denied_write', 'denied_network'].every(
        (key) => observed[key] === true,
      )
    ) {
      return false;
    }
    const emptyCodexHome = path.join(probeRoot, 'empty-codex-home');
    mkdirSync(emptyCodexHome, { mode: 0o700 });
    const isolatedPolicy = supervisedCodexPolicy(candidate, forbiddenPaths, mandate.mcpServerNames);
    for (const configuration of [
      { policy, execution: bounded },
      {
        policy: isolatedPolicy,
        execution: { ...bounded, env: { ...bounded.env, CODEX_HOME: emptyCodexHome } },
      },
    ]) {
      const configured = await runDeliveryCommand({
        command: 'codex',
        args: [
          ...configuration.policy.codexConfig.flatMap((entry) => ['-c', entry]),
          'mcp',
          'list',
          '--json',
        ],
        cwd: candidate,
        execution: configuration.execution,
      });
      if (configured.exitCode !== 0) {
        return false;
      }
      const servers: unknown = JSON.parse(configured.stdout);
      if (
        !Array.isArray(servers) ||
        !servers.every((server: unknown) => responseObject(server).enabled === false)
      ) {
        return false;
      }
    }
    return true;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}
