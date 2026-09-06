import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertNoStageOrphans,
  assertStageProcessesStopped,
  stageProcesses,
} from '../../src/delivery/process-supervision.js';
import { isAlive } from '../../src/runtime/proc.js';

vi.mock('node:child_process', async (original) => {
  const module = await original<typeof import('node:child_process')>();
  return { ...module, spawn: vi.fn(module.spawn) };
});

const actualProcesses =
  await vi.importActual<typeof import('node:child_process')>('node:child_process');
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once('close', () => {
          resolve();
        });
        child.kill('SIGKILL');
      });
    }
  }
  vi.mocked(spawn).mockReset().mockImplementation(actualProcesses.spawn);
});

function snapshotProgram(program: string): void {
  vi.mocked(spawn).mockImplementation((_command, _args, options) => {
    const child = actualProcesses.spawn(process.execPath, ['-e', program], options);
    children.push(child);
    return child;
  });
}

describe('owned stage process supervision', () => {
  it('admits live descendants and refuses a helper reparented outside the owned group', async () => {
    const root = { pid: 100, parentPid: 10, group: 100, state: 'S' };
    const provider = { pid: 101, parentPid: 100, group: 100, state: 'S' };
    const helper = { pid: 102, parentPid: 101, group: 100, state: 'S' };
    await expect(
      assertNoStageOrphans('100', {}, () => Promise.resolve([root, provider, helper])),
    ).resolves.toBeUndefined();
    await expect(
      assertNoStageOrphans('100', {}, () => Promise.resolve([root, { ...helper, parentPid: 1 }])),
    ).rejects.toThrow('orphaned-provider-process');
  });

  it('waits for demonstrated group cleanup before acknowledging completion', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce([{ pid: 102, parentPid: 1, group: 100, state: 'S' }])
      .mockResolvedValue([]);
    await assertStageProcessesStopped('100', read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]?.[1]).toEqual(read.mock.calls[1]?.[1]);
  });

  it('passes one cleanup deadline to every fresh read and rejects proof arriving after it', async () => {
    const read = vi.fn(async () => {
      await sleep(270);
      return [];
    });
    await expect(assertStageProcessesStopped('100', read)).rejects.toThrow(
      'stage-process-cleanup-unconfirmed',
    );
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('asynchronous process evidence acquisition', () => {
  it('accepts a delayed fresh snapshot without blocking the event loop and excludes zombies', async () => {
    snapshotProgram(
      `setTimeout(() => process.stdout.write('100 1 100 S\\n101 100 100 Z\\n102 1 102 S\\n'), 150);`,
    );
    let heartbeat = false;
    const timer = setTimeout(() => {
      heartbeat = true;
    }, 25);
    try {
      await expect(stageProcesses('100')).resolves.toEqual([
        { pid: 100, parentPid: 1, group: 100, state: 'S' },
      ]);
      expect(heartbeat).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it('never admits a previous successful sample after a nonzero process exit', async () => {
    snapshotProgram(`process.stdout.write('100 1 100 S\\n');`);
    await expect(stageProcesses('100')).resolves.toHaveLength(1);
    snapshotProgram(`process.stderr.write('private process diagnostic');process.exit(7);`);
    const error: unknown = await stageProcesses('100').catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: 'stage-process-evidence-unavailable',
      evidence: { reason: 'exit', exitCode: 7, signal: null },
    });
    expect(JSON.stringify(error)).not.toContain('private process diagnostic');
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed process evidence', async () => {
    snapshotProgram(`process.stdout.write('not process evidence');`);
    await expect(stageProcesses('100')).rejects.toThrow('stage-process-evidence-invalid');
  });

  it.each(['deadline', 'cancel'] as const)(
    'kills an ignored-TERM sampler on %s and confirms process exit before rejecting',
    async (condition) => {
      snapshotProgram(`process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
      const cancellation = new AbortController();
      const control =
        condition === 'deadline'
          ? { deadlineMonotonicMs: performance.now() + 150 }
          : { signal: cancellation.signal };
      const timer = setTimeout(() => {
        cancellation.abort();
      }, 150);
      try {
        await expect(stageProcesses('100', control)).rejects.toMatchObject({
          evidence: {
            reason: condition === 'deadline' ? 'timeout' : 'cancelled',
            signal: 'SIGKILL',
          },
        });
        const child = children[0];
        expect(child?.pid).toBeDefined();
        expect(child?.signalCode).toBe('SIGKILL');
        expect(isAlive(child?.pid ?? -1)).toBe(false);
      } finally {
        clearTimeout(timer);
      }
    },
  );

  it('kills an overflowing sampler without retaining its excess output', async () => {
    snapshotProgram(`process.stdout.write(Buffer.alloc(9*1024*1024,65));setInterval(()=>{},1000);`);
    await expect(stageProcesses('100')).rejects.toMatchObject({
      evidence: { reason: 'output-limit', signal: 'SIGKILL' },
    });
  });

  it('enforces its finite default acquisition bound and confirms sampler exit', async () => {
    snapshotProgram(`process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
    await expect(stageProcesses('100')).rejects.toMatchObject({
      evidence: { reason: 'timeout', signal: 'SIGKILL' },
    });
    expect(children[0]?.signalCode).toBe('SIGKILL');
  });

  it('retains only an OS error code when the snapshot process cannot start', async () => {
    vi.mocked(spawn).mockImplementation((_command, _args, options) => {
      return actualProcesses.spawn('/missing-process-snapshot-fixture', [], options);
    });
    await expect(stageProcesses('100')).rejects.toMatchObject({
      evidence: { reason: 'spawn', errorCode: 'ENOENT' },
    });
  });

  it('refuses invalid deadlines and already cancelled reads before spawning', async () => {
    await expect(stageProcesses('100', { deadlineMonotonicMs: NaN })).rejects.toThrow(
      'stage-process-deadline-invalid',
    );
    await expect(stageProcesses('100', { signal: AbortSignal.abort() })).rejects.toMatchObject({
      evidence: { reason: 'cancelled' },
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
