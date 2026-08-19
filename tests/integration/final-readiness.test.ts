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

function writeVerdict(
  name: string,
  ready: boolean,
  rationale = `${name} rationale`,
  coverageComplete = true,
): string {
  const file = path.join(tmp, `${name}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        ready,
        rationale,
        coverage_complete: coverageComplete,
        unresolved_occurrence_ids: [],
        invariant_assessments: [],
      },
      null,
      2,
    )}\n`,
  );
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
        expectedLog: 'iter=0 — intermediate judge',
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
        expectedLog: 'proof-satisfied at v0',
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
        expectedLog: 'hit MAX_ITERS=1 without proof',
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
        expectedLog: 'stable-diff telemetry at v1',
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
        expectedLog: 'hit MAX_ITERS=1 without proof',
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
      writeFileSync(
        review,
        `${JSON.stringify({
          approval: 'accept',
          coverage_complete: true,
          unresolved_occurrence_ids: [],
          invariant_assessments: [],
          concerns: [],
        })}\n`,
      );
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
      const proofCanSatisfy = !['creator-convergence', 'stable-diff', 'max-iters'].includes(kind);
      const expectedStatus = ready && proofCanSatisfy ? 'clean' : 'needs-review';
      expect(result.exitCode).toBe(0);
      expect(result.status).toBe(expectedStatus);
      expect(result.structuralStatus).toBe('clean');
      expect(result.convergence).toMatchObject({
        promise: setup.quality === 'thorough' ? 'exhaustive' : 'cumulative',
        satisfied: expectedStatus === 'clean',
      });
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
      expect(summary).not.toContain('final_judge_rationale:');
      expect(summary).toContain(`- FINAL: ${expectedStatus}`);
      const runLog = readFileSync(path.join(work, 'run.log'), 'utf8');
      expect(runLog).toContain(`FINAL JUDGE: ${ready ? 'ready' : 'not-ready'}`);
      expect(runLog.indexOf('FINAL:')).toBeGreaterThan(
        runLog.indexOf('translate-pass: disabled (locale=en)'),
      );
      const finalPrompt = readFileSync(path.join(tmp, 'claude.prompt'), 'utf8');
      expect(finalPrompt).toContain(`plan_sha256: ${digest}`);
      expect(finalPrompt).toContain(
        `## Plan\n${planBytes.toString('utf8')}\n\n## Critique Context`,
      );

      const records = readRunRecords(path.join(tmp, 'state'));
      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record).toMatchObject({
        state: 'finished',
        exitCode: 0,
        finalStatus: expectedStatus,
        structuralStatus: 'clean',
        finalConvergence: {
          promise: setup.quality === 'thorough' ? 'exhaustive' : 'cumulative',
          satisfied: expectedStatus === 'clean',
        },
        finalReadiness: {
          evaluated: true,
          ready,
          rationale: 'final-verdict rationale',
          planSha256: digest,
        },
      });
      if (expectedStatus === 'clean') {
        expect(record?.finalReason).toBe('');
      } else {
        expect(record?.finalReason).toContain(
          ready ? 'Convergence proof:' : 'Final Judge: not-ready',
        );
      }
      expect(record?.finalConvergence?.artifactPath).toMatch(/\/convergence\.final\.json$/);
      expect(Array.isArray(record?.finalConvergence?.exhaustedLimits)).toBe(true);
      expect(Array.isArray(record?.finalConvergence?.unresolvedCoverage)).toBe(true);
    },
    30_000,
  );

  it('keeps final coverage proof separate from intermediate Judge approval', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const intermediate = writeVerdict('intermediate-ready', true);
    const finalUnproved = writeVerdict('final-coverage-unproved', true, 'coverage unproved', false);
    const calls = path.join(tmp, 'claude-json.calls');

    const result = await withEnvAsync(
      baseEnv({
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CLAUDE_JSON_RESULT: finalUnproved,
        FAKE_CLAUDE_JSON_CALLS: calls,
        FAKE_CLAUDE_JSON_RESULT_1: intermediate,
        FAKE_CLAUDE_JSON_RESULT_2: finalUnproved,
        FAKE_CLAUDE_JSON_RESULT_3: finalUnproved,
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

    expect(result.status).toBe('needs-review');
    expect(result.readiness?.ready).toBe(true);
    expect(result.convergence?.satisfied).toBe(false);
    expect(result.convergence?.unresolvedCoverage).toContain('final-judge:coverage-unproved');
    expect(
      JSON.parse(readFileSync(path.join(work, 'convergence.final.json'), 'utf8')),
    ).toMatchObject({
      judgeApprovedPlanVersion: 0,
      satisfied: false,
    });
  });

  it('cannot clean a canonical plan mutated by the final Judge provider', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const verdict = writeVerdict('mutation-ready', true);
    const mutatedPlan = path.join(tmp, 'mutated-final.md');
    writeStructuredPlanFile(mutatedPlan, 'Mutated During Final Judge');
    writeFileSync(
      mutatedPlan,
      readFileSync(mutatedPlan, 'utf8').replaceAll('Fixture Phase', 'Mutated Phase'),
    );
    const mutationCalls = path.join(tmp, 'final-mutation.calls');

    const result = await withEnvAsync(
      baseEnv({
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CLAUDE_JSON_RESULT: verdict,
        FAKE_CLAUDE_FINAL_PLAN_MUTATION_SOURCE: mutatedPlan,
        FAKE_CLAUDE_FINAL_PLAN_MUTATION_TARGET: path.join(work, 'plan.final.md'),
        FAKE_CLAUDE_FINAL_PLAN_MUTATION_CALLS: mutationCalls,
      }),
      () =>
        runPlanLoop({
          input,
          iters: 1,
          quality: 'balanced',
          fix: false,
          translate: false,
          workDir: work,
          config: { split: { mode: 'always' } },
        }),
    );

    const finalPlan = path.join(work, 'plan.final.md');
    const finalDigest = createHash('sha256').update(readFileSync(finalPlan)).digest('hex');
    const systemCheck = JSON.parse(
      readFileSync(path.join(work, 'system-check.final.json'), 'utf8'),
    ) as { planSha256: string };
    const convergence = JSON.parse(
      readFileSync(path.join(work, 'convergence.final.json'), 'utf8'),
    ) as { canonicalPlanSha256: string; unresolvedCoverage: string[] };

    expect(result.status).toBe('needs-review');
    expect(result.convergence?.satisfied).toBe(false);
    expect(result.convergence?.unresolvedCoverage).toContain('canonical-plan:proof-hash-mismatch');
    expect(convergence.unresolvedCoverage).toContain('canonical-plan:proof-hash-mismatch');
    expect(convergence.canonicalPlanSha256).toBe(finalDigest);
    expect(systemCheck.planSha256).toBe(finalDigest);
    expect(result.readiness?.planSha256).toBe(finalDigest);
    expect(readFileSync(finalPlan, 'utf8')).toContain('# Mutated During Final Judge');
    expect(readFileSync(finalPlan, 'utf8')).toContain('status: needs-review');
    const packageDir = path.join(work, 'plan.package');
    expect(readFileSync(path.join(packageDir, 'plan.md'))).toEqual(readFileSync(finalPlan));
    expect(readFileSync(path.join(packageDir, 'README.md'), 'utf8')).toContain(
      '# Mutated During Final Judge - change pack',
    );
    expect(readFileSync(path.join(packageDir, 'run.md'), 'utf8')).toContain(
      '# Mutated During Final Judge - runbook',
    );
    expect(existsSync(path.join(packageDir, 'phase-1-fixture-phase.md'))).toBe(false);
    expect(existsSync(path.join(packageDir, 'phase-1-mutated-phase.md'))).toBe(true);
    expect(readFileSync(mutationCalls, 'utf8')).toBe('2');
    expect(readFileSync(path.join(work, 'run.log'), 'utf8')).not.toContain('FINAL: clean');
  });

  it('does not let final Judge readiness substitute for rejected intermediate proof', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const intermediate = writeVerdict('intermediate-not-ready', false);
    const finalReady = writeVerdict('final-ready', true);
    const calls = path.join(tmp, 'claude-json.calls');

    const result = await withEnvAsync(
      baseEnv({
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CLAUDE_JSON_RESULT: finalReady,
        FAKE_CLAUDE_JSON_CALLS: calls,
        FAKE_CLAUDE_JSON_RESULT_1: intermediate,
        FAKE_CLAUDE_JSON_RESULT_2: finalReady,
        FAKE_CLAUDE_JSON_RESULT_3: finalReady,
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

    expect(result.status).toBe('needs-review');
    expect(result.readiness?.ready).toBe(true);
    expect(result.convergence?.unresolvedCoverage).toContain('plan.v0:judge');
    expect(result.convergence?.unresolvedCoverage).not.toContain('final-judge:coverage-unproved');
    const state = JSON.parse(readFileSync(path.join(work, 'convergence.final.json'), 'utf8')) as {
      judgeApprovedPlanVersion?: number;
    };
    expect(state.judgeApprovedPlanVersion).toBeUndefined();
  });

  it('keeps a changed final coverage proof from cleaning the projected plan', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const intermediate = writeVerdict('intermediate-ready', true);
    const finalUnproved = writeVerdict('final-first-unproved', true, 'first proof', false);
    const finalProved = writeVerdict('final-second-proved', true, 'second proof', true);
    const calls = path.join(tmp, 'claude-json.calls');

    const result = await withEnvAsync(
      baseEnv({
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CLAUDE_JSON_RESULT: finalProved,
        FAKE_CLAUDE_JSON_CALLS: calls,
        FAKE_CLAUDE_JSON_RESULT_1: intermediate,
        FAKE_CLAUDE_JSON_RESULT_2: finalUnproved,
        FAKE_CLAUDE_JSON_RESULT_3: finalProved,
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

    expect(result.status).toBe('needs-review');
    expect(result.convergence?.unresolvedCoverage).toContain('final-judge:inconsistent-verdict');
    expect(result.convergence?.unresolvedCoverage).not.toContain('final-judge:coverage-unproved');
  });

  it('keeps intermediate and final Judge rationale out of normal run logging', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const intermediateSecret = 'INTERMEDIATE_JUDGE_PRIVATE_BODY_68f121';
    const finalSecret = 'FINAL_JUDGE_PRIVATE_BODY_d19c04';
    const intermediate = writeVerdict('intermediate-private', true, intermediateSecret);
    const finalNotReady = writeVerdict('final-private', false, finalSecret);
    const calls = path.join(tmp, 'claude-json.calls');

    const result = await withEnvAsync(
      baseEnv({
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CLAUDE_JSON_RESULT: finalNotReady,
        FAKE_CLAUDE_JSON_CALLS: calls,
        FAKE_CLAUDE_JSON_RESULT_1: intermediate,
        FAKE_CLAUDE_JSON_RESULT_2: finalNotReady,
        FAKE_CLAUDE_JSON_RESULT_3: finalNotReady,
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

    const runLog = readFileSync(path.join(work, 'run.log'), 'utf8');
    const summary = readFileSync(path.join(work, 'summary.md'), 'utf8');
    expect(runLog).not.toContain(intermediateSecret);
    expect(runLog).not.toContain(finalSecret);
    expect(summary).not.toContain(intermediateSecret);
    expect(summary).not.toContain(finalSecret);
    expect(result.reason).not.toContain(finalSecret);
    expect(result.readiness?.rationale).toBe(finalSecret);
    const record = readRunRecords(path.join(tmp, 'state'))[0];
    expect(record?.finalReason).not.toContain(finalSecret);
    expect(record?.finalReadiness?.rationale).toBe(finalSecret);
    expect(
      JSON.parse(readFileSync(path.join(work, 'judge.final.meta.json'), 'utf8')),
    ).toMatchObject({
      rationale: finalSecret,
    });
  });

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
    expect(readFileSync(calls, 'utf8')).toBe('5');
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
