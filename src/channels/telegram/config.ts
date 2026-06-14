// Slack added to a long-poll duration to derive the default HTTP abort, so a
// single hung getUpdates aborts shortly after the server's long-poll window.
export const TELEGRAM_HTTP_TIMEOUT_SLACK_SECONDS = 15;

export const DEFAULT_TELEGRAM_POLL_TIMEOUT_SECONDS = 50;
export const DEFAULT_TELEGRAM_HTTP_TIMEOUT_SECONDS = 70;
export const DEFAULT_TELEGRAM_RECEIVE_FAILURE_WINDOW_SECONDS = 120;
export const DEFAULT_TELEGRAM_RECEIVE_BACKOFF_SECONDS = 2;

export function telegramApiBase(): string {
  return process.env.AGENT_QUORUM_TELEGRAM_API_BASE ?? 'https://api.telegram.org';
}

export function telegramConfigured(): boolean {
  return (
    Boolean(process.env.AGENT_QUORUM_TELEGRAM_BOT_TOKEN) &&
    Boolean(process.env.AGENT_QUORUM_TELEGRAM_CHAT_ID)
  );
}
