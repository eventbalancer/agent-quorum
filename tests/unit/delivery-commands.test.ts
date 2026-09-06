import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RepositoryBroker,
  repositoryEnvironment,
  runDeliveryCommand,
  sandboxPolicy,
} from '../../src/delivery/commands.js';
import { dockerExecutorArgs } from '../../src/delivery/confined-executor.js';
import { runContainerGuard } from '../../src/delivery/container-guard.js';
import { isAlive } from '../../src/runtime/proc.js';
import { deliveryFixture } from '../helpers/delivery.js';

const directories: string[] = [];
afterEach(() => {
  directories.splice(0).forEach((directory) => {
    rmSync(directory, { recursive: true, force: true });
  });
});

function temporary(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'delivery-command-'));
  directories.push(directory);
  return directory;
}

function sendOwnerHeartbeats(
  input: PassThrough,
  deadlineEpochMs = Date.now() + 10_000,
): () => void {
  const heartbeat = () => {
    input.write(
      `${JSON.stringify({
        deadlineEpochMs,
        validUntilEpochMs: Math.min(deadlineEpochMs, Date.now() + 450),
      })}\n`,
    );
  };
  heartbeat();
  const timer = setInterval(heartbeat, 100);
  return () => {
    clearInterval(timer);
  };
}

