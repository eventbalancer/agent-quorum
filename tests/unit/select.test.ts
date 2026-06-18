import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseSelector,
  resolveSelector,
  isRunRecord,
  type ResolvedRun,
} from '../../src/cli/select.js';
import { writeRunRecord, type RunRecordDraft } from '../../src/core/run-store.js';
import { pgidOf, procStartToken } from '../../src/runtime/proc.js';

let stateDir: string;

function draft(overrides: Partial<RunRecordDraft> = {}): RunRecordDraft {
  return {
    name: 'demo',
    pid: 999999,
    pgid: '0',
    procStartToken: 'tok',
    mode: 'plan',
    inputPath: '/tmp/in.md',
    workDir: path.join(stateDir, 'work'),
    logPath: path.join(stateDir, 'work', 'run.log'),
    plansDir: '/tmp/plans',
    startedAt: '2026-06-13T00:00:00Z',
    quality: 'balanced',
    state: 'running',
    ...overrides,
  };
}

function runIdOf(resolved: ResolvedRun | undefined): string | undefined {
  return resolved !== undefined && isRunRecord(resolved) ? resolved.runId : undefined;
}

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-select.'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe('parseSelector', () => {
  it('classifies a numeric (date-like) token as a pid, never an id', () => {
    expect(parseSelector('20260613')).toEqual({ kind: 'pid', value: 20260613 });
    expect(parseSelector('4242')).toEqual({ kind: 'pid', value: 4242 });
  });

  it('classifies runId-shaped tokens as id and other tokens as name', () => {
    expect(parseSelector('r000000abc-deadbeef')).toEqual({
      kind: 'id',
      value: 'r000000abc-deadbeef',
    });
    expect(parseSelector('feature-x')).toEqual({ kind: 'name', value: 'feature-x' });
  });

  it('honors --work and --last flags and returns undefined with no input', () => {
    expect(parseSelector('ignored', { work: '/w' })).toEqual({ kind: 'work', value: '/w' });
    expect(parseSelector(undefined, { last: true })).toEqual({ kind: 'last' });
    expect(parseSelector(undefined)).toBeUndefined();
  });
});

describe('resolveSelector', () => {
  it('resolves an exact runId and a unique runId prefix to the same record', () => {
    const only = writeRunRecord(stateDir, draft({ name: 'alpha' }));
    expect(runIdOf(resolveSelector({ kind: 'id', value: only.runId }, { stateDir }))).toBe(
      only.runId,
    );
    const prefixSelector = parseSelector(only.runId.slice(0, 10));
    expect(prefixSelector?.kind).toBe('id');
    expect(prefixSelector && runIdOf(resolveSelector(prefixSelector, { stateDir }))).toBe(
      only.runId,
    );
  });

  it('resolves a duplicate name to the most recent record', () => {
    const older = writeRunRecord(
      stateDir,
      draft({ name: 'twin', startedAt: '2026-06-13T00:00:00Z' }),
    );
    const newer = writeRunRecord(
      stateDir,
      draft({ name: 'twin', startedAt: '2026-06-13T05:00:00Z' }),
    );
    expect(newer.runId).not.toBe(older.runId);
    expect(runIdOf(resolveSelector({ kind: 'name', value: 'twin' }, { stateDir }))).toBe(
      newer.runId,
    );
  });

  it('resolves --last to the most recent record overall', () => {
    writeRunRecord(stateDir, draft({ name: 'a', startedAt: '2026-06-13T00:00:00Z' }));
    const last = writeRunRecord(stateDir, draft({ name: 'b', startedAt: '2026-06-13T09:00:00Z' }));
    expect(runIdOf(resolveSelector({ kind: 'last' }, { stateDir }))).toBe(last.runId);
  });

  it('resolves a live pid to its owning record but not a dead pid', () => {
    const live = writeRunRecord(
      stateDir,
      draft({
        name: 'live',
        pid: process.pid,
        pgid: pgidOf(process.pid) ?? '0',
        procStartToken: procStartToken(process.pid) ?? 'tok',
      }),
    );
    expect(runIdOf(resolveSelector({ kind: 'pid', value: process.pid }, { stateDir }))).toBe(
      live.runId,
    );
    expect(resolveSelector({ kind: 'pid', value: 999998 }, { stateDir })).toBeUndefined();
  });

  it('resolves --work to a bare workDir without consulting the ledger', () => {
    const resolved = resolveSelector({ kind: 'work', value: '/some/work' }, { stateDir });
    expect(resolved).toEqual({ workDir: '/some/work' });
  });
});
