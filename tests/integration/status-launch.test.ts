import {
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
      PLAN_LOOP_CONFIG_FILE: path.join(tmp, 'plan-loop.json'),
      PLAN_LOOP_PLANS_DIR: path.join(tmp, 'plans'),
      PLAN_LOOP_STATE_DIR: path.join(tmp, 'state'),
      PLAN_LOOP_CLARIFY: '0',
      PLAN_LOOP_RETRY_COUNT: '0',
      PLAN_LOOP_LAUNCH_VERIFY_DELAY: '0.3',
      PLAN_LOOP_WORK_DIR: undefined,
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
  tmp = mkdtempSync(path.join(os.tmpdir(), 'plan-loop-statustest.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  writeSlowCodex();
  mkdirSync(path.join(tmp, 'plans'), { recursive: true });
  mkdirSync(path.join(tmp, 'state'), { recursive: true });
  writeDefaultPlanLoopConfig(path.join(tmp, 'plan-loop.json'));
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

    const statusEnv = {
      PLAN_LOOP_PLANS_DIR: path.join(tmp, 'plans'),
      PLAN_LOOP_STATE_DIR: path.join(tmp, 'state'),
      PLAN_LOOP_STATUS_SCAN_PS: '0',
    };

    const byGrandchild = runCli(['status', String(runA.grandchildPid)], statusEnv);
    expect(byGrandchild.status).toBe(0);
    expect(byGrandchild.stdout).toContain('━━ alpha ━━');
    expect(byGrandchild.stdout).toContain(`PID=${runA.pid}`);
    expect(byGrandchild.stdout).toContain(`WORK: ${realpathSync(runA.work)}`);

    const nonPlanLoop = runCli(['status', String(process.pid)], statusEnv);
    expect(nonPlanLoop.status).toBe(3);
    expect(nonPlanLoop.stderr).toContain(`PID ${process.pid} is not part of a plan-loop tree`);

    const runB = await launchHangingRun('beta');

    // A stale registry entry whose pid now belongs to a non-plan-loop process
    // (this vitest worker) must be ignored by the no-argument discovery.
    writeFileSync(
      path.join(tmp, 'state', `${process.pid}.tsv`),
      `pid\t${process.pid}\nwork_dir\t${path.join(tmp, 'plans', 'loop-decoy')}\n`,
    );

    const listAll = runCli(['status'], statusEnv);
    expect(listAll.status).toBe(0);
    expect(listAll.stdout).toContain('found 2 plan-loop run(s)');
    expect(listAll.stdout).toContain('━━ alpha ━━');
    expect(listAll.stdout).toContain('━━ beta ━━');
    expect(listAll.stdout).not.toContain('loop-decoy');

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
