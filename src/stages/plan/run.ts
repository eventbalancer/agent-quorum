import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { packageRoot, projectRoot } from '../../runtime/env.js';
import { fileLineCount } from '../../runtime/files.js';
import { installSignalTeardown, ownPgid } from '../../runtime/exec.js';
import { HaltError } from '../../runtime/halt.js';
import { disableRunLogSink, enableRunLogSink, err, log } from '../../runtime/log.js';
import { resolveArtifactRoots } from '../../runtime/paths.js';
import { procStartToken } from '../../runtime/proc.js';
import { Scratch } from '../../runtime/scratch.js';
import {
  cleanupRunRegistry,
  nowUtcStamp,
  writeRunMetadata,
  type RunMetadata,
} from '../../core/artifacts.js';
import {
  deriveRunName,
  finalizeRunRecord,
  pruneRuns,
  readRunRecords,
  runNameFromWorkdir,
  writeRunRecord,
  type RunState,
} from '../../core/run-store.js';
import { runClarificationGate } from './clarify.js';
import {
  resolveConfig,
  resolveRoleConfig,
  resolveRolePermissions,
  resolveRunSettings,
  runnersInUse,
  type CliSettings,
  type ResolveOverrides,
  type Secrets,
} from '../../core/config.js';
import { isJsonObject, type JsonValue } from '../../core/json.js';
import { handoffDir } from '../../core/store.js';
import { runCreatorCreate } from './creator.js';
import { qualityMatrix } from '../../core/quality.js';
import { runFixPass } from './fix-pass.js';
import { markOperatorInterventionsMigrated } from './interventions.js';
import { resolveWatchdogKnobs } from '../../core/knobs.js';
import { resolveRunnerBinaries } from '../../providers/registry.js';
import { runIterationLoop } from './loop.js';
import { preflightRunners } from './preflight.js';
import {
  emitPlanPackage,
  evaluateSplitDecision,
  parsePlanStructure,
  SPLIT_DECISION_FILE,
  validatePlanPackage,
  type PackageHealth,
  type SplitDecision,
} from './plan-package.js';
import {
  planDocumentShapeHealth,
  planHasTitleHeading,
  type PlanShapeHealth,
} from './plan-shape.js';
import { prepareResume } from './resume.js';
import { skillPaths, type RunContext } from '../../core/run-context.js';
import { buildRunReport, writeSummary, type RunReport } from './summary.js';
import {
  telegramNotifyCompletion,
  type TelegramCompletionNotification,
  type TelegramRuntime,
} from '../../channels/telegram/index.js';
import { runTranslatePass } from './translate-pass.js';
import {
  EMPTY_FINDINGS_COUNTS,
  readFindingsCounts,
  validateFinalPlan,
  type FindingsCounts,
} from './validate-plan.js';
import type { RunMode, RunOverrides } from '../../types.js';

export const RUN_USAGE =
  'usage: agent-quorum plan [--iters N] [--quality {quick,balanced,thorough}] [--no-fix] [--locale LOCALE] [--no-translate] <plan.md>\n' +
  '       agent-quorum plan [--iters N] [--quality {quick,balanced,thorough}] [--no-fix] [--locale LOCALE] [--no-translate] --prompt <prompt.md>\n';

function usage(): never {
  process.stderr.write(RUN_USAGE);
  throw new HaltError('usage', 1, true);
}

export interface ParsedRunArgs {
  mode: RunMode;
  inputPath: string;
  cli: CliSettings;
}

