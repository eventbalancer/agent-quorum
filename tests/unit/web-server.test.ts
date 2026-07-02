import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { startWebServer, type WebServerHandle } from '../../src/cli/web/server.js';

interface MessagePayload {
  readonly message: { readonly id: number; readonly text: string; readonly ts: string };
}

interface MessageListPayload {
  readonly messages: readonly { readonly id: number; readonly text: string; readonly ts: string }[];
}

async function postMessage(handle: WebServerHandle, body: string): Promise<Response> {
  return await fetch(`${handle.url}api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('web workspace server', () => {
  it('serves the self-contained chat page at /', async () => {
    const handle = await startWebServer({ preferredPort: 0 });
    try {
      const response = await fetch(handle.url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.text();
      expect(body).toContain('id="transcript"');
      expect(body).toContain('id="message-input"');
      expect(body).toContain('id="send"');
      expect(body).toContain("fetch('/api/messages'");
      expect(body).not.toContain('http://');
      expect(body).not.toContain('https://');
    } finally {
      await handle.close();
    }
  });

  it('binds loopback only and reports the bound port in the url', async () => {
    const handle = await startWebServer({ preferredPort: 0 });
    try {
      expect(handle.usedFallback).toBe(false);
      expect(handle.url).toBe(`http://127.0.0.1:${String(handle.port)}/`);
    } finally {
      await handle.close();
    }
  });

  it('accepts posted messages and lists them in insertion order', async () => {
    const handle = await startWebServer({ preferredPort: 0 });
    try {
      const first = await postMessage(handle, JSON.stringify({ text: 'hello' }));
      expect(first.status).toBe(201);
      const firstPayload = (await first.json()) as MessagePayload;
      expect(firstPayload.message.text).toBe('hello');
      expect(firstPayload.message.id).toBe(1);
      expect(typeof firstPayload.message.ts).toBe('string');

      const second = await postMessage(handle, JSON.stringify({ text: 'second' }));
      expect(second.status).toBe(201);

      const list = await fetch(`${handle.url}api/messages`);
      expect(list.status).toBe(200);
      const listPayload = (await list.json()) as MessageListPayload;
      expect(listPayload.messages.map((message) => message.text)).toEqual(['hello', 'second']);
    } finally {
      await handle.close();
    }
  });

  it('rejects invalid json, blank text, unknown paths, and oversized bodies', async () => {
    const handle = await startWebServer({ preferredPort: 0 });
    try {
      const invalidJson = await postMessage(handle, 'not json');
      expect(invalidJson.status).toBe(400);

      const blankText = await postMessage(handle, JSON.stringify({ text: '  ' }));
      expect(blankText.status).toBe(400);

      const missingText = await postMessage(handle, JSON.stringify({}));
      expect(missingText.status).toBe(400);

      const unknownPath = await fetch(`${handle.url}nope`);
      expect(unknownPath.status).toBe(404);

      const oversized = await postMessage(handle, JSON.stringify({ text: 'a'.repeat(300 * 1024) }));
      expect(oversized.status).toBe(413);
    } finally {
      await handle.close();
    }
  });

  it('falls back to an ephemeral port when the preferred port is busy', async () => {
    const blocker = createNetServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const blockedPort = (blocker.address() as AddressInfo).port;
    const handle = await startWebServer({ preferredPort: blockedPort });
    try {
      expect(handle.usedFallback).toBe(true);
      expect(handle.port).not.toBe(blockedPort);
      const response = await fetch(handle.url);
      expect(response.status).toBe(200);
      await response.text();
    } finally {
      await handle.close();
      await new Promise<void>((resolve) => {
        blocker.close(() => {
          resolve();
        });
      });
    }
  });

  it('close() drains idle keep-alive connections and frees the port', async () => {
    const handle = await startWebServer({ preferredPort: 0 });
    const response = await fetch(handle.url);
    await response.text();
    const closeStartedAt = performance.now();
    await handle.close();
    expect(performance.now() - closeStartedAt).toBeLessThan(2000);
    await expect(fetch(handle.url)).rejects.toThrow();
  });
});
