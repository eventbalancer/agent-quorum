import { createServer, type Server } from 'node:http';

export interface TelegramStub {
  baseUrl: string;
  sent: string[];
  queueReply: (updateId: number, text: string) => void;
  close: () => Promise<void>;
}

// Minimal Bot API stub served over PLAN_LOOP_TELEGRAM_API_BASE. getUpdates pops
// one queued reply per call (mirroring the reference test queue); sendMessage
// records the text and returns a message id.
export async function startTelegramStub(chatId = '42'): Promise<TelegramStub> {
  const sent: string[] = [];
  const queue: { update_id: number; message: { chat: { id: number }; text: string } }[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const respond = (payload: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    if (url.pathname.endsWith('/getUpdates')) {
      const next = queue.shift();
      respond({ ok: true, result: next === undefined ? [] : [next] });
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

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    sent,
    queueReply: (updateId, text) => {
      queue.push({ update_id: updateId, message: { chat: { id: Number(chatId) }, text } });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
