import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { randomQueue } = vi.hoisted(() => ({ randomQueue: [] as Buffer[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (size: number): Buffer => randomQueue.shift() ?? actual.randomBytes(size),
  };
});

import {
  deriveRunName,
  finalizeRunRecord,
  generateRunId,
  pruneRuns,
  readRunRecords,
  readRunRecordsAcross,
  resolveRunState,
  runNameFromWorkdir,
  runRecordPath,
  writeRunRecord,
  type RunRecord,
  type RunRecordDraft,
  type RunStateProbes,
} from '../../src/core/run-store.js';
import { HaltError } from '../../src/runtime/halt.js';

let stateDir: string;

function draft(overrides: Partial<RunRecordDraft> = {}): RunRecordDraft {
  return {
    name: 'demo',
    pid: 4242,
    pgid: '4242',
    procStartToken: 'tok-1',
    mode: 'plan',
    inputPath: '/tmp/in.md',
    workDir: path.join(stateDir, 'work'),
    logPath: path.join(stateDir, 'work', 'run.log'),
    plansDir: '/tmp/plans',
    startedAt: '2026-06-13T00:00:00Z',
    effort: 'high',
    state: 'running',
    ...overrides,
  };
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return { ...draft(), runId: 'r000000000-deadbeef', ...overrides };
}

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-runstore.'));
  randomQueue.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('run identity', () => {
  it('generateRunId yields a sortable, non-digit-leading id', () => {
    const id = generateRunId();
    expect(id).toMatch(/^r[0-9a-z]+-[0-9a-f]+$/);
    expect(/^[0-9]/.test(id)).toBe(false);
  });

  it('deriveRunName suffixes only on a tracked collision', () => {
    expect(deriveRunName([], 'feat')).toBe('feat');
    const first = [record({ runId: 'r1', name: 'feat' })];
    expect(deriveRunName(first, 'feat')).toBe('feat-2');
    const second = [...first, record({ runId: 'r2', name: 'feat-2' })];
    expect(deriveRunName(second, 'feat')).toBe('feat-3');
  });

  it('runNameFromWorkdir strips the loop- prefix', () => {
    expect(runNameFromWorkdir('/x/loop-feat')).toBe('feat');
    expect(runNameFromWorkdir('/x/custom')).toBe('custom');
  });
});

describe('run records', () => {
  it('writeRunRecord mints a non-digit id and a finalize round-trip preserves real paths', () => {
    const written = writeRunRecord(stateDir, draft());
    expect(/^[0-9]/.test(written.runId)).toBe(false);
    expect(existsSync(runRecordPath(stateDir, written.runId))).toBe(true);

    finalizeRunRecord(stateDir, written.runId, {
      state: 'finished',
      exitCode: 0,
      finalStatus: 'clean',
      endedAt: '2026-06-13T01:00:00Z',
    });

    const all = readRunRecords(stateDir);
    expect(all).toHaveLength(1);
    const read = all[0];
    expect(read?.runId).toBe(written.runId);
    expect(read?.state).toBe('finished');
    expect(read?.exitCode).toBe(0);
    expect(read?.finalStatus).toBe('clean');
    expect(read?.workDir).toBe(written.workDir);
    expect(read?.logPath).toBe(written.logPath);
  });

  it('regenerates and retries when the generated record path already exists', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    const bufA = Buffer.alloc(10, 0xaa);
    const bufB = Buffer.alloc(10, 0xbb);
    randomQueue.push(bufA, bufA, bufB);

    const first = writeRunRecord(stateDir, draft());
    const second = writeRunRecord(stateDir, draft());

    expect(second.runId).not.toBe(first.runId);
    expect(existsSync(runRecordPath(stateDir, first.runId))).toBe(true);
    expect(existsSync(runRecordPath(stateDir, second.runId))).toBe(true);
  });

  it('throws for a fixedRunId collision instead of regenerating', () => {
    const existing = writeRunRecord(stateDir, draft());
    expect(() => writeRunRecord(stateDir, draft(), { fixedRunId: existing.runId })).toThrow(
      HaltError,
    );
  });
});

