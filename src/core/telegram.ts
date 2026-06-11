import { isJsonObject, type JsonObject, type JsonValue } from './json.js';

export function telegramApiBase(): string {
  return process.env.PLAN_LOOP_TELEGRAM_API_BASE ?? 'https://api.telegram.org';
}

export function telegramConfigured(): boolean {
  return (
    Boolean(process.env.PLAN_LOOP_TELEGRAM_BOT_TOKEN) &&
    Boolean(process.env.PLAN_LOOP_TELEGRAM_CHAT_ID)
  );
}

// Bot API call over global fetch (the in-process replacement for curl).
// Resolves with the parsed body, or undefined on transport failure or an
// ok:false envelope.
async function telegramCall(
  method: string,
  params: Record<string, string>,
  options: { get?: boolean; timeoutSeconds?: number } = {},
): Promise<JsonObject | undefined> {
  const token = process.env.PLAN_LOOP_TELEGRAM_BOT_TOKEN ?? '';
  const url = `${telegramApiBase()}/bot${token}/${method}`;
  const timeoutSeconds =
    options.timeoutSeconds ?? Number(process.env.PLAN_LOOP_TELEGRAM_HTTP_TIMEOUT ?? 70);
  const search = new URLSearchParams(params);
  try {
    const response = await fetch(options.get ? `${url}?${search.toString()}` : url, {
      method: options.get ? 'GET' : 'POST',
      ...(options.get
        ? {}
        : {
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: search.toString(),
          }),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    if (!response.ok) {
      return undefined;
    }
    const body = JSON.parse(await response.text()) as JsonValue;
    if (!isJsonObject(body) || body.ok !== true) {
      return undefined;
    }
    return body;
  } catch {
    return undefined;
  }
}

// Send a text message to the configured chat. Resolves with the new
// message_id, or undefined on failure.
export async function telegramSend(text: string): Promise<string | undefined> {
  const body = await telegramCall('sendMessage', {
    chat_id: process.env.PLAN_LOOP_TELEGRAM_CHAT_ID ?? '',
    text,
    disable_web_page_preview: 'true',
  });
  if (body === undefined) {
    return undefined;
  }
  const result = isJsonObject(body.result) ? body.result : {};
  const messageId = result.message_id;
  if (messageId === null || messageId === undefined || messageId === false) {
    return '';
  }
  return typeof messageId === 'string' ? messageId : JSON.stringify(messageId);
}

export interface TelegramUpdate {
  updateId: number;
  text: string;
}

// Long-poll getUpdates from <offset>; resolves with the chat's messages or
// undefined on failure.
export async function telegramGetUpdates(
  offset: number,
  timeout = 50,
): Promise<TelegramUpdate[] | undefined> {
  const body = await telegramCall(
    'getUpdates',
    {
      offset: String(offset),
      timeout: String(timeout),
      allowed_updates: '["message"]',
    },
    { get: true, timeoutSeconds: timeout + 15 },
  );
  if (body === undefined) {
    return undefined;
  }
  const chat = process.env.PLAN_LOOP_TELEGRAM_CHAT_ID ?? '';
  const results = Array.isArray(body.result) ? body.result : [];
  const updates: TelegramUpdate[] = [];
  for (const entry of results) {
    if (!isJsonObject(entry)) {
      continue;
    }
    const message = entry.message;
    if (!isJsonObject(message)) {
      continue;
    }
    const chatObj = isJsonObject(message.chat) ? message.chat : {};
    const chatId = chatObj.id;
    const chatIdText = typeof chatId === 'string' ? chatId : JSON.stringify(chatId ?? null);
    if (chatIdText !== chat) {
      continue;
    }
    const updateId = entry.update_id;
    if (typeof updateId !== 'number') {
      continue;
    }
    const text = message.text;
    const rendered =
      text === null || text === undefined || text === false
        ? ''
        : typeof text === 'string'
          ? text
          : JSON.stringify(text);
    updates.push({ updateId, text: rendered });
  }
  return updates;
}
