import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function ps(args: string[]): string {
  try {
    const result = spawnSync('ps', args, {
      encoding: 'utf8',
      timeout: 1000,
      killSignal: 'SIGKILL',
    });
    if (result.status !== 0) {
      return '';
    }
    return result.stdout;
  } catch {
    return '';
  }
}

export function psField(pid: number, field: string): string {
  return ps(['-p', String(pid), '-o', `${field}=`]).trim();
}

// On Linux the comm field can contain spaces and parentheses; everything after
// the final ')' is the space-separated stat tail whose first entries are
// state, ppid, pgrp, ... (man proc, /proc/<pid>/stat).
function linuxStatTail(pid: number): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  } catch {
    return undefined;
  }
}

export function ppidOf(pid: number): number | undefined {
  if (process.platform === 'linux') {
    const tail = linuxStatTail(pid);
    const ppid = tail === undefined ? NaN : Number(tail[1]);
    return Number.isInteger(ppid) ? ppid : undefined;
  }
  const out = psField(pid, 'ppid');
  if (!/^[0-9]+$/.test(out)) {
    return undefined;
  }
  return Number(out);
}

export function pgidOf(pid: number): string | undefined {
  if (process.platform === 'linux') {
    const tail = linuxStatTail(pid);
    const pgrp = tail?.[2];
    return pgrp !== undefined && /^[0-9]+$/.test(pgrp) ? pgrp : undefined;
  }
  const out = psField(pid, 'pgid');
  return /^[0-9]+$/.test(out) ? out : undefined;
}

// A stable marker that changes when the pid is recycled by a different process:
// the process start time. macOS exposes it through `ps -o lstart`; Linux uses
// the starttime field (clock ticks since boot) from /proc/<pid>/stat.
export function procStartToken(pid: number): string | undefined {
  if (process.platform === 'linux') {
    const tail = linuxStatTail(pid);
    const startTime = tail?.[19];
    return startTime !== undefined && startTime !== '' ? startTime : undefined;
  }
  const out = psField(pid, 'lstart');
  return out === '' ? undefined : out;
}

export function commandOf(pid: number): string {
  return ps(['-p', String(pid), '-o', 'command=']).replace(/\n$/, '');
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
