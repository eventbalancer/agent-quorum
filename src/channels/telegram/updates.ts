import { isJsonObject, type JsonObject, type JsonValue } from '../../core/json.js';
import { telegramCall, type TelegramFailure } from './client.js';
import { TELEGRAM_HTTP_TIMEOUT_SLACK_SECONDS, type TelegramRuntime } from './config.js';

export interface TelegramUpdate {
  readonly updateId: number;
  readonly text: string;
  readonly replyToMessageId?: number;
}

export type TelegramFetch =
  | { readonly ok: true; readonly updates: TelegramUpdate[]; readonly nextOffset: number }
  | { readonly ok: false; readonly failure: TelegramFailure };

function rawUpdateId(entry: JsonValue): number | undefined {
  if (!isJsonObject(entry)) {
    return undefined;
  }
  return typeof entry.update_id === 'number' ? entry.update_id : undefined;
}

function renderMessageText(value: JsonValue | undefined): string {
  if (value === null || value === undefined || value === false) {
    return '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function messageChatId(message: JsonObject): string {
  const chat = isJsonObject(message.chat) ? message.chat : {};
  return typeof chat.id === 'string' ? chat.id : JSON.stringify(chat.id ?? null);
}

function messageReplyToId(message: JsonObject): number | undefined {
  const replyTo = isJsonObject(message.reply_to_message)
    ? message.reply_to_message.message_id
    : undefined;
  return typeof replyTo === 'number' ? replyTo : undefined;
}

// A chat-matched update with rendered text, or undefined when the entry is not a
// message for <chat>. A non-matching entry still advances the caller's bot-global
// offset through rawUpdateId; only chat messages become updates.
function parseChatUpdate(entry: JsonValue, chat: string): TelegramUpdate | undefined {
  if (!isJsonObject(entry) || typeof entry.update_id !== 'number') {
    return undefined;
  }
  const message = entry.message;
  if (!isJsonObject(message) || messageChatId(message) !== chat) {
    return undefined;
  }
  const replyToMessageId = messageReplyToId(message);
  return {
    updateId: entry.update_id,
    text: renderMessageText(message.text),
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
  };
}

// nextOffset comes from every raw update_id (not just chat-matched ones) because
// getUpdates confirms updates bot-globally; httpTimeoutSeconds bounds the HTTP
// abort independently of the long-poll so a hung receive surfaces promptly.
export async function telegramGetUpdates(
  runtime: TelegramRuntime,
  offset: number,
  timeout = 50,
  options: { httpTimeoutSeconds?: number } = {},
): Promise<TelegramFetch> {
  const getUpdatesParams = {
    offset: String(offset),
    timeout: String(timeout),
    allowed_updates: '["message"]',
  };
  const httpTimeoutSeconds =
    options.httpTimeoutSeconds ?? timeout + TELEGRAM_HTTP_TIMEOUT_SLACK_SECONDS;
  const getUpdatesOptions = {
    get: true,
    timeoutSeconds: httpTimeoutSeconds,
  };
  const telegramCallResult = await telegramCall(
    runtime,
    'getUpdates',
    getUpdatesParams,
    getUpdatesOptions,
  );
  if (!telegramCallResult.ok) {
    return { ok: false, failure: telegramCallResult.failure };
  }

  const chat = runtime.chatId;
  const entries = Array.isArray(telegramCallResult.body.result)
    ? telegramCallResult.body.result
    : [];
  const updates: TelegramUpdate[] = [];
  let maxRawId: number | undefined;
  for (const entry of entries) {
    const id = rawUpdateId(entry);
    if (id === undefined) {
      continue;
    }
    maxRawId = maxRawId === undefined ? id : Math.max(maxRawId, id);
    const update = parseChatUpdate(entry, chat);
    if (update !== undefined) {
      updates.push(update);
    }
  }

  const nextOffset = maxRawId === undefined ? offset : maxRawId + 1;
  return { ok: true, updates, nextOffset };
}
