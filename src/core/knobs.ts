import type { ResolvedConfig, ResolvedStreamKnobs } from './config.js';
import { HaltError } from '../runtime/halt.js';
import {
  DISABLED_STREAM_KNOBS,
  RUNNER_META,
  RUNNERS,
  STREAM_RUNNERS,
} from '../providers/registry.js';
import type { Runner } from '../types.js';
import type { StreamKnobs } from '../providers/watchdog.js';

const STALL_STATUS = 124;

export interface PassKnobs {
  timeoutSeconds: number;
  semanticIdleTimeoutSeconds: number;
  retryCount: number;
}

export interface WatchdogKnobs {
  stream: Record<Runner, StreamKnobs>;
  fixPass: PassKnobs;
  translatePass: PassKnobs;
}

function streamKnobs(knobs: ResolvedStreamKnobs): StreamKnobs {
  return {
    stallStatus: STALL_STATUS,
    pollSeconds: knobs.pollSeconds,
    graceSeconds: knobs.graceSeconds,
    byteTimeoutSeconds: knobs.byteTimeoutSeconds,
    semanticTimeoutSeconds: knobs.semanticTimeoutSeconds,
    wallTimeoutSeconds: knobs.wallTimeoutSeconds,
  };
}

// Runners whose RUNNER_META sets requirePositivePoll must reject a zero poll on
// top of resolveConfig's non-negative check: a zero poll would busy-loop the watchdog.
export function resolveWatchdogKnobs(resolved: ResolvedConfig): WatchdogKnobs {
  const knobs = resolved.knobs;
  for (const runner of STREAM_RUNNERS) {
    const meta = RUNNER_META[runner];
    if (meta.stream.requirePositivePoll && !(knobs[runner].pollSeconds > 0)) {
      throw new HaltError(
        `AGENT_QUORUM_${meta.stream.envPrefix}_STALL_POLL_SECONDS expects a positive integer`,
        1,
      );
    }
  }
  const stream = {} as Record<Runner, StreamKnobs>;
  for (const runner of RUNNERS) {
    stream[runner] = DISABLED_STREAM_KNOBS;
  }
  for (const runner of STREAM_RUNNERS) {
    stream[runner] = streamKnobs(knobs[runner]);
  }
  return {
    stream,
    fixPass: knobs.fixPass,
    translatePass: knobs.translatePass,
  };
}