export function parseRunArgs(args: readonly string[]): ParsedRunArgs {
  let mode: RunMode = 'plan';
  let inputPath = '';
  const cli: CliSettings = {};

  let i = 0;
  const usageError = (message: string): never => {
    process.stderr.write(`${message}\n`);
    throw new HaltError(message, 1, true);
  };
  parse: while (i < args.length) {
    const arg = args[i] ?? '';
    switch (true) {
      case arg === '--prompt': {
        mode = 'prompt';
        const value = args[i + 1] ?? '';
        if (value === '') {
          usage();
        }
        inputPath = value;
        i += 2;
        break;
      }
      case arg === '--iters' || arg === '--max-iters': {
        const value = args[i + 1] ?? '';
        if (!/^[0-9]+$/.test(value)) {
          usageError('--iters expects a positive integer');
        }
        cli.maxIters = value;
        i += 2;
        break;
      }
      case arg.startsWith('--iters=') || arg.startsWith('--max-iters='): {
        const value = arg.slice(arg.indexOf('=') + 1);
        if (!/^[0-9]+$/.test(value)) {
          usageError('--iters expects a positive integer');
        }
        cli.maxIters = value;
        i += 1;
        break;
      }
      case arg === '--fix':
        cli.fix = '1';
        i += 1;
        break;
      case arg === '--no-fix':
        cli.fix = '0';
        i += 1;
        break;
      case arg === '--translate':
        cli.translate = '1';
        i += 1;
        break;
      case arg === '--no-translate':
        cli.translate = '0';
        i += 1;
        break;
      case arg === '--locale': {
        const value = args[i + 1] ?? '';
        if (value === '') {
          usageError('--locale expects a locale tag');
        }
        cli.locale = value;
        i += 2;
        break;
      }
      case arg.startsWith('--locale='):
        cli.locale = arg.slice('--locale='.length);
        if (cli.locale === '') {
          usageError('--locale expects a locale tag');
        }
        i += 1;
        break;
      case arg === '--quality': {
        const value = args[i + 1] ?? '';
        if (value === '') {
          usageError('--quality expects quick, balanced, or thorough');
        }
        cli.quality = value;
        i += 2;
        break;
      }
      case arg.startsWith('--quality='):
        cli.quality = arg.slice('--quality='.length);
        i += 1;
        break;
      case arg === '-h' || arg === '--help':
        process.stdout.write(RUN_USAGE);
        throw new HaltError('help', 0, true);
      case arg === '--':
        break parse;
      case arg.startsWith('-'):
        process.stderr.write(`unknown flag: ${arg}\n`);
        usage();
        break;
      default:
        if (inputPath !== '') {
          process.stderr.write(`unexpected arg: ${arg}\n`);
          usage();
        }
        inputPath = arg;
        i += 1;
        break;
    }
  }

  if (inputPath === '') {
    usage();
  }
  if (!existsSync(inputPath) || !statSync(inputPath).isFile()) {
    process.stderr.write(`file not found: ${inputPath}\n`);
    throw new HaltError(`file not found: ${inputPath}`, 1, true);
  }
  return { mode, inputPath, cli };
}

function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function absolutePath(file: string): string {
  return path.join(canonicalDir(path.dirname(path.resolve(file))), path.basename(file));
}

function filesEqual(a: string, b: string): boolean {
  if (!existsSync(a) || !existsSync(b)) {
    return false;
  }
  return readFileSync(a).equals(readFileSync(b));
}

export interface RunOutcome {
  exitCode: number;
  report?: RunReport;
}

type CompletionNotificationDetails = Omit<TelegramCompletionNotification, 'inputPath' | 'workDir'>;
type CompletionNotifier = (details: CompletionNotificationDetails) => Promise<void>;

function createCompletionNotifier(
  inputPath: string,
  workDir: string,
  runtime: TelegramRuntime,
): CompletionNotifier {
  let didNotifyCompletion = false;
  return async (details) => {
    if (didNotifyCompletion) {
      return;
    }
    didNotifyCompletion = true;
    await telegramNotifyCompletion(runtime, { inputPath, workDir, ...details });
  };
}

function errorExitCode(error: unknown): number {
  if (error instanceof HaltError) {
    return error.exitCode;
  }
  return 1;
}

function errorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

interface SplitPackageResult {
  readonly splitDecision: SplitDecision;
  readonly packagePhaseCount: number;
  readonly packageDir?: string;
  readonly packageHealth?: PackageHealth;
}

type FinalStatus = 'clean' | 'needs-review' | 'blocked';

interface ResolveFinalStatusParams {
  readonly finalTitle: 0 | 1;
  readonly shape: PlanShapeHealth;
  readonly findings: FindingsCounts;
  readonly packageHealth?: PackageHealth;
}

interface FinalStatusResult {
  readonly status: FinalStatus;
  readonly reason: string;
}

