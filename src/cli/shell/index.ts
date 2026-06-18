import { emitKeypressEvents } from 'node:readline';
import { resolveRunState, type RunRecord, type RunStateProbes } from '../../core/run-store.js';
import { colorsEnabled } from '../../runtime/log.js';
import { systemProbes } from '../probes.js';
import {
  loadDashboard as loadDashboardImpl,
  loadRunDetail as loadRunDetailImpl,
  readLogSince as readLogSinceImpl,
  readLogTail as readLogTailImpl,
  type DashboardGroup,
  type LogAppend,
  type LogTail,
  type RunDetailView,
} from './data.js';
import {
  interveneFromShell,
  launchFromShell,
  stopRun,
  type CommandResult,
  type LaunchResult,
  type StopResult,
} from './actions.js';
import { decodeKey, type ReadlineKey } from './keys.js';
import {
  initialState,
  reduce,
  type ActionResult,
  type InterveneTarget,
  type LaunchForm,
  type ShellEffect,
  type ShellEvent,
  type ShellState,
} from './model.js';
import { DEFAULT_VIEWPORT, render, type Viewport } from './render.js';

type Writer = (text: string) => void;
const sink: Writer = () => undefined;

type LaunchOk = Exclude<LaunchResult, { error: string }>;

function launchMessage(outcome: LaunchOk): string {
  const parts = [`started ${outcome.name ?? 'run'}`];
  if (outcome.runId !== undefined) {
    parts.push(`run ${outcome.runId}`);
  }
  if (outcome.pid !== undefined) {
    parts.push(`pid ${outcome.pid}`);
  }
  return parts.join(' · ');
}

function describeStop(result: StopResult): ActionResult {
  if (result.kind === 'killed') {
    return { kind: 'stop', ok: true, message: `sent ${result.command}` };
  }
  if (result.kind === 'aborted') {
    return { kind: 'stop', ok: false, message: `stop aborted — ${result.reason}` };
  }
  return { kind: 'stop', ok: false, message: `stop failed — ${result.message}` };
}

const FOLLOW_POLL_MS = 200;
const REFRESH_MS = 2000;
const LOG_TAIL_LINES = 1000;

