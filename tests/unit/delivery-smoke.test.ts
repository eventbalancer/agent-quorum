import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readDeliverySmokeRequest,
  verifyDeliverySmokeWorkspace,
  runDeliverySmokeCli,
  type DeliverySmokeRequest,
} from '../../scripts/delivery-smoke.js';
import { deliveryFixture } from '../helpers/delivery.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'delivery-smoke-request.'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function request(): DeliverySmokeRequest {
  return {
    repositoryRoot: path.join(root, 'repository'),
    stateDirectory: path.join(root, 'state'),
    issue: 1,
    outputDir: path.join(root, 'evidence'),
    scenarioTimeoutMs: 1000,
    attemptLimit: 2,
    executionControlFile: path.join(root, 'control.json'),
    remainingActiveMs: 3000,
  };
}

function writeRequest(value: unknown): string {
  const file = path.join(root, 'request.json');
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

describe('explicit autonomous smoke request', () => {
  it('accepts only a private request with explicit absolute paths and finite bounds', () => {
    const value = request();
    expect(readDeliverySmokeRequest(writeRequest(value))).toEqual(value);
  });

  it('rejects broad permissions and symlink aliases', () => {
    const file = writeRequest(request());
    chmodSync(file, 0o644);
    expect(() => readDeliverySmokeRequest(file)).toThrow('owner-only regular file');
    chmodSync(file, 0o600);
    const alias = path.join(root, 'alias.json');
    symlinkSync(file, alias);
    expect(() => readDeliverySmokeRequest(alias)).toThrow('owner-only regular file');
  });

  it.each([
    { remainingActiveMs: 0 },
    { stateDirectory: 'relative-state' },
    { issue: 0 },
    { issue: 1.5 },
    { scenarioTimeoutMs: -1 },
    { attemptLimit: 1.5 },
    { executionControlFile: 'relative.json' },
    { unexpected: 'authority' },
  ])('rejects invalid request fields: %j', (changes) => {
    const file = writeRequest({ ...request(), ...changes });
    expect(() => readDeliverySmokeRequest(file)).toThrow(
      'unsupported fields or invalid explicit bounds',
    );
  });

  it('rejects unsupported invocation arguments without launching a provider', async () => {
    await expect(runDeliverySmokeCli(['--output', root])).rejects.toThrow('usage:');
  });
  it('checks actual clean revisions through brokered Git without running candidate fsmonitor or textconv', async () => {
    const fixture = deliveryFixture();
    try {
      const worktree = path.join(root, 'candidate');
      mkdirSync(worktree);
      const git = (...args: string[]) =>
        execFileSync(
          '/usr/bin/git',
          [
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'commit.gpgSign=false',
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.test',
            ...args,
          ],
          {
            cwd: worktree,
            encoding: 'utf8',
            env: {
              PATH: '/usr/bin:/bin',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
            },
          },
        ).trim();
      git('init', '-q');
      writeFileSync(path.join(worktree, 'source.ts'), 'export const value = 1;\n');
      writeFileSync(path.join(worktree, '.gitattributes'), '*.ts diff=fixture\n');
      writeFileSync(path.join(worktree, 'manifest.json'), '{}\n');
      git('add', '--all');
      git('commit', '-q', '-m', 'fixture implementation');
      const implementation = git('rev-parse', 'HEAD');
      writeFileSync(
        path.join(worktree, 'manifest.json'),
        JSON.stringify({ workspaceRevision: implementation }),
      );
      git('add', '--all');
      git('commit', '-q', '-m', 'fixture manifest');
      const candidate = git('rev-parse', 'HEAD');
      const marker = path.join(root, 'unsafe-git-hook-ran');
      const unsafe = path.join(root, 'unsafe-hook');
      writeFileSync(unsafe, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
      git('config', 'core.fsmonitor', unsafe);
      git('config', 'diff.fixture.textconv', unsafe);
      fixture.ledger.saveIssue({
        number: 1,
        nodeId: 'I_1',
        title: 'Fixture',
        originalBody: '',
        fingerprint: '',
        stage: 'live',
        baseSha: implementation,
        worktree,
        acceptance: [],
        decisions: [],
        dependencies: [],
        findingKeys: [],
      });
      const execution = { deadlineEpochMs: Date.now() + 10000, processGroup: 'shared' as const };
      await expect(
        verifyDeliverySmokeWorkspace(
          fixture.ledger,
          execution,
          1,
          worktree,
          implementation,
          path.join(worktree, 'manifest.json'),
        ),
      ).resolves.toBe(candidate);
      expect(existsSync(marker)).toBe(false);
      writeFileSync(path.join(worktree, 'source.ts'), 'export const value = 2;\n');
      await expect(
        verifyDeliverySmokeWorkspace(
          fixture.ledger,
          execution,
          1,
          worktree,
          implementation,
          path.join(worktree, 'manifest.json'),
        ),
      ).rejects.toThrow('live-workspace-must-be-clean');
      expect(existsSync(marker)).toBe(false);
      fixture.ledger.changeMode('revoked', 'fixture revoke');
      await expect(
        verifyDeliverySmokeWorkspace(
          fixture.ledger,
          execution,
          1,
          worktree,
          implementation,
          path.join(worktree, 'manifest.json'),
        ),
      ).rejects.toThrow('delivery-not-active');
    } finally {
      fixture.ledger.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