function writeSplitDecisionFile(work: string, splitDecision: SplitDecision): void {
  writeFileSync(
    path.join(work, SPLIT_DECISION_FILE),
    `${JSON.stringify(
      {
        decision: splitDecision.split ? 'split' : 'no-split',
        rationale: splitDecision.rationale,
        signals: splitDecision.signals,
      },
      null,
      2,
    )}\n`,
  );
}

function emptyPackageHealth(): PackageHealth {
  return {
    ok: false,
    emptyWorkPlan: true,
    missingFiles: 0,
    missingHeadings: 0,
    brokenCrossRefs: 0,
    forbiddenShell: 0,
    references: EMPTY_FINDINGS_COUNTS,
  };
}

function emitAndValidateSplitPackage(ctx: RunContext, finalPlan: string): SplitPackageResult {
  const structure = parsePlanStructure(finalPlan);
  const splitDecision = evaluateSplitDecision(structure, {
    mode: ctx.split.mode,
    minPhases: ctx.split.minPhases,
    maxPlanLines: ctx.maxPlanLines,
  });
  writeSplitDecisionFile(ctx.work, splitDecision);

  if (!splitDecision.split) {
    log(`split: no package (${splitDecision.rationale})`);
    return { splitDecision, packagePhaseCount: 0 };
  }

  const emitted = emitPlanPackage(ctx.work, finalPlan, structure, splitDecision);
  if (emitted.kind === 'empty-work-plan') {
    err('split: forced split over an empty/absent Work Plan — no package written');
    return {
      splitDecision,
      packagePhaseCount: 0,
      packageHealth: emptyPackageHealth(),
    };
  }

  const packagePhaseCount = emitted.paths.phases.length;
  const packageHealth = validatePlanPackage(ctx.provider.projectRoot, emitted.paths.dir);
  log(`split: emitted plan.package/ with ${packagePhaseCount} phase doc(s)`);
  return {
    splitDecision,
    packagePhaseCount,
    packageDir: emitted.paths.dir,
    packageHealth,
  };
}

function isPackageBroken(packageHealth: PackageHealth): boolean {
  return (
    packageHealth.emptyWorkPlan ||
    packageHealth.missingFiles > 0 ||
    packageHealth.missingHeadings > 0 ||
    packageHealth.brokenCrossRefs > 0 ||
    packageHealth.forbiddenShell > 0
  );
}

function hasPackageReferencesNeedingReview(packageHealth: PackageHealth): boolean {
  return (
    packageHealth.references.stale > 0 ||
    packageHealth.references.ambiguous > 0 ||
    packageHealth.references.unresolved > 0
  );
}

function resolveFinalStatus({
  finalTitle,
  shape,
  findings,
  packageHealth,
}: ResolveFinalStatusParams): FinalStatusResult {
  if (finalTitle !== 1 || shape.missing !== 0 || shape.graph !== 1 || shape.frontmatter !== 1) {
    return {
      status: 'blocked',
      reason: `plan shape broken (title=${finalTitle} missing_sections=${shape.missing} impact_graph_mermaid=${shape.graph} frontmatter=${shape.frontmatter})`,
    };
  }

  if (packageHealth !== undefined && isPackageBroken(packageHealth)) {
    return {
      status: 'blocked',
      reason: packageHealth.emptyWorkPlan
        ? 'plan.package not emitted: forced split over an empty/absent Work Plan'
        : `plan.package broken (missing_files=${packageHealth.missingFiles} missing_headings=${packageHealth.missingHeadings} broken_cross_refs=${packageHealth.brokenCrossRefs} forbidden_shell=${packageHealth.forbiddenShell})`,
    };
  }

  if (findings.stale > 0) {
    return {
      status: 'needs-review',
      reason: `${findings.stale} stale line reference(s) remain after fix-pass`,
    };
  }

  if (findings.ambiguous > 0 || findings.unresolved > 0) {
    return {
      status: 'needs-review',
      reason: `${findings.ambiguous} ambiguous + ${findings.unresolved} unresolved reference(s) (may be generic names or future files)`,
    };
  }

  if (packageHealth !== undefined && hasPackageReferencesNeedingReview(packageHealth)) {
    return {
      status: 'needs-review',
      reason: `plan.package references need review (stale=${packageHealth.references.stale} ambiguous=${packageHealth.references.ambiguous} unresolved=${packageHealth.references.unresolved})`,
    };
  }

  return { status: 'clean', reason: '' };
}

