import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { err } from './log.js';
import { ps, psField } from './proc.js';

const liveChildren = new Set<ChildProcess>();
const isolatedChildren = new WeakSet<ChildProcess>();
const exitResults = new WeakMap<ChildProcess, Promise<number>>();

// Providers run in their own process group (detached) so the watchdog and the
// TERM/INT teardown can kill whole subtrees with one negative-pgid signal.
export function spawnDetached(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawnOwned(command, args, options, true);
}

export function spawnOwned(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
  isolated = true,
): ChildProcess {
  const child = spawn(command, args, { ...options, detached: isolated });
  if (isolated) {
    isolatedChildren.add(child);
  }
  liveChildren.add(child);
  exitResults.set(child, observeExit(child));
  child.once('exit', () => liveChildren.delete(child));
  child.once('error', () => liveChildren.delete(child));
  return child;
}

export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    if (isolatedChildren.has(child)) {
      process.kill(-child.pid, signal);
    } else {
      signalDescendants(child.pid, signal);
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export function waitForExit(child: ChildProcess): Promise<number> {
  const observed = exitResults.get(child);
  if (observed !== undefined) {
    return observed;
  }
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  if (child.signalCode !== null) {
    return Promise.resolve(128 + os.constants.signals[child.signalCode]);
  }
  const result = observeExit(child);
  exitResults.set(child, result);
  return result;
}

function observeExit(child: ChildProcess): Promise<number> {
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

function signalDescendants(pid: number, signal: NodeJS.Signals): void {
  const output = ps(['-axo', 'pid=,ppid=']);
  if (output === '') {
    return;
  }
  const relationships = output
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const descendants = new Set([pid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [childPid, parentPid] of relationships) {
      if (
        childPid !== undefined &&
        parentPid !== undefined &&
        descendants.has(parentPid) &&
        !descendants.has(childPid)
      ) {
        descendants.add(childPid);
        changed = true;
      }
    }
  }
  for (const childPid of [...descendants].reverse()) {
    if (childPid === pid) {
      continue;
    }
    try {
      process.kill(childPid, signal);
    } catch {
      /* already gone */
    }
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function interruptThenTerminate(
  child: ChildProcess,
  graceSeconds: number,
): Promise<void> {
  if (hasExited(child)) {
    await terminateOwned(child, 0);
    return;
  }
  killTree(child, 'SIGINT');
  const deadline = Date.now() + graceSeconds * 1000;
  while (Date.now() < deadline) {
    if (hasExited(child)) {
      await terminateOwned(child, 0);
      return;
    }
    await sleep(200);
  }
  await terminateOwned(child, 1000);
}

export async function terminateOwned(child: ChildProcess, graceMs = 1000): Promise<void> {
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new TypeError('termination grace must be finite and non-negative');
  }
  killTree(child, 'SIGTERM');
  const deadline = performance.now() + graceMs;
  while (!hasExited(child) && performance.now() < deadline) {
    await sleep(Math.min(20, Math.max(1, deadline - performance.now())));
  }
  killTree(child, 'SIGKILL');
  await waitForExit(child);
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
  return psField(process.pid, 'pgid');
}

let activeCleanup: (() => void) | undefined;
let teardownInstalled = false;

export function installSignalTeardown(cleanup: () => void): void {
  activeCleanup = cleanup;
  if (teardownInstalled) {
    return;
  }
  teardownInstalled = true;
  const teardown = async () => {
    err('termination signal — killing run tree and cleaning scratch');
    await Promise.all([...liveChildren].map((child) => terminateOwned(child)));
    try {
      activeCleanup?.();
    } catch {
      /* best effort */
    }
    process.exit(143);
  };
  let terminating = false;
  const onSignal = () => {
    if (!terminating) {
      terminating = true;
      void teardown();
    }
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
