import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../helpers/cli.js';
import { pgidOf } from '../../src/runtime/proc.js';
import {
  writeDefaultPlanLoopConfig,
  writeFakeBin,
  writeStructuredPlanFile,
} from '../helpers/harness.js';

let tmp: string;
let fake: string;
const launchedPids: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A codex stand-in that hangs: it records its own pid and a grandchild pid so
// status can be queried from the bottom of the tree.
function writeSlowCodex(): void {
  writeFileSync(
    path.join(fake, 'codex'),
    '#!/usr/bin/env bash\n' +
      'if [[ "${1:-}" == "login" && "${2:-}" == "status" ]]; then exit 0; fi\n' +
      'if [[ -n "${SLOW_CODEX_PID_FILE:-}" ]]; then echo $$ > "$SLOW_CODEX_PID_FILE.$$"; fi\n' +
      'sleep 300 &\n' +
      'if [[ -n "${SLOW_CODEX_PID_FILE:-}" ]]; then echo $! > "$SLOW_CODEX_PID_FILE.$$.child"; fi\n' +
      'wait\n',
  );
  chmodSync(path.join(fake, 'codex'), 0o755);
}

interface LaunchedRun {
  pid: number;
  work: string;
  log: string;
  grandchildPid: number;
  codexPid: number;
}

async function launchHangingRun(name: string): Promise<LaunchedRun> {
  const input = path.join(tmp, `${name}.md`);
  writeStructuredPlanFile(input, `Run ${name}`);
  const pidBase = path.join(tmp, `${name}.codex.pid`);
  const result = runCli(
    ['launch', '--effort', 'low', '--iters', '1', input, '--no-fix', '--no-translate'],
    {
      PATH: `${fake}:${process.env.PATH ?? ''}`,
      AGENT_QUORUM_CONFIG_FILE: path.join(tmp, 'agent-quorum.json'),
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_CLARIFY: '0',
      AGENT_QUORUM_RETRY_COUNT: '0',
      AGENT_QUORUM_LAUNCH_VERIFY_DELAY: '0.3',
      AGENT_QUORUM_WORK_DIR: undefined,
      SLOW_CODEX_PID_FILE: pidBase,
      FAKE_CODEX_PROMPT: path.join(tmp, `${name}.codex.prompt`),
    },
  );
  expect(result.status).toBe(0);
  const pid = Number(/pid:\s+([0-9]+)/.exec(result.stdout)?.[1]);
  const work = /work:\s+(.*)/.exec(result.stdout)?.[1] ?? '';
  const log = /log:\s+(.*)/.exec(result.stdout)?.[1] ?? '';
  expect(Number.isInteger(pid)).toBe(true);
  launchedPids.push(pid);

  let codexPid = 0;
  let grandchildPid = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pidFiles = (await import('node:fs'))
      .readdirSync(tmp)
      .filter((entry) => entry.startsWith(`${name}.codex.pid.`) && entry.endsWith('.child'));
    const first = pidFiles[0];
    if (first !== undefined) {
      grandchildPid = Number(readFileSync(path.join(tmp, first), 'utf8').trim());
      codexPid = Number(first.replace(`${name}.codex.pid.`, '').replace('.child', ''));
      break;
    }
    await sleep(100);
  }
  expect(grandchildPid).toBeGreaterThan(0);
  return { pid, work, log, grandchildPid, codexPid };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-statustest.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  writeSlowCodex();
  mkdirSync(path.join(tmp, 'plans'), { recursive: true });
  mkdirSync(path.join(tmp, 'state'), { recursive: true });
  writeDefaultPlanLoopConfig(path.join(tmp, 'agent-quorum.json'));
});

