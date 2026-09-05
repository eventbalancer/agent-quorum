import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { startContainerProvider } from './container-provider.js';
import { PROVIDER_MESSAGE_BYTES } from './provider-channel.js';

const HEARTBEAT_LIMIT_MS = 500;
const TERMINATION_GRACE_MS = 100;
const MAX_ALLOWANCE_MS = 120 * 60_000;

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
}

export function runContainerGuard(
  command: readonly string[],
  input: Readable,
  provider?: { receive(value: unknown): boolean },
): Promise<number> {
  if (command.length === 0) {
    return Promise.resolve(2);
  }
  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    let deadline: number | undefined;
    let buffer = '';
    let stopping = false;
    let settled = false;
    let expiry: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const finish = (status: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(expiry);
      clearTimeout(escalation);
      if (child !== undefined) {
        killGroup(child, 'SIGKILL');
      }
      input.pause();
      input.off('data', receive);
      input.off('end', stop);
      input.off('error', stop);
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      resolve(status);
    };
    const stop = () => {
      if (stopping || settled) {
        return;
      }
      stopping = true;
      if (child === undefined) {
        finish(143);
        return;
      }
      killGroup(child, 'SIGTERM');
      escalation = setTimeout(() => {
        if (child !== undefined) {
          killGroup(child, 'SIGKILL');
        }
      }, TERMINATION_GRACE_MS);
    };
    const heartbeat = (line: string) => {
      const value: unknown = JSON.parse(line);
      if (provider?.receive(value) === true) {
        return;
      }
      const now = Date.now();
      if (
        child === undefined &&
        typeof value === 'object' &&
        value !== null &&
        'validUntilEpochMs' in value &&
        typeof value.validUntilEpochMs === 'number' &&
        value.validUntilEpochMs <= now
      ) {
        return;
      }
      if (
        typeof value !== 'object' ||
        value === null ||
        !('deadlineEpochMs' in value) ||
        typeof value.deadlineEpochMs !== 'number' ||
        !Number.isSafeInteger(value.deadlineEpochMs) ||
        !('validUntilEpochMs' in value) ||
        typeof value.validUntilEpochMs !== 'number' ||
        !Number.isSafeInteger(value.validUntilEpochMs) ||
        value.deadlineEpochMs <= now ||
        value.deadlineEpochMs - now > MAX_ALLOWANCE_MS ||
        value.validUntilEpochMs <= now ||
        value.validUntilEpochMs > value.deadlineEpochMs ||
        value.validUntilEpochMs - now > HEARTBEAT_LIMIT_MS ||
        (deadline !== undefined && value.deadlineEpochMs > deadline)
      ) {
        stop();
        return;
      }
      deadline = value.deadlineEpochMs;
      clearTimeout(expiry);
      expiry = setTimeout(stop, Math.max(0, value.validUntilEpochMs - now - TERMINATION_GRACE_MS));
      if (child === undefined && !stopping) {
        const executable = command[0];
        if (executable === undefined) {
          finish(2);
          return;
        }
        child = spawn(executable, command.slice(1), {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        child.stdout?.on('data', (chunk: Buffer) => {
          process.stdout.write(chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          process.stderr.write(chunk);
        });
        child.once('error', () => {
          finish(127);
        });
        child.once('exit', (code) => {
          finish(stopping ? 143 : (code ?? 1));
        });
      }
    };
    const receive = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > PROVIDER_MESSAGE_BYTES + 1024) {
        stop();
        return;
      }
      for (
        let index = buffer.indexOf('\n');
        index >= 0 && !stopping && !settled;
        index = buffer.indexOf('\n')
      ) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          heartbeat(line);
        } catch {
          stop();
        }
      }
    };
    input.setEncoding('utf8');
    input.on('data', receive);
    input.once('end', stop);
    input.once('error', stop);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    expiry = setTimeout(stop, HEARTBEAT_LIMIT_MS - TERMINATION_GRACE_MS);
  });
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const provider = args[0] === '--provider-proxy' ? await startContainerProvider() : undefined;
  const status = await runContainerGuard(
    provider === undefined ? args : args.slice(1),
    process.stdin,
    provider,
  );
  provider?.close();
  process.exit(status);
}
