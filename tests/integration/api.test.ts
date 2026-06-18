import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
  getRun,
  getRunLogPath,
  getRunStatus,
  interveneRun,
  launchPlanLoop,
  listRuns,
  runPlanLoop,
} from '../../src/index.js';
import { readRunRecords, writeRunRecord, type RunRecordDraft } from '../../src/core/run-store.js';
import { pgidOf, procStartToken } from '../../src/runtime/proc.js';
import { startTelegramStub } from '../helpers/telegram-stub.js';
import {
  captureStderr,
  emptyCritique,
  writeCritique,
  writeStoreConfig,
  writeStoreConfigRoles,
  writeFakeBin,
  writeStructuredPlanFile,
  withCwd,
  withCwdAsync,
  withEnv,
  withEnvAsync,
  type StderrCapture,
} from '../helpers/harness.js';

let tmp: string;
let fake: string;
let work: string;
let capture: StderrCapture;

type EnvOverrides = Record<string, string | undefined>;

function baseEnv(extra: EnvOverrides = {}): EnvOverrides {
  return {
    PATH: `${fake}:${process.env.PATH ?? ''}`,
    AGENT_QUORUM_HOME: path.join(tmp, 'home'),
    AGENT_QUORUM_WORK_DIR: work,
    AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
    AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
    AGENT_QUORUM_CLARIFY: '0',
    AGENT_QUORUM_RETRY_COUNT: '0',
    AGENT_QUORUM_RESUME: undefined,
    FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
    ...extra,
  };
}

function liveDraft(name: string, store: string): RunRecordDraft {
  return {
    name,
    pid: process.pid,
    pgid: pgidOf(process.pid) ?? '0',
    procStartToken: procStartToken(process.pid) ?? 'tok',
    mode: 'plan',
    inputPath: path.join(tmp, `${name}.md`),
    workDir: path.join(store, 'work'),
    logPath: path.join(store, 'work', 'run.log'),
    plansDir: path.join(tmp, 'plans'),
    startedAt: '2026-06-15T00:00:00Z',
    quality: 'quick',
    state: 'running',
  };
}

// A critic stand-in that outlives the launch verify delay (the reference
// behaves the same way); the auth probe still answers instantly so preflight
// does not eat its 3 s timeout.
function writeHangingCodex(): void {
  writeFileSync(
    path.join(fake, 'codex'),
    '#!/usr/bin/env bash\n' +
      'if [[ "${1:-}" == "login" && "${2:-}" == "status" ]]; then exit 0; fi\n' +
      'sleep 300 &\nwait\n',
  );
  chmodSync(path.join(fake, 'codex'), 0o755);
}

