import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPlanLoop } from '../../src/index.js';
import { readRunRecords } from '../../src/core/run-store.js';
import {
  captureStderr,
  emptyCritique,
  withEnvAsync,
  writeCritique,
  writeFakeBin,
  writeStoreConfig,
  writeStructuredPlanFile,
  type StderrCapture,
} from '../helpers/harness.js';

type TerminationKind =
  | 'zero-issue'
  | 'intermediate-judge'
  | 'creator-convergence'
  | 'stable-diff'
  | 'max-iters'
  | 'post-fix';

interface CaseSetup {
  readonly env: Record<string, string | undefined>;
  readonly quality: 'balanced' | 'thorough';
  readonly fix: boolean;
  readonly diffThreshold?: number;
  readonly expectedLog: string;
}

const MAJOR_ISSUE = {
  id: 'C1',
  addresses: null,
  severity: 'major',
  category: 'correctness',
  claim: 'fixture concern',
  evidence: 'fixture.md:1',
  suggested_fix: 'address it',
  confidence: 1,
  duplicate_of: null,
};

const NIT_ISSUE = { ...MAJOR_ISSUE, severity: 'nit', category: 'convention' };

let tmp: string;
let fake: string;
let work: string;
let input: string;
let capture: StderrCapture;

function baseEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    PATH: `${fake}:${process.env.PATH ?? ''}`,
    AGENT_QUORUM_HOME: path.join(tmp, 'home'),
    AGENT_QUORUM_WORK_DIR: work,
    AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
    AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
    AGENT_QUORUM_CLARIFY: '0',
    AGENT_QUORUM_RETRY_COUNT: '0',
    AGENT_QUORUM_RETRY_DELAY_SECONDS: '0',
    FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
    FAKE_CLAUDE_PROMPT: path.join(tmp, 'claude.prompt'),
    ...extra,
  };
}

function writeVerdict(name: string, ready: boolean, rationale = `${name} rationale`): string {
  const file = path.join(tmp, `${name}.json`);
  writeFileSync(file, `${JSON.stringify({ ready, rationale }, null, 2)}\n`);
  return file;
}

