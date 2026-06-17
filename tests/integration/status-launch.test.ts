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
import { writeStoreConfig, writeFakeBin, writeStructuredPlanFile } from '../helpers/harness.js';

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

async function launchHangingRun(
  name: string,
  envOverrides: Record<string, string | undefined> = {},
): Promise<LaunchedRun> {
  const input = path.join(tmp, `${name}.md`);
  writeStructuredPlanFile(input, `Run ${name}`);
  const pidBase = path.join(tmp, `${name}.codex.pid`);
  const result = runCli(
    ['launch', '--effort', 'low', '--iters', '1', input, '--no-fix', '--no-translate'],
    {
      PATH: `${fake}:${process.env.PATH ?? ''}`,
      AGENT_QUORUM_HOME: path.join(tmp, 'home'),
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_CLARIFY: '0',
      AGENT_QUORUM_RETRY_COUNT: '0',
      AGENT_QUORUM_LAUNCH_VERIFY_DELAY: '0.3',
      AGENT_QUORUM_WORK_DIR: undefined,
      SLOW_CODEX_PID_FILE: pidBase,
      FAKE_CODEX_PROMPT: path.join(tmp, `${name}.codex.prompt`),
      ...envOverrides,
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
  writeStoreConfig(path.join(tmp, 'home'));
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

describe('launch + status', () => {
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
      AGENT_QUORUM_HOME: path.join(tmp, 'home'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
    };

    const byGrandchild = runCli(['status', String(runA.grandchildPid)], statusEnv, undefined, tmp);
    expect(byGrandchild.status).toBe(0);
    expect(byGrandchild.stdout).toContain('━━ alpha ━━');
    expect(byGrandchild.stdout).toContain(`PID=${runA.pid}`);
    expect(byGrandchild.stdout).toContain(`WORK: ${realpathSync(runA.work)}`);

    const nonAgentQuorum = runCli(['status', String(process.pid)], statusEnv, undefined, tmp);
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

    const listAll = runCli(['status'], statusEnv, undefined, tmp);
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
    const afterDecoy = runCli(['status'], statusEnv, undefined, tmp);
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

describe('status provider-neutral hints', () => {
  it('derives the stall hint provider and shows a provider-neutral retry hint', async () => {
    const run = await launchHangingRun('gamma');
    const statusEnv = {
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_HOME: path.join(tmp, 'home'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
    };

    // The neutralized P1 retry trace token triggers the provider-neutral hint.
    appendFileSync(run.log, '    api retry 2/10 after 1172ms\n');
    const retry = runCli(['status', String(run.grandchildPid)], statusEnv, undefined, tmp);
    expect(retry.status).toBe(0);
    expect(retry.stdout).toContain('(a provider is retrying API calls, waiting not progressing)');
    expect(retry.stdout).not.toContain('claude is retrying');

    // A cursor stall names cursor in the hint, not the old hardcoded claude.
    appendFileSync(run.log, '[agent-quorum] cursor stream stalled: no byte progress\n');
    const stall = runCli(['status', String(run.grandchildPid)], statusEnv, undefined, tmp);
    expect(stall.status).toBe(0);
    expect(stall.stdout).toContain('(watchdog terminated a recent cursor call, see run.log)');
    expect(stall.stdout).not.toContain('recent claude call');

    process.kill(run.pid, 'SIGTERM');
    await sleep(1500);
    expect(isAlive(run.grandchildPid)).toBe(false);
  }, 120_000);
});

describe('cross-store discovery', () => {
  it('lists a project-local self-planning run with no STATE_DIR/PLANS_DIR at status time', async () => {
    const projRun = await launchHangingRun('proj', {
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, '.agents', 'plans'),
      AGENT_QUORUM_STATE_DIR: undefined,
    });
    const listEnv = {
      AGENT_QUORUM_HOME: path.join(tmp, 'home'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
      AGENT_QUORUM_PLANS_DIR: undefined,
      AGENT_QUORUM_STATE_DIR: undefined,
    };

    const listing = runCli(['status'], listEnv, undefined, tmp);
    expect(listing.status).toBe(0);
    expect(listing.stdout).toContain('found 1 agent-quorum run(s)');
    expect(listing.stdout).toContain('proj  [running]');
    // Missing known stores still leave discovery at exit 0.
    expect(existsSync(path.join(tmp, 'home', 'state'))).toBe(false);

    process.kill(projRun.pid, 'SIGTERM');
    await sleep(1500);
    expect(isAlive(projRun.grandchildPid)).toBe(false);
  }, 120_000);

  it('--store scopes the listing to one store, ignoring a live run elsewhere', async () => {
    const live = await launchHangingRun('delta');
    const emptyStore = path.join(tmp, 'empty-state');
    mkdirSync(emptyStore, { recursive: true });
    const statusEnv = {
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_HOME: path.join(tmp, 'home'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
    };

    const scoped = runCli(['status', '--store', emptyStore], statusEnv, undefined, tmp);
    expect(scoped.status).toBe(0);
    expect(scoped.stderr).toContain('no agent-quorum runs currently active');

    const aggregated = runCli(['status'], statusEnv, undefined, tmp);
    expect(aggregated.status).toBe(0);
    expect(aggregated.stdout).toContain('delta  [running]');

    process.kill(live.pid, 'SIGTERM');
    await sleep(1500);
    expect(isAlive(live.grandchildPid)).toBe(false);
  }, 120_000);

  it('status --watch <selector> --store <dir> emits one snapshot resolved from that store', async () => {
    const run = await launchHangingRun('epsilon');
    const statusEnv = {
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_HOME: path.join(tmp, 'home'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
    };

    const snapshot = runCli(
      ['status', '--watch', 'epsilon', '--store', path.join(tmp, 'state')],
      statusEnv,
      undefined,
      tmp,
    );
    expect(snapshot.status).toBe(0);
    expect(snapshot.stdout).toContain('━━ epsilon ━━');

    process.kill(run.pid, 'SIGTERM');
    await sleep(1500);
    expect(isAlive(run.grandchildPid)).toBe(false);
  }, 120_000);
});
