import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { killTree, spawnOwned, terminateOwned, waitForExit } from './exec.js';
import { pgidOf, procStartToken } from './proc.js';
import { spawnExecutionStartGate } from './execution-start-gate.js';

export interface ExecutionAttempt {
  readonly command: string;
  readonly cwd: string;
}

export interface ExecutionProcess extends ExecutionAttempt {
  readonly pid: number;
  readonly pgid: string;
  readonly procStartToken: string;
}

export interface ExecutionControl {
  readonly signal?: AbortSignal;
  readonly deadlineEpochMs?: number;
  readonly processGroup?: 'isolated' | 'shared';
  readonly terminateGraceMs?: number;
  readonly attemptTimeoutMs?: number;
  readonly codexDeniedMcpServers?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly beforeSpawn?: (attempt: ExecutionAttempt) => void | Promise<void>;
  readonly onSpawn?: (process: ExecutionProcess) => void | Promise<void>;
}

export class ExecutionControlError extends Error {
  constructor(readonly reason: 'aborted' | 'deadline') {
    super(`execution ${reason}`);
    this.name = 'ExecutionControlError';
  }
}

export function assertExecutionAllowed(control?: ExecutionControl): void {
  if (
    control?.attemptTimeoutMs !== undefined &&
    (!Number.isSafeInteger(control.attemptTimeoutMs) || control.attemptTimeoutMs <= 0)
  ) {
    throw new TypeError('execution attempt timeout must be a positive safe integer');
  }
  if (
    control?.terminateGraceMs !== undefined &&
    (!Number.isFinite(control.terminateGraceMs) || control.terminateGraceMs < 0)
  ) {
    throw new TypeError('termination grace must be finite and non-negative');
  }
  if (control?.signal?.aborted === true) {
    throw new ExecutionControlError('aborted');
  }
  const deadline = control?.deadlineEpochMs;
  if (deadline !== undefined) {
    if (!Number.isSafeInteger(deadline) || deadline <= 0) {
      throw new TypeError('execution deadline must be a positive safe integer');
    }
    if (Date.now() >= deadline) {
      throw new ExecutionControlError('deadline');
    }
  }
}

async function awaitExecution<T>(
  operation: T | Promise<T>,
  control?: ExecutionControl,
): Promise<T> {
  assertExecutionAllowed(control);
  if (control?.signal === undefined && control?.deadlineEpochMs === undefined) {
    return operation;
  }
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(new ExecutionControlError('aborted'));
    };
    control.signal?.addEventListener('abort', onAbort, { once: true });
    if (control.deadlineEpochMs !== undefined) {
      timer = setTimeout(
        () => {
          reject(new ExecutionControlError('deadline'));
        },
        Math.max(0, control.deadlineEpochMs - Date.now()),
      );
    }
  });
  try {
    return await Promise.race([Promise.resolve(operation), interrupted]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) {
      control.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export async function controlledDelay(
  milliseconds: number,
  control?: ExecutionControl,
): Promise<void> {
  assertExecutionAllowed(control);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new TypeError('execution delay must be finite and non-negative');
  }
  const remaining =
    control?.deadlineEpochMs === undefined
      ? milliseconds
      : Math.min(milliseconds, Math.max(0, control.deadlineEpochMs - Date.now()));
  try {
    await sleep(
      remaining,
      undefined,
      control?.signal === undefined ? {} : { signal: control.signal },
    );
  } catch (error) {
    assertExecutionAllowed(control);
    throw error;
  }
  assertExecutionAllowed(control);
}

export async function spawnControlled(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
  control?: ExecutionControl,
): Promise<ChildProcess> {
  assertExecutionAllowed(control);
  const attempt = { command, cwd: options.cwd === undefined ? process.cwd() : String(options.cwd) };
  await awaitExecution(control?.beforeSpawn?.(attempt), control);
  assertExecutionAllowed(control);
  if (control?.attemptTimeoutMs !== undefined) {
    control = {
      ...control,
      deadlineEpochMs: Math.min(
        control.deadlineEpochMs ?? Infinity,
        Date.now() + control.attemptTimeoutMs,
      ),
    };
  }
  const spawnOptions = {
    ...options,
    ...(control?.env === undefined ? {} : { env: control.env }),
  };
  const gate =
    control?.processGroup === 'shared' && control.onSpawn !== undefined
      ? spawnExecutionStartGate(command, args, spawnOptions)
      : undefined;
  const child =
    gate?.child ?? spawnOwned(command, args, spawnOptions, control?.processGroup !== 'shared');
  const exit = waitForExit(child);
  let timer: NodeJS.Timeout | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    const remaining =
      control?.deadlineEpochMs === undefined
        ? Infinity
        : Math.max(0, control.deadlineEpochMs - Date.now());
    stopping ??= terminateOwned(child, Math.min(control?.terminateGraceMs ?? 1000, remaining));
    void stopping;
  };
  control?.signal?.addEventListener('abort', stop, { once: true });
  if (control?.deadlineEpochMs !== undefined) {
    const grace = control.terminateGraceMs ?? 1000;
    timer = setTimeout(stop, Math.max(0, control.deadlineEpochMs - Date.now() - grace));
  }
  void exit.then(() => {
    killTree(child, 'SIGKILL');
    clearTimeout(timer);
    control?.signal?.removeEventListener('abort', stop);
  });
  try {
    if (child.pid !== undefined) {
      await awaitExecution(
        control?.onSpawn?.({
          ...attempt,
          pid: child.pid,
          pgid: pgidOf(child.pid) ?? '',
          procStartToken: procStartToken(child.pid) ?? '',
        }),
        control,
      );
    }
    assertExecutionAllowed(control);
    if (gate !== undefined) {
      await awaitExecution(gate.release(), control);
      assertExecutionAllowed(control);
    }
    return child;
  } catch (error) {
    await terminateOwned(child, 0);
    throw error;
  } finally {
    gate?.close();
  }
}
