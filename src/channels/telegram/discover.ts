import { setTimeout as sleep } from 'node:timers/promises';
import { isJsonObject, type JsonValue } from '../../core/json.js';
import { HaltError } from '../../runtime/halt.js';
import { telegramCall } from './client.js';
import { TELEGRAM_HTTP_TIMEOUT_SLACK_SECONDS, type TelegramDiscoveryRuntime } from './config.js';

export interface DiscoverChatIdOptions {
  readonly timeoutSeconds: number;
  readonly code: string;
  // Invoked after the offset is fixed, so the code reply cannot be swallowed by the drain.
  readonly onReady: () => void | Promise<void>;
  readonly pollTimeoutSeconds?: number;
  readonly pollIntervalMs?: number;
}

const DRAIN_TIMEOUT_SECONDS = 0;
const DEFAULT_POLL_TIMEOUT_SECONDS = 25;
const DEFAULT_POLL_INTERVAL_MS = 250;

function rawUpdateId(entry: JsonValue): number | undefined {
  if (!isJsonObject(entry)) {
    return undefined;
  }
  return typeof entry.update_id === 'number' ? entry.update_id : undefined;
}

// Matches by code text, not chat: the chat id is exactly what discovery is learning.
function matchedChatId(entry: JsonValue, code: string): string | undefined {
  if (!isJsonObject(entry)) {
    return undefined;
  }
  const message = entry.message;
  if (!isJsonObject(message) || message.text !== code) {
    return undefined;
  }
  const chat = isJsonObject(message.chat) ? message.chat : {};
  if (typeof chat.id === 'string') {
    return chat.id;
  }
  return typeof chat.id === 'number' ? String(chat.id) : undefined;
}

async function getUpdates(
  runtime: TelegramDiscoveryRuntime,
  offset: number,
  timeoutSeconds: number,
): Promise<JsonValue[]> {
  const result = await telegramCall(
    runtime,
    'getUpdates',
    {
      offset: String(offset),
      timeout: String(timeoutSeconds),
      allowed_updates: '["message"]',
    },
    { get: true, timeoutSeconds: timeoutSeconds + TELEGRAM_HTTP_TIMEOUT_SLACK_SECONDS },
  );
  if (!result.ok) {
    if (result.failure.kind === 'conflict') {
      throw new HaltError(
        'telegram discovery: getUpdates returned 409 — a webhook is set; delete it (deleteWebhook) before running setup',
        1,
      );
    }
    throw new HaltError(`telegram discovery: getUpdates failed (${result.failure.kind})`, 1);
  }
  return Array.isArray(result.body.result) ? result.body.result : [];
}

// Drain pending updates to fix a high-water offset before onReady, so a stale message
// within Telegram's retention window cannot match the code.
export async function telegramDiscoverChatId(
  runtime: TelegramDiscoveryRuntime,
  options: DiscoverChatIdOptions,
): Promise<string> {
  const pollTimeoutSeconds = options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let offset = 0;
  for (const entry of await getUpdates(runtime, 0, DRAIN_TIMEOUT_SECONDS)) {
    const id = rawUpdateId(entry);
    if (id !== undefined) {
      offset = Math.max(offset, id + 1);
    }
  }

  await options.onReady();

  const deadline = Date.now() + options.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const remainingSeconds = Math.ceil((deadline - Date.now()) / 1000);
    const perPoll = Math.max(1, Math.min(pollTimeoutSeconds, remainingSeconds));
    for (const entry of await getUpdates(runtime, offset, perPoll)) {
      const id = rawUpdateId(entry);
      if (id !== undefined) {
        offset = Math.max(offset, id + 1);
      }
      const chatId = matchedChatId(entry, options.code);
      if (chatId !== undefined) {
        return chatId;
      }
    }
    if (Date.now() >= deadline) {
      break;
    }
    await sleep(pollIntervalMs);
  }
  throw new HaltError(
    'telegram discovery: timed out waiting for the code message — resend the code to your bot and retry setup',
    1,
  );
}
