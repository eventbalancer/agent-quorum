import { existsSync } from 'node:fs';
import { HaltError } from './runtime/halt.js';
import { resolveArtifactRoots } from './runtime/paths.js';
import { runInterveneCli } from './cli/intervene.js';
import { runLaunchCli } from './cli/launch.js';
import { runPlanLoopCli, type RunOutcome } from './stages/plan/run.js';
import { runStatusCli } from './cli/status.js';
import {
  parseSelector,
  resolveSelector,
  isRunRecord,
  resolveLogPath,
  type Selector,
} from './cli/select.js';
import {
  pruneRuns as pruneRunsStore,
  readRunRecords,
  type PruneResult,
  type RetentionPolicy,
  type RunRecord,
} from './core/run-store.js';
import type { Effort, RunOverrides } from './types.js';

export { ExitCode } from './exit-codes.js';
export type { Effort, Role, RunMode, RunOverrides, Runner } from './types.js';
export type { PruneResult, RetentionPolicy, RunRecord, RunState } from './core/run-store.js';
export type RunSelector = Selector;

// Root override for lookups so a run created under a custom `home` is reachable
// without mutating process.env. Resolves through resolveArtifactRoots.
export interface RunLookupOptions {
  home?: string;
}

export interface RunPlanLoopOptions {
  input: string;
  prompt?: boolean;
  iters?: number;
  effort?: Effort;
  fix?: boolean;
  translate?: boolean;
  locale?: string;
  workDir?: string;
  configFile?: string;
  home?: string;
}

export interface LaunchPlanLoopOptions extends RunPlanLoopOptions {
  resume?: boolean;
}

// Public projection of the internal CritiqueHealth — the same numbers as the
// `final_health` line in summary.md. The field names (including `new`) are a
// fixed consumer contract.
export interface RunHealth {
  critic: number;
  addressed: number;
  new: number;
  invalid: number;
  validAddressedPct: number;
}

export interface RunResult {
  exitCode: number;
  runId?: string;
  name?: string;
  workDir?: string;
  finalPlanPath?: string;
  summaryPath?: string;
  iterations?: number;
  health?: RunHealth;
  splitDecision?: string;
  packageDir?: string;
}

export interface CommandResult {
  exitCode: number;
  output: string;
}

export interface LaunchResult extends CommandResult {
  runId?: string;
  name?: string;
  workDir?: string;
  pid?: number;
  logPath?: string;
}

export type InterventionTarget = 'all' | 'critic' | 'creator' | 'fixer' | 'reviewer';

function commonArgs(options: RunPlanLoopOptions): string[] {
  const args: string[] = [];
  if (options.iters !== undefined) {
    args.push('--iters', String(options.iters));
  }
  if (options.effort !== undefined) {
    args.push('--effort', options.effort);
  }
  if (options.fix === true) {
    args.push('--fix');
  }
  if (options.fix === false) {
    args.push('--no-fix');
  }
  if (options.translate === true) {
    args.push('--translate');
  }
  if (options.translate === false) {
    args.push('--no-translate');
  }
  if (options.locale !== undefined) {
    args.push('--locale', options.locale);
  }
  if (options.prompt === true) {
    args.push('--prompt', options.input);
  } else {
    args.push(options.input);
  }
  return args;
}

function runOverrides(options: RunPlanLoopOptions): RunOverrides {
  return {
    ...(options.workDir !== undefined ? { workDir: options.workDir } : {}),
    ...(options.configFile !== undefined ? { configFile: options.configFile } : {}),
    ...(options.home !== undefined ? { home: options.home } : {}),
  };
}

function toRunResult(outcome: RunOutcome): RunResult {
  const report = outcome.report;
  if (report === undefined) {
    return { exitCode: outcome.exitCode };
  }
  return {
    exitCode: outcome.exitCode,
    workDir: report.workDir,
    ...(report.runId !== undefined ? { runId: report.runId } : {}),
    ...(report.name !== undefined ? { name: report.name } : {}),
    ...(report.finalPlanPath !== undefined ? { finalPlanPath: report.finalPlanPath } : {}),
    ...(report.summaryPath !== undefined ? { summaryPath: report.summaryPath } : {}),
    ...(report.iterations !== undefined ? { iterations: report.iterations } : {}),
    ...(report.health !== undefined
      ? {
          health: {
            critic: report.health.total,
            addressed: report.health.addressed,
            new: report.health.newIssues,
            invalid: report.health.invalid,
            validAddressedPct: report.health.pct,
          },
        }
      : {}),
    ...(report.splitDecision !== undefined ? { splitDecision: report.splitDecision } : {}),
    ...(report.packageDir !== undefined ? { packageDir: report.packageDir } : {}),
  };
}

function haltToExit(error: unknown): number {
  if (error instanceof HaltError) {
    if (!error.logged) {
      process.stderr.write(`${error.message}\n`);
    }
    return error.exitCode;
  }
  throw error;
}

