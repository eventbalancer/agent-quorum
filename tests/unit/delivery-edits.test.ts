import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentDigest } from '../../src/delivery/contract.js';
import { EditBroker, type DeliveryEdit } from '../../src/delivery/edits.js';
import { deliveryFixture } from '../helpers/delivery.js';

const fixtures: ReturnType<typeof deliveryFixture>[] = [];
function fixture(): ReturnType<typeof deliveryFixture> {
  const result = deliveryFixture();
  fixtures.push(result);
  return result;
}
afterEach(() => {
  for (const value of fixtures.splice(0)) {
    value.ledger.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});

function patch(file: string, before: string, after: string): DeliveryEdit {
  return {
    kind: 'patch',
    path: file,
    baseSha256: contentDigest(before),
    mode: 420,
    hunks: [{ before, after }],
    content: null,
  };
}

describe('digest-bound delivery edits', () => {
  it('applies compact patches and reconciles an interrupted multi-file batch exactly once', () => {
    const { worktree, ledger } = fixture();
    writeFileSync(path.join(worktree, 'one.ts'), 'one');
    writeFileSync(path.join(worktree, 'two.ts'), 'two');
    const broker = new EditBroker(ledger);
    const edits = [patch('one.ts', 'one', 'first'), patch('two.ts', 'two', 'second')];
    expect(() => {
      broker.apply(1, worktree, edits, 'batch', (index) => {
        if (index === 0) {
          throw new Error('interruption');
        }
      });
    }).toThrow('interruption');
    expect(readFileSync(path.join(worktree, 'one.ts'), 'utf8')).toBe('first');
    expect(readFileSync(path.join(worktree, 'two.ts'), 'utf8')).toBe('two');
    broker.apply(1, worktree, edits, 'batch');
    broker.apply(1, worktree, edits, 'batch');
    expect(readFileSync(path.join(worktree, 'two.ts'), 'utf8')).toBe('second');
    expect(ledger.effects()).toHaveLength(1);
  });

  it('validates the complete batch before its first edit and preserves unrelated changes', () => {
    const { worktree, ledger } = fixture();
    writeFileSync(path.join(worktree, 'one.ts'), 'one');
    writeFileSync(path.join(worktree, 'two.ts'), 'changed by another process');
    expect(() => {
      new EditBroker(ledger).apply(1, worktree, [
        patch('one.ts', 'one', 'first'),
        patch('two.ts', 'two', 'second'),
      ]);
    }).toThrow('edit-base-digest-mismatch');
    expect(readFileSync(path.join(worktree, 'one.ts'), 'utf8')).toBe('one');
    expect(ledger.effects()).toHaveLength(0);
  });

  it('supports executable creation and deletion without symlink traversal', () => {
    const { worktree, ledger, root } = fixture();
    const broker = new EditBroker(ledger);
    broker.apply(1, worktree, [
      {
        kind: 'create',
        path: 'scripts/new.sh',
        baseSha256: null,
        mode: 493,
        hunks: [],
        content: '#!/bin/sh\nexit 0\n',
      },
    ]);
    expect(statSync(path.join(worktree, 'scripts/new.sh')).mode & 0o777).toBe(0o755);
    writeFileSync(path.join(root, 'private'), 'private');
    symlinkSync(path.join(root, 'private'), path.join(worktree, 'link'));
    expect(() => {
      broker.apply(1, worktree, [patch('link', 'private', 'changed')]);
    }).toThrow('symlink');
    expect(readFileSync(path.join(root, 'private'), 'utf8')).toBe('private');
  });

  it.each([
    '../outside',
    '/absolute',
    '.git/config',
    'dist/index.js',
    'pnpm-lock.yaml',
    '.env',
    '.codex/config.toml',
  ])('rejects disallowed target %s', (target) => {
    const { worktree, ledger } = fixture();
    expect(() => {
      new EditBroker(ledger).apply(1, worktree, [
        { kind: 'create', path: target, baseSha256: null, mode: 420, hunks: [], content: 'new' },
      ]);
    }).toThrow('edit-path');
  });

  it('rejects ambiguous hunks and release version changes', () => {
    const { worktree, ledger } = fixture();
    writeFileSync(path.join(worktree, 'repeat.ts'), 'one one');
    const ambiguous = {
      ...patch('repeat.ts', 'one one', 'after'),
      hunks: [{ before: 'one', after: 'two' }],
    };
    expect(() => {
      new EditBroker(ledger).apply(1, worktree, [ambiguous]);
    }).toThrow('not-unique');
    const before = JSON.stringify({ name: 'agent-quorum', version: '1.0.0' });
    writeFileSync(path.join(worktree, 'package.json'), before);
    expect(() => {
      new EditBroker(ledger).apply(1, worktree, [
        patch('package.json', before, JSON.stringify({ name: 'agent-quorum', version: '2.0.0' })),
      ]);
    }).toThrow('release-version');
  });

  it('rejects publication introduced by an automatic workflow', () => {
    const { worktree, ledger } = fixture();
    mkdirSync(path.join(worktree, '.github/workflows'), { recursive: true });
    expect(() => {
      new EditBroker(ledger).apply(1, worktree, [
        {
          kind: 'create',
          path: '.github/workflows/new.yml',
          baseSha256: null,
          mode: 420,
          hunks: [],
          content: 'on: push\njobs:\n  publish:\n    steps:\n      - run: npm publish\n',
        },
      ]);
    }).toThrow('workflow-edit-excluded');
  });
});
