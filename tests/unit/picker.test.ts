import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listCandidates, pickInteractive, renderListing } from '../../src/cli/picker.js';
import {
  finalizeRunRecord,
  writeRunRecord,
  type RunRecordDraft,
} from '../../src/core/run-store.js';
import { pgidOf, procStartToken } from '../../src/runtime/proc.js';

const ESC = String.fromCharCode(27);

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

function ttyStream(): PassThrough & { isTTY?: boolean } {
  const stream: PassThrough & { isTTY?: boolean } = new PassThrough();
  stream.isTTY = true;
  return stream;
}

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-picker.'));
  homeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-picker-home.'));
  cwdDir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-picker-cwd.'));
  savedEnv.clear();
  setEnv('AGENT_QUORUM_STATE_DIR', stateDir);
  setEnv('AGENT_QUORUM_HOME', homeDir);
  setEnv('AGENT_QUORUM_PLANS_DIR', undefined);
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

describe('listCandidates', () => {
  it('lists live runs before recent finished runs regardless of start time', () => {
    writeRunRecord(
      stateDir,
      draft({ ...liveOverrides(), name: 'liverun', startedAt: '2026-06-13T01:00:00Z' }),
    );
    const done = writeRunRecord(
      stateDir,
      draft({ name: 'donerun', startedAt: '2026-06-13T09:00:00Z' }),
    );
    finalizeRunRecord(stateDir, done.runId, {
      state: 'finished',
      exitCode: 0,
      endedAt: '2026-06-13T10:00:00Z',
    });

    const candidates = listCandidates();
    expect(candidates.map((candidate) => candidate.record.name)).toEqual(['liverun', 'donerun']);
    expect(candidates[0]?.isLive).toBe(true);
    expect(candidates[1]?.isLive).toBe(false);
    expect(candidates[1]?.state).toBe('finished');
  });

  it('bounds recent finished runs to the retention keep count', () => {
    for (let i = 0; i < 3; i += 1) {
      const done = writeRunRecord(
        stateDir,
        draft({ name: `done-${i}`, startedAt: `2026-06-1${i}T00:00:00Z` }),
      );
      finalizeRunRecord(stateDir, done.runId, { state: 'finished', exitCode: 0 });
    }
    const saved = process.env.AGENT_QUORUM_RETAIN_COUNT;
    process.env.AGENT_QUORUM_RETAIN_COUNT = '1';
    try {
      expect(listCandidates().filter((candidate) => !candidate.isLive)).toHaveLength(1);
    } finally {
      if (saved === undefined) {
        Reflect.deleteProperty(process.env, 'AGENT_QUORUM_RETAIN_COUNT');
      } else {
        process.env.AGENT_QUORUM_RETAIN_COUNT = saved;
      }
    }
  });

  it('aggregates live runs across known stores by default', () => {
    const projStore = path.join(cwdDir, '.agents', 'plans', '.runs');
    writeRunRecord(stateDir, draft({ ...liveOverrides(), name: 'in-state' }));
    writeRunRecord(projStore, draft({ ...liveOverrides(), name: 'in-project' }));

    const names = listCandidates().map((candidate) => candidate.record.name);
    expect(names).toHaveLength(2);
    expect(names).toContain('in-state');
    expect(names).toContain('in-project');
  });

  it('scopes the listing to an explicit store, ignoring other stores', () => {
    const projStore = path.join(cwdDir, '.agents', 'plans', '.runs');
    writeRunRecord(stateDir, draft({ ...liveOverrides(), name: 'in-state' }));
    writeRunRecord(projStore, draft({ ...liveOverrides(), name: 'in-project' }));

    const names = listCandidates([stateDir]).map((candidate) => candidate.record.name);
    expect(names).toEqual(['in-state']);
  });
});

describe('renderListing', () => {
  it('renders a scriptable listing that is escape-free without color', () => {
    writeRunRecord(stateDir, draft({ ...liveOverrides(), name: 'foo' }));
    const candidates = listCandidates();
    const plain = renderListing(candidates, { color: false });
    expect(plain).toContain('found 1 agent-quorum run(s)');
    expect(plain).toContain('foo  [running]');
    expect(plain.includes(ESC)).toBe(false);
    expect(renderListing(candidates, { color: true }).includes(ESC)).toBe(true);
  });
});

describe('pickInteractive', () => {
  it('auto-selects a sole candidate without prompting', async () => {
    writeRunRecord(stateDir, draft({ ...liveOverrides(), name: 'solo' }));
    const candidates = listCandidates();
    expect(candidates).toHaveLength(1);
    const picked = await pickInteractive(candidates, { input: ttyStream(), output: ttyStream() });
    expect(picked?.record.name).toBe('solo');
  });

  it('selects the chosen run from a numbered prompt', async () => {
    writeRunRecord(
      stateDir,
      draft({ ...liveOverrides(), name: 'one', startedAt: '2026-06-13T02:00:00Z' }),
    );
    writeRunRecord(
      stateDir,
      draft({ ...liveOverrides(), name: 'two', startedAt: '2026-06-13T01:00:00Z' }),
    );
    const candidates = listCandidates();
    expect(candidates.map((candidate) => candidate.record.name)).toEqual(['one', 'two']);

    const input = ttyStream();
    const pending = pickInteractive(candidates, { input, output: ttyStream() });
    input.write('2\n');
    expect((await pending)?.record.name).toBe('two');
  });

  it('returns undefined for an out-of-range choice', async () => {
    writeRunRecord(
      stateDir,
      draft({ ...liveOverrides(), name: 'one', startedAt: '2026-06-13T02:00:00Z' }),
    );
    writeRunRecord(
      stateDir,
      draft({ ...liveOverrides(), name: 'two', startedAt: '2026-06-13T01:00:00Z' }),
    );
    const candidates = listCandidates();

    const input = ttyStream();
    const pending = pickInteractive(candidates, { input, output: ttyStream() });
    input.write('9\n');
    expect(await pending).toBeUndefined();
  });
});
