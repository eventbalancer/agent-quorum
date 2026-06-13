import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLogsCli, runPruneCli, runShowCli } from '../../src/cli/runs.js';
import {
  finalizeRunRecord,
  writeRunRecord,
  type RunRecordDraft,
} from '../../src/core/run-store.js';
import { HaltError } from '../../src/runtime/halt.js';

let tmp: string;
let stateDir: string;
let savedStateDir: string | undefined;

function seed(name: string, withLog: boolean): string {
  const workDir = path.join(tmp, 'plans', `loop-${name}`);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path.join(workDir, 'plan.final.md'), '# final\n');
  if (withLog) {
    writeFileSync(path.join(workDir, 'run.log'), '[agent-quorum] line one\n');
  }
  const draft: RunRecordDraft = {
    name,
    pid: 999999,
    pgid: '0',
    procStartToken: 'tok',
    mode: 'plan',
    inputPath: path.join(tmp, `${name}.md`),
    workDir,
    logPath: path.join(workDir, 'run.log'),
    plansDir: path.join(tmp, 'plans'),
    startedAt: '2026-06-13T00:00:00Z',
    effort: 'low',
    state: 'running',
  };
  const record = writeRunRecord(stateDir, draft);
  finalizeRunRecord(stateDir, record.runId, {
    state: 'finished',
    exitCode: 0,
    endedAt: '2026-06-13T01:00:00Z',
  });
  return workDir;
}

function collect(): { out: (text: string) => void; text: () => string } {
  let buffer = '';
  return {
    out: (text: string) => {
      buffer += text;
    },
    text: () => buffer,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-runsunit.'));
  stateDir = path.join(tmp, 'state');
  mkdirSync(stateDir, { recursive: true });
  savedStateDir = process.env.AGENT_QUORUM_STATE_DIR;
  process.env.AGENT_QUORUM_STATE_DIR = stateDir;
});

afterEach(() => {
  if (savedStateDir === undefined) {
    Reflect.deleteProperty(process.env, 'AGENT_QUORUM_STATE_DIR');
  } else {
    process.env.AGENT_QUORUM_STATE_DIR = savedStateDir;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('runShowCli', () => {
  it('prints artifact paths and state for a resolved run', () => {
    const workDir = seed('alpha', true);
    const sink = collect();
    expect(runShowCli(['alpha'], sink.out)).toBe(0);
    expect(sink.text()).toContain(workDir);
    expect(sink.text()).toContain('plan.final.md');
    expect(sink.text()).toContain('finished');
  });

  it('prints usage for --help', () => {
    const sink = collect();
    expect(runShowCli(['--help'], sink.out)).toBe(0);
    expect(sink.text()).toContain('agent-quorum show');
  });

  it('throws HaltError(2) when nothing resolves', () => {
    expect(() => runShowCli(['ghost'], () => undefined)).toThrow(HaltError);
  });
});

describe('runLogsCli', () => {
  it('prints the log for a resolved run', async () => {
    seed('beta', true);
    const sink = collect();
    expect(await runLogsCli(['beta'], sink.out)).toBe(0);
    expect(sink.text()).toContain('[agent-quorum] line one');
  });

  it('follows a terminal run and drains the log without hanging', async () => {
    seed('gamma', true);
    const sink = collect();
    expect(await runLogsCli(['--last', '-f'], sink.out)).toBe(0);
    expect(sink.text()).toContain('[agent-quorum] line one');
  });

  it('degrades to a clear message and exit 0 when there is no run.log', async () => {
    seed('delta', false);
    const sink = collect();
    expect(await runLogsCli(['delta'], sink.out)).toBe(0);
    expect(sink.text()).toContain('no run.log');
  });
});

describe('runPruneCli', () => {
  it('removes terminal records beyond --keep; --dry-run removes none', () => {
    seed('a', false);
    seed('b', false);
    seed('c', false);
    const dry = collect();
    expect(runPruneCli(['--keep', '1', '--dry-run'], dry.out)).toBe(0);
    expect(dry.text()).toContain('would remove 2 run record(s)');
    const real = collect();
    expect(runPruneCli(['--keep', '1'], real.out)).toBe(0);
    expect(real.text()).toContain('removed 2 run record(s)');
  });

  it('prints usage for --help and rejects unknown flags', () => {
    const help = collect();
    expect(runPruneCli(['--help'], help.out)).toBe(0);
    expect(help.text()).toContain('agent-quorum prune');
    expect(() => runPruneCli(['--bogus'], () => undefined)).toThrow(HaltError);
  });
});
