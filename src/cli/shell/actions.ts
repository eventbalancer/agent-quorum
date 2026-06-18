import { existsSync, statSync } from 'node:fs';
import {
  resolveRunState,
  runNameFromWorkdir,
  type RunRecord,
  type RunStateProbes,
} from '../../core/run-store.js';
import { runInterveneCli } from '../intervene.js';
import { runLaunchCli, type LaunchOutcome } from '../launch.js';
import { systemProbes } from '../probes.js';
import type { InterveneTarget, LaunchForm } from './model.js';

type Writer = (text: string) => void;

export type LaunchResult = LaunchOutcome | { readonly error: string };

export interface CommandResult {
  readonly code: number;
  readonly error?: string;
}

export type StopResult =
  | { readonly kind: 'killed'; readonly command: string }
  | { readonly kind: 'aborted'; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string };

export interface InterveneParams {
  readonly record: RunRecord;
  readonly target: InterveneTarget;
  readonly message: string;
}

export interface LaunchEngineDeps {
  readonly runLaunch?: typeof runLaunchCli;
}

export interface InterveneEngineDeps {
  readonly runIntervene?: typeof runInterveneCli;
}

export interface StopDeps {
  readonly kill?: (pid: number, signal: NodeJS.Signals | number) => void;
  readonly probes?: RunStateProbes;
}

// Mirrors `commonArgs` (`src/index.ts:95-124`) plus the `--resume` prefix: one
// input token (positional plan or `--prompt`), `--iters`/`--quality`/`--locale`
// only when set, and the tri-state `--fix`/`--translate` only when toggled off
// the default.
function buildLaunchArgs(form: LaunchForm, input: string): string[] {
  const args: string[] = [];
  if (form.resume) {
    args.push('--resume');
  }
  if (form.promptMode) {
    args.push('--prompt', input);
  } else {
    args.push(input);
  }
  if (form.iters !== '') {
    args.push('--iters', form.iters);
  }
  if (form.quality !== 'default') {
    args.push('--quality', form.quality);
  }
  if (form.fix === 'on') {
    args.push('--fix');
  } else if (form.fix === 'off') {
    args.push('--no-fix');
  }
  const locale = form.locale.trim();
  if (locale !== '') {
    args.push('--locale', locale);
  }
  if (form.translate === 'on') {
    args.push('--translate');
  } else if (form.translate === 'off') {
    args.push('--no-translate');
  }
  return args;
}

// Prevalidates the form (input present, a real file, and a sane `iters`) and
// returns `{error}` without touching the engine on failure. On success returns
// the `LaunchOutcome`; for a resume (no `runId`/`name`) the name is recovered
// from the workdir. The driver runs this under stderr capture, so engine stderr
// (resume attaching/none/ambiguous, post-launch failure) is folded into a status.
export async function launchFromShell(
  form: LaunchForm,
  out: Writer,
  deps: LaunchEngineDeps = {},
): Promise<LaunchResult> {
  const input = form.input.trim();
  if (input === '') {
    return { error: 'input is required' };
  }
  if (!existsSync(input) || !statSync(input).isFile()) {
    return { error: `input is not a readable file: ${input}` };
  }
  if (form.iters !== '') {
    const iters = Number(form.iters);
    if (!Number.isInteger(iters) || iters < 1) {
      return { error: 'iters must be an integer >= 1' };
    }
  }
  const engine = deps.runLaunch ?? runLaunchCli;
  try {
    const outcome = await engine(buildLaunchArgs(form, input), out, {});
    if (outcome.exitCode !== 0) {
      return { error: `launch exited with code ${outcome.exitCode}` };
    }
    if (outcome.name === undefined && outcome.workDir !== undefined) {
      return { ...outcome, name: runNameFromWorkdir(outcome.workDir) };
    }
    return outcome;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// Records an intervention through the CLI engine directly (never the public
// barrel), appending the identical `{id, ts, target, message}` line. The driver
// supplies the stderr capture.
export function interveneFromShell(
  params: InterveneParams,
  out: Writer,
  deps: InterveneEngineDeps = {},
): CommandResult {
  const engine = deps.runIntervene ?? runInterveneCli;
  try {
    const code = engine(
      ['--work', params.record.workDir, '--target', params.target, '--', params.message],
      out,
    );
    return { code };
  } catch (error) {
    return { code: 1, error: error instanceof Error ? error.message : String(error) };
  }
}

// The only process-mutating path. After the typed-name confirmation (gated in
// the reducer) it re-resolves liveness immediately before signaling — a recycled
// pid/pgid or an already-terminal run is never signaled — then signals the run's
// process group inside a try/catch. `kill`/`probes` are injectable so tests
// assert the gate, the recheck, and kill-failure handling without terminating a
// real process.
export function stopRun(record: RunRecord, deps: StopDeps = {}): StopResult {
  const probes = deps.probes ?? systemProbes;
  const kill =
    deps.kill ??
    ((pid: number, signal: NodeJS.Signals | number): void => {
      process.kill(pid, signal);
    });
  const command = `kill -TERM -${record.pgid}`;
  if (resolveRunState(record, probes) !== 'running') {
    return { kind: 'aborted', reason: 'run is no longer live' };
  }
  try {
    kill(-Number(record.pgid), 'SIGTERM');
    return { kind: 'killed', command };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}