// A malformed forwarded value fails the run before any provider work rather than being dropped.
function readForwardedOverrides(env: NodeJS.ProcessEnv, home: string): ResolveOverrides {
  const overrides: ResolveOverrides = {};
  const configJson = env.AGENT_QUORUM_CONFIG_OVERRIDE_JSON;
  if (configJson !== undefined && configJson !== '') {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(configJson) as JsonValue;
    } catch {
      throw new HaltError('AGENT_QUORUM_CONFIG_OVERRIDE_JSON is not valid JSON', 1);
    }
    if (!isJsonObject(parsed)) {
      throw new HaltError('AGENT_QUORUM_CONFIG_OVERRIDE_JSON must be a JSON object', 1);
    }
    overrides.config = parsed;
  }
  const secretFile = env.AGENT_QUORUM_SECRETS_OVERRIDE_FILE;
  if (secretFile !== undefined && secretFile !== '') {
    overrides.secrets = readSecretHandoff(secretFile, home);
  }
  return overrides;
}

// Confirm the path resolves to a regular file strictly inside <home>/handoff/ before any
// unlink, so a hostile env var cannot turn the reader into an arbitrary-file delete.
function readSecretHandoff(filePath: string, home: string): Secrets {
  let dir: string;
  try {
    dir = realpathSync(handoffDir(home));
  } catch {
    throw new HaltError(
      'AGENT_QUORUM_SECRETS_OVERRIDE_FILE set but the store handoff directory does not exist',
      1,
    );
  }
  let resolved: string;
  try {
    resolved = realpathSync(filePath);
  } catch {
    throw new HaltError(
      'AGENT_QUORUM_SECRETS_OVERRIDE_FILE does not resolve to a readable file',
      1,
    );
  }
  if (!resolved.startsWith(dir + path.sep)) {
    throw new HaltError(
      'AGENT_QUORUM_SECRETS_OVERRIDE_FILE must resolve inside the store handoff directory',
      1,
    );
  }
  if (!statSync(resolved).isFile()) {
    throw new HaltError('AGENT_QUORUM_SECRETS_OVERRIDE_FILE must resolve to a regular file', 1);
  }
  const raw = readFileSync(resolved, 'utf8');
  unlinkSync(resolved);
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    throw new HaltError('AGENT_QUORUM_SECRETS_OVERRIDE_FILE is not valid JSON', 1);
  }
  if (!isJsonObject(parsed)) {
    throw new HaltError('AGENT_QUORUM_SECRETS_OVERRIDE_FILE must contain a JSON object', 1);
  }
  const token = parsed.telegramBotToken;
  if (token !== undefined && typeof token !== 'string') {
    throw new HaltError('AGENT_QUORUM_SECRETS_OVERRIDE_FILE telegramBotToken must be a string', 1);
  }
  return token === undefined ? {} : { telegramBotToken: token };
}