async function killDetachedRun(pid: number): Promise<void> {
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
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-apitest.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  work = path.join(tmp, 'work');
  mkdirSync(work);
  mkdirSync(path.join(tmp, 'plans'), { recursive: true });
  mkdirSync(path.join(tmp, 'state'), { recursive: true });
  writeStoreConfig(path.join(tmp, 'home'));
  writeStructuredPlanFile(path.join(tmp, 'input.md'), 'API Input');
  emptyCritique(path.join(tmp, 'empty.json'));
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
          quality: 'quick',
          fix: false,
          translate: false,
        }),
    );
    expect(result.exitCode).toBe(ExitCode.Ok);
    for (const artifact of ['plan.final.md', 'summary.md', 'run.meta.tsv', 'findings.json']) {
      expect(existsSync(path.join(work, artifact)), artifact).toBe(true);
    }
    const summary = readFileSync(path.join(work, 'summary.md'), 'utf8');
    expect(summary).toContain('- FINAL: clean');

    const canonicalWork = realpathSync(work);
    expect(result.workDir).toBe(canonicalWork);
    expect(result.finalPlanPath).toBe(path.join(canonicalWork, 'plan.final.md'));
    expect(result.summaryPath).toBe(path.join(canonicalWork, 'summary.md'));
    expect(result.iterations).toBe(Number(/- iterations: ([0-9]+)/.exec(summary)?.[1]));
    const healthLine =
      /- final_health: critic=([0-9]+), addressed=([0-9]+), new=([0-9]+), invalid=([0-9]+), valid_addressed_pct=([0-9]+)/.exec(
        summary,
      );
    expect(healthLine).not.toBeNull();
    expect(result.health).toEqual({
      critic: Number(healthLine?.[1]),
      addressed: Number(healthLine?.[2]),
      new: Number(healthLine?.[3]),
      invalid: Number(healthLine?.[4]),
      validAddressedPct: Number(healthLine?.[5]),
    });

    expect(result.runId).toMatch(/^r[0-9a-z]+-[0-9a-f]+$/);
    expect(result.name).toBe('work');
    const runLog = path.join(canonicalWork, 'run.log');
    expect(existsSync(runLog)).toBe(true);
    expect(readFileSync(runLog, 'utf8')).toContain('[agent-quorum]');
  });

  it('keeps two same-input runs in distinct workdirs, each addressable by its runId', async () => {
    const defaultWorkEnv = baseEnv({
      AGENT_QUORUM_WORK_DIR: undefined,
      FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json'),
    });
    const options = {
      input: path.join(tmp, 'input.md'),
      iters: 1,
      quality: 'quick' as const,
      fix: false,
      translate: false,
    };
    const first = await withEnvAsync(defaultWorkEnv, () => runPlanLoop(options));
    const second = await withEnvAsync(defaultWorkEnv, () => runPlanLoop(options));

    expect(first.exitCode).toBe(ExitCode.Ok);
    expect(second.exitCode).toBe(ExitCode.Ok);
    expect(first.name).toBe('input');
    expect(second.name).toBe('input-2');
    expect(first.workDir).toBe(realpathSync(path.join(tmp, 'plans', 'loop-input')));
    expect(second.workDir).toBe(realpathSync(path.join(tmp, 'plans', 'loop-input-2')));
    expect(first.runId).not.toBe(second.runId);

    const records = readRunRecords(path.join(tmp, 'state'));
    const byName = new Map(records.map((entry) => [entry.runId, entry.name]));
    expect(first.runId !== undefined && byName.get(first.runId)).toBe('input');
    expect(second.runId !== undefined && byName.get(second.runId)).toBe('input-2');
  });

  it('exposes additive package fields: no-split keeps finalPlanPath and reports no package', async () => {
    const result = await withEnvAsync(
      baseEnv({ FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json') }),
      () =>
        runPlanLoop({
          input: path.join(tmp, 'input.md'),
          iters: 1,
          quality: 'quick',
          fix: false,
          translate: false,
        }),
    );
    expect(result.exitCode).toBe(ExitCode.Ok);
    expect(result.finalPlanPath).toBe(path.join(realpathSync(work), 'plan.final.md'));
    expect(result.splitDecision).toBe('no-split');
    expect(result.packageDir).toBeUndefined();
  });

  it('runs the fix pass and the localized final pass when locale is set', async () => {
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
          quality: 'quick',
          fix: true,
          locale: 'pt-BR',
        }),
    );

    expect(result.exitCode).toBe(ExitCode.Ok);
    expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe(
      readFileSync(fixed, 'utf8'),
    );
    expect(existsSync(path.join(work, 'plan.final.before-fix.md'))).toBe(true);
    expect(existsSync(path.join(work, 'plan.final.pt-BR.md'))).toBe(true);
    expect(readFileSync(path.join(work, 'summary.md'), 'utf8')).toContain('- final_localized:');
    expect(readFileSync(path.join(work, 'summary.md'), 'utf8')).toContain('- locale: pt-BR');
  });

  it('resumes from the last stable plan and archives stale artifacts', async () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'API Input');
    writeFileSync(path.join(work, 'plan.final.md'), '# Stale final\n');
    writeFileSync(path.join(work, 'rejected-log.jsonl'), '');

    const result = await withEnvAsync(
      baseEnv({ FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json'), AGENT_QUORUM_RESUME: '1' }),
      () =>
        runPlanLoop({
          input: path.join(tmp, 'input.md'),
          iters: 1,
          quality: 'quick',
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
        quality: 'quick',
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
      () =>
        runPlanLoop({ input: broken, iters: 1, quality: 'quick', fix: false, translate: false }),
    );
    expect(result.exitCode).toBe(ExitCode.Blocked);
  });
});

