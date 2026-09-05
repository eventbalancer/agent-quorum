import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireWorkdirLock } from '../../src/runtime/workdir-lock.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'workdir-lock-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('planning work directory ownership', () => {
  it('excludes a second owner through path aliases and releases explicitly', () => {
    const work = path.join(root, 'work');
    const first = acquireWorkdirLock(work);
    symlinkSync(root, path.join(root, 'alias'));
    expect(() => acquireWorkdirLock(path.join(root, 'alias', 'work'))).toThrow('owned');
    first.release();
    const second = acquireWorkdirLock(work);
    first.release();
    expect(() => acquireWorkdirLock(work)).toThrow('owned');
    second.release();
  });

  it('recovers a provably dead local owner without using a time-to-live', () => {
    const work = path.join(root, 'work');
    const original = acquireWorkdirLock(work);
    const store = new DatabaseSync(path.join(root, '.agent-quorum-work-locks.sqlite'));
    store.exec('UPDATE workdir_owners SET pid = 2147483647');
    store.close();
    const recovered = acquireWorkdirLock(work);
    original.release();
    expect(() => acquireWorkdirLock(work)).toThrow('owned');
    recovered.release();
  });

  it('blocks malformed or foreign ownership without overwriting it', () => {
    const work = path.join(root, 'work');
    const original = acquireWorkdirLock(work);
    const store = new DatabaseSync(path.join(root, '.agent-quorum-work-locks.sqlite'));
    store.exec("UPDATE workdir_owners SET host = 'another-machine'");
    expect(() => acquireWorkdirLock(work)).toThrow('owned');
    store.exec("UPDATE workdir_owners SET startToken = ''");
    expect(() => acquireWorkdirLock(work)).toThrow('unverifiable');
    expect(store.prepare('SELECT startToken FROM workdir_owners').get()?.startToken).toBe('');
    store.close();
    original.release();
  });

  it('rejects a handoff without the exact existing lease', () => {
    const work = path.join(root, 'work');
    const original = acquireWorkdirLock(work);
    expect(() => acquireWorkdirLock(work, 'wrong-token')).toThrow('owned');
    original.release();
    expect(() => acquireWorkdirLock(work, original.token)).toThrow('no existing owner');
  });

  it('consumes a launch handoff exactly once and protects the new owner from parent cleanup', () => {
    const work = path.join(root, 'work');
    const parent = acquireWorkdirLock(work);
    const child = acquireWorkdirLock(work, parent.token);
    expect(child.token).not.toBe(parent.token);
    parent.release();
    expect(() => acquireWorkdirLock(work, parent.token)).toThrow('owned');
    expect(() => acquireWorkdirLock(work)).toThrow('owned');
    child.release();
  });
});
