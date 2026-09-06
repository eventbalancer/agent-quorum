import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
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
  readonly head: string;
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
        head: lines.find((line) => line.startsWith('HEAD '))?.slice(5) ?? '',
      };
    })
    .filter((entry) => entry.worktree !== '');
}

function readAdminFile(admin: string, name: string): string | undefined {
  const file = path.join(admin, name);
  if (lstatSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
    return undefined;
  }
  return readFileSync(file, 'utf8').trim();
}

async function isCompletedMissingSession(
  entry: WorktreeInventoryEntry,
  sourceRoot: string,
  repository: Pick<RepositoryBroker, 'git'>,
): Promise<boolean> {
  try {
    const isCanonicalMissingPath =
      path.isAbsolute(entry.worktree) &&
      path.normalize(entry.worktree) === entry.worktree &&
      lstatSync(entry.worktree, { throwIfNoEntry: false }) === undefined &&
      realpathSync(path.dirname(entry.worktree)) === path.dirname(entry.worktree);
    if (!isCanonicalMissingPath || !/^[a-f0-9]{40}$/.test(entry.head)) {
      return false;
    }
    const commonPath = await repository.git(
      sourceRoot,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      0,
    );
    const common = realpathSync(commonPath);
    const registrations = path.join(common, 'worktrees');
    if (realpathSync(registrations) !== registrations) {
      return false;
    }
    const matches = readdirSync(registrations, { withFileTypes: true })
      .filter((candidate) => candidate.isDirectory())
      .map((candidate) => path.join(registrations, candidate.name))
      .filter((admin) => readAdminFile(admin, 'gitdir') === path.join(entry.worktree, '.git'));
    const admin = matches[0];
    if (matches.length !== 1 || admin === undefined) {
      return false;
    }
    const registeredCommon = readAdminFile(admin, 'commondir');
    const expectedHead = entry.branch === '' ? entry.head : `ref: ${entry.branch}`;
    const hasMatchingRegistration =
      registeredCommon !== undefined &&
      realpathSync(path.resolve(admin, registeredCommon)) === common &&
      readAdminFile(admin, 'HEAD') === expectedHead;
    if (!hasMatchingRegistration || readAdminFile(admin, 'agent-quorum-done.json') === undefined) {
      return false;
    }
    const head = await repository.git(
      sourceRoot,
      ['rev-parse', '--verify', `${entry.branch || entry.head}^{commit}`],
      0,
    );
    return head === entry.head;
  } catch {
    return false;
  }
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
      sessions.push({
        worktree: entry.worktree,
        branch: entry.branch,
        issues,
        ambiguous: issues.length === 0,
      });
    } catch {
      if (!(await isCompletedMissingSession(entry, mandate.sourceRoot, repository))) {
        sessions.push({
          worktree: entry.worktree,
          branch: entry.branch,
          issues: [],
          ambiguous: true,
        });
      }
    }
  }
  return sessions;
}
