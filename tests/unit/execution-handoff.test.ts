import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readExecutionHandoff } from '../../src/runtime/execution-handoff.js';
import { spawnControlled } from '../../src/runtime/execution-control.js';
import { waitForExit } from '../../src/runtime/exec.js';

let root: string;
let server: Server;
const sockets = new Set<Socket>();
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'eh-'));
  server = createServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
  });
});
afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  if (server.listening) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      }),
    );
  }
  rmSync(root, { recursive: true, force: true });
});

function handoff(): string {
  const file = path.join(root, 'control.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      deadlineEpochMs: Date.now() + 10000,
      processGroup: 'shared',
      socketPath: path.join(root, 'guardian.sock'),
      nonce: 'n'.repeat(32),
    }),
    { mode: 0o600 },
  );
  return file;
}

describe('execution control handoff', () => {
  it('authenticates every admission and cancels an active child when its guardian disappears', async () => {
    const received: { type: string; nonce: string; requestId: string }[] = [];
    let watch: Socket | undefined;
    server.on('connection', (socket) => {
      let pending = '';
      socket.on('data', (chunk: Buffer) => {
        pending += chunk.toString();
        if (!pending.includes('\n')) {
          return;
        }
        const request = JSON.parse(pending.trim()) as {
          type: string;
          nonce: string;
          requestId: string;
        };
        received.push(request);
        if (request.type === 'watch') {
          watch = socket;
        }
        socket.write('{"ok":true}\n');
      });
    });
    server.listen(path.join(root, 'guardian.sock'));
    await once(server, 'listening');
    const control = readExecutionHandoff(handoff());
    const child = await spawnControlled(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
      { ...control, terminateGraceMs: 10 },
    );
    expect(received.map((request) => request.type)).toEqual(['watch', 'before-spawn', 'spawned']);
    expect(new Set(received.map((request) => request.requestId)).size).toBe(3);
    expect(received.every((request) => request.nonce === 'n'.repeat(32))).toBe(true);
    watch?.destroy();
    expect(await waitForExit(child)).toBe(143);
    expect(control.signal?.aborted).toBe(true);
  });

  it('rejects an ambiguous or unavailable admission without attempting a spawn', async () => {
    server.on('connection', (socket) => socket.destroy());
    server.listen(path.join(root, 'guardian.sock'));
    await once(server, 'listening');
    const control = readExecutionHandoff(handoff());
    let started = false;
    await expect(
      spawnControlled(
        process.execPath,
        [],
        {},
        {
          ...control,
          onSpawn: () => {
            started = true;
          },
        },
      ),
    ).rejects.toThrow(/admission|aborted/);
    expect(started).toBe(false);
  });

  it('rejects permissive or invalid handoff files', () => {
    const file = handoff();
    chmodSync(file, 0o644);
    expect(() => readExecutionHandoff(file)).toThrow('owner-only');
    chmodSync(file, 0o600);
    writeFileSync(file, '{}');
    expect(() => readExecutionHandoff(file)).toThrow('invalid');
  });
});