function writeUpdateMeta(name: string, withMajor: boolean): string {
  const file = path.join(tmp, `${name}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        plan_version: 1,
        issues: withMajor
          ? [
              {
                id: 'C1',
                verdict: 'accept',
                verdict_reason: 'fixture',
                final_severity: 'major',
                duplicate_of: null,
              },
            ]
          : [],
        applied: withMajor ? ['C1'] : [],
        rejected_append: [],
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

function setupCase(kind: TerminationKind, finalVerdict: string): CaseSetup {
  const critique = path.join(tmp, 'critique.json');
  switch (kind) {
    case 'zero-issue':
      emptyCritique(critique);
      return {
        env: baseEnv({ FAKE_CODEX_OUTPUT: critique, FAKE_CLAUDE_JSON_RESULT: finalVerdict }),
        quality: 'balanced',
        fix: false,
        expectedLog: 'converged at v0 (critic returned no issues)',
      };
    case 'intermediate-judge': {
      writeCritique(critique, [NIT_ISSUE]);
      const calls = path.join(tmp, 'claude-json.calls');
      const intermediate = writeVerdict('intermediate-ready', true);
      return {
        env: baseEnv({
          FAKE_CODEX_OUTPUT: critique,
          FAKE_CLAUDE_JSON_RESULT: finalVerdict,
          FAKE_CLAUDE_JSON_CALLS: calls,
          FAKE_CLAUDE_JSON_RESULT_1: intermediate,
          FAKE_CLAUDE_JSON_RESULT_2: finalVerdict,
        }),
        quality: 'balanced',
        fix: false,
        expectedLog: 'intermediate judge verdict: implementation-ready',
      };
    }
    case 'creator-convergence': {
      writeCritique(critique, [MAJOR_ISSUE]);
      const revision = path.join(tmp, 'creator-converged.md');
      writeStructuredPlanFile(revision, 'Creator Converged');
      const meta = writeUpdateMeta('creator-converged-meta', false);
      return {
        env: baseEnv({
          FAKE_CODEX_OUTPUT: critique,
          FAKE_CLAUDE_MARKDOWN_RESULT: revision,
          FAKE_CLAUDE_JSON_RESULT: finalVerdict,
          FAKE_CLAUDE_JSON_CALLS: path.join(tmp, 'claude-json.calls'),
          FAKE_CLAUDE_JSON_RESULT_1: meta,
          FAKE_CLAUDE_JSON_RESULT_2: finalVerdict,
        }),
        quality: 'balanced',
        fix: false,
        expectedLog: 'converged at v1 (no accepted blockers/majors)',
      };
    }
    case 'stable-diff': {
      writeCritique(critique, [MAJOR_ISSUE]);
      const meta = writeUpdateMeta('stable-meta', true);
      return {
        env: baseEnv({
          FAKE_CODEX_OUTPUT: critique,
          FAKE_CLAUDE_MARKDOWN_RESULT: input,
          FAKE_CLAUDE_JSON_RESULT: finalVerdict,
          FAKE_CLAUDE_JSON_CALLS: path.join(tmp, 'claude-json.calls'),
          FAKE_CLAUDE_JSON_RESULT_1: meta,
          FAKE_CLAUDE_JSON_RESULT_2: finalVerdict,
        }),
        quality: 'balanced',
        fix: false,
        expectedLog: 'stable-diff at v1',
      };
    }
    case 'max-iters': {
      writeCritique(critique, [MAJOR_ISSUE]);
      const revision = path.join(tmp, 'max-iters.md');
      writeStructuredPlanFile(revision, 'MAX ITERS Revision');
      const meta = writeUpdateMeta('max-iters-meta', true);
      return {
        env: baseEnv({
          FAKE_CODEX_OUTPUT: critique,
          FAKE_CLAUDE_MARKDOWN_RESULT: revision,
          FAKE_CLAUDE_JSON_RESULT: finalVerdict,
          FAKE_CLAUDE_JSON_CALLS: path.join(tmp, 'claude-json.calls'),
          FAKE_CLAUDE_JSON_RESULT_1: meta,
          FAKE_CLAUDE_JSON_RESULT_2: finalVerdict,
        }),
        quality: 'thorough',
        fix: false,
        diffThreshold: 0,
        expectedLog: 'hit MAX_ITERS=1 without convergence',
      };
    }
    case 'post-fix': {
      writeFileSync(
        input,
        `${readFileSync(input, 'utf8')}\n- Broken reference: \`missing-file.ts:99999\`\n`,
      );
      emptyCritique(critique);
      const fixed = path.join(tmp, 'fixed.md');
      writeStructuredPlanFile(fixed, 'Post-fix Final');
      const review = path.join(tmp, 'review.json');
      writeFileSync(review, `${JSON.stringify({ approval: 'accept', concerns: [] })}\n`);
      return {
        env: baseEnv({
          FAKE_CODEX_OUTPUT: critique,
          FAKE_CODEX_OUTPUT_CALLS: path.join(tmp, 'codex.calls'),
          FAKE_CODEX_OUTPUT_1: critique,
          FAKE_CODEX_OUTPUT_2: review,
          FAKE_CLAUDE_MARKDOWN_RESULT: fixed,
          FAKE_CLAUDE_JSON_RESULT: finalVerdict,
        }),
        quality: 'balanced',
        fix: true,
        expectedLog: 'fix-pass: clean accept, using proposal as final plan',
      };
    }
    default: {
      kind satisfies never;
      throw new Error('unreachable termination kind');
    }
  }
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-final-readiness.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  work = path.join(tmp, 'work');
  mkdirSync(work);
  mkdirSync(path.join(tmp, 'plans'));
  mkdirSync(path.join(tmp, 'state'));
  writeStoreConfig(path.join(tmp, 'home'));
  input = path.join(tmp, 'input.md');
  writeStructuredPlanFile(input, 'Readiness Input');
  capture = captureStderr();
});

