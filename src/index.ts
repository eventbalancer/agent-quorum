import { HaltError } from './runtime/halt.js';
import { runInterveneCli } from './cli/intervene.js';
import { runLaunchCli } from './cli/launch.js';
import { runPlanLoopCli } from './cli/run.js';
import { runStatusCli } from './cli/status.js';
import type { Effort } from './types.js';

export { ExitCode } from './exit-codes.js';
export type { Effort, Role, RunMode, Runner } from './types.js';

export interface RunPlanLoopOptions {
  input: string;
  prompt?: boolean;
  iters?: number;
  effort?: Effort;
  fix?: boolean;
  translate?: boolean;
}

export interface LaunchPlanLoopOptions extends RunPlanLoopOptions {
  resume?: boolean;
}

export interface RunResult {
  exitCode: number;
}

export interface CommandResult {
  exitCode: number;
  output: string;
}

export type InterventionTarget = 'all' | 'critic' | 'creator' | 'fixer' | 'reviewer';

function commonArgs(options: RunPlanLoopOptions): string[] {
  const args: string[] = [];
  if (options.iters !== undefined) args.push('--iters', String(options.iters));
  if (options.effort !== undefined) args.push('--effort', options.effort);
  if (options.fix === true) args.push('--fix');
  if (options.fix === false) args.push('--no-fix');
  if (options.translate === true) args.push('--translate');
  if (options.translate === false) args.push('--no-translate');
  if (options.prompt === true) args.push('--prompt', options.input);
  else args.push(options.input);
  return args;
}

function haltToExit(error: unknown): number {
  if (error instanceof HaltError) {
    if (!error.logged) process.stderr.write(`${error.message}\n`);
    return error.exitCode;
  }
  throw error;
}

// The core plan → critique → update loop, byte-contract identical to the
// reference plan-loop.sh run. Returns the exit code; never calls process.exit.
export async function runPlanLoop(options: RunPlanLoopOptions): Promise<RunResult> {
  try {
    return { exitCode: await runPlanLoopCli(commonArgs(options)) };
  } catch (error) {
    return { exitCode: haltToExit(error) };
  }
}

// Detach a run into its own process group with run.log redirection, exactly
// like the reference launch.sh.
export async function launchPlanLoop(options: LaunchPlanLoopOptions): Promise<CommandResult> {
  const args = options.resume === true ? ['--resume', ...commonArgs(options)] : commonArgs(options);
  let output = '';
  try {
    const exitCode = await runLaunchCli(args, (text) => {
      output += text;
    });
    return { exitCode, output };
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
