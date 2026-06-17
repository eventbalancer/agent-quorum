import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';

export interface QueueReplyOptions {
  readonly replyTo?: number;
  // Override the chat the message comes from (defaults to the stub's chat id), so
  // discovery tests can seed a message from a different chat than the coded one.
  readonly chatId?: string;
}

export interface FailNextOptions {
  readonly status?: number;
  readonly errorCode?: number;
  readonly description?: string;
  readonly hang?: boolean;
  readonly times: number;
}

export interface TelegramStub {
  readonly baseUrl: string;
  readonly sent: readonly string[];
  readonly queueReply: (updateId: number, text: string, options?: QueueReplyOptions) => void;
  readonly failNext: (options: FailNextOptions) => void;
  readonly close: () => Promise<void>;
}

interface StubChat {
  readonly id: number;
}

interface StubReplyTo {
  readonly message_id: number;
}

interface StubMessage {
  readonly chat: StubChat;
  readonly text: string;
  reply_to_message?: StubReplyTo;
}

interface StubUpdate {
  readonly update_id: number;
  readonly message: StubMessage;
}

const HANG_RESPONSE_DELAY_MS = 60_000;

// Minimal Bot API stub served over AGENT_QUORUM_TELEGRAM_API_BASE. getUpdates
// returns the queued chat updates at or above the requested offset (honoring the
// bot-global offset so the broker journal dedupes correctly); sendMessage records
// the text and returns a message id. failNext injects classified receive failures
// (non-2xx, HTTP-200 ok:false error_code, non-2xx + body error_code, or a hang
// that outlives the client HTTP timeout) for a bounded number of getUpdates calls.
export async function startTelegramStub(chatId = '42'): Promise<TelegramStub> {
  const sent: string[] = [];
  const queue: StubUpdate[] = [];
  const sockets = new Set<Socket>();
  const hangTimers = new Set<NodeJS.Timeout>();
  let failSpec: FailNextOptions | undefined;
  let failRemaining = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const respond = (payload: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    if (url.pathname.endsWith('/getUpdates')) {
      if (failSpec !== undefined && failRemaining > 0) {
        const spec = failSpec;
        failRemaining -= 1;
        if (spec.hang === true) {
          const timer = setTimeout(() => {
            respond({ ok: true, result: [] });
          }, HANG_RESPONSE_DELAY_MS);
          hangTimers.add(timer);
          req.on('close', () => {
            clearTimeout(timer);
            hangTimers.delete(timer);
          });
          return;
        }
        const body: Record<string, unknown> = { ok: false };
        if (spec.errorCode !== undefined) {
          body.error_code = spec.errorCode;
          body.description = spec.description ?? 'injected failure';
        }
        respond(body, spec.status ?? 200);
        return;
      }
      const offset = Number(url.searchParams.get('offset') ?? '0');
      respond({
        ok: true,
        result: queue.filter((update) => update.update_id >= offset),
      });
      return;
    }
    if (url.pathname.endsWith('/sendMessage')) {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        sent.push(params.get('text') ?? '');
        respond({ ok: true, result: { message_id: sent.length } });
      });
      return;
    }
    respond({ ok: false });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    sent,
    queueReply: (updateId, text, options = {}) => {
      const message: StubMessage = { chat: { id: Number(options.chatId ?? chatId) }, text };
      if (options.replyTo !== undefined) {
        message.reply_to_message = { message_id: options.replyTo };
      }
      queue.push({ update_id: updateId, message });
    },
    failNext: (options) => {
      failSpec = options;
      failRemaining = options.times;
    },
    close: () => {
      return new Promise<void>((resolve, reject) => {
        for (const timer of hangTimers) {
          clearTimeout(timer);
        }
        hangTimers.clear();
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