function captureCommand(run: (write: (text: string) => void) => number): CommandResult {
  let output = '';
  try {
    const exitCode = run((text) => {
      output += text;
    });
    return { exitCode, output };
  } catch (error) {
    return { exitCode: haltToExit(error), output };
  }
}

// The core plan → critique → update loop, byte-contract identical to the
// reference agent-quorum.sh run. Returns the exit code; never calls process.exit.
export async function runPlanLoop(options: RunPlanLoopOptions): Promise<RunResult> {
  try {
    return toRunResult(await runPlanLoopCli(commonArgs(options), runOverrides(options)));
  } catch (error) {
    return { exitCode: haltToExit(error) };
  }
}

// Detach a run into its own process group with run.log redirection, exactly
// like the reference launch.sh. A detached launch cannot report iterations or
// health at detach time — read the artifacts in workDir once the run ends.
export async function launchPlanLoop(options: LaunchPlanLoopOptions): Promise<LaunchResult> {
  const args = options.resume === true ? ['--resume', ...commonArgs(options)] : commonArgs(options);
  let output = '';
  try {
    const outcome = await runLaunchCli(
      args,
      (text) => {
        output += text;
      },
      runOverrides(options),
    );
    return {
      exitCode: outcome.exitCode,
      output,
      ...(outcome.runId !== undefined ? { runId: outcome.runId } : {}),
      ...(outcome.name !== undefined ? { name: outcome.name } : {}),
      ...(outcome.workDir !== undefined ? { workDir: outcome.workDir } : {}),
      ...(outcome.pid !== undefined ? { pid: outcome.pid } : {}),
      ...(outcome.logPath !== undefined ? { logPath: outcome.logPath } : {}),
    };
  } catch (error) {
    return { exitCode: haltToExit(error), output };
  }
}

// Status snapshot: a pid (any process in the run's tree) or no query to list
// every currently running agent-quorum run.
export function getRunStatus(query?: number): CommandResult {
  return captureCommand((write) => runStatusCli(query === undefined ? [] : [String(query)], write));
}

// Append an operator intervention to a run's ledger.
export function addIntervention(
  workDir: string,
  message: string,
  target: InterventionTarget = 'all',
): CommandResult {
  return captureCommand((write) =>
    runInterveneCli(['--work', workDir, '--target', target, '--', message], write),
  );
}

function lookupStateDir(options?: RunLookupOptions): string {
  return resolveArtifactRoots(options?.home !== undefined ? { home: options.home } : {}).stateDir;
}

function toSelector(selector: string | RunSelector): Selector | undefined {
  return typeof selector === 'string' ? parseSelector(selector) : selector;
}

// List every run record under the resolved root, most-recent state not inferred
// here (read record.state or pass to status for liveness).
export function listRuns(options?: RunLookupOptions): RunRecord[] {
  return readRunRecords(lookupStateDir(options));
}

// Resolve a selector (string token, or a structured RunSelector for
// --last/--work) to its run record. A bare --work selector has no record and
// returns undefined; use getRunLogPath for its log.
export function getRun(
  selector: string | RunSelector,
  options?: RunLookupOptions,
): RunRecord | undefined {
  const parsed = toSelector(selector);
  if (parsed === undefined) {
    return undefined;
  }
  const resolved = resolveSelector(parsed, { stateDir: lookupStateDir(options) });
  return resolved !== undefined && isRunRecord(resolved) ? resolved : undefined;
}

// The API counterpart of `logs`: the run's run.log path when it exists, else
// undefined (the run streamed to its console or does not resolve).
export function getRunLogPath(
  selector: string | RunSelector,
  options?: RunLookupOptions,
): string | undefined {
  const parsed = toSelector(selector);
  if (parsed === undefined) {
    return undefined;
  }
  const resolved = resolveSelector(parsed, { stateDir: lookupStateDir(options) });
  if (resolved === undefined) {
    return undefined;
  }
  const logPath = resolveLogPath(resolved);
  return existsSync(logPath) ? logPath : undefined;
}

// Resolve a selector to its workDir and append an intervention there. Exit code
// 2 when the selector resolves nothing; otherwise mirrors addIntervention.
export function interveneRun(
  selector: string | RunSelector,
  message: string,
  target: InterventionTarget = 'all',
  options?: RunLookupOptions,
): CommandResult {
  const parsed = toSelector(selector);
  const resolved =
    parsed === undefined
      ? undefined
      : resolveSelector(parsed, { stateDir: lookupStateDir(options) });
  if (resolved === undefined) {
    return { exitCode: 2, output: 'no run matches selector\n' };
  }
  return addIntervention(resolved.workDir, message, target);
}

// Bound the durable ledger by retention policy (record-only; never deletes
// functional workdirs). See RetentionPolicy for defaults and env overrides.
export function pruneRuns(policy?: RetentionPolicy, options?: RunLookupOptions): PruneResult {
  return pruneRunsStore(lookupStateDir(options), policy ?? {});
}
