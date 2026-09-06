import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deliveryFixture } from '../helpers/delivery.js';
import { foreignSessions } from '../../src/delivery/session-ownership.js';
import type { RepositoryBroker } from '../../src/delivery/commands.js';

const fixtures: ReturnType<typeof deliveryFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.ledger.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

interface MissingWorktreeFixture {
  readonly fixture: ReturnType<typeof deliveryFixture>;
  readonly root: string;
  readonly worktree: string;
  readonly admin: string;
  readonly repository: Pick<RepositoryBroker, 'git'>;
}

function missingWorktreeFixture(): MissingWorktreeFixture {
  const fixture = deliveryFixture();
  fixtures.push(fixture);
  const root = realpathSync(fixture.root);
  fixture.ledger.changeMode('stopped', 'prepare canonical temporary repository');
  fixture.ledger.prepare({ ...fixture.mandate, sourceRoot: root });
  const git = (cwd: string, args: readonly string[]) => {
    const options: ExecFileSyncOptionsWithStringEncoding = {
      cwd,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    };
    return execFileSync('git', [...args], options).trim();
  };
  git(root, ['init', '--initial-branch=main']);
  git(root, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  ]);
  const worktree = path.join(root, 'other-session');
  git(root, ['worktree', 'add', '-b', 'session/other', worktree]);
  const admin = git(worktree, ['rev-parse', '--absolute-git-dir']);
  writeFileSync(path.join(admin, 'agent-quorum-task.md'), 'Investigate #42');
  rmSync(worktree, { recursive: true });
  return {
    fixture,
    root,
    worktree,
    admin,
    repository: {
      git: (cwd, args) => {
        return Promise.resolve(git(cwd, args));
      },
    },
  };
}

describe('delivery foreign-session ownership', () => {
  it('retains ambiguous and issue-associated sessions regardless of advisory marker expiration', async () => {
    const fixture = deliveryFixture();
    fixtures.push(fixture);
    const admin = path.join(fixture.root, 'admin');
    mkdirSync(admin);
    writeFileSync(path.join(admin, 'agent-quorum-task.md'), 'Investigate #42');
    writeFileSync(
      path.join(admin, 'agent-quorum-active-edit.json'),
      JSON.stringify({ refreshedAt: '2000-01-01', ttlSeconds: 1 }),
    );
    const sessions = await foreignSessions(fixture.ledger, {
      git: (cwd, args) =>
        Promise.resolve(
          args[0] === 'worktree'
            ? `worktree ${fixture.root}\nbranch refs/heads/main\n\nworktree ${fixture.root}/other\nbranch refs/heads/session/unknown\n`
            : cwd.endsWith('/other')
              ? admin
              : '',
        ),
    });
    expect(sessions).toEqual([
      {
        worktree: `${fixture.root}/other`,
        branch: 'refs/heads/session/unknown',
        issues: [42],
        ambiguous: false,
      },
    ]);
    writeFileSync(path.join(admin, 'agent-quorum-task.md'), 'Unassociated task');
    const ambiguous = await foreignSessions(fixture.ledger, {
      git: (_cwd, args) =>
        Promise.resolve(
          args[0] === 'worktree'
            ? `worktree ${fixture.root}/other\nbranch refs/heads/unknown\n`
            : admin,
        ),
    });
    expect(ambiguous[0]?.ambiguous).toBe(true);
    writeFileSync(path.join(admin, 'agent-quorum-done.json'), '{}');
    expect(
      await foreignSessions(fixture.ledger, {
        git: (_cwd, args) =>
          Promise.resolve(args[0] === 'worktree' ? `worktree ${fixture.root}/other\n` : admin),
      }),
    ).toEqual([]);
  });

  it('honors an existing done marker for a missing registered worktree without modifying its records', async () => {
    const { fixture, worktree, admin, repository } = missingWorktreeFixture();
    const doneFile = path.join(admin, 'agent-quorum-done.json');
    const done = JSON.stringify({ branch: 'session/other', doneAt: '2026-07-01T00:00:00Z' });
    writeFileSync(doneFile, done);
    expect(await foreignSessions(fixture.ledger, repository)).toEqual([]);
    expect(readFileSync(doneFile, 'utf8')).toBe(done);
    expect(readFileSync(path.join(admin, 'gitdir'), 'utf8').trim()).toBe(
      path.join(worktree, '.git'),
    );
  });

  it('keeps a missing unfinished worktree ambiguous even when its task names an issue', async () => {
    const { fixture, worktree, repository } = missingWorktreeFixture();
    expect(await foreignSessions(fixture.ledger, repository)).toEqual([
      { worktree, branch: 'refs/heads/session/other', issues: [], ambiguous: true },
    ]);
  });

  it.each(['commondir', 'HEAD', 'missing-head', 'aliased-gitdir', 'aliased-marker'])(
    'does not admit a missing worktree completion with %s metadata',
    async (fault) => {
      const { fixture, root, worktree, admin, repository } = missingWorktreeFixture();
      const inventory = await repository.git(root, ['worktree', 'list', '--porcelain'], 0);
      const observedRepository: Pick<RepositoryBroker, 'git'> = {
        git: (cwd, args, issue) => {
          if (args[0] === 'worktree') {
            return Promise.resolve(inventory);
          }
          return repository.git(cwd, args, issue);
        },
      };
      const doneFile = path.join(admin, 'agent-quorum-done.json');
      writeFileSync(doneFile, '{}');
      if (fault === 'commondir') {
        writeFileSync(path.join(admin, 'commondir'), root);
      } else if (fault === 'HEAD') {
        writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/main');
      } else if (fault === 'missing-head') {
        rmSync(path.join(admin, 'HEAD'));
      } else if (fault === 'aliased-gitdir') {
        const alias = path.join(root, 'alias');
        symlinkSync(root, alias);
        writeFileSync(path.join(admin, 'gitdir'), path.join(alias, 'other-session', '.git'));
      } else {
        const target = path.join(root, 'done.json');
        writeFileSync(target, '{}');
        rmSync(doneFile);
        symlinkSync(target, doneFile);
      }
      expect(await foreignSessions(fixture.ledger, observedRepository)).toEqual([
        { worktree, branch: 'refs/heads/session/other', issues: [], ambiguous: true },
      ]);
    },
  );

  it('keeps a completed but aliased missing path ambiguous', async () => {
    const { fixture, root, admin, repository } = missingWorktreeFixture();
    const alias = path.join(root, 'alias');
    const worktree = path.join(alias, 'other-session');
    symlinkSync(root, alias);
    writeFileSync(path.join(admin, 'gitdir'), path.join(worktree, '.git'));
    writeFileSync(path.join(admin, 'agent-quorum-done.json'), '{}');
    expect(await foreignSessions(fixture.ledger, repository)).toEqual([
      { worktree, branch: 'refs/heads/session/other', issues: [], ambiguous: true },
    ]);
  });

  it('does not choose between duplicate registrations for a missing completed path', async () => {
    const { fixture, admin, repository } = missingWorktreeFixture();
    writeFileSync(path.join(admin, 'agent-quorum-done.json'), '{}');
    cpSync(admin, path.join(path.dirname(admin), 'duplicate'), { recursive: true });
    const sessions = await foreignSessions(fixture.ledger, repository);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.ambiguous)).toBe(true);
  });
});