afterEach(() => {
  capture.restore();
  rmSync(tmp, { recursive: true, force: true });
});

describe('final Judge termination and verdict matrix', () => {
  const cases = (
    [
      'zero-issue',
      'intermediate-judge',
      'creator-convergence',
      'stable-diff',
      'max-iters',
      'post-fix',
    ] as const
  ).flatMap((kind) => [true, false].map((ready) => ({ kind, ready })));

  it.each(cases)(
    '$kind records final ready=$ready for the delivered plan',
    async ({ kind, ready }) => {
      const finalVerdict = writeVerdict('final-verdict', ready);
      const setup = setupCase(kind, finalVerdict);

      const result = await withEnvAsync(setup.env, () =>
        runPlanLoop({
          input,
          iters: 1,
          quality: setup.quality,
          fix: setup.fix,
          translate: false,
          workDir: work,
          ...(setup.diffThreshold !== undefined
            ? { config: { settings: { diffThreshold: setup.diffThreshold } } }
            : {}),
        }),
      );

      const finalPlan = path.join(work, 'plan.final.md');
      const planBytes = readFileSync(finalPlan);
      const digest = createHash('sha256').update(planBytes).digest('hex');
      const expectedStatus = ready ? 'clean' : 'needs-review';
      expect(result.exitCode).toBe(0);
      expect(result.status).toBe(expectedStatus);
      expect(result.structuralStatus).toBe('clean');
      expect(result.readiness).toEqual({
        evaluated: true,
        ready,
        rationale: 'final-verdict rationale',
        planSha256: digest,
      });
      expect(result.readinessPath).toBe(path.join(result.workDir ?? work, 'judge.final.meta.json'));
      expect(capture.text()).toContain(setup.expectedLog);

      const metadata = JSON.parse(
        readFileSync(path.join(work, 'judge.final.meta.json'), 'utf8'),
      ) as unknown;
      expect(metadata).toEqual({
        canonical_plan: 'plan.final.md',
        plan_sha256: digest,
        evaluated: true,
        ready,
        rationale: 'final-verdict rationale',
        verdict_artifact: 'judge.final.json',
      });
      expect(readFileSync(path.join(work, 'judge.final.json'), 'utf8')).toBe(
        readFileSync(path.join(work, 'judge.final.raw'), 'utf8'),
      );

      const summary = readFileSync(path.join(work, 'summary.md'), 'utf8');
      expect(summary).toContain('- structural_status: clean');
      expect(summary).toContain(
        `- final_judge: evaluated=true, readiness=${ready ? 'ready' : 'not-ready'}, plan_sha256=${digest}`,
      );
      expect(summary).toContain('- final_judge_rationale: final-verdict rationale');
      expect(summary).toContain(`- FINAL: ${expectedStatus}`);
      const runLog = readFileSync(path.join(work, 'run.log'), 'utf8');
      expect(runLog).toContain(`FINAL JUDGE: ${ready ? 'ready' : 'not-ready'}`);
      const finalPrompt = readFileSync(path.join(tmp, 'claude.prompt'), 'utf8');
      expect(finalPrompt).toContain(`plan_sha256: ${digest}`);
      expect(finalPrompt).toContain(
        `## Plan\n${planBytes.toString('utf8')}\n\n## Critique Context`,
      );

      const records = readRunRecords(path.join(tmp, 'state'));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        state: 'finished',
        exitCode: 0,
        finalStatus: expectedStatus,
        finalReason: ready ? '' : 'Final Judge: final-verdict rationale',
        structuralStatus: 'clean',
        finalReadiness: {
          evaluated: true,
          ready,
          rationale: 'final-verdict rationale',
          planSha256: digest,
        },
      });
    },
    30_000,
  );

  it('degrades exhausted schema-invalid final output to unknown needs-review', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const invalid = path.join(tmp, 'invalid-verdict.json');
    writeFileSync(invalid, '{"ready":true}\n');
    const calls = path.join(tmp, 'claude-json.calls');

    const result = await withEnvAsync(
      baseEnv({
        AGENT_QUORUM_RETRY_COUNT: '1',
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CLAUDE_JSON_RESULT: invalid,
        FAKE_CLAUDE_JSON_CALLS: calls,
      }),
      () =>
        runPlanLoop({
          input,
          iters: 1,
          quality: 'balanced',
          fix: false,
          translate: false,
          workDir: work,
        }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('needs-review');
    expect(result.readiness).toMatchObject({ evaluated: false, ready: null });
    expect(readFileSync(calls, 'utf8')).toBe('2');
    expect(existsSync(path.join(work, 'plan.final.md'))).toBe(true);
    expect(existsSync(path.join(work, 'judge.final.json'))).toBe(false);
    expect(
      JSON.parse(readFileSync(path.join(work, 'judge.final.meta.json'), 'utf8')),
    ).toMatchObject({
      evaluated: false,
      ready: null,
      verdict_artifact: null,
    });
    expect(readFileSync(path.join(work, 'summary.md'), 'utf8')).toContain(
      'final_judge: evaluated=false, readiness=unknown',
    );
    expect(readFileSync(path.join(work, 'run.log'), 'utf8')).toContain('FINAL JUDGE: unknown');
  }, 30_000);

  it('keeps structural needs-review distinct from a positive readiness verdict', async () => {
    writeFileSync(
      input,
      `${readFileSync(input, 'utf8')}\n- Broken reference: \`missing-file.ts:99999\`\n`,
    );
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const verdict = writeVerdict('structurally-warned-ready', true);

    const result = await withEnvAsync(
      baseEnv({ FAKE_CODEX_OUTPUT: critique, FAKE_CLAUDE_JSON_RESULT: verdict }),
      () =>
        runPlanLoop({
          input,
          iters: 1,
          quality: 'balanced',
          fix: false,
          translate: false,
          workDir: work,
        }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('needs-review');
    expect(result.structuralStatus).toBe('needs-review');
    expect(result.readiness?.ready).toBe(true);
    expect(result.reason).toContain('reference');
  });

  it('skips final Judge when structural status is blocked', async () => {
    writeFileSync(input, '# Broken plan\n');
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);

    const result = await withEnvAsync(baseEnv({ FAKE_CODEX_OUTPUT: critique }), () =>
      runPlanLoop({
        input,
        iters: 1,
        quality: 'balanced',
        fix: false,
        translate: false,
        workDir: work,
      }),
    );

    expect(result.exitCode).toBe(6);
    expect(result.status).toBe('blocked');
    expect(result.structuralStatus).toBe('blocked');
    expect(result.readiness).toBeUndefined();
    expect(existsSync(path.join(work, 'judge.final.raw'))).toBe(false);
    expect(readFileSync(path.join(work, 'run.log'), 'utf8')).toContain(
      'final Judge skipped — structural status is blocked',
    );
  });

  it('keeps quick quality free of final Judge calls and artifacts', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);

    const result = await withEnvAsync(baseEnv({ FAKE_CODEX_OUTPUT: critique }), () =>
      runPlanLoop({
        input,
        iters: 1,
        quality: 'quick',
        fix: false,
        translate: false,
        workDir: work,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('clean');
    expect(result.readiness).toBeUndefined();
    expect(existsSync(path.join(work, 'judge.final.raw'))).toBe(false);
    expect(existsSync(path.join(work, 'judge.final.json'))).toBe(false);
    expect(existsSync(path.join(work, 'judge.final.meta.json'))).toBe(false);
    expect(readFileSync(path.join(work, 'summary.md'), 'utf8')).not.toContain('final_judge:');
    expect(readFileSync(path.join(work, 'run.log'), 'utf8')).not.toContain('FINAL JUDGE:');
  });
});