afterEach(async () => {
  for (const pid of launchedPids.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  await sleep(100);
  rmSync(tmp, { recursive: true, force: true });
});

describe('launch + status (Finding F4, AC-5)', () => {
  it('resolves a grandchild PID to the root run, lists runs, and tears down without orphans', async () => {
    const runA = await launchHangingRun('alpha');
    expect(existsSync(runA.log)).toBe(true);
    expect(runA.work).toBe(path.join(tmp, 'plans', 'loop-alpha'));

    const logContent = readFileSync(runA.log, 'utf8');
    expect(logContent).toContain('[agent-quorum]');
    expect(logContent).not.toContain('\x1b[');

    const statusEnv = {
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
    };

    const byGrandchild = runCli(['status', String(runA.grandchildPid)], statusEnv);
    expect(byGrandchild.status).toBe(0);
    expect(byGrandchild.stdout).toContain('━━ alpha ━━');
    expect(byGrandchild.stdout).toContain(`PID=${runA.pid}`);
    expect(byGrandchild.stdout).toContain(`WORK: ${realpathSync(runA.work)}`);

    const nonAgentQuorum = runCli(['status', String(process.pid)], statusEnv);
    expect(nonAgentQuorum.status).toBe(3);
    expect(nonAgentQuorum.stderr).toContain(
      `PID ${process.pid} is not part of an agent-quorum tree`,
    );

    const runB = await launchHangingRun('beta');

    // A stale registry entry whose pid now belongs to a non-agent-quorum process
    // (this vitest worker) must be ignored by the no-argument discovery.
    writeFileSync(
      path.join(tmp, 'state', `${process.pid}.tsv`),
      `pid\t${process.pid}\nwork_dir\t${path.join(tmp, 'plans', 'loop-decoy')}\n`,
    );

    const listAll = runCli(['status'], statusEnv);
    expect(listAll.status).toBe(0);
    expect(listAll.stdout).toContain('found 2 agent-quorum run(s)');
    expect(listAll.stdout).toContain('alpha  [running]');
    expect(listAll.stdout).toContain('beta  [running]');
    expect(listAll.stdout).not.toContain('loop-decoy');

    // A stale `running` record whose pid is alive (this worker) with a matching
    // pgid but a different start token must be rejected, not listed as live.
    writeFileSync(
      path.join(tmp, 'state', 'runs', 'rdecoy00000-token.json'),
      `${JSON.stringify({
        runId: 'rdecoy00000-token',
        name: 'tokendecoy',
        pid: process.pid,
        pgid: pgidOf(process.pid) ?? '0',
        procStartToken: 'STALE-START-TOKEN',
        mode: 'plan',
        inputPath: path.join(tmp, 'decoy.md'),
        workDir: path.join(tmp, 'plans', 'loop-tokendecoy'),
        logPath: path.join(tmp, 'plans', 'loop-tokendecoy', 'run.log'),
        plansDir: path.join(tmp, 'plans'),
        startedAt: '2026-01-01T00:00:00Z',
        effort: 'low',
        state: 'running',
      })}\n`,
    );
    const afterDecoy = runCli(['status'], statusEnv);
    expect(afterDecoy.status).toBe(0);
    // The decoy is listed, but its start-token mismatch demotes it to a
    // terminal state — it is never shown as a live/running run.
    expect(afterDecoy.stdout).toContain('alpha  [running]');
    expect(afterDecoy.stdout).toContain('beta  [running]');
    expect(afterDecoy.stdout).toContain('tokendecoy  [failed]');
    expect(afterDecoy.stdout).not.toMatch(/tokendecoy {2}\[running\]/);

    process.kill(runA.pid, 'SIGTERM');
    await sleep(1500);
    expect(isAlive(runA.pid)).toBe(false);
    expect(isAlive(runA.codexPid)).toBe(false);
    expect(isAlive(runA.grandchildPid)).toBe(false);

    process.kill(runB.pid, 'SIGTERM');
    await sleep(1500);
    expect(isAlive(runB.grandchildPid)).toBe(false);
  }, 120_000);
});

describe('status provider-neutral hints (FR-7)', () => {
  it('derives the stall hint provider and shows a provider-neutral retry hint', async () => {
    const run = await launchHangingRun('gamma');
    const statusEnv = {
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
    };

    // The neutralized P1 retry trace token triggers the provider-neutral hint.
    appendFileSync(run.log, '    api retry 2/10 after 1172ms\n');
    const retry = runCli(['status', String(run.grandchildPid)], statusEnv);
    expect(retry.status).toBe(0);
    expect(retry.stdout).toContain('(a provider is retrying API calls, waiting not progressing)');
    expect(retry.stdout).not.toContain('claude is retrying');

    // A cursor stall names cursor in the hint, not the old hardcoded claude.
    appendFileSync(run.log, '[agent-quorum] cursor stream stalled: no byte progress\n');
    const stall = runCli(['status', String(run.grandchildPid)], statusEnv);
    expect(stall.status).toBe(0);
    expect(stall.stdout).toContain('(watchdog terminated a recent cursor call, see run.log)');
    expect(stall.stdout).not.toContain('recent claude call');

    process.kill(run.pid, 'SIGTERM');
    await sleep(1500);
    expect(isAlive(run.grandchildPid)).toBe(false);
  }, 120_000);
});
