import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepositoryBroker } from '../../src/delivery/commands.js';
import { digest } from '../../src/delivery/contract.js';
import { deliveryFixture } from '../helpers/delivery.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function fixture(
  interruption: 'created' | 'completed' | 'saved' = 'created',
  override: Readonly<Record<string, unknown>> = {},
  recordedIssue = 31,
) {
  const result = deliveryFixture();
  cleanups.push(() => {
    result.ledger.close();
    rmSync(result.root, { recursive: true, force: true });
  });
  const home = path.join(result.root, 'home');
  mkdirSync(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const git = (args: readonly string[], cwd = result.root) => {
    const execution = spawnSync(
      '/usr/bin/git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        ...args,
      ],
      {
        cwd,
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      },
    );
    expect(execution.status, execution.stderr).toBe(0);
    return execution.stdout.trim();
  };
  git(['init', '--initial-branch=main']);
  writeFileSync(path.join(result.root, 'README.md'), '# Original main\n');
  writeFileSync(path.join(result.root, 'package.json'), '{}\n');
  git(['add', 'README.md', 'package.json']);
  git(['commit', '-m', 'Original main']);
  const base = git(['rev-parse', 'HEAD']);
  const slug = `delivery-31-${digest(result.mandate).slice(0, 10)}`;
  const branch = `session/${slug}`;
  const worktree = path.join(home, '.agent-quorum/worktrees/agent-quorum', slug);
  mkdirSync(path.dirname(worktree), { recursive: true });
  const key = `worktree:31:${branch}`;
  result.ledger.intendEffect({
    key,
    kind: 'branch',
    issue: recordedIssue,
    state: 'intended',
    input: { worktree, branch, base, ...override },
  });
  git(['worktree', 'add', '-b', branch, worktree, base]);
  if (interruption !== 'created') {
    result.ledger.finishEffect(key, 'completed', { worktree, branch });
  }
  if (interruption === 'saved') {
    result.ledger.saveIssue({
      number: 31,
      nodeId: 'I31',
      title: 'Fixture',
      originalBody: 'Original problem',
      fingerprint: 'fixture',
      stage: 'refine',
      baseSha: base,
      worktree,
      branch,
      acceptance: [],
      decisions: [],
      dependencies: [],
      findingKeys: [],
    });
  }
  const permit = result.ledger.reserveActive(31, 0, Date.now(), 'fixture');
  result.ledger.settleActive(permit.id, 123.25, 'fixture');
  result.ledger.changeMode('blocked', 'fixture interruption');
  const mandate = { ...result.mandate, controllerDigest: 'new frozen controller' };
  result.ledger.prepare(mandate);
  result.ledger.changeMode('active', 'fixture reauthorization');
  writeFileSync(path.join(result.root, 'new-main.txt'), 'New main evidence\n');
  git(['add', 'new-main.txt']);
  git(['commit', '-m', 'Advance main']);
  const currentMain = git(['rev-parse', 'HEAD']);
  const broker = new RepositoryBroker(result.ledger, mandate, {
    deadlineEpochMs: Date.now() + 10000,
  });
  return { ...result, home, worktree, branch, key, base, currentMain, mandate, broker, git };
}

