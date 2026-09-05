import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import {
  assertExecutionAllowed,
  type ExecutionAttempt,
  type ExecutionControl,
  type ExecutionProcess,
} from './execution-control.js';

export interface ExecutionHandoff {
  readonly version: 1;
  readonly deadlineEpochMs: number;
  readonly processGroup: 'shared';
  readonly socketPath: string;
  readonly nonce: string;
  readonly attemptTimeoutMs?: number;
  readonly codexDeniedMcpServers?: readonly string[];
}

function parseHandoff(file: string): ExecutionHandoff {
  const stat = lstatSync(file);
  if (
    !path.isAbsolute(file) ||
    !stat.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  ) {
    throw new Error('execution control file must be an absolute owner-only regular file');
  }
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('deadlineEpochMs' in value) ||
    typeof value.deadlineEpochMs !== 'number' ||
    !Number.isSafeInteger(value.deadlineEpochMs) ||
    value.deadlineEpochMs <= 0 ||
    !('processGroup' in value) ||
    value.processGroup !== 'shared' ||
    !('socketPath' in value) ||
    typeof value.socketPath !== 'string' ||
    !path.isAbsolute(value.socketPath) ||
    !('nonce' in value) ||
    typeof value.nonce !== 'string' ||
    value.nonce.length < 32
  ) {
    throw new Error('execution control file is invalid');
  }
  if (
    'attemptTimeoutMs' in value &&
    (typeof value.attemptTimeoutMs !== 'number' ||
      !Number.isSafeInteger(value.attemptTimeoutMs) ||
      value.attemptTimeoutMs <= 0)
  ) {
    throw new Error('execution attempt timeout is invalid');
  }
  if (
    'codexDeniedMcpServers' in value &&
    (!Array.isArray(value.codexDeniedMcpServers) ||
      value.codexDeniedMcpServers.some((name: unknown) => typeof name !== 'string' || name === ''))
  ) {
    throw new Error('execution Codex MCP policy is invalid');
  }
  return value as ExecutionHandoff;
}

function requestAdmission(
  handoff: ExecutionHandoff,
  type: 'before-spawn' | 'spawned' | 'watch',
  attempt: ExecutionAttempt,
  child?: ExecutionProcess,
  disconnected?: () => void,
): Promise<void> {
  assertExecutionAllowed(handoff);
  return new Promise((resolve, reject) => {
    const socket = createConnection(handoff.socketPath);
    let buffer = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error === undefined && disconnected !== undefined) {
        socket.setTimeout(0);
        socket.unref();
      } else {
        socket.destroy();
      }
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    socket.setTimeout(Math.min(5000, Math.max(1, handoff.deadlineEpochMs - Date.now())), () => {
      finish(new Error('execution admission timed out'));
    });
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({ version: 1, requestId: randomUUID(), nonce: handoff.nonce, type, attempt, ...(child === undefined ? {} : { process: child }) })}\n`,
      );
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 4096) {
        finish(new Error('execution admission response is too large'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }
      try {
        const reply: unknown = JSON.parse(buffer.slice(0, newline));
        if (typeof reply === 'object' && reply !== null && 'ok' in reply && reply.ok === true) {
          finish();
        } else {
          finish(new Error('execution admission rejected'));
        }
      } catch {
        finish(new Error('execution admission response is invalid'));
      }
    });
    socket.once('error', () => {
      disconnected?.();
      finish(new Error('execution admission unavailable'));
    });
    socket.once('close', () => {
      disconnected?.();
      finish(new Error('execution admission disconnected'));
    });
  });
}

export function readExecutionHandoff(file: string): ExecutionControl {
  const handoff = parseHandoff(file);
  const cancellation = new AbortController();
  let watcher: Promise<void> | undefined;
  const abort = () => {
    cancellation.abort();
  };
  return {
    signal: cancellation.signal,
    deadlineEpochMs: handoff.deadlineEpochMs,
    processGroup: handoff.processGroup,
    ...(handoff.attemptTimeoutMs === undefined
      ? {}
      : { attemptTimeoutMs: handoff.attemptTimeoutMs }),
    ...(handoff.codexDeniedMcpServers === undefined
      ? {}
      : { codexDeniedMcpServers: handoff.codexDeniedMcpServers }),
    beforeSpawn: async (attempt) => {
      watcher ??= requestAdmission(handoff, 'watch', attempt, undefined, abort);
      try {
        await watcher;
        assertExecutionAllowed({ ...handoff, signal: cancellation.signal });
        await requestAdmission(handoff, 'before-spawn', attempt);
      } catch (error) {
        abort();
        throw error;
      }
    },
    onSpawn: (child) => requestAdmission(handoff, 'spawned', child, child),
  };
}
