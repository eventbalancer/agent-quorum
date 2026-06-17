import type { ResolvedConfig, ResolvedStreamKnobs } from './config.js';
import { HaltError } from '../runtime/halt.js';
import {
  DISABLED_STREAM_KNOBS,
  RUNNER_META,
  RUNNERS,
  type RunnerMeta,
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

// Project the resolved knob values onto the watchdog shape, deriving the per-runner
// stream map from RUNNER_META: streaming runners use their resolved knobs, others
// the disabled sentinel. resolveConfig has already validated the values as
// non-negative integers; the claude poll must additionally be positive (a zero
// poll would busy-loop the watchdog).
export function resolveWatchdogKnobs(resolved: ResolvedConfig): WatchdogKnobs {
  const knobs = resolved.knobs;
  if (!(knobs.claude.pollSeconds > 0)) {
    throw new HaltError('AGENT_QUORUM_CLAUDE_STALL_POLL_SECONDS expects a positive integer', 1);
  }
  const resolvedStream: Partial<Record<Runner, ResolvedStreamKnobs>> = {
    claude: knobs.claude,
    cursor: knobs.cursor,
  };
  const stream = {} as Record<Runner, StreamKnobs>;
  for (const runner of RUNNERS) {
    const meta: RunnerMeta = RUNNER_META[runner];
    const resolvedRunnerKnobs = resolvedStream[runner];
    stream[runner] =
      meta.stream !== undefined && resolvedRunnerKnobs !== undefined
        ? streamKnobs(resolvedRunnerKnobs)
        : DISABLED_STREAM_KNOBS;
  }
  return {
    stream,
    fixPass: knobs.fixPass,
    translatePass: knobs.translatePass,
  };
}