export async function runPlanLoopCli(
  args: readonly string[],
  overrides: RunOverrides = {},
): Promise<RunOutcome> {
  const parsed = parseRunArgs(args);

  const { home, runsDir, stateDir } = resolveArtifactRoots(overrides);
  // Typed RunOverrides and the detached child's forwarded env are exclusive in practice;
  // typed input wins if both appear.
  const forwarded = readForwardedOverrides(process.env, home);
  const configOverrides: ResolveOverrides = {
    cli: parsed.cli,
    ...(forwarded.config !== undefined ? { config: forwarded.config } : {}),
    ...(forwarded.secrets !== undefined ? { secrets: forwarded.secrets } : {}),
    ...(overrides.config !== undefined ? { config: overrides.config } : {}),
    ...(overrides.secrets !== undefined ? { secrets: overrides.secrets } : {}),
  };
  const { config: resolved } = resolveConfig({
    overrides: configOverrides,
    env: process.env,
    home,
  });
  const settings = resolveRunSettings(resolved);
  const knobs = resolveWatchdogKnobs(resolved);
  const qualityKnobs = qualityMatrix(settings.quality);

  const plansDir = runsDir;
  const inputPath = absolutePath(parsed.inputPath);
  const base = path.basename(inputPath, '.md');

  let runStateDir = stateDir;
  if (!path.isAbsolute(runStateDir)) {
    runStateDir = path.join(process.cwd(), runStateDir);
  }
  mkdirSync(runStateDir, { recursive: true });
  runStateDir = canonicalDir(runStateDir);

  const explicitWork = overrides.workDir ?? process.env.AGENT_QUORUM_WORK_DIR;
  const forwardedName = process.env.AGENT_QUORUM_RUN_NAME;
  const explicitName =
    forwardedName !== undefined && forwardedName !== '' ? forwardedName : undefined;
  let work: string;
  let name: string;
  if (explicitWork !== undefined && explicitWork !== '') {
    work = path.isAbsolute(explicitWork) ? explicitWork : path.join(process.cwd(), explicitWork);
    name = explicitName ?? runNameFromWorkdir(work);
  } else {
    name = explicitName ?? deriveRunName(readRunRecords(runStateDir), base);
    work = path.join(plansDir, `loop-${name}`);
  }
  mkdirSync(work, { recursive: true });
  work = canonicalDir(work);

  const logPath = path.join(work, 'run.log');
  const runMetaFile = path.join(work, 'run.meta.tsv');
  const runRegistryFile = path.join(runStateDir, `${process.pid}.tsv`);
  const notifyCompletion = createCompletionNotifier(inputPath, work, resolved.telegram);

  const pgid = ownPgid();
  const startToken = procStartToken(process.pid) ?? '';
  const forwardedRunId = process.env.AGENT_QUORUM_RUN_ID;
  const startedAt = nowUtcStamp();
  let runId = '';
  const finalizeRun = (state: RunState, exitCode: number, finalStatus?: string): void => {
    if (runId === '') {
      return;
    }
    finalizeRunRecord(runStateDir, runId, {
      state,
      exitCode,
      endedAt: nowUtcStamp(),
      ...(finalStatus !== undefined ? { finalStatus } : {}),
    });
  };

  try {
    if (process.env.AGENT_QUORUM_STDIO_IS_RUNLOG !== '1') {
      enableRunLogSink(logPath);
    }
    runId = writeRunRecord(
      runStateDir,
      {
        name,
        pid: process.pid,
        pgid,
        procStartToken: startToken,
        mode: parsed.mode,
        inputPath,
        workDir: work,
        logPath,
        plansDir,
        startedAt,
        quality: settings.quality,
        state: 'running',
      },
      forwardedRunId !== undefined && forwardedRunId !== '' ? { fixedRunId: forwardedRunId } : {},
    ).runId;
    log(`run ${runId} (${name})`);
    try {
      pruneRuns(runStateDir, {}, resolved.retention);
    } catch {
      /* best-effort retention; never block a run on prune */
    }

    const matrix = resolveRoleConfig(resolved);
    const permissions = resolveRolePermissions(resolved);

    const metadata: RunMetadata = {
      pid: process.pid,
      pgid,
      mode: parsed.mode,
      inputPath,
      workDir: work,
      plansDir,
      startedAt,
      quality: settings.quality,
      sessionMode: String(qualityKnobs.sessionMode),
      creatorOneShot: String(qualityKnobs.creatorOneShot),
      previousCritiques: qualityKnobs.previousCritiques,
      topology: qualityKnobs.topology,
      maxIters: settings.maxIters,
      fixPass: String(settings.fixPass),
      diffThreshold: settings.diffThreshold,
      creator: {
        runner: matrix.creator.runner,
        model: matrix.creator.model,
        reasoning: matrix.creator.reasoning,
        createTools: permissions.creator.createTools,
        createDisallowedTools: permissions.creator.createDisallowedTools,
        updateTools: permissions.creator.updateTools,
        updateDisallowedTools: permissions.creator.updateDisallowedTools,
      },
      critic: {
        runner: matrix.critic.runner,
        model: matrix.critic.model,
        reasoning: matrix.critic.reasoning,
        tools: permissions.critic.tools,
        disallowedTools: permissions.critic.disallowedTools,
      },
      fixer: {
        runner: matrix.fixer.runner,
        model: matrix.fixer.model,
        reasoning: matrix.fixer.reasoning,
        tools: permissions.fixer.tools,
        disallowedTools: permissions.fixer.disallowedTools,
      },
      reviewer: {
        runner: matrix.reviewer.runner,
        model: matrix.reviewer.model,
        reasoning: matrix.reviewer.reasoning,
        tools: permissions.reviewer.tools,
        disallowedTools: permissions.reviewer.disallowedTools,
      },
      runId,
      name,
    };
    writeRunMetadata(runMetaFile, runRegistryFile, metadata);

    const skills = skillPaths(packageRoot());
    for (const skillFile of [
      skills.creatorSkill,
      skills.creatorSchema,
      skills.creatorMetaSchema,
      skills.clarifySchema,
      skills.criticSkill,
      skills.criticSchema,
      skills.fixerSkill,
      skills.reviewerSkill,
      skills.reviewerSchema,
      skills.translatorSkill,
      skills.markdownSchema,
    ]) {
      if (!existsSync(skillFile)) {
        process.stderr.write(`missing: ${skillFile}\n`);
        cleanupRunRegistry(runRegistryFile);
        finalizeRun('failed', 1);
        await notifyCompletion({ exitCode: 1, reason: `missing: ${skillFile}` });
        return { exitCode: 1, report: { workDir: work, runId, name } };
      }
    }

    const binaries = { ...resolveRunnerBinaries(), cursor: resolved.providers.cursorBin };
    const required = runnersInUse(matrix, settings.fixPass, settings.translatePass);
    const preflightFailure = preflightRunners(required, binaries);
    if (preflightFailure !== undefined) {
      process.stderr.write(`${preflightFailure.message}\n`);
      cleanupRunRegistry(runRegistryFile);
      finalizeRun('failed', 1);
      await notifyCompletion({ exitCode: 1, reason: preflightFailure.message });
      return { exitCode: 1, report: { workDir: work, runId, name } };
    }

    const scratch = Scratch.create(base);
    const creatorSessionFile = path.join(work, 'creator.session-id');

    const ctx: RunContext = {
      work,
      mode: parsed.mode,
      inputPath,
      plansDir,
      config: resolved,
      settings,
      quality: qualityKnobs,
      permissions,
      skills,
      provider: {
        scratch,
        projectRoot: projectRoot(),
        retry: { retryCount: settings.retryCount, retryDelaySeconds: settings.retryDelaySeconds },
        streamKnobs: knobs.stream,
        matrix,
        sessionMode: qualityKnobs.sessionMode,
        creatorSessionFile,
        markdownSchemaPath: skills.markdownSchema,
        binaries,
        claudePermissionMode: resolved.providers.claudePermissionMode,
        livenessHeartbeatSeconds: resolved.providers.livenessHeartbeatSeconds,
        claudeThinkingEvery: resolved.providers.claudeThinkingEvery,
        ...(resolved.providers.providerDiagnostics
          ? { diagnosticsDir: path.join(work, 'diagnostics') }
          : {}),
      },
      passes: { fixPass: knobs.fixPass, translatePass: knobs.translatePass },
      maxPlanLines: resolved.status.maxPlanLines,
      split: {
        mode: resolved.split.mode,
        minPhases: resolved.split.minPhases,
      },
      lastCritiqueIter: -1,
      resume: { startIter: 0, archivedCount: 0, archiveDir: '' },
    };

    const cleanup = () => {
      cleanupRunRegistry(runRegistryFile);
      scratch.sweep();
    };
    installSignalTeardown(cleanup);

    try {
      if (qualityKnobs.sessionMode === 1) {
        rmSync(creatorSessionFile, { force: true });
      }
      const rejectedLog = path.join(work, 'rejected-log.jsonl');
      if (!existsSync(rejectedLog)) {
        writeFileSync(rejectedLog, '');
      }

      if (parsed.mode === 'prompt') {
        const promptCopy = path.join(work, 'prompt.md');
        if (!filesEqual(inputPath, promptCopy)) {
          copyFileSync(inputPath, promptCopy);
        }
        const v0 = path.join(work, 'plan.v0.md');
        if (!existsSync(v0) || statSync(v0).size === 0) {
          const gate = await runClarificationGate(ctx, inputPath);
          if (!gate.ok) {
            finalizeRun('failed', gate.exitCode);
            await notifyCompletion({ exitCode: gate.exitCode, reason: gate.reason });
            return { exitCode: gate.exitCode, report: { workDir: work, runId, name } };
          }
          log(`creating plan v0 from prompt (${matrix.creator.runner} ${matrix.creator.model})`);
          await runCreatorCreate(ctx, inputPath, v0);
          markOperatorInterventionsMigrated(work, 'creator', 'plan.v0.md');
          log(`  → plan.v0.md created (${fileLineCount(v0)} lines)`);
        }
      } else {
        const v0 = path.join(work, 'plan.v0.md');
        if (!existsSync(v0)) {
          copyFileSync(inputPath, v0);
        }
      }

      let startIter = 0;
      if (process.env.AGENT_QUORUM_RESUME === '1') {
        startIter = prepareResume(ctx);
      }
      if (startIter > 0) {
        log(`resuming from v${startIter}`);
      }

      const { iter } = await runIterationLoop(ctx, startIter);

      const finalPlan = path.join(work, 'plan.final.md');
      validateFinalPlan(ctx.provider.projectRoot, finalPlan);

      if (settings.fixPass === 1) {
        await runFixPass(ctx, finalPlan);
      } else {
        log('fix-pass: disabled via --no-fix');
      }

      const splitPackage = emitAndValidateSplitPackage(ctx, finalPlan);

      const shape = planDocumentShapeHealth(finalPlan);
      const finalTitle = planHasTitleHeading(finalPlan) ? 1 : 0;
      const findings = readFindingsCounts(path.join(work, 'findings.json'));
      const packageHealth = splitPackage.packageHealth;
      const final = resolveFinalStatus({
        finalTitle,
        shape,
        findings,
        ...(packageHealth !== undefined ? { packageHealth } : {}),
      });
      const finalStatus = final.status;
      const finalReason = final.reason;
      if (finalStatus === 'clean') {
        log('FINAL: clean — plan.final.md is structurally complete with no stale references');
      } else {
        err(`FINAL: ${finalStatus} — ${finalReason}`);
      }

      const translateFile = path.join(work, `plan.final.${settings.locale}.md`);
      if (settings.translatePass === 1) {
        await runTranslatePass(ctx, finalPlan, translateFile);
      } else {
        log('translate-pass: disabled (locale=en)');
      }

      writeSummary(ctx, {
        iter,
        localizedFinalFile: translateFile,
        finalStale: findings.stale,
        finalAmbiguous: findings.ambiguous,
        finalUnresolved: findings.unresolved,
        finalStatus,
        finalReason,
        splitDecision: splitPackage.splitDecision.split ? 'split' : 'no-split',
        splitRationale: splitPackage.splitDecision.rationale,
        packagePhaseCount: splitPackage.packagePhaseCount,
        ...(splitPackage.packageDir !== undefined ? { packageDir: splitPackage.packageDir } : {}),
        ...(packageHealth !== undefined ? { packageHealth } : {}),
      });

      log(`done. summary: ${path.join(work, 'summary.md')}`);
      const report = { ...buildRunReport(ctx, iter), runId, name };
      const exitCode = finalStatus === 'blocked' ? 6 : 0;
      finalizeRun(finalStatus === 'blocked' ? 'blocked' : 'finished', exitCode, finalStatus);
      await notifyCompletion({
        exitCode,
        status: finalStatus,
        reason: finalReason,
        iterations: iter,
        ...(report.summaryPath !== undefined ? { summaryPath: report.summaryPath } : {}),
      });
      return { exitCode, report };
    } finally {
      cleanup();
    }
  } catch (error) {
    finalizeRun('failed', errorExitCode(error));
    await notifyCompletion({ exitCode: errorExitCode(error), reason: errorReason(error) });
    throw error;
  } finally {
    disableRunLogSink();
  }
}