describe('confined repository commands', () => {
  it('uses private candidate environment and no host-wide filesystem or loopback grants', () => {
    const scratch = temporary();
    const env = repositoryEnvironment(scratch);
    expect(env.HOME).toBe(path.join(scratch, 'home'));
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.PATH).not.toContain(`${path.delimiter}.${path.delimiter}`);
    const policy = sandboxPolicy('/candidate', scratch, '/control', '/source');
    expect(policy).not.toContain('(subpath "/")');
    expect(policy).not.toContain('localhost:*');
    expect(policy).toContain('(deny file-write* (subpath "/candidate/.git"))');
  });

  it('bounds output and fully collects successful command output', async () => {
    const success = await runDeliveryCommand({
      command: process.execPath,
      args: ['-e', "process.stdout.write('result'); process.stderr.write('diagnostic')"],
      cwd: temporary(),
      execution: { deadlineEpochMs: Date.now() + 5000 },
    });
    expect(success).toEqual({ exitCode: 0, stdout: 'result', stderr: 'diagnostic' });
    await expect(
      runDeliveryCommand({
        command: process.execPath,
        args: ['-e', "process.stdout.write('x'.repeat(9 * 1024 * 1024))"],
        cwd: temporary(),
        execution: { deadlineEpochMs: Date.now() + 5000 },
      }),
    ).rejects.toThrow('command-output-limit');
  });

  it('disables candidate-configured Git helpers and blocks custom filters before staging', async () => {
    const fixture = deliveryFixture();
    directories.push(fixture.root);
    const git = (args: readonly string[]) => {
      const result = spawnSync('/usr/bin/git', args, { cwd: fixture.worktree, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    };
    try {
      git(['init']);
      const hook = path.join(fixture.worktree, 'helper.sh');
      const sentinel = path.join(fixture.root, 'helper-ran');
      writeFileSync(hook, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o700 });
      git(['config', 'core.fsmonitor', hook]);
      const broker = new RepositoryBroker(fixture.ledger, fixture.mandate, {
        deadlineEpochMs: Date.now() + 5000,
      });
      await broker.git(fixture.worktree, ['status', '--porcelain'], 1);
      expect(existsSync(sentinel)).toBe(false);
      git(['config', 'filter.proposal.clean', hook]);
      await expect(broker.git(fixture.worktree, ['status', '--porcelain'], 1)).rejects.toThrow(
        'repository-external-git-command-configured',
      );
      expect(existsSync(sentinel)).toBe(false);
      await expect(broker.git(fixture.worktree, ['push', '--force'], 1, true)).rejects.toThrow(
        'forbidden-git-operation',
      );
    } finally {
      fixture.ledger.close();
    }
  });

  it('pins container image and exposes only the candidate and read-only frozen harness', () => {
    const image = `node@sha256:${'a'.repeat(64)}`;
    const args = dockerExecutorArgs({ image, worktree: '/candidate', runtimeRoot: '/frozen' }, [
      'pnpm',
      'run',
      'test',
    ]);
    expect(args).toContain('--network=none');
    expect(args).toContain('--pull=never');
    expect(args).toContain('--read-only');
    expect(args).toContain('type=bind,source=/frozen,target=/aq-harness,readonly');
    expect(args.filter((arg) => arg.startsWith('type=bind,')).join(' ')).not.toContain(
      'docker.sock',
    );
    expect(args.slice(-4)).toEqual([
      '/aq-harness/src/delivery/container-watchdog.py',
      'pnpm',
      'run',
      'test',
    ]);
    expect(() =>
      dockerExecutorArgs({ image: 'node:latest', worktree: '/candidate', runtimeRoot: '/frozen' }, [
        'true',
      ]),
    ).toThrow('digest-pinned');
    expect(() =>
      dockerExecutorArgs({ image, worktree: '/candidate,bad', runtimeRoot: '/frozen' }, ['true']),
    ).toThrow('executor-path');
  });

  it.each([-25, 25])(
    'renews a guarded command with a %i ms container clock offset',
    async (clockOffsetMs) => {
      const guard = new URL('../../src/delivery/container-guard.ts', import.meta.url).href;
      const program = `
        import { runContainerGuard } from ${JSON.stringify(guard)};
        const hostNow = Date.now;
        Date.now = () => hostNow() + ${clockOffsetMs};
        const status = await runContainerGuard(
          [process.execPath, '-e', "setTimeout(() => process.stdout.write('complete'), 750)"],
          process.stdin,
        );
        process.exit(status);
      `;
      const result = await runDeliveryCommand({
        command: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', program],
        cwd: temporary(),
        execution: { deadlineEpochMs: Date.now() + 5000 },
        keepAlive: true,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe('complete');
    },
  );

  it.each([
    { label: 'expired', validUntilOffsetMs: 0 },
    { label: 'overlong', validUntilOffsetMs: 501 },
  ])('rejects an $label heartbeat after owner admission', async ({ validUntilOffsetMs }) => {
    const input = new PassThrough();
    const result = runContainerGuard(
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      input,
    );
    const now = Date.now();
    const deadlineEpochMs = now + 5000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      input.write(`${JSON.stringify({ deadlineEpochMs, validUntilEpochMs: now + 400 })}\n`);
      input.write(
        `${JSON.stringify({ deadlineEpochMs, validUntilEpochMs: now + validUntilOffsetMs })}\n`,
      );
    } finally {
      clock.mockRestore();
    }
    try {
      expect(await result).toBe(143);
    } finally {
      input.end();
      await result;
      input.destroy();
    }
  });

  it('finishes stopping an uncooperative command despite late owner heartbeats', async () => {
    const directory = temporary();
    const receipt = path.join(directory, 'pid');
    const stopping = path.join(directory, 'stopping');
    const input = new PassThrough();
    const program = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(stopping)}, 'yes');
      });
      setInterval(() => {}, 1000);
      setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(receipt)}, String(process.pid));
      }, 600);
    `;
    const result = runContainerGuard([process.execPath, '-e', program], input);
    const deadlineEpochMs = Date.now() + 10_000;
    let stopHeartbeats = sendOwnerHeartbeats(input, deadlineEpochMs);
    try {
      await expect
        .poll(() => (existsSync(receipt) ? readFileSync(receipt, 'utf8') : ''), { timeout: 5000 })
        .toMatch(/^[1-9][0-9]*$/);
      const pid = Number(readFileSync(receipt, 'utf8'));
      stopHeartbeats();
      await expect.poll(() => existsSync(stopping), { timeout: 5000, interval: 10 }).toBe(true);
      stopHeartbeats = sendOwnerHeartbeats(input, deadlineEpochMs);
      expect(await result).toBe(143);
      expect(isAlive(pid)).toBe(false);
    } finally {
      stopHeartbeats();
      input.end();
      await result;
      input.destroy();
    }
  });

  it('requires a fresh owner admission and accepts current pings after queued startup pings expire', async () => {
    const input = new PassThrough();
    const result = runContainerGuard([process.execPath, '-e', 'process.exit(0)'], input);
    input.write(
      `${JSON.stringify({ deadlineEpochMs: Date.now() + 5000, validUntilEpochMs: Date.now() - 5000 })}\n`,
    );
    const stopHeartbeats = sendOwnerHeartbeats(input);
    try {
      expect(await result).toBe(0);
    } finally {
      stopHeartbeats();
      input.end();
      await result;
      input.destroy();
    }
    const disconnected = new PassThrough();
    const absent = runContainerGuard([process.execPath, '-e', 'process.exit(0)'], disconnected);
    disconnected.end();
    expect(await absent).toBe(143);
  });

  it.runIf(process.platform === 'darwin')(
    'enforces filesystem denial in the actual local sandbox',
    async () => {
      const root = temporary();
      const candidate = path.join(root, 'candidate');
      const scratch = path.join(root, 'scratch');
      mkdirSync(candidate);
      mkdirSync(scratch);
      const forbidden = path.join(root, 'outside');
      writeFileSync(forbidden, 'host secret');
      const program = `const fs=require('node:fs'); fs.writeFileSync('allowed','yes'); try { fs.readFileSync(${JSON.stringify(forbidden)}); process.exit(9); } catch (e) { if(e.code!=='EPERM'&&e.code!=='EACCES')process.exit(8); }`;
      const result = await runDeliveryCommand({
        command: '/usr/bin/sandbox-exec',
        args: [
          '-p',
          sandboxPolicy(candidate, scratch, '/control', '/source'),
          process.execPath,
          '-e',
          program,
        ],
        cwd: candidate,
        execution: { deadlineEpochMs: Date.now() + 5000 },
        env: repositoryEnvironment(scratch),
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(readFileSync(path.join(candidate, 'allowed'), 'utf8')).toBe('yes');
    },
  );
});
