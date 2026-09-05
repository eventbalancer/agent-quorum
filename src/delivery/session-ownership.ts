import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RepositoryBroker } from './commands.js';
import type { DeliveryLedger } from './ledger.js';

export interface ForeignSession {
  readonly worktree: string;
  readonly branch: string;
  readonly issues: readonly number[];
  readonly ambiguous: boolean;
}

interface WorktreeInventoryEntry {
  readonly worktree: string;
  readonly branch: string;
}

export function parseWorktreeInventory(text: string): readonly WorktreeInventoryEntry[] {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      return {
        worktree: lines.find((line) => line.startsWith('worktree '))?.slice(9) ?? '',
        branch: lines.find((line) => line.startsWith('branch '))?.slice(7) ?? '',
      };
    })
    .filter((entry) => entry.worktree !== '');
}

export async function foreignSessions(
  ledger: DeliveryLedger,
  repository: Pick<RepositoryBroker, 'git'>,
): Promise<readonly ForeignSession[]> {
  const mandate = ledger.mandate();
  const inventory = await repository.git(
    mandate.sourceRoot,
    ['worktree', 'list', '--porcelain'],
    0,
  );
  const owned = new Set([
    mandate.sourceRoot,
    ...ledger.issues().flatMap((issue) => (issue.worktree === undefined ? [] : [issue.worktree])),
  ]);
  const sessions: ForeignSession[] = [];
  for (const entry of parseWorktreeInventory(inventory)) {
    if (owned.has(entry.worktree)) {
      continue;
    }
    try {
      const admin = await repository.git(entry.worktree, ['rev-parse', '--absolute-git-dir'], 0);
      if (existsSync(path.join(admin, 'agent-quorum-done.json'))) {
        continue;
      }
      const descriptionPath = path.join(admin, 'agent-quorum-task.md');
      const description = existsSync(descriptionPath) ? readFileSync(descriptionPath, 'utf8') : '';
      const issues = [
        ...new Set(
          [
            ...description.matchAll(/#([1-9][0-9]*)\b/g),
            ...entry.branch.matchAll(/(?:issue|delivery)-([1-9][0-9]*)\b/g),
          ].map((match) => Number(match[1])),
        ),
      ];
      sessions.push({ ...entry, issues, ambiguous: issues.length === 0 });
    } catch {
      sessions.push({ ...entry, issues: [], ambiguous: true });
    }
  }
  return sessions;
}
