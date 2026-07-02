import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { openInBrowser } from '../../src/cli/web/open.js';

interface RecordedSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: { readonly detached?: boolean; readonly stdio?: string };
}

class FakeOpenerChild extends EventEmitter {
  unrefCalls = 0;

  unref(): void {
    this.unrefCalls += 1;
  }
}

function fakeSpawn(recorded: RecordedSpawn[], child: FakeOpenerChild): typeof spawn {
  const spawnFn = (
    command: string,
    args: readonly string[],
    options: RecordedSpawn['options'],
  ): FakeOpenerChild => {
    recorded.push({ command, args, options });
    return child;
  };
  return spawnFn as unknown as typeof spawn;
}

const URL_UNDER_TEST = 'http://127.0.0.1:4747/';

describe('openInBrowser', () => {
  it('maps each platform to a detached, unref-ed opener command', async () => {
    const platformCases = [
      { platform: 'darwin', command: 'open', args: [URL_UNDER_TEST] },
      { platform: 'win32', command: 'cmd', args: ['/c', 'start', '', URL_UNDER_TEST] },
      { platform: 'linux', command: 'xdg-open', args: [URL_UNDER_TEST] },
    ] as const;
    for (const platformCase of platformCases) {
      const recorded: RecordedSpawn[] = [];
      const child = new FakeOpenerChild();
      const openResult = openInBrowser(URL_UNDER_TEST, {
        platform: platformCase.platform,
        spawnFn: fakeSpawn(recorded, child),
      });
      child.emit('exit', 0, null);
      await expect(openResult).resolves.toBe(true);
      expect(recorded).toEqual([
        {
          command: platformCase.command,
          args: [...platformCase.args],
          options: { detached: true, stdio: 'ignore' },
        },
      ]);
      expect(child.unrefCalls).toBe(1);
    }
  });

  it('resolves false when the opener exits nonzero', async () => {
    const child = new FakeOpenerChild();
    const openResult = openInBrowser(URL_UNDER_TEST, {
      platform: 'linux',
      spawnFn: fakeSpawn([], child),
    });
    child.emit('exit', 3, null);
    await expect(openResult).resolves.toBe(false);
  });

  it('resolves false when the opener is killed by a signal', async () => {
    const child = new FakeOpenerChild();
    const openResult = openInBrowser(URL_UNDER_TEST, {
      platform: 'linux',
      spawnFn: fakeSpawn([], child),
    });
    child.emit('exit', null, 'SIGKILL');
    await expect(openResult).resolves.toBe(false);
  });

  it('resolves false when the opener fails to spawn', async () => {
    const child = new FakeOpenerChild();
    const openResult = openInBrowser(URL_UNDER_TEST, {
      platform: 'darwin',
      spawnFn: fakeSpawn([], child),
    });
    child.emit('error', new Error('spawn open ENOENT'));
    await expect(openResult).resolves.toBe(false);
  });

  it('treats a child that outlives the timeout as a successful hand-off', async () => {
    const child = new FakeOpenerChild();
    const openResult = openInBrowser(URL_UNDER_TEST, {
      platform: 'linux',
      spawnFn: fakeSpawn([], child),
      timeoutMs: 20,
    });
    await expect(openResult).resolves.toBe(true);
  });
});
