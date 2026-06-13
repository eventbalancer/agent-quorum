import { closeSync, openSync, writeSync } from 'node:fs';

export interface ColorStream {
  isTTY?: boolean;
}

// Computed per call (never cached at import time) so a NO_COLOR/isTTY change
// after module load takes effect. NO_COLOR follows no-color.org: present and
// non-empty disables color regardless of its value.
export function colorsEnabled(stream: ColorStream = process.stderr): boolean {
  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') {
    return false;
  }
  return stream.isTTY === true;
}

export const AGENT_QUORUM_PREFIX = '[agent-quorum]';
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

let runLogFd: number | undefined;

// Mirror every `[agent-quorum]` line into a run's own run.log for in-process runs.
// The detached launch child already has run.log as its stderr fd, so it sets
// AGENT_QUORUM_STDIO_IS_RUNLOG=1 and leaves the sink disabled to avoid double
// writes, keeping the detached run.log byte-identical.
export function enableRunLogSink(file: string): void {
  disableRunLogSink();
  try {
    runLogFd = openSync(file, 'a');
  } catch {
    runLogFd = undefined;
  }
}

export function disableRunLogSink(): void {
  if (runLogFd === undefined) {
    return;
  }
  try {
    closeSync(runLogFd);
  } catch {
    /* best effort */
  }
  runLogFd = undefined;
}

function emit(colorCode: string, message: string): void {
  const prefix = colorsEnabled()
    ? `${colorCode}${AGENT_QUORUM_PREFIX}\x1b[0m`
    : AGENT_QUORUM_PREFIX;
  process.stderr.write(`${prefix} ${message}\n`);
  if (runLogFd !== undefined) {
    try {
      writeSync(runLogFd, `${AGENT_QUORUM_PREFIX} ${message.replace(ANSI_PATTERN, '')}\n`);
    } catch {
      /* never let logging crash the run */
    }
  }
}

export function log(message: string): void {
  emit('\x1b[36m', message);
}

export function err(message: string): void {
  emit('\x1b[31m', message);
}
