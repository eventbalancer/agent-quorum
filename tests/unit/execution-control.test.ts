import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  controlledDelay,
  ExecutionControlError,
  spawnControlled,
} from '../../src/runtime/execution-control.js';
import { killTree, waitForExit } from '../../src/runtime/exec.js';
import { isAlive, pgidOf } from '../../src/runtime/proc.js';
import { runWithRetries } from '../../src/runtime/retry.js';

const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        killTree(child, 'SIGKILL');
      }
      await waitForExit(child);
    }),
  );
});

describe('execution control', () => {
  it('reserves each attempt before spawning and records actual process identity', async () => {
    const events: string[] = [];
    const child = await spawnControlled(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 50)'],
      { stdio: 'ignore' },
      {
        beforeSpawn: () => {
          events.push('reserved');
        },
        onSpawn: (process) => {
          events.push('spawned');
          expect(process.pid).toBeGreaterThan(0);
          expect(process.pgid).not.toBe('');
          expect(process.procStartToken).not.toBe('');
        },
      },
    );
    children.push(child);
    expect(events).toEqual(['reserved', 'spawned']);
    expect(await waitForExit(child)).toBe(0);
    expect(await waitForExit(child)).toBe(0);
  });

  it('preserves the supervisor process group when requested', async () => {
    const child = await spawnControlled(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 50)'],
      { stdio: 'ignore' },
      { processGroup: 'shared' },
    );
    children.push(child);
    expect(pgidOf(child.pid ?? 0)).toBe(pgidOf(process.pid));
    expect(await waitForExit(child)).toBe(0);
  });

  it('never spawns after rejected admission or cancellation during reservation', async () => {
    let spawned = 0;
    await expect(
      spawnControlled(
        process.execPath,
        ['-e', 'process.exit(0)'],
        {},
        {
          beforeSpawn: () => {
            throw new Error('attempt exhausted');
          },
          onSpawn: () => {
            spawned += 1;
          },
        },
      ),
    ).rejects.toThrow('attempt exhausted');
    const abort = new AbortController();
    await expect(
      spawnControlled(
        process.execPath,
        [],
        {},
        {
          signal: abort.signal,
          beforeSpawn: () => {
            abort.abort();
          },
          onSpawn: () => {
            spawned += 1;
          },
        },
      ),
    ).rejects.toBeInstanceOf(ExecutionControlError);
    expect(spawned).toBe(0);
  });

  it('bounds an admission callback that never settles', async () => {
    let spawned = false;
    await expect(
      spawnControlled(
        process.execPath,
        [],
        {},
        {
          deadlineEpochMs: Date.now() + 50,
          beforeSpawn: () => new Promise<void>(() => undefined),
          onSpawn: () => {
            spawned = true;
          },
        },
      ),
    ).rejects.toThrow('deadline');
    expect(spawned).toBe(false);
  });

  it('sweeps an owned descendant when its group leader exits first', async () => {
    const child = await spawnControlled(
      process.execPath,
      [
        '-e',
        `
      const { spawn } = require('node:child_process');
      const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.stdout.write(String(nested.pid));
      nested.unref();
    `,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    children.push(child);
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    await waitForExit(child);
    const pid = Number(output);
    expect(pid).toBeGreaterThan(0);
    await expect.poll(() => isAlive(pid), { timeout: 2000 }).toBe(false);
  });

  it('escalates ignored termination and reaps before returning from the owned process', async () => {
    const abort = new AbortController();
    const child = await spawnControlled(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
      { signal: abort.signal, terminateGraceMs: 20 },
    );
    children.push(child);
    if (child.stdout === null) {
      throw new Error('missing stdout');
    }
    await once(child.stdout, 'data');
    abort.abort();
    expect(await waitForExit(child)).toBe(137);
  });

  it('enforces a deadline even when provider idle guards are disabled', async () => {
    const child = await spawnControlled(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: 'ignore' },
      { deadlineEpochMs: Date.now() + 300, terminateGraceMs: 50 },
    );
    children.push(child);
    expect(await waitForExit(child)).toBe(137);
  });

  it('interrupts retry waiting without spending another attempt', async () => {
    const abort = new AbortController();
    let attempts = 0;
    const result = runWithRetries(
      'fixture',
      { retryCount: 3, retryDelaySeconds: 100 },
      () => {
        attempts += 1;
        queueMicrotask(() => {
          abort.abort();
        });
        return { status: 1, retryable: true };
      },
      { signal: abort.signal },
    );
    await expect(result).rejects.toBeInstanceOf(ExecutionControlError);
    expect(attempts).toBe(1);
    await expect(controlledDelay(1000, { deadlineEpochMs: Date.now() - 1 })).rejects.toBeInstanceOf(
      ExecutionControlError,
    );
  });
});
