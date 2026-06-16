import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadDashboard,
  loadRunDetail,
  readLogSince,
  readLogTail,
} from '../../src/cli/shell/data.js';
import { listCandidates } from '../../src/cli/picker.js';
import {
  finalizeRunRecord,
  writeRunRecord,
  type RunRecord,
  type RunRecordDraft,
} from '../../src/core/run-store.js';
import { pgidOf, procStartToken } from '../../src/runtime/proc.js';

let stateDir: string;
let homeDir: string;
let cwdDir: string;
let savedCwd: string;
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  savedEnv.set(key, process.env[key]);
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

function liveOverrides(): Partial<RunRecordDraft> {
  return {
    pid: process.pid,
    pgid: pgidOf(process.pid) ?? '0',
    procStartToken: procStartToken(process.pid) ?? 'tok',
  };
}

function draft(overrides: Partial<RunRecordDraft> = {}): RunRecordDraft {
  const work = overrides.workDir ?? path.join(stateDir, 'work');
  return {
    name: 'demo',
    pid: 999999,
    pgid: '0',
    procStartToken: 'tok',
    mode: 'plan',
    inputPath: '/tmp/in.md',
    workDir: work,
    logPath: path.join(work, 'run.log'),
    plansDir: '/tmp/plans',
    startedAt: '2026-06-13T00:00:00Z',
    effort: 'high',
    state: 'running',
    ...overrides,
  };
}

function projectStore(): string {
  return path.join(cwdDir, '.agents', 'plans', '.runs');
}

function finishedRecord(store: string, overrides: Partial<RunRecordDraft> = {}): RunRecord {
  const record = writeRunRecord(store, draft(overrides));
  finalizeRunRecord(store, record.runId, {
    state: 'finished',
    exitCode: 0,
    endedAt: '2026-06-13T10:00:00Z',
  });
  return record;
}

