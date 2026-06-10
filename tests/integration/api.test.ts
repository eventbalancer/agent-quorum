import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addIntervention,
  ExitCode,
  getRunStatus,
  launchPlanLoop,
  runPlanLoop,
} from '../../src/index.js';
import { resetConfigCache } from '../../src/core/config.js';
import {
  captureStderr,
  emptyCritique,
  writeCritique,
  writeDefaultPlanLoopConfig,
  writeFakeBin,
  writeStructuredPlanFile,
  withEnvAsync,
  type StderrCapture,
} from '../helpers/harness.js';

let tmp: string;
let fake: string;
let work: string;
let capture: StderrCapture;

function baseEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    PATH: `${fake}:${process.env.PATH ?? ''}`,
    PLAN_LOOP_CONFIG_FILE: path.join(tmp, 'plan-loop.json'),
    PLAN_LOOP_WORK_DIR: work,
    PLAN_LOOP_PLANS_DIR: path.join(tmp, 'plans'),
    PLAN_LOOP_STATE_DIR: path.join(tmp, 'state'),
    PLAN_LOOP_CLARIFY: '0',
    PLAN_LOOP_RETRY_COUNT: '0',
    PLAN_LOOP_RESUME: undefined,
    FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
    ...extra,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'plan-loop-apitest.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  work = path.join(tmp, 'work');
  mkdirSync(work);
  mkdirSync(path.join(tmp, 'plans'), { recursive: true });
  mkdirSync(path.join(tmp, 'state'), { recursive: true });
  writeDefaultPlanLoopConfig(path.join(tmp, 'plan-loop.json'));
  writeStructuredPlanFile(path.join(tmp, 'input.md'), 'API Input');
  emptyCritique(path.join(tmp, 'empty.json'));
  resetConfigCache();
  capture = captureStderr();
});

afterEach(() => {
  capture.restore();
  rmSync(tmp, { recursive: true, force: true });
});

