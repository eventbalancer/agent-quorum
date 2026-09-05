import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { PROVIDER_FRAME_PREFIX, PROVIDER_MESSAGE_BYTES } from './provider-channel.js';

interface ContainerProvider {
  receive(value: unknown): boolean;
  close(): void;
}

export async function startContainerProvider(): Promise<ContainerProvider> {
  const pending = new Map<string, Socket>();
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    if (pending.size >= 16) {
      socket.destroy();
      return;
    }
    const id = randomUUID();
    pending.set(id, socket);
    let buffer = '';
    let requested = false;
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > PROVIDER_MESSAGE_BYTES || requested) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }
      try {
        const request: unknown = JSON.parse(buffer.slice(0, newline));
        requested = true;
        process.stdout.write(`\n${PROVIDER_FRAME_PREFIX}${JSON.stringify({ id, request })}\n`);
      } catch {
        socket.destroy();
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (pending.delete(id) && requested) {
        process.stdout.write(`\n${PROVIDER_FRAME_PREFIX}${JSON.stringify({ id, cancel: true })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen('/tmp/aq-provider.sock', () => {
      resolve();
    });
  });
  return {
    receive(value) {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('type' in value) ||
        value.type !== 'provider-response'
      ) {
        return false;
      }
      if ('id' in value && typeof value.id === 'string' && 'response' in value) {
        const socket = pending.get(value.id);
        pending.delete(value.id);
        socket?.end(`${JSON.stringify(value.response)}\n`);
      }
      return true;
    },
    close() {
      for (const socket of pending.values()) {
        socket.destroy();
      }
      pending.clear();
      server.close();
    },
  };
}
