import { isJsonObject } from '../../core/json.js';
import { telegramCall } from './client.js';
import type { TelegramRuntime } from './config.js';

export async function telegramSend(
  runtime: TelegramRuntime,
  text: string,
): Promise<string | undefined> {
  const sendMessageParams = {
    chat_id: runtime.chatId,
    text,
    disable_web_page_preview: 'true',
  };
  const telegramCallResult = await telegramCall(runtime, 'sendMessage', sendMessageParams, {
    timeoutSeconds: runtime.httpTimeoutSeconds,
  });
  if (!telegramCallResult.ok) {
    return undefined;
  }
  const messageResult = isJsonObject(telegramCallResult.body.result)
    ? telegramCallResult.body.result
    : {};
  const messageId = messageResult.message_id;
  if (messageId === null || messageId === undefined || messageId === false) {
    return '';
  }
  return typeof messageId === 'string' ? messageId : JSON.stringify(messageId);
}
