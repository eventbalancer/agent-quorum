// Slack added to a long-poll duration to derive the default HTTP abort, so a
// single hung getUpdates aborts shortly after the server's long-poll window.
export const TELEGRAM_HTTP_TIMEOUT_SLACK_SECONDS = 15;

export const DEFAULT_TELEGRAM_POLL_TIMEOUT_SECONDS = 50;
export const DEFAULT_TELEGRAM_HTTP_TIMEOUT_SECONDS = 70;
export const DEFAULT_TELEGRAM_RECEIVE_FAILURE_WINDOW_SECONDS = 120;
export const DEFAULT_TELEGRAM_RECEIVE_BACKOFF_SECONDS = 2;

export interface TelegramTransport {
  readonly botToken: string;
  readonly apiBase: string;
}

export interface TelegramRuntime extends TelegramTransport {
  readonly chatId: string;
  readonly httpTimeoutSeconds: number;
  readonly pollTimeoutSeconds: number;
  readonly receiveFailureWindowSeconds: number;
  readonly receiveBackoffSeconds: number;
  readonly stateDir: string;
}

export interface TelegramDiscoveryRuntime extends TelegramTransport {
  readonly stateDir?: string;
}

export function telegramConfigured(runtime: TelegramRuntime): boolean {
  return Boolean(runtime.botToken) && Boolean(runtime.chatId);
}
