import { setTimeout as sleep } from 'node:timers/promises';
import type { ChildProcess } from 'node:child_process';
import { HaltError } from '../runtime/halt.js';
import { log } from '../runtime/log.js';
import type { TraceContext } from './trace.js';

const LIVENESS_HEARTBEAT_SECONDS_ENV = 'AGENT_QUORUM_LIVENESS_HEARTBEAT_SECONDS';
const DEFAULT_LIVENESS_HEARTBEAT_SECONDS = 30;
const POLL_SLICE_MS = 200;

interface ChildSettlement {
  readonly isSettled: () => boolean;
}

function trackChildSettlement(child: ChildProcess): ChildSettlement {
  let hasSpawnError = false;
  child.once('error', () => {
    hasSpawnError = true;
  });
  return {
    isSettled: () => hasSpawnError || child.exitCode !== null || child.signalCode !== null,
  };
}

async function sleepUntilSettledOrDuration(
  isSettled: () => boolean,
  durationMs: number,
): Promise<void> {
  let waited = 0;
  while (waited < durationMs && !isSettled()) {
    const slice = Math.min(POLL_SLICE_MS, durationMs - waited);
    await sleep(slice);
    waited += slice;
  }
}

export function livenessHeartbeatSeconds(): number {
  const raw = process.env[LIVENESS_HEARTBEAT_SECONDS_ENV];
  if (raw === undefined || raw === '') {
    return DEFAULT_LIVENESS_HEARTBEAT_SECONDS;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new HaltError(`${LIVENESS_HEARTBEAT_SECONDS_ENV} expects a non-negative integer`, 1);
  }
  return Number(raw);
}

// Wall-clock liveness for an in-flight provider call: one [agent-quorum] line per
// cadence interval while the child is alive. Writes only through log() and never
// touches StreamState, so it cannot defer or mask a watchdog stall.
export async function runLivenessHeartbeat(
  child: ChildProcess,
  context: TraceContext,
  seconds: number,
): Promise<void> {
  if (seconds <= 0) {
    return;
  }

  const { isSettled } = trackChildSettlement(child);
  const intervalMs = seconds * 1000;
  let elapsed = 0;
  let beats = 0;
  while (!isSettled()) {
    await sleepUntilSettledOrDuration(isSettled, intervalMs);
    if (isSettled()) {
      return;
    }
    elapsed += seconds;
    beats += 1;
    log(
      `${context.role}/${context.provider} still working — ${elapsed}s elapsed (liveness ${beats})`,
    );
  }
}
