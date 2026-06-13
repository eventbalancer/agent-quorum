import { HaltError } from '../runtime/halt.js';
import type { StreamKnobs } from '../providers/watchdog.js';

const STALL_STATUS = 124;

export interface PassKnobs {
  timeoutSeconds: number;
  semanticIdleTimeoutSeconds: number;
  retryCount: number;
}

export interface WatchdogKnobs {
  claude: StreamKnobs;
  cursor: StreamKnobs;
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

// Watchdog and pass knobs resolve from env with the reference defaults. The
// reference validates only the claude and fix/translate knobs (cursor knobs
// pass through unvalidated); the claude poll must additionally be positive.
export function resolveWatchdogKnobs(): WatchdogKnobs {
  const claudeByte = envNumber('AGENT_QUORUM_CLAUDE_STALL_TIMEOUT_SECONDS', 600);
  const claudePoll = envNumber('AGENT_QUORUM_CLAUDE_STALL_POLL_SECONDS', 5);
  const claudeGrace = envNumber('AGENT_QUORUM_CLAUDE_STALL_INTERRUPT_GRACE_SECONDS', 20);
  const claudeWall = envNumber('AGENT_QUORUM_CLAUDE_CALL_TIMEOUT_SECONDS', 1800);
  const claudeSemantic = envNumber('AGENT_QUORUM_CLAUDE_SEMANTIC_IDLE_TIMEOUT_SECONDS', 900);
  const cursorByte = envNumber('AGENT_QUORUM_CURSOR_STALL_TIMEOUT_SECONDS', 600);
  const cursorPoll = envNumber('AGENT_QUORUM_CURSOR_STALL_POLL_SECONDS', 5);
  const cursorGrace = envNumber('AGENT_QUORUM_CURSOR_STALL_INTERRUPT_GRACE_SECONDS', 20);
  const cursorWall = envNumber('AGENT_QUORUM_CURSOR_CALL_TIMEOUT_SECONDS', 1800);
  const cursorSemantic = envNumber('AGENT_QUORUM_CURSOR_SEMANTIC_IDLE_TIMEOUT_SECONDS', 900);
  const fixTimeout = envNumber('AGENT_QUORUM_FIX_PASS_TIMEOUT_SECONDS', 900);
  const fixSemantic = envNumber('AGENT_QUORUM_FIX_PASS_SEMANTIC_IDLE_TIMEOUT_SECONDS', 900);
  const fixRetries = envNumber('AGENT_QUORUM_FIX_PASS_RETRY_COUNT', 1);
  const translateTimeout = envNumber('AGENT_QUORUM_TRANSLATE_PASS_TIMEOUT_SECONDS', 900);
  const translateSemantic = envNumber(
    'AGENT_QUORUM_TRANSLATE_PASS_SEMANTIC_IDLE_TIMEOUT_SECONDS',
    900,
  );
  const translateRetries = envNumber('AGENT_QUORUM_TRANSLATE_PASS_RETRY_COUNT', 1);

  requireNonNegativeInteger(claudeByte);
  requireNonNegativeInteger(claudePoll);
  requireNonNegativeInteger(claudeGrace);
  requireNonNegativeInteger(claudeWall);
  requireNonNegativeInteger(claudeSemantic);
  requireNonNegativeInteger(fixTimeout);
  requireNonNegativeInteger(fixSemantic);
  requireNonNegativeInteger(fixRetries);
  requireNonNegativeInteger(translateTimeout);
  requireNonNegativeInteger(translateSemantic);
  requireNonNegativeInteger(translateRetries);
  if (!(claudePoll.value > 0)) {
    throw new HaltError('AGENT_QUORUM_CLAUDE_STALL_POLL_SECONDS expects a positive integer', 1);
  }

  return {
    claude: {
      stallStatus: STALL_STATUS,
      pollSeconds: claudePoll.value,
      graceSeconds: claudeGrace.value,
      byteTimeoutSeconds: claudeByte.value,
      semanticTimeoutSeconds: claudeSemantic.value,
      wallTimeoutSeconds: claudeWall.value,
    },
    cursor: {
      stallStatus: STALL_STATUS,
      pollSeconds: cursorPoll.value,
      graceSeconds: cursorGrace.value,
      byteTimeoutSeconds: cursorByte.value,
      semanticTimeoutSeconds: cursorSemantic.value,
      wallTimeoutSeconds: cursorWall.value,
    },
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
