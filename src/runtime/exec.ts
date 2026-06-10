import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { err } from './log.js';

const liveChildren = new Set<ChildProcess>();

// Providers run in their own process group (detached) so the watchdog and the
// TERM/INT teardown can kill whole subtrees with one negative-pgid signal.
export function spawnDetached(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  const child = spawn(command, args, { ...options, detached: true });
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  child.once('error', () => liveChildren.delete(child));
  return child;
}

export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        const signum = os.constants.signals[signal];
        resolve(128 + signum);
        return;
      }
      resolve(code ?? 0);
    });
    child.once('error', () => {
      resolve(127);
    });
  });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function interruptThenTerminate(
  child: ChildProcess,
  graceSeconds: number,
): Promise<void> {
  if (hasExited(child)) return;
  killTree(child, 'SIGINT');
  const deadline = Date.now() + graceSeconds * 1000;
  while (Date.now() < deadline) {
    if (hasExited(child)) return;
    await sleep(200);
  }
  killTree(child, 'SIGTERM');
}

// Process-group id of the current process. Linux reads /proc/self/stat
// in-process; macOS has no /proc, so this single call site mirrors the
// reference's `ps -o pgid=` with a graceful empty-string fallback.
export function ownPgid(): string {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync('/proc/self/stat', 'utf8');
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
      const fields = afterComm.split(' ');
      return fields[2] ?? '';
    } catch {
      return '';
    }
  }
  try {
    const result = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {
      encoding: 'utf8',
    });
    if (result.status === 0) return result.stdout.trim();
    return '';
  } catch {
    return '';
  }
}

let activeCleanup: (() => void) | undefined;
let teardownInstalled = false;

export function installSignalTeardown(cleanup: () => void): void {
  activeCleanup = cleanup;
  if (teardownInstalled) return;
  teardownInstalled = true;
  const teardown = () => {
    err('termination signal — killing run tree and cleaning scratch');
    try {
      activeCleanup?.();
    } catch {
      /* best effort */
    }
    for (const child of liveChildren) killTree(child, 'SIGTERM');
    process.exit(143);
  };
  process.on('SIGTERM', teardown);
  process.on('SIGINT', teardown);
}
