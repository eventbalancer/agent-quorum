import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, mkdirSync, openSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isAlive, pgidOf, procStartToken } from './proc.js';

interface WorkdirOwner {
  readonly token: string;
  readonly host: string;
  readonly pid: number;
  readonly pgid: string;
  readonly startToken: string;
}

export interface WorkdirLock {
  readonly token: string;
  readonly workDir: string;
  release(): void;
}

function canonicalPath(target: string): string {
  try {
    return realpathSync(target);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
    const parent = path.dirname(target);
    if (parent === target) {
      throw error;
    }
    return path.join(canonicalPath(parent), path.basename(target));
  }
}

function parseOwner(value: Record<string, unknown>): WorkdirOwner {
  if (
    typeof value.token !== 'string' ||
    typeof value.host !== 'string' ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.pgid !== 'string' ||
    typeof value.startToken !== 'string' ||
    value.startToken === ''
  ) {
    throw new Error('planning work directory ownership is unverifiable');
  }
  return value as unknown as WorkdirOwner;
}

function ownerAlive(owner: WorkdirOwner): boolean {
  if (owner.host !== os.hostname()) {
    return true;
  }
  if (!isAlive(owner.pid)) {
    return false;
  }
  const pgid = pgidOf(owner.pid);
  const startToken = procStartToken(owner.pid);
  return (
    pgid === undefined ||
    startToken === undefined ||
    (pgid === owner.pgid && startToken === owner.startToken)
  );
}

function withStore<T>(file: string, operation: (store: DatabaseSync) => T): T {
  const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
  chmodSync(file, 0o600);
  const store = new DatabaseSync(file);
  try {
    store.exec(
      'PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS workdir_owners (path TEXT PRIMARY KEY, token TEXT NOT NULL, host TEXT NOT NULL, pid INTEGER NOT NULL, pgid TEXT NOT NULL, startToken TEXT NOT NULL); BEGIN IMMEDIATE;',
    );
    try {
      const result = operation(store);
      store.exec('COMMIT');
      return result;
    } catch (error) {
      store.exec('ROLLBACK');
      throw error;
    }
  } finally {
    store.close();
  }
}

export function acquireWorkdirLock(workDir: string, handoffToken?: string): WorkdirLock {
  const canonical = canonicalPath(path.resolve(workDir));
  const parent = path.dirname(canonical);
  mkdirSync(parent, { recursive: true });
  const storeFile = path.join(parent, '.agent-quorum-work-locks.sqlite');
  const owner: WorkdirOwner = {
    token: randomUUID(),
    host: os.hostname(),
    pid: process.pid,
    pgid: pgidOf(process.pid) ?? '',
    startToken: procStartToken(process.pid) ?? '',
  };
  if (owner.pgid === '' || owner.startToken === '') {
    throw new Error('cannot establish planning work directory owner identity');
  }
  withStore(storeFile, (store) => {
    const row = store
      .prepare('SELECT token, host, pid, pgid, startToken FROM workdir_owners WHERE path = ?')
      .get(canonical);
    const existing = row === undefined ? undefined : parseOwner(row);
    if (handoffToken !== undefined) {
      if (existing === undefined) {
        throw new Error('planning work directory handoff has no existing owner');
      }
      if (existing.token !== handoffToken || existing.host !== owner.host) {
        throw new Error(`planning work directory is owned by another invocation: ${canonical}`);
      }
    } else if (existing !== undefined && ownerAlive(existing)) {
      throw new Error(
        `planning work directory is owned by an active or unverifiable process: ${canonical}`,
      );
    }
    store
      .prepare(
        'INSERT OR REPLACE INTO workdir_owners (path, token, host, pid, pgid, startToken) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(canonical, owner.token, owner.host, owner.pid, owner.pgid, owner.startToken);
  });
  return {
    token: owner.token,
    workDir: canonical,
    release() {
      withStore(storeFile, (store) => {
        store
          .prepare(
            'DELETE FROM workdir_owners WHERE path = ? AND token = ? AND pid = ? AND startToken = ?',
          )
          .run(canonical, owner.token, owner.pid, owner.startToken);
      });
    },
  };
}
