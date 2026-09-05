import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
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

  it('stops an uncooperative container command when owner heartbeats disappear', async () => {
    const directory = temporary();
    const receipt = path.join(directory, 'pid');
    const input = new PassThrough();
    const result = runContainerGuard(
      [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(receipt)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`,
      ],
      input,
    );
    const deadlineEpochMs = Date.now() + 5000;
    input.write(`${JSON.stringify({ deadlineEpochMs, validUntilEpochMs: Date.now() + 450 })}\n`);
    await expect.poll(() => existsSync(receipt)).toBe(true);
    const pid = Number(readFileSync(receipt, 'utf8'));
    expect(await result).toBe(143);
    expect(isAlive(pid)).toBe(false);
    input.destroy();
  });

  it('requires a fresh owner admission and accepts current pings after queued startup pings expire', async () => {
    const input = new PassThrough();
    const result = runContainerGuard([process.execPath, '-e', 'process.exit(0)'], input);
    input.write(
      `${JSON.stringify({ deadlineEpochMs: Date.now() + 5000, validUntilEpochMs: Date.now() - 5000 })}\n`,
    );
    input.write(
      `${JSON.stringify({ deadlineEpochMs: Date.now() + 5000, validUntilEpochMs: Date.now() + 450 })}\n`,
    );
    expect(await result).toBe(0);
    input.destroy();
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