describe('runPlanLoop (in-process)', () => {
  it('converges at v0 and returns ExitCode.Ok with the full artifact set', async () => {
    const result = await withEnvAsync(
      baseEnv({ FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json') }),
      () =>
        runPlanLoop({
          input: path.join(tmp, 'input.md'),
          iters: 1,
          effort: 'low',
          fix: false,
          translate: false,
        }),
    );
    expect(result.exitCode).toBe(ExitCode.Ok);
    for (const artifact of ['plan.final.md', 'summary.md', 'run.meta.tsv', 'findings.json']) {
      expect(existsSync(path.join(work, artifact)), artifact).toBe(true);
    }
    expect(readFileSync(path.join(work, 'summary.md'), 'utf8')).toContain('- FINAL: clean');
  });

  it('runs the fix pass and the translate pass when enabled', async () => {
    const input = path.join(tmp, 'bad-input.md');
    writeStructuredPlanFile(input, 'API Known Bad');
    writeFileSync(
      input,
      `${readFileSync(input, 'utf8')}\n- Broken reference: \`missing-file.ts:99999\`\n`,
    );
    const fixed = path.join(tmp, 'fixed.md');
    writeStructuredPlanFile(fixed, 'API Fixed');
    const review = path.join(tmp, 'review.json');
    writeFileSync(review, `${JSON.stringify({ approval: 'accept', concerns: [] }, null, 2)}\n`);

    const result = await withEnvAsync(
      baseEnv({
        FAKE_CODEX_OUTPUT_CALLS: path.join(tmp, 'codex.calls'),
        FAKE_CODEX_OUTPUT_1: path.join(tmp, 'empty.json'),
        FAKE_CODEX_OUTPUT_2: review,
        FAKE_CLAUDE_MARKDOWN_RESULT: fixed,
      }),
      () =>
        runPlanLoop({
          input,
          iters: 1,
          effort: 'low',
          fix: true,
          translate: true,
        }),
    );

    expect(result.exitCode).toBe(ExitCode.Ok);
    expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe(
      readFileSync(fixed, 'utf8'),
    );
    expect(existsSync(path.join(work, 'plan.final.before-fix.md'))).toBe(true);
    expect(existsSync(path.join(work, 'plan.final.ru.md'))).toBe(true);
    expect(readFileSync(path.join(work, 'summary.md'), 'utf8')).toContain('- final_ru:');
  });

  it('resumes from the last stable plan and archives stale artifacts', async () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'API Input');
    writeFileSync(path.join(work, 'plan.final.md'), '# Stale final\n');
    writeFileSync(path.join(work, 'rejected-log.jsonl'), '');

    const result = await withEnvAsync(
      baseEnv({ FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json'), PLAN_LOOP_RESUME: '1' }),
      () =>
        runPlanLoop({
          input: path.join(tmp, 'input.md'),
          iters: 1,
          effort: 'low',
          fix: false,
          translate: false,
        }),
    );

    expect(result.exitCode).toBe(ExitCode.Ok);
    expect(capture.text()).toContain('resume archived 1 stale artifact(s)');
    expect(readFileSync(path.join(work, 'summary.md'), 'utf8')).toContain('- resume_start: 0');
  });

  it('maps schema-invalid critiques to ExitCode.SchemaInvalid', async () => {
    const invalid = path.join(tmp, 'invalid.json');
    writeCritique(invalid, [{ id: 'BAD' }]);
    const result = await withEnvAsync(baseEnv({ FAKE_CODEX_OUTPUT: invalid }), () =>
      runPlanLoop({
        input: path.join(tmp, 'input.md'),
        iters: 1,
        effort: 'low',
        fix: false,
        translate: false,
      }),
    );
    expect(result.exitCode).toBe(ExitCode.SchemaInvalid);
  });

  it('maps usage errors to ExitCode.Usage', async () => {
    const result = await withEnvAsync(baseEnv(), () =>
      runPlanLoop({ input: path.join(tmp, 'no-such.md'), fix: false, translate: false }),
    );
    expect(result.exitCode).toBe(ExitCode.Usage);
    expect(capture.text()).toContain('file not found:');
  });

  it('blocks a shape-broken final plan with ExitCode.Blocked', async () => {
    const broken = path.join(tmp, 'broken.md');
    writeFileSync(broken, '# Just a summary\n\n## Context\nNothing else.\n');
    const result = await withEnvAsync(
      baseEnv({ FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json') }),
      () => runPlanLoop({ input: broken, iters: 1, effort: 'low', fix: false, translate: false }),
    );
    expect(result.exitCode).toBe(ExitCode.Blocked);
  });
});

describe('getRunStatus (in-process)', () => {
  it('reports no active runs against an empty registry', async () => {
    const result = await withEnvAsync(
      {
        PLAN_LOOP_PLANS_DIR: path.join(tmp, 'plans'),
        PLAN_LOOP_STATE_DIR: path.join(tmp, 'state'),
        PLAN_LOOP_STATUS_SCAN_PS: '0',
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async () => getRunStatus(),
    );
    expect(result.exitCode).toBe(0);
    expect(capture.text()).toContain('no plan-loop runs currently active');
  });

  it('rejects a dead PID with exit 2 and a live non-plan-loop PID with exit 3', async () => {
    const env = {
      PLAN_LOOP_PLANS_DIR: path.join(tmp, 'plans'),
      PLAN_LOOP_STATE_DIR: path.join(tmp, 'state'),
      PLAN_LOOP_STATUS_SCAN_PS: '0',
    };
    // eslint-disable-next-line @typescript-eslint/require-await
    const dead = await withEnvAsync(env, async () => getRunStatus(999999));
    expect(dead.exitCode).toBe(2);
    // eslint-disable-next-line @typescript-eslint/require-await
    const alien = await withEnvAsync(env, async () => getRunStatus(process.pid));
    expect(alien.exitCode).toBe(3);
  });
});

describe('addIntervention (in-process)', () => {
  it('appends a ledger entry and surfaces the recorded line', () => {
    const result = addIntervention(work, 'check the cutover', 'critic');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('target=critic');
    const entry = JSON.parse(
      readFileSync(path.join(work, 'operator-interventions.jsonl'), 'utf8').trim(),
    ) as { message: string };
    expect(entry.message).toBe('check the cutover');
  });

  it('maps usage errors to exit 1', () => {
    const result = addIntervention(work, 'x', 'translator' as never);
    expect(result.exitCode).toBe(1);
  });
});

describe('launchPlanLoop (in-process)', () => {
  it('detaches a run and reports pid/log/work', async () => {
    // The liveness check needs a run that outlives the verify delay (the
    // reference behaves the same way), so the critic hangs.
    writeFileSync(path.join(fake, 'codex'), '#!/usr/bin/env bash\nsleep 300 &\nwait\n');
    chmodSync(path.join(fake, 'codex'), 0o755);
    const result = await withEnvAsync(
      baseEnv({
        PLAN_LOOP_LAUNCH_VERIFY_DELAY: '0.3',
        PLAN_LOOP_WORK_DIR: undefined,
      }),
      () =>
        launchPlanLoop({
          input: path.join(tmp, 'input.md'),
          iters: 1,
          effort: 'low',
          fix: false,
          translate: false,
        }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('started: input');
    const pid = Number(/pid:\s+([0-9]+)/.exec(result.output)?.[1]);
    expect(Number.isInteger(pid)).toBe(true);
    expect(existsSync(path.join(tmp, 'plans', 'loop-input', 'run.log'))).toBe(true);

    const statusEnv = {
      PLAN_LOOP_PLANS_DIR: path.join(tmp, 'plans'),
      PLAN_LOOP_STATE_DIR: path.join(tmp, 'state'),
      PLAN_LOOP_STATUS_SCAN_PS: '0',
    };
    let byPid = { exitCode: -1, output: '' };
    for (let attempt = 0; attempt < 50 && byPid.exitCode !== 0; attempt += 1) {
      await sleep(200);
      byPid = await withEnvAsync(
        statusEnv,
        // eslint-disable-next-line @typescript-eslint/require-await
        async () => getRunStatus(pid),
      );
    }
    expect(byPid.exitCode).toBe(0);
    expect(byPid.output).toContain('━━ input ━━');
    expect(byPid.output).toContain(`PID=${pid}`);
    const listing = await withEnvAsync(
      statusEnv,
      // eslint-disable-next-line @typescript-eslint/require-await
      async () => getRunStatus(),
    );
    expect(listing.exitCode).toBe(0);
    expect(listing.output).toContain('found 1 plan-loop run(s)');

    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    await sleep(100);
  }, 30_000);

  it('runs a prompt-mode loop in-process (clarify disabled)', async () => {
    const prompt = path.join(tmp, 'prompt.md');
    writeFileSync(prompt, 'Build the api fixture.\n');
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'API Created');

    const result = await withEnvAsync(
      baseEnv({
        FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json'),
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
      }),
      () =>
        runPlanLoop({
          input: prompt,
          prompt: true,
          iters: 1,
          effort: 'low',
          fix: false,
          translate: false,
        }),
    );

    expect(result.exitCode).toBe(ExitCode.Ok);
    expect(existsSync(path.join(work, 'prompt.md'))).toBe(true);
    const summary = readFileSync(path.join(work, 'summary.md'), 'utf8');
    expect(summary).toContain('- mode: prompt');
    expect(summary).toContain('## v0 (created from prompt)');
  });

  it('maps launch usage errors to the reference exit codes', async () => {
    const result = await launchPlanLoop({ input: path.join(tmp, 'no-such.md') });
    expect(result.exitCode).toBe(2);
    expect(capture.text()).toContain('input not found:');
  });
});
