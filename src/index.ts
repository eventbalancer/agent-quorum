import { HaltError } from './runtime/halt.js';
import { runInterveneCli } from './cli/intervene.js';
import { runLaunchCli } from './cli/launch.js';
import { runPlanLoopCli, type RunOutcome } from './cli/run.js';
import { runStatusCli } from './cli/status.js';
import type { Effort, RunOverrides } from './types.js';

export { ExitCode } from './exit-codes.js';
export type { Effort, Role, RunMode, RunOverrides, Runner } from './types.js';

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
  workDir?: string;
  finalPlanPath?: string;
  summaryPath?: string;
  iterations?: number;
  health?: RunHealth;
}

export interface CommandResult {
  exitCode: number;
  output: string;
}

export interface LaunchResult extends CommandResult {
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

// The core plan → critique → update loop, byte-contract identical to the
// reference plan-loop.sh run. Returns the exit code; never calls process.exit.
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
      ...(outcome.workDir !== undefined ? { workDir: outcome.workDir } : {}),
      ...(outcome.pid !== undefined ? { pid: outcome.pid } : {}),
      ...(outcome.logPath !== undefined ? { logPath: outcome.logPath } : {}),
    };
  } catch (error) {
    return { exitCode: haltToExit(error), output };
  }
}

// Status snapshot: a pid (any process in the run's tree) or no query to list
// every currently running plan-loop run.
export function getRunStatus(query?: number): CommandResult {
  let output = '';
  try {
    const exitCode = runStatusCli(query === undefined ? [] : [String(query)], (text) => {
      output += text;
    });
    return { exitCode, output };
  } catch (error) {
    return { exitCode: haltToExit(error), output };
  }
}

// Append an operator intervention to a run's ledger.
export function addIntervention(
  workDir: string,
  message: string,
  target: InterventionTarget = 'all',
): CommandResult {
  let output = '';
  try {
    const exitCode = runInterveneCli(
      ['--work', workDir, '--target', target, '--', message],
      (text) => {
        output += text;
      },
    );
    return { exitCode, output };
  } catch (error) {
    return { exitCode: haltToExit(error), output };
  }
}