describe('getRunStatus (in-process)', () => {
  it('reports no active runs against an empty registry', async () => {
    const result = await withCwdAsync(tmp, () =>
      withEnvAsync(
        {
          AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
          AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
          AGENT_QUORUM_HOME: path.join(tmp, 'home'),
          AGENT_QUORUM_STATUS_SCAN_PS: '0',
        },
        () => getRunStatus(),
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(capture.text()).toContain('no agent-quorum runs currently active');
  });

  it('rejects a dead PID with exit 2 and a live non-agent-quorum PID with exit 3', async () => {
    const env = {
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
    };
    const dead = await withEnvAsync(env, () => getRunStatus(999999));
    expect(dead.exitCode).toBe(2);
    const alien = await withEnvAsync(env, () => getRunStatus(process.pid));
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
    writeHangingCodex();
    const result = await withEnvAsync(
      baseEnv({
        AGENT_QUORUM_LAUNCH_VERIFY_DELAY: '0.3',
        AGENT_QUORUM_WORK_DIR: undefined,
      }),
      () =>
        launchPlanLoop({
          input: path.join(tmp, 'input.md'),
          iters: 1,
          quality: 'quick',
          fix: false,
          translate: false,
        }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('started: input');
    const pid = Number(/pid:\s+([0-9]+)/.exec(result.output)?.[1]);
    expect(Number.isInteger(pid)).toBe(true);
    expect(existsSync(path.join(tmp, 'plans', 'loop-input', 'run.log'))).toBe(true);
    expect(result.pid).toBe(pid);
    expect(result.workDir).toBe(path.join(tmp, 'plans', 'loop-input'));
    expect(result.logPath).toBe(path.join(tmp, 'plans', 'loop-input', 'run.log'));
    expect(result.runId).toMatch(/^r[0-9a-z]+-[0-9a-f]+$/);
    expect(result.name).toBe('input');
    expect(result.output).toContain(`run:   ${result.runId ?? ''}`);

    const statusEnv = {
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_HOME: path.join(tmp, 'home'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
    };
    let byPid = { exitCode: -1, output: '' };
    for (let attempt = 0; attempt < 50 && byPid.exitCode !== 0; attempt += 1) {
      await sleep(200);
      byPid = await withEnvAsync(statusEnv, () => getRunStatus(pid));
    }
    expect(byPid.exitCode).toBe(0);
    expect(byPid.output).toContain('━━ input ━━');
    expect(byPid.output).toContain(`PID=${pid}`);
    const listing = await withCwdAsync(tmp, () => withEnvAsync(statusEnv, () => getRunStatus()));
    expect(listing.exitCode).toBe(0);
    expect(listing.output).toContain('found 1 agent-quorum run(s)');

    await killDetachedRun(pid);
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
          quality: 'quick',
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

describe('typed workDir option (config via store)', () => {
  it('runPlanLoop honors workDir without mutating process.env', async () => {
    const optWork = path.join(tmp, 'opt-work');
    mkdirSync(optWork);
    const optHome = path.join(tmp, 'opt-home');
    writeStoreConfigRoles(optHome, 'critic:codex:custom-model-probe');

    const result = await withEnvAsync(
      baseEnv({
        AGENT_QUORUM_WORK_DIR: undefined,
        AGENT_QUORUM_HOME: optHome,
        FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json'),
      }),
      async () => {
        const envBefore = JSON.stringify(process.env);
        const run = await runPlanLoop({
          input: path.join(tmp, 'input.md'),
          iters: 1,
          quality: 'quick',
          fix: false,
          translate: false,
          workDir: optWork,
        });
        expect(JSON.stringify(process.env)).toBe(envBefore);
        return run;
      },
    );

    expect(result.exitCode).toBe(ExitCode.Ok);
    for (const artifact of ['plan.final.md', 'summary.md', 'run.meta.tsv']) {
      expect(existsSync(path.join(optWork, artifact)), artifact).toBe(true);
    }
    expect(readFileSync(path.join(optWork, 'run.meta.tsv'), 'utf8')).toContain(
      'custom-model-probe',
    );
    expect(existsSync(path.join(tmp, 'plans', 'loop-input'))).toBe(false);
  });

  it('launchPlanLoop forwards workDir to the detached child', async () => {
    writeHangingCodex();
    const optWork = path.join(tmp, 'launch-work');
    const optHome = path.join(tmp, 'opt-home');
    writeStoreConfigRoles(optHome, 'critic:codex:launch-model-probe');

    const result = await withEnvAsync(
      baseEnv({
        AGENT_QUORUM_LAUNCH_VERIFY_DELAY: '0.3',
        AGENT_QUORUM_WORK_DIR: undefined,
        AGENT_QUORUM_HOME: optHome,
      }),
      async () => {
        const envBefore = JSON.stringify(process.env);
        const run = await launchPlanLoop({
          input: path.join(tmp, 'input.md'),
          iters: 1,
          quality: 'quick',
          fix: false,
          translate: false,
          workDir: optWork,
        });
        expect(JSON.stringify(process.env)).toBe(envBefore);
        return run;
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(`work:  ${optWork}`);
    expect(existsSync(path.join(optWork, 'run.log'))).toBe(true);
    const pid = Number(/pid:\s+([0-9]+)/.exec(result.output)?.[1]);
    expect(Number.isInteger(pid)).toBe(true);

    try {
      let meta = '';
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const metaFile = path.join(optWork, 'run.meta.tsv');
        if (existsSync(metaFile)) {
          meta = readFileSync(metaFile, 'utf8');
          if (meta.includes('launch-model-probe')) {
            break;
          }
        }
        await sleep(200);
      }
      expect(meta).toContain('launch-model-probe');
    } finally {
      await killDetachedRun(pid);
    }
  }, 30_000);
});

describe('library selector API', () => {
  it('resolves a run created under a custom home via {home} without touching env', async () => {
    const home = path.join(tmp, 'home');
    const result = await withEnvAsync(
      baseEnv({
        AGENT_QUORUM_WORK_DIR: undefined,
        AGENT_QUORUM_PLANS_DIR: undefined,
        AGENT_QUORUM_STATE_DIR: undefined,
        FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json'),
      }),
      () =>
        runPlanLoop({
          input: path.join(tmp, 'input.md'),
          iters: 1,
          quality: 'quick',
          fix: false,
          translate: false,
          home,
        }),
    );
    expect(result.exitCode).toBe(ExitCode.Ok);
    expect(result.name).toBe('input');
    const runId = result.runId ?? '';
    const canonicalWork = realpathSync(path.join(home, 'runs', 'loop-input'));

    // Lookups resolve purely via {home}; env carries no state/plans dir here.
    expect(getRun('input', { home })?.runId).toBe(runId);
    expect(getRun(runId, { home })?.name).toBe('input');
    expect(getRunLogPath('input', { home })).toBe(path.join(canonicalWork, 'run.log'));
    // home overrides the root but still aggregates; isolate cwd so the
    // project-local store does not leak host runs into this assertion.
    expect(withCwd(tmp, () => listRuns({ home })).map((record) => record.name)).toContain('input');

    const intervention = interveneRun('input', 'check the cutover', 'all', { home });
    expect(intervention.exitCode).toBe(0);
    expect(
      readFileSync(path.join(canonicalWork, 'operator-interventions.jsonl'), 'utf8'),
    ).toContain('check the cutover');

    // A selector that matches nothing resolves to undefined / exit 2.
    expect(getRun('ghost', { home })).toBeUndefined();
    expect(interveneRun('ghost', 'x', 'all', { home }).exitCode).toBe(2);
  });

  it('getRunStatus(pid) keeps its signature and behavior', async () => {
    const env = {
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
    };
    const dead = await withEnvAsync(env, () => getRunStatus(999999));
    expect(dead.exitCode).toBe(2);
    expect(typeof dead.output).toBe('string');
  });
});

describe('library cross-store discovery', () => {
  it('listRuns() aggregates a non-ambient project-local store and matches the CLI listing', async () => {
    const realTmp = realpathSync(tmp);
    const projStore = path.join(realTmp, '.agents', 'plans', '.runs');
    writeRunRecord(projStore, liveDraft('proj-run', projStore));

    const env = {
      AGENT_QUORUM_HOME: path.join(realTmp, 'home'),
      AGENT_QUORUM_PLANS_DIR: undefined,
      AGENT_QUORUM_STATE_DIR: undefined,
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
    };
    const aggregated = await withCwdAsync(realTmp, () => withEnvAsync(env, () => listRuns()));
    expect(aggregated.map((record) => record.name)).toContain('proj-run');

    const listing = await withCwdAsync(realTmp, () => withEnvAsync(env, () => getRunStatus()));
    expect(listing.exitCode).toBe(0);
    expect(listing.output).toContain('proj-run');
  });

  it('listRuns({ store }) returns only that store', () => {
    const storeA = path.join(tmp, 'store-a');
    const storeB = path.join(tmp, 'store-b');
    writeRunRecord(storeA, liveDraft('only-a', storeA));
    writeRunRecord(storeB, liveDraft('only-b', storeB));
    expect(listRuns({ store: storeA }).map((record) => record.name)).toEqual(['only-a']);
  });

  it('home overrides the root but still aggregates, while store scopes to one ledger', () => {
    const realTmp = realpathSync(tmp);
    const home = path.join(realTmp, 'home');
    const homeStore = path.join(home, 'state');
    const projStore = path.join(realTmp, '.agents', 'plans', '.runs');
    writeRunRecord(homeStore, liveDraft('home-run', homeStore));
    writeRunRecord(projStore, liveDraft('proj-run', projStore));

    const aggregated = withEnv(
      { AGENT_QUORUM_PLANS_DIR: undefined, AGENT_QUORUM_STATE_DIR: undefined },
      () => withCwd(realTmp, () => listRuns({ home })),
    ).map((record) => record.name);
    expect(aggregated).toContain('home-run');
    expect(aggregated).toContain('proj-run');

    expect(listRuns({ store: homeStore }).map((record) => record.name)).toEqual(['home-run']);
  });
});

async function waitForCompletionNotification(
  stub: Awaited<ReturnType<typeof startTelegramStub>>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (stub.sent.some((text) => text.includes('agent-quorum finished'))) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

describe('structured config and secrets (P5)', () => {
  it('runPlanLoop({ config, secrets }) configures Telegram + roles structurally without mutating process.env', async () => {
    const stub = await startTelegramStub();
    const structHome = path.join(tmp, 'struct-home');
    try {
      const result = await withEnvAsync(
        baseEnv({
          AGENT_QUORUM_HOME: structHome,
          AGENT_QUORUM_TELEGRAM_API_BASE: stub.baseUrl,
          AGENT_QUORUM_TELEGRAM_BOT_TOKEN: undefined,
          AGENT_QUORUM_TELEGRAM_CHAT_ID: undefined,
          FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json'),
        }),
        async () => {
          const envBefore = JSON.stringify(process.env);
          const run = await runPlanLoop({
            input: path.join(tmp, 'input.md'),
            iters: 1,
            quality: 'quick',
            fix: false,
            translate: false,
            config: {
              telegram: { chatId: '77' },
              roles: { critic: { model: 'struct-model-probe' } },
            },
            secrets: { telegramBotToken: 'STRUCT-INPROC-TOKEN' },
          });
          expect(JSON.stringify(process.env)).toBe(envBefore);
          return run;
        },
      );

      expect(result.exitCode).toBe(ExitCode.Ok);
      expect(readFileSync(path.join(work, 'run.meta.tsv'), 'utf8')).toContain('struct-model-probe');
      expect(stub.sent.some((text) => text.includes('agent-quorum finished'))).toBe(true);
    } finally {
      await stub.close();
    }
  });

  it('runPlanLoop top-level iters wins over config.settings.iters (tie-break)', async () => {
    const result = await withEnvAsync(
      baseEnv({ FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json') }),
      () =>
        runPlanLoop({
          input: path.join(tmp, 'input.md'),
          iters: 1,
          quality: 'quick',
          fix: false,
          translate: false,
          config: { settings: { iters: 9 } },
        }),
    );
    expect(result.exitCode).toBe(ExitCode.Ok);
    expect(readFileSync(path.join(work, 'run.meta.tsv'), 'utf8')).toMatch(/^max_iters\t1$/m);
  });
});

describe('launchPlanLoop secret handoff round-trip (P5)', () => {
  it('hands a structured token to the detached child via the handoff file, notifies, and keeps it out of the provider env', async () => {
    const stub = await startTelegramStub();
    const home = path.join(tmp, 'home');
    const envDump = path.join(tmp, 'codex.env');
    try {
      const result = await withEnvAsync(
        baseEnv({
          AGENT_QUORUM_LAUNCH_VERIFY_DELAY: '0.3',
          AGENT_QUORUM_WORK_DIR: undefined,
          AGENT_QUORUM_TELEGRAM_API_BASE: stub.baseUrl,
          AGENT_QUORUM_TELEGRAM_BOT_TOKEN: undefined,
          FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json'),
          FAKE_CODEX_ENVDUMP: envDump,
        }),
        () =>
          launchPlanLoop({
            input: path.join(tmp, 'input.md'),
            iters: 1,
            quality: 'quick',
            fix: false,
            translate: false,
            config: { telegram: { chatId: '42' } },
            secrets: { telegramBotToken: 'SECRET-STRUCT-TOKEN' },
          }),
      );

      expect(result.exitCode).toBe(0);
      const pid = result.pid ?? 0;
      try {
        expect(await waitForCompletionNotification(stub)).toBe(true);
        const dump = readFileSync(envDump, 'utf8');
        expect(dump).not.toContain('SECRET-STRUCT-TOKEN');
        expect(dump).not.toMatch(/^AGENT_QUORUM_TELEGRAM_BOT_TOKEN=/m);
        expect(dump).not.toMatch(/^AGENT_QUORUM_SECRETS_OVERRIDE_JSON=/m);
        const handoff = path.join(home, 'handoff');
        expect(existsSync(handoff) ? readdirSync(handoff) : []).toEqual([]);
      } finally {
        await killDetachedRun(pid);
      }
    } finally {
      await stub.close();
    }
  }, 30_000);

  it('strips an ambient bot token from the detached child env yet still notifies via the handoff file', async () => {
    const stub = await startTelegramStub();
    const home = path.join(tmp, 'home');
    const envDump = path.join(tmp, 'codex.env');
    try {
      const result = await withEnvAsync(
        baseEnv({
          AGENT_QUORUM_LAUNCH_VERIFY_DELAY: '0.3',
          AGENT_QUORUM_WORK_DIR: undefined,
          AGENT_QUORUM_TELEGRAM_API_BASE: stub.baseUrl,
          AGENT_QUORUM_TELEGRAM_CHAT_ID: '42',
          AGENT_QUORUM_TELEGRAM_BOT_TOKEN: 'SECRET-AMBIENT-TOKEN',
          FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json'),
          FAKE_CODEX_ENVDUMP: envDump,
        }),
        () =>
          launchPlanLoop({
            input: path.join(tmp, 'input.md'),
            iters: 1,
            quality: 'quick',
            fix: false,
            translate: false,
          }),
      );

      expect(result.exitCode).toBe(0);
      const pid = result.pid ?? 0;
      try {
        expect(await waitForCompletionNotification(stub)).toBe(true);
        const dump = readFileSync(envDump, 'utf8');
        expect(dump).not.toContain('SECRET-AMBIENT-TOKEN');
        const handoff = path.join(home, 'handoff');
        expect(existsSync(handoff) ? readdirSync(handoff) : []).toEqual([]);
      } finally {
        await killDetachedRun(pid);
      }
    } finally {
      await stub.close();
    }
  }, 30_000);
});
