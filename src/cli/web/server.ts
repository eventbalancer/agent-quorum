import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chatPageHtml } from './page.js';

export const DEFAULT_WEB_PORT = 4747;
export const WEB_HOST = '127.0.0.1';

const MAX_BODY_BYTES = 256 * 1024;

export interface ChatMessage {
  readonly id: number;
  readonly text: string;
  readonly ts: string;
}

export interface WebServerHandle {
  readonly url: string;
  readonly port: number;
  readonly usedFallback: boolean;
  close(): Promise<void>;
}

export interface StartWebServerOptions {
  readonly preferredPort?: number;
}

interface BodyReadOk {
  readonly kind: 'body';
  readonly text: string;
}

interface BodyReadTooLarge {
  readonly kind: 'too-large';
}

interface BodyReadFailed {
  readonly kind: 'failed';
}

type BodyReadOutcome = BodyReadOk | BodyReadTooLarge | BodyReadFailed;

type AppendChatMessage = (text: string) => ChatMessage;

function readRequestBody(request: IncomingMessage): Promise<BodyReadOutcome> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const settle = (outcome: BodyReadOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(outcome);
    };
    request.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        settle({ kind: 'too-large' });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      settle({ kind: 'body', text: Buffer.concat(chunks).toString('utf8') });
    });
    request.on('error', () => {
      settle({ kind: 'failed' });
    });
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sendChatPage(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(chatPageHtml());
}

function parseMessageText(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('text' in parsed)) {
    return undefined;
  }
  const { text } = parsed;
  if (typeof text !== 'string') {
    return undefined;
  }
  const trimmed = text.trim();
  return trimmed === '' ? undefined : trimmed;
}

async function handlePostMessage(
  request: IncomingMessage,
  response: ServerResponse,
  appendMessage: AppendChatMessage,
): Promise<void> {
  const outcome = await readRequestBody(request);
  if (outcome.kind === 'too-large') {
    sendJson(response, 413, { error: 'request body too large' });
    return;
  }
  if (outcome.kind === 'failed') {
    sendJson(response, 400, { error: 'request body unreadable' });
    return;
  }
  const text = parseMessageText(outcome.text);
  if (text === undefined) {
    sendJson(response, 400, { error: 'expected json body with a non-empty "text" string' });
    return;
  }
  sendJson(response, 201, { message: appendMessage(text) });
}

function createChatServer(): Server {
  const messages: ChatMessage[] = [];
  let nextId = 1;
  const appendMessage = (text: string): ChatMessage => {
    const message: ChatMessage = {
      id: nextId,
      text,
      ts: new Date().toISOString(),
    };
    nextId += 1;
    messages.push(message);
    return message;
  };
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      sendChatPage(response);
      return;
    }
    if (request.method === 'GET' && request.url === '/api/messages') {
      sendJson(response, 200, { messages });
      return;
    }
    if (request.method === 'POST' && request.url === '/api/messages') {
      void handlePostMessage(request, response, appendMessage);
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  });
}

function listenOnce(server: Server, port: number): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      resolve(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(undefined);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, WEB_HOST);
  });
}

// server.close() first so the listener stops accepting, then closeAllConnections()
// to drop established and idle keep-alive sockets; the reverse order races a new
// connection in between and can keep the server alive.
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}

export async function startWebServer(
  options: StartWebServerOptions = {},
): Promise<WebServerHandle> {
  const preferredPort = options.preferredPort ?? DEFAULT_WEB_PORT;
  const server = createChatServer();
  let usedFallback = false;
  const preferredError = await listenOnce(server, preferredPort);
  if (preferredError !== undefined) {
    if (preferredError.code !== 'EADDRINUSE') {
      throw preferredError;
    }
    const fallbackError = await listenOnce(server, 0);
    if (fallbackError !== undefined) {
      throw fallbackError;
    }
    usedFallback = true;
  }
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('web workspace: server bound without a tcp address');
  }
  const port = address.port;
  return {
    url: `http://${WEB_HOST}:${String(port)}/`,
    port,
    usedFallback,
    close: () => closeServer(server),
  };
}
