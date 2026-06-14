import { isJsonObject } from '../../core/json.js';
import { telegramCall } from './client.js';

export async function telegramSend(text: string): Promise<string | undefined> {
  const sendMessageParams = {
    chat_id: process.env.AGENT_QUORUM_TELEGRAM_CHAT_ID ?? '',
    text,
    disable_web_page_preview: 'true',
  };
  const telegramCallResult = await telegramCall('sendMessage', sendMessageParams);
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