const ENTER_ALT = '\x1b[?1049h';
const EXIT_ALT = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[H';

type Timer = ReturnType<typeof setInterval>;

export interface ShellInput {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
}

export interface ShellOutput {
  write(text: string): boolean;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

export interface ShellStreams {
  readonly input: ShellInput;
  readonly output: ShellOutput;
}

export interface RunShellDeps {
  readonly loadDashboard: () => DashboardGroup[];
  readonly loadRunDetail: (record: RunRecord) => RunDetailView;
  readonly readLogTail: (logPath: string, maxLines: number) => LogTail;
  readonly readLogSince: (logPath: string, offset: number) => LogAppend;
  readonly probes: RunStateProbes;
  readonly followMs: number;
  readonly refreshMs: number;
  readonly launchAction: (form: LaunchForm, out: Writer) => Promise<LaunchResult>;
  readonly interveneAction: (
    record: RunRecord,
    target: InterveneTarget,
    message: string,
  ) => CommandResult;
  readonly stopAction: (record: RunRecord) => StopResult;
}

export const defaultRunShellDeps: RunShellDeps = {
  loadDashboard: loadDashboardImpl,
  loadRunDetail: loadRunDetailImpl,
  readLogTail: readLogTailImpl,
  readLogSince: readLogSinceImpl,
  probes: systemProbes,
  followMs: FOLLOW_POLL_MS,
  refreshMs: REFRESH_MS,
  launchAction: launchFromShell,
  interveneAction: (record, target, message) =>
    interveneFromShell({ record, target, message }, sink),
  stopAction: (record) => stopRun(record),
};

type StderrWrite = typeof process.stderr.write;

interface StderrCapture {
  read: () => string;
  restore: () => void;
}

// Redirect `process.stderr.write` to a buffer until `restore()`, so an engine
// that writes to stderr (the dead-pid `runStatusCli` load, launch/intervene)
// never corrupts the alt-screen.
function installStderrCapture(): StderrCapture {
  const original: StderrWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  const replacement = ((
    chunk: Uint8Array | string,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done !== undefined) {
      done();
    }
    return true;
  }) as StderrWrite;
  process.stderr.write = replacement;
  return {
    read: () => captured,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

// Run `fn` with stderr captured and restored in `finally`; the captured text is
// returned for folding into a status line.
export function captureStderr<T>(fn: () => T): { result: T; captured: string } {
  const capture = installStderrCapture();
  try {
    const result = fn();
    return { result, captured: capture.read() };
  } finally {
    capture.restore();
  }
}

async function captureStderrAsync<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; captured: string }> {
  const capture = installStderrCapture();
  try {
    const result = await fn();
    return { result, captured: capture.read() };
  } finally {
    capture.restore();
  }
}

export function shouldOpenShell(
  args: readonly string[],
  input: { isTTY?: boolean },
  output: { isTTY?: boolean },
): boolean {
  return args.length === 0 && input.isTTY === true && output.isTTY === true;
}

export interface DispatchDeps {
  readonly runShell: (streams: ShellStreams) => Promise<number>;
  readonly writeHelp: () => void;
}

// The empty-args dispatch seam: open the shell only in a dual-TTY, otherwise
// write global help. Exported so a unit test can route injected streams without
// a PTY.
export async function openShellOrHelp(streams: ShellStreams, deps: DispatchDeps): Promise<number> {
  if (shouldOpenShell([], streams.input, streams.output)) {
    return deps.runShell(streams);
  }
  deps.writeHelp();
  return 0;
}

export function runShell(
  streams: ShellStreams = { input: process.stdin, output: process.stdout },
  deps: RunShellDeps = defaultRunShellDeps,
): Promise<number> {
  const { input, output } = streams;
  const color = colorsEnabled(output);
  let state: ShellState = initialState;
  let finished = false;
  let draining = false;
  const queue: ShellEvent[] = [];
  let refreshTimer: Timer | undefined;
  let followTimer: Timer | undefined;
  let followOffset = 0;

  return new Promise<number>((resolve) => {
    function viewport(): Viewport {
      return {
        cols: output.columns ?? DEFAULT_VIEWPORT.cols,
        rows: output.rows ?? DEFAULT_VIEWPORT.rows,
      };
    }

    function renderFrame(): void {
      output.write(`${CLEAR}${render(state, viewport(), { color, now: Date.now() })}`);
    }

    function stopFollow(): void {
      if (followTimer !== undefined) {
        clearInterval(followTimer);
        followTimer = undefined;
      }
    }

    function teardown(): void {
      stopFollow();
      if (refreshTimer !== undefined) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
      }
      input.removeListener('keypress', onKeypress);
      input.removeListener('end', onEnd);
      input.removeListener('error', onEnd);
      process.removeListener('SIGWINCH', onResize);
      input.setRawMode?.(false);
      output.write(`${SHOW_CURSOR}${EXIT_ALT}`);
    }

    function finish(code: number): void {
      if (finished) {
        return;
      }
      finished = true;
      queue.length = 0;
      teardown();
      resolve(code);
    }

    function startFollow(record: RunRecord): void {
      stopFollow();
      const tail = deps.readLogTail(record.logPath, LOG_TAIL_LINES);
      followOffset = tail.size;
      enqueue({ type: 'log-open', tail });
      followTimer = setInterval(() => {
        const append = deps.readLogSince(record.logPath, followOffset);
        let appended = '';
        if (append.available) {
          appended = append.appended;
          followOffset = append.size;
        }
        const live = resolveRunState(record, deps.probes) === 'running';
        if (!live) {
          stopFollow();
          enqueue({ type: 'log-append', appended, size: followOffset, terminal: true });
          return;
        }
        if (appended.length > 0) {
          enqueue({ type: 'log-append', appended, size: followOffset });
        }
      }, deps.followMs);
    }

    async function runLaunchAction(form: LaunchForm): Promise<void> {
      const { result, captured } = await captureStderrAsync(() => deps.launchAction(form, sink));
      const action: ActionResult =
        'error' in result
          ? { kind: 'launch', ok: false, message: result.error }
          : { kind: 'launch', ok: true, message: launchMessage(result) };
      enqueue({ type: 'action-result', result: action, captured });
    }

    function runInterveneAction(record: RunRecord, target: InterveneTarget, message: string): void {
      const { result, captured } = captureStderr(() =>
        deps.interveneAction(record, target, message),
      );
      const action: ActionResult =
        result.code === 0
          ? { kind: 'intervene', ok: true, message: `intervention recorded for ${record.name}` }
          : {
              kind: 'intervene',
              ok: false,
              message: result.error ?? `intervene failed (exit ${result.code})`,
            };
      enqueue({ type: 'action-result', result: action, captured });
    }

    function runStopAction(record: RunRecord): void {
      const result = deps.stopAction(record);
      const action: ActionResult = describeStop(result);
      enqueue({ type: 'action-result', result: action });
    }

    function runEffect(effect: ShellEffect): void {
      switch (effect.kind) {
        case 'quit':
          finish(0);
          return;
        case 'reload':
          enqueue({ type: 'data', groups: deps.loadDashboard() });
          return;
        case 'load-detail': {
          const { result } = captureStderr(() => deps.loadRunDetail(effect.record));
          enqueue({ type: 'detail', detail: result });
          return;
        }
        case 'follow-log':
          startFollow(effect.record);
          return;
        case 'stop-follow':
          stopFollow();
          return;
        case 'launch':
          void runLaunchAction(effect.form);
          return;
        case 'intervene':
          runInterveneAction(effect.record, effect.target, effect.message);
          return;
        case 'stop':
          runStopAction(effect.record);
          return;
        default: {
          effect satisfies never;
          return;
        }
      }
    }

    function handle(event: ShellEvent): void {
      const next = reduce(state, event);
      state = next.state;
      renderFrame();
      if (next.effect !== undefined) {
        runEffect(next.effect);
      }
    }

    function enqueue(event: ShellEvent): void {
      if (finished) {
        return;
      }
      queue.push(event);
      if (draining) {
        return;
      }
      draining = true;
      while (queue.length > 0) {
        const next = queue.shift();
        if (next !== undefined) {
          handle(next);
        }
      }
      draining = false;
    }

    function onKeypress(...args: unknown[]): void {
      const str = typeof args[0] === 'string' ? args[0] : undefined;
      const key = args[1] as ReadlineKey | undefined;
      enqueue({ type: 'key', key: decodeKey(str, key) });
    }

    function onEnd(): void {
      finish(0);
    }

    function onResize(): void {
      renderFrame();
    }

    output.write(`${ENTER_ALT}${HIDE_CURSOR}`);
    input.setRawMode?.(true);
    emitKeypressEvents(input as unknown as NodeJS.ReadableStream);
    input.on('keypress', onKeypress);
    input.on('end', onEnd);
    input.on('error', onEnd);
    process.on('SIGWINCH', onResize);
    refreshTimer = setInterval(() => {
      enqueue({ type: 'tick' });
    }, deps.refreshMs);

    renderFrame();
    enqueue({ type: 'data', groups: deps.loadDashboard() });
  });
}
