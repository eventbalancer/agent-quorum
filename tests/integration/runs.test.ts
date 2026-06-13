import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../helpers/cli.js';
import {
  finalizeRunRecord,
  writeRunRecord,
  type RunRecordDraft,
} from '../../src/core/run-store.js';

let tmp: string;
let stateDir: string;

function draft(name: string, workDir: string, startedAt: string): RunRecordDraft {
  return {
    name,
    pid: 999999,
    pgid: '0',
    procStartToken: 'tok',
    mode: 'plan',
    inputPath: path.join(tmp, `${name}.md`),
    workDir,
    logPath: path.join(workDir, 'run.log'),
    plansDir: path.join(tmp, 'plans'),
    startedAt,
    effort: 'low',
    state: 'running',
  };
}

function seedFinishedRun(
  name: string,
  withLog: boolean,
  startedAt = '2026-06-13T00:00:00Z',
): string {
  const workDir = path.join(tmp, 'plans', `loop-${name}`);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path.join(workDir, 'plan.final.md'), '# final\n');
  writeFileSync(path.join(workDir, 'summary.md'), '# summary\n');
  if (withLog) {
    writeFileSync(path.join(workDir, 'run.log'), '[agent-quorum] seeded log line\n');
  }
  const record = writeRunRecord(stateDir, draft(name, workDir, startedAt));
  finalizeRunRecord(stateDir, record.runId, {
    state: 'finished',
    exitCode: 0,
    endedAt: '2026-06-13T01:00:00Z',
  });
  return workDir;
}

function env(): Record<string, string | undefined> {
  return { AGENT_QUORUM_STATE_DIR: stateDir };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-runstest.'));
  stateDir = path.join(tmp, 'state');
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('show (AC-4)', () => {
  it('prints a run’s artifact paths and state resolved by name', () => {
    const workDir = seedFinishedRun('alpha', true);
    const result = runCli(['show', 'alpha'], env());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(workDir);
    expect(result.stdout).toContain(path.join(workDir, 'plan.final.md'));
    expect(result.stdout).toContain(path.join(workDir, 'summary.md'));
    expect(result.stdout).toContain('finished');
  });

  it('exits 2 when the selector matches no run', () => {
    const result = runCli(['show', 'nope'], env());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no run matches');
  });
});

describe('logs (AC-5)', () => {
  it('prints run.log resolved by name', () => {
    seedFinishedRun('beta', true);
    const result = runCli(['logs', 'beta'], env());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[agent-quorum] seeded log line');
  });

  it('follows a terminal run’s log with -f and exits without hanging', () => {
    seedFinishedRun('gamma', true);
    const result = runCli(['logs', '--last', '-f'], env());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[agent-quorum] seeded log line');
  });

  it('degrades with a clear message and exit 0 when the run produced no log', () => {
    seedFinishedRun('delta', false);
    const result = runCli(['logs', 'delta'], env());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no run.log');
  });
});

describe('intervene by selector (AC-7)', () => {
  it('records against a run resolved by name', () => {
    const workDir = seedFinishedRun('alpha', true);
    const result = runCli(['intervene', 'alpha', 'check', 'the', 'cutover'], env());
    expect(result.status).toBe(0);
    const ledger = readFileSync(path.join(workDir, 'operator-interventions.jsonl'), 'utf8');
    expect(ledger).toContain('check the cutover');
  });

  it('records against the most-recent run with --last', () => {
    seedFinishedRun('older', true, '2026-06-13T00:00:00Z');
    const recent = seedFinishedRun('newer', true, '2026-06-13T09:00:00Z');
    const result = runCli(['intervene', '--last', 'review', 'this'], env());
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(recent, 'operator-interventions.jsonl'), 'utf8')).toContain(
      'review this',
    );
  });

  it('exits 2 when a selector matches no run', () => {
    const result = runCli(['intervene', 'ghost', 'msg'], env());
    expect(result.status).toBe(2);
  });
});

describe('prune (AC-9)', () => {
  it('removes terminal records beyond --keep and reports; --dry-run removes none', () => {
    seedFinishedRun('a', false, '2026-06-10T00:00:00Z');
    seedFinishedRun('b', false, '2026-06-11T00:00:00Z');
    seedFinishedRun('c', false, '2026-06-12T00:00:00Z');

    const dry = runCli(['prune', '--keep', '1', '--dry-run'], env());
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('would remove 2 run record(s)');

    const real = runCli(['prune', '--keep', '1'], env());
    expect(real.status).toBe(0);
    expect(real.stdout).toContain('removed 2 run record(s)');
  });
});

describe('status --watch (AC-10)', () => {
  it('emits a single snapshot for a run in a non-TTY and exits', () => {
    seedFinishedRun('alpha', true);
    const result = runCli(['status', '--watch', 'alpha'], env());
    expect(result.status).toBe(0);
    // A finished run's pid is gone; printStatus emits a single terse snapshot.
    expect(`${result.stdout}${result.stderr}`).toContain('999999');
  });
});