function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const st = statSync(full);
        out.push(`${path.relative(root, full)}|${st.size}|${st.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-shelldata.'));
  homeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-shelldata-home.'));
  cwdDir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-shelldata-cwd.'));
  savedEnv.clear();
  setEnv('AGENT_QUORUM_STATE_DIR', stateDir);
  setEnv('AGENT_QUORUM_HOME', homeDir);
  setEnv('AGENT_QUORUM_PLANS_DIR', undefined);
  setEnv('AGENT_QUORUM_RETAIN_COUNT', undefined);
  savedCwd = process.cwd();
  process.chdir(cwdDir);
});

afterEach(() => {
  process.chdir(savedCwd);
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

describe('loadDashboard', () => {
  it('groups runs by canonical store and matches listCandidates membership (parity)', () => {
    writeRunRecord(stateDir, draft({ ...liveOverrides(), name: 'in-state' }));
    writeRunRecord(projectStore(), draft({ ...liveOverrides(), name: 'in-project' }));

    const groups = loadDashboard();
    const byLabel = new Map(groups.map((group) => [group.label, group]));
    expect(byLabel.get('ambient')?.runs.map((row) => row.name)).toEqual(['in-state']);
    expect(byLabel.get('project-local')?.runs.map((row) => row.name)).toEqual(['in-project']);

    const dashboardIds = new Set(groups.flatMap((group) => group.runs.map((row) => row.runId)));
    const candidateIds = new Set(listCandidates().map((candidate) => candidate.record.runId));
    expect(dashboardIds).toEqual(candidateIds);
  });

  it('dedups an alias/symlinked store so a run appears exactly once', () => {
    symlinkSync(stateDir, path.join(homeDir, 'state'));
    writeRunRecord(stateDir, draft({ ...liveOverrides(), name: 'solo' }));

    const groups = loadDashboard();
    const rows = groups.flatMap((group) => group.runs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('solo');
    expect(groups).toHaveLength(1);
  });

  it('applies the global finished cap and keeps parity with listCandidates', () => {
    setEnv('AGENT_QUORUM_RETAIN_COUNT', '1');
    writeRunRecord(stateDir, draft({ ...liveOverrides(), name: 'live' }));
    finishedRecord(stateDir, { name: 'old', startedAt: '2026-06-10T00:00:00Z' });
    finishedRecord(projectStore(), { name: 'new', startedAt: '2026-06-14T00:00:00Z' });

    const rows = loadDashboard().flatMap((group) => group.runs);
    expect(rows.filter((row) => !row.isLive)).toHaveLength(1);
    expect(rows.find((row) => !row.isLive)?.name).toBe('new');

    const dashboardIds = new Set(rows.map((row) => row.runId));
    const candidateIds = new Set(listCandidates().map((candidate) => candidate.record.runId));
    expect(dashboardIds).toEqual(candidateIds);
  });

  it('omits a store whose runs are all beyond the global cap', () => {
    setEnv('AGENT_QUORUM_RETAIN_COUNT', '1');
    finishedRecord(stateDir, { name: 'old', startedAt: '2026-06-10T00:00:00Z' });
    finishedRecord(projectStore(), { name: 'new', startedAt: '2026-06-14T00:00:00Z' });

    const groups = loadDashboard();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.store).toBe(realpathSync(projectStore()));
    expect(groups[0]?.label).toBe('project-local');
  });

  it('sorts live runs before finished runs within a group regardless of start time', () => {
    finishedRecord(stateDir, { name: 'late-finished', startedAt: '2026-06-20T00:00:00Z' });
    writeRunRecord(
      stateDir,
      draft({ ...liveOverrides(), name: 'early-live', startedAt: '2026-06-01T00:00:00Z' }),
    );

    const rows = loadDashboard().flatMap((group) => group.runs);
    expect(rows.map((row) => row.name)).toEqual(['early-live', 'late-finished']);
    expect(rows[0]?.isLive).toBe(true);
  });
});

describe('loadRunDetail', () => {
  function seedFinished(): RunRecord {
    const work = path.join(stateDir, 'loop-detail');
    mkdirSync(work, { recursive: true });
    writeFileSync(path.join(work, 'plan.final.md'), 'final\n');
    writeFileSync(path.join(work, 'summary.md'), 'summary\n');
    writeFileSync(path.join(work, 'critique.v1.json'), '{}\n');
    writeFileSync(path.join(work, 'critique.v2.json'), '{}\n');
    writeFileSync(
      path.join(work, 'operator-interventions.jsonl'),
      `${JSON.stringify({ id: 'I1', ts: '2026-06-13T00:00:00Z', target: 'all', message: 'hi' })}\n`,
    );
    writeFileSync(path.join(work, 'run.log'), '[agent-quorum] first\n[agent-quorum] last event\n');
    return writeRunRecord(
      stateDir,
      draft({ name: 'detail', workDir: work, logPath: path.join(work, 'run.log') }),
    );
  }

  it('composes artifact, iteration, intervention, and last-event fields for a finished run', () => {
    const record = seedFinished();
    const detail = loadRunDetail(record);
    expect(detail.state).toBe('finished');
    expect(detail.artifacts).toEqual({ planFinal: true, summary: true });
    expect(detail.iterations).toBe(2);
    expect(detail.interventions.total).toBe('1');
    expect(detail.lastEvent).toBe('last event');
    expect(detail.process).toEqual({ available: false });
  });

  it('captures process info for a live run via the injected status engine', () => {
    const record = writeRunRecord(stateDir, draft({ ...liveOverrides(), name: 'live' }));
    const detail = loadRunDetail(record, {
      runStatus: (_args, out) => {
        out('PROCESS TREE\n');
        return 0;
      },
    });
    expect(detail.state).toBe('running');
    expect(detail.process).toEqual({ available: true, captured: 'PROCESS TREE\n' });
  });

  it('falls back to the record view when the live status call throws (dead-pid race)', () => {
    const record = writeRunRecord(stateDir, draft({ ...liveOverrides(), name: 'racing' }));
    const detail = loadRunDetail(record, {
      runStatus: () => {
        throw new Error('PID not found');
      },
    });
    expect(detail.state).toBe('running');
    expect(detail.process).toEqual({ available: false });
  });
});

describe('readLogTail / readLogSince', () => {
  it('marks a missing run.log as unavailable', () => {
    const missing = path.join(stateDir, 'nope', 'run.log');
    expect(readLogTail(missing, 50)).toEqual({ lines: [], size: 0, available: false });
    expect(readLogSince(missing, 0)).toEqual({ appended: '', size: 0, available: false });
  });

  it('reads a tail and incrementally drains appended bytes', () => {
    const work = path.join(stateDir, 'loop-log');
    mkdirSync(work, { recursive: true });
    const logPath = path.join(work, 'run.log');
    writeFileSync(logPath, 'a\nb\n');

    const tail = readLogTail(logPath, 50);
    expect(tail.available).toBe(true);
    expect(tail.lines).toEqual(['a', 'b']);

    expect(readLogSince(logPath, tail.size)).toEqual({
      appended: '',
      size: tail.size,
      available: true,
    });

    writeFileSync(logPath, 'a\nb\nc\n');
    const appended = readLogSince(logPath, tail.size);
    expect(appended.available).toBe(true);
    expect(appended.appended).toBe('c\n');
    expect(appended.size).toBeGreaterThan(tail.size);
  });
});

describe('read-only guarantee', () => {
  it('leaves the store and workdir byte-identical across loads', () => {
    const work = path.join(stateDir, 'loop-readonly');
    mkdirSync(work, { recursive: true });
    writeFileSync(path.join(work, 'plan.final.md'), 'final\n');
    writeFileSync(path.join(work, 'run.log'), '[agent-quorum] only\n');
    const record = writeRunRecord(
      stateDir,
      draft({ name: 'ro', workDir: work, logPath: path.join(work, 'run.log') }),
    );

    const before = snapshot(stateDir);
    loadDashboard();
    loadRunDetail(record);
    readLogTail(record.logPath, 50);
    readLogSince(record.logPath, 0);
    expect(snapshot(stateDir)).toEqual(before);
  });
});
