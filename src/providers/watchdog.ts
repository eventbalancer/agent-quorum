import type { ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { killTree } from '../runtime/exec.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../core/json.js';

export interface StreamKnobs {
  stallStatus: number;
  pollSeconds: number;
  graceSeconds: number;
  byteTimeoutSeconds: number;
  semanticTimeoutSeconds: number;
  wallTimeoutSeconds: number;
}

// Shared mutable counters between the stream consumer and the watchdog: the
// consumer bumps bytes for every chunk and progress for every semantic event.
export class StreamState {
  bytes = 0;
  progress = 0;
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function sleepWatchingExit(child: ChildProcess, seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (exited(child)) {
      return;
    }
    await sleep(Math.min(200, Math.max(1, deadline - Date.now())));
  }
}

// Byte-idle, semantic-idle, and wall-clock guards over a provider stream. On
// trigger: SIGINT to the provider group, grace, then SIGTERM; resolves with the
// stall reason. Resolves undefined when the child exits on its own.
export async function watchStream(
  child: ChildProcess,
  state: StreamState,
  knobs: StreamKnobs,
): Promise<string | undefined> {
  const byteTo = knobs.byteTimeoutSeconds;
  const semTo = knobs.semanticTimeoutSeconds;
  const wallTo = knobs.wallTimeoutSeconds;
  if (!(byteTo > 0 || semTo > 0 || wallTo > 0)) {
    return undefined;
  }

  let elapsed = 0;
  let byteIdle = 0;
  let semIdle = 0;
  let lastBytes = -1;
  let lastProgress = 0;

  while (!exited(child)) {
    await sleepWatchingExit(child, knobs.pollSeconds);
    if (exited(child)) {
      return undefined;
    }
    elapsed += knobs.pollSeconds;

    const size = state.bytes;
    if (size !== lastBytes) {
      lastBytes = size;
      byteIdle = 0;
    } else {
      byteIdle += knobs.pollSeconds;
    }

    if (state.progress > lastProgress) {
      lastProgress = state.progress;
      semIdle = 0;
    } else {
      semIdle += knobs.pollSeconds;
    }

    let reason: string;
    if (wallTo > 0 && elapsed >= wallTo) {
      reason = `wall-clock timeout after ${elapsed}s (limit=${wallTo}s)`;
    } else if (byteTo > 0 && byteIdle >= byteTo) {
      reason = `no stream events for ${byteIdle}s (stream_bytes=${size})`;
    } else if (semTo > 0 && semIdle >= semTo) {
      reason = `no semantic progress for ${semIdle}s (stream_bytes=${size})`;
    } else {
      continue;
    }

    killTree(child, 'SIGINT');
    await sleepWatchingExit(child, knobs.graceSeconds);
    if (!exited(child)) {
      killTree(child, 'SIGTERM');
    }
    return reason;
  }
  return undefined;
}

function parseEvent(line: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(line) as JsonValue;
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Claude semantic-progress predicate: assistant text/tool_use, user
// tool_result, thinking_tokens heartbeats (any encoding), or the final result.
export function claudeProgressEvent(line: string): boolean {
  const event = parseEvent(line);
  if (!event) {
    return false;
  }
  if (event.type === 'thinking_tokens') {
    return true;
  }
  if (event.subtype === 'thinking_tokens') {
    return true;
  }
  if (event.thinking_tokens !== undefined && event.thinking_tokens !== null) {
    return true;
  }
  if (event.type === 'result') {
    return true;
  }
  const message = isJsonObject(event.message) ? event.message : undefined;
  const content = message && Array.isArray(message.content) ? message.content : [];
  if (event.type === 'assistant') {
    return content.some(
      (item) => isJsonObject(item) && (item.type === 'text' || item.type === 'tool_use'),
    );
  }
  if (event.type === 'user') {
    return content.some((item) => isJsonObject(item) && item.type === 'tool_result');
  }
  return false;
}

// Cursor semantic-progress predicate: assistant text, any tool_call, or result.
export function cursorProgressEvent(line: string): boolean {
  const event = parseEvent(line);
  if (!event) {
    return false;
  }
  if (event.type === 'tool_call') {
    return true;
  }
  if (event.type === 'result') {
    return true;
  }
  if (event.type === 'assistant') {
    const message = isJsonObject(event.message) ? event.message : undefined;
    const content = message && Array.isArray(message.content) ? message.content : [];
    return content.some((item) => isJsonObject(item) && item.type === 'text');
  }
  return false;
}