describe('readRunRecordsAcross', () => {
  it('unions records across stores and dedupes repeated/trailing-slash derivations', () => {
    const other = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-runstore-b.'));
    try {
      const a = writeRunRecord(stateDir, draft({ name: 'alpha' }));
      const b = writeRunRecord(other, draft({ name: 'beta' }));

      const union = readRunRecordsAcross([stateDir, other]);
      expect(union.map((entry) => entry.runId).sort()).toEqual([a.runId, b.runId].sort());

      const deduped = readRunRecordsAcross([stateDir, `${stateDir}/`, stateDir]);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.runId).toBe(a.runId);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('collapses a symlinked duplicate store to a single read', () => {
    const written = writeRunRecord(stateDir, draft({ name: 'alpha' }));
    const linkParent = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-runstore-link.'));
    const link = path.join(linkParent, 'state-link');
    symlinkSync(stateDir, link);
    try {
      const deduped = readRunRecordsAcross([stateDir, link]);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.runId).toBe(written.runId);
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
    }
  });

  it('skips a missing or non-directory store without throwing', () => {
    const written = writeRunRecord(stateDir, draft({ name: 'alpha' }));
    const missing = path.join(stateDir, 'does-not-exist');
    const file = path.join(stateDir, 'a-file');
    writeFileSync(file, 'not a directory\n');
    const union = readRunRecordsAcross([missing, file, stateDir]);
    expect(union).toHaveLength(1);
    expect(union[0]?.runId).toBe(written.runId);
  });

  it('returns an empty array for empty input', () => {
    expect(readRunRecordsAcross([])).toEqual([]);
  });

  it('never rewrites record files', () => {
    const written = writeRunRecord(stateDir, draft({ name: 'alpha' }));
    const file = runRecordPath(stateDir, written.runId);
    const before = readFileSync(file);
    readRunRecordsAcross([stateDir, stateDir]);
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});

describe('resolveRunState', () => {
  const live: RunStateProbes = {
    isAlive: () => true,
    pgidOf: () => '4242',
    procStartToken: () => 'tok-1',
  };
  const dead: RunStateProbes = {
    isAlive: () => false,
    pgidOf: () => undefined,
    procStartToken: () => undefined,
  };
  const recycledPid: RunStateProbes = {
    isAlive: () => true,
    pgidOf: () => '4242',
    procStartToken: () => 'tok-RECYCLED',
  };

  it('keeps a genuinely live running record running', () => {
    expect(resolveRunState(record(), live)).toBe('running');
  });

  it('infers finished/failed for a dead running record by plan presence', () => {
    const rec = record();
    expect(resolveRunState(rec, dead)).toBe('failed');
    mkdirSync(rec.workDir, { recursive: true });
    writeFileSync(path.join(rec.workDir, 'plan.final.md'), '# done\n');
    expect(resolveRunState(rec, dead)).toBe('finished');
  });

  it('rejects a pgid-matching record whose start token no longer matches', () => {
    const rec = record();
    expect(resolveRunState(rec, recycledPid)).toBe('failed');
    mkdirSync(rec.workDir, { recursive: true });
    writeFileSync(path.join(rec.workDir, 'plan.final.md'), '# done\n');
    expect(resolveRunState(rec, recycledPid)).toBe('finished');
  });

  it('returns an already-terminal state unchanged', () => {
    expect(resolveRunState(record({ state: 'finished' }), dead)).toBe('finished');
  });
});

describe('pruneRuns', () => {
  function seedFinished(name: string, startedAt: string): string {
    const written = writeRunRecord(stateDir, draft({ name, startedAt }));
    finalizeRunRecord(stateDir, written.runId, {
      state: 'finished',
      exitCode: 0,
      endedAt: startedAt,
    });
    return written.runId;
  }

  it('removes terminal records beyond keepCount, keeps running, and dry-run removes none', () => {
    const running = writeRunRecord(stateDir, draft({ name: 'live' }));
    for (let i = 0; i < 4; i += 1) {
      seedFinished(`done-${i}`, `2026-06-1${i}T00:00:00Z`);
    }

    const dry = pruneRuns(stateDir, { keepCount: 2, dryRun: true });
    expect(dry.removed).toHaveLength(2);
    expect(readRunRecords(stateDir)).toHaveLength(5);

    const real = pruneRuns(stateDir, { keepCount: 2 });
    expect(real.removed).toHaveLength(2);
    const remaining = readRunRecords(stateDir);
    expect(remaining).toHaveLength(3);
    expect(remaining.some((entry) => entry.runId === running.runId)).toBe(true);
  });

  it('removes terminal records older than maxAgeDays', () => {
    const old = seedFinished('old', '2020-01-01T00:00:00Z');
    const recent = seedFinished('recent', '2026-06-13T00:00:00Z');
    const result = pruneRuns(stateDir, { keepCount: 100, maxAgeDays: 30 });
    expect(result.removed).toContain(old);
    expect(result.removed).not.toContain(recent);
  });
});
