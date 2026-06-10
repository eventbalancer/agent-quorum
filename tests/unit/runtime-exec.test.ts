import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { killTree, spawnDetached, waitForExit } from '../../src/runtime/exec.js';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('exec process groups', () => {
  it('killTree terminates the whole detached child tree', async () => {
    const child = spawnDetached('sh', ['-c', 'sleep 30 & echo "grandchild:$!"; sleep 30'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    while (!stdout.includes('grandchild:')) {
      await sleep(50);
    }
    const grandchildPid = Number(/grandchild:(\d+)/.exec(stdout)?.[1]);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(isAlive(child.pid ?? -1)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    killTree(child, 'SIGTERM');
    const status = await waitForExit(child);
    expect(status).toBe(143);
    await sleep(200);
    expect(isAlive(grandchildPid)).toBe(false);
  });

  it('waitForExit maps clean exits to their code', async () => {
    const child = spawnDetached('sh', ['-c', 'exit 5'], { stdio: 'ignore' });
    expect(await waitForExit(child)).toBe(5);
  });

  it('waitForExit reports 127 for unknown binaries', async () => {
    const child = spawnDetached('plan-loop-no-such-binary', [], { stdio: 'ignore' });
    expect(await waitForExit(child)).toBe(127);
  });
});
