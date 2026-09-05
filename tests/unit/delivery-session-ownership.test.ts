import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deliveryFixture } from '../helpers/delivery.js';
import { foreignSessions } from '../../src/delivery/session-ownership.js';

const fixtures: ReturnType<typeof deliveryFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.ledger.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

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
});