describe('durable delivery worktree identity', () => {
  it.each(['created', 'completed', 'saved'] as const)(
    'reuses the original Git worktree after interruption at %s and mandate/main rotation',
    async (interruption) => {
      const state = fixture(interruption);
      const before = state.ledger.budget(31, Date.now());
      const result = await state.broker.createWorktree(31, state.currentMain, state.key);
      expect(result).toEqual({
        worktree: state.worktree,
        branch: state.branch,
        baseSha: state.base,
      });
      expect(state.ledger.effects()).toEqual([
        expect.objectContaining({
          key: state.key,
          state: 'completed',
          input: { worktree: state.worktree, branch: state.branch, base: state.base },
          output: { worktree: state.worktree, branch: state.branch },
        }),
      ]);
      expect(state.ledger.budget(31, Date.now())).toEqual(before);
      expect(state.git(['rev-parse', 'HEAD'], state.worktree)).toBe(state.base);
      expect(state.git(['worktree', 'list', '--porcelain']).match(/^worktree /gmu)).toHaveLength(2);
      const replacement = path.join(
        path.dirname(state.worktree),
        `delivery-31-${digest(state.mandate).slice(0, 10)}`,
      );
      expect(existsSync(replacement)).toBe(false);
      expect(await state.broker.createWorktree(31, state.currentMain)).toEqual(result);
    },
  );

  it.each([
    { base: 'not-a-commit' },
    { branch: 'session/delivery-32-aaaaaaaaaa' },
    { worktree: '/outside-owned-storage' },
  ])('rejects malformed recorded worktree intent %j', async (override) => {
    const state = fixture('created', override);
    await expect(state.broker.createWorktree(31, state.currentMain)).rejects.toThrow(
      'worktree-intent-invalid',
    );
    expect(state.ledger.effect(state.key)?.state).toBe('intended');
    expect(state.ledger.effects()).toHaveLength(1);
  });

  it('rejects multiple recorded intents and an explicitly mismatched recovery key', async () => {
    const state = fixture();
    await expect(
      state.broker.createWorktree(31, state.currentMain, 'different-effect'),
    ).rejects.toThrow('worktree-intent-identity-mismatch');
    state.ledger.intendEffect({
      key: 'worktree:31:session/delivery-31-aaaaaaaaaa',
      kind: 'branch',
      issue: 31,
      state: 'intended',
      input: { worktree: state.worktree, branch: state.branch, base: state.base },
    });
    await expect(state.broker.createWorktree(31, state.currentMain)).rejects.toThrow(
      'worktree-ownership-ambiguous',
    );
    expect(state.ledger.effect(state.key)?.state).toBe('intended');
  });

  it('rejects an original worktree key attributed to another issue', async () => {
    const state = fixture('created', {}, 32);
    await expect(state.broker.createWorktree(31, state.currentMain)).rejects.toThrow(
      'worktree-intent-invalid',
    );
    expect(state.ledger.effects()).toHaveLength(1);
    expect(state.ledger.effect(state.key)?.state).toBe('intended');
  });

  it('rejects completed output that attributes a different path to the original intent', async () => {
    const state = fixture();
    state.ledger.finishEffect(state.key, 'completed', {
      worktree: '/different',
      branch: state.branch,
    });
    await expect(state.broker.createWorktree(31, state.currentMain)).rejects.toThrow(
      'worktree-intent-output-mismatch',
    );
  });

  it('rejects a changed checked-out branch without claiming its worktree', async () => {
    const state = fixture();
    state.git(['checkout', '-b', 'foreign-branch'], state.worktree);
    await expect(state.broker.createWorktree(31, state.currentMain)).rejects.toThrow(
      'worktree-ownership-ambiguous',
    );
    expect(state.ledger.effect(state.key)?.state).toBe('intended');
  });

  it.each(['copied', 'symlinked'])(
    'rejects a %s Git pointer whose registered checkout is elsewhere',
    async (pointer) => {
      const state = fixture();
      const moved = path.join(state.home, 'moved-worktree');
      state.git(['worktree', 'move', state.worktree, moved]);
      mkdirSync(state.worktree);
      for (const file of ['README.md', 'package.json']) {
        copyFileSync(path.join(moved, file), path.join(state.worktree, file));
      }
      if (pointer === 'copied') {
        copyFileSync(path.join(moved, '.git'), path.join(state.worktree, '.git'));
      } else {
        symlinkSync(path.join(moved, '.git'), path.join(state.worktree, '.git'));
      }
      await expect(state.broker.createWorktree(31, state.currentMain)).rejects.toThrow(
        'worktree-ownership-ambiguous',
      );
      expect(state.ledger.effect(state.key)?.state).toBe('intended');
    },
  );

  it('requires the current mandate to authorize the original issue', async () => {
    const state = fixture();
    state.ledger.changeMode('blocked', 'fixture narrowing');
    const mandate = {
      ...state.mandate,
      profile: { ...state.mandate.profile, scope: { include: [], exclude: [31], priorities: [] } },
    };
    state.ledger.prepare(mandate);
    state.ledger.changeMode('active', 'fixture narrower authorization');
    await expect(
      new RepositoryBroker(state.ledger, mandate, {}).createWorktree(31, state.currentMain),
    ).rejects.toThrow('issue-outside-mandate');
    expect(state.ledger.effect(state.key)?.state).toBe('intended');
  });
});
