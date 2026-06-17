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

interface EnvNumberEntry {
  name: string;
  raw: string;
  value: number;
}

function envNumber(name: string, fallback: number): EnvNumberEntry {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return { name, raw: String(fallback), value: fallback };
  }
  return { name, raw, value: Number(raw) };
}

function requireNonNegativeInteger(entry: EnvNumberEntry): number {
  if (!/^[0-9]+$/.test(entry.raw)) {
    throw new HaltError(`${entry.name} expects a non-negative integer`, 1);
  }
  return entry.value;
}

// Resolve one streaming runner's knobs from its AGENT_QUORUM_<prefix>_* env vars
// with the reference defaults. validateEnv gates the non-negative-integer checks
// and requirePositivePoll the positive-poll check, preserving the reference
// asymmetry: claude is validated (poll must be positive), cursor passes through.
function resolveStreamKnobs(
  prefix: string,
  validateEnv: boolean,
  requirePositivePoll: boolean,
): StreamKnobs {
  const byte = envNumber(`AGENT_QUORUM_${prefix}_STALL_TIMEOUT_SECONDS`, 600);
  const poll = envNumber(`AGENT_QUORUM_${prefix}_STALL_POLL_SECONDS`, 5);
  const grace = envNumber(`AGENT_QUORUM_${prefix}_STALL_INTERRUPT_GRACE_SECONDS`, 20);
  const wall = envNumber(`AGENT_QUORUM_${prefix}_CALL_TIMEOUT_SECONDS`, 1800);
  const semantic = envNumber(`AGENT_QUORUM_${prefix}_SEMANTIC_IDLE_TIMEOUT_SECONDS`, 900);
  if (validateEnv) {
    requireNonNegativeInteger(byte);
    requireNonNegativeInteger(poll);
    requireNonNegativeInteger(grace);
    requireNonNegativeInteger(wall);
    requireNonNegativeInteger(semantic);
  }
  if (requirePositivePoll && !(poll.value > 0)) {
    throw new HaltError(`AGENT_QUORUM_${prefix}_STALL_POLL_SECONDS expects a positive integer`, 1);
  }
  return {
    stallStatus: STALL_STATUS,
    pollSeconds: poll.value,
    graceSeconds: grace.value,
    byteTimeoutSeconds: byte.value,
    semanticTimeoutSeconds: semantic.value,
    wallTimeoutSeconds: wall.value,
  };
}

// Watchdog and pass knobs resolve from env with the reference defaults. Stream
// knobs derive per runner from RUNNER_META (non-streaming runners get the
// disabled sentinel); the fix/translate pass knobs are validated as before.
export function resolveWatchdogKnobs(): WatchdogKnobs {
  const stream = {} as Record<Runner, StreamKnobs>;
  for (const runner of RUNNERS) {
    const meta: RunnerMeta = RUNNER_META[runner];
    stream[runner] =
      meta.stream !== undefined
        ? resolveStreamKnobs(
            meta.stream.envPrefix,
            meta.stream.validateEnv,
            meta.stream.requirePositivePoll,
          )
        : DISABLED_STREAM_KNOBS;
  }

  const fixTimeout = envNumber('AGENT_QUORUM_FIX_PASS_TIMEOUT_SECONDS', 900);
  const fixSemantic = envNumber('AGENT_QUORUM_FIX_PASS_SEMANTIC_IDLE_TIMEOUT_SECONDS', 900);
  const fixRetries = envNumber('AGENT_QUORUM_FIX_PASS_RETRY_COUNT', 1);
  const translateTimeout = envNumber('AGENT_QUORUM_TRANSLATE_PASS_TIMEOUT_SECONDS', 900);
  const translateSemantic = envNumber(
    'AGENT_QUORUM_TRANSLATE_PASS_SEMANTIC_IDLE_TIMEOUT_SECONDS',
    900,
  );
  const translateRetries = envNumber('AGENT_QUORUM_TRANSLATE_PASS_RETRY_COUNT', 1);

  requireNonNegativeInteger(fixTimeout);
  requireNonNegativeInteger(fixSemantic);
  requireNonNegativeInteger(fixRetries);
  requireNonNegativeInteger(translateTimeout);
  requireNonNegativeInteger(translateSemantic);
  requireNonNegativeInteger(translateRetries);

  return {
    stream,
    fixPass: {
      timeoutSeconds: fixTimeout.value,
      semanticIdleTimeoutSeconds: fixSemantic.value,
      retryCount: fixRetries.value,
    },
    translatePass: {
      timeoutSeconds: translateTimeout.value,
      semanticIdleTimeoutSeconds: translateSemantic.value,
      retryCount: translateRetries.value,
    },
  };
}
