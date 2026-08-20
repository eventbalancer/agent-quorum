import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPlanLoop } from '../../src/index.js';
import {
  captureStderr,
  emptyCritique,
  withEnvAsync,
  writeFakeBin,
  writeReadinessAssessment,
  writeStoreConfig,
  writeStructuredPlanFile,
  type StderrCapture,
} from '../helpers/harness.js';

let tmp: string;
let fake: string;
let work: string;
let input: string;
let assessment: string;
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
    AGENT_QUORUM_RETRY_DELAY_SECONDS: '0',
    AGENT_QUORUM_RESUME: undefined,
    FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
    FAKE_CLAUDE_PROMPT: path.join(tmp, 'claude.prompt'),
    FAKE_READINESS_ASSESSMENT: assessment,
    ...extra,
  };
}

function writeAcceptedReview(file: string): void {
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        approval: 'accept',
        coverage_complete: true,
        unresolved_occurrence_ids: [],
        invariant_assessments: [],
        concerns: [],
      },
      null,
      2,
    )}\n`,
  );
}

function writeJudgeVerdict(file: string, ready: boolean): void {
  writeFileSync(
    file,
    `${JSON.stringify({
      ready,
      rationale: ready
        ? 'The exact final candidate is acceptable.'
        : 'The current candidate is not ready.',
      coverage_complete: true,
      unresolved_occurrence_ids: [],
      invariant_assessments: [],
    })}\n`,
  );
}

async function run(extra: EnvOverrides, fix: boolean) {
  return withEnvAsync(baseEnv(extra), () =>
    runPlanLoop({
      input,
      iters: 1,
      quality: 'balanced',
      fix,
      translate: false,
      workDir: work,
    }),
  );
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-finalization-proof.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  work = path.join(tmp, 'work');
  mkdirSync(work);
  mkdirSync(path.join(tmp, 'plans'));
  mkdirSync(path.join(tmp, 'state'));
  writeStoreConfig(path.join(tmp, 'home'));
  input = path.join(tmp, 'input.md');
  assessment = path.join(tmp, 'readiness-standard.json');
  writeReadinessAssessment(assessment);
  capture = captureStderr();
});

afterEach(() => {
  capture.restore();
  rmSync(tmp, { recursive: true, force: true });
});

describe('delivered-plan readiness proof', () => {
  it('allows an orchestration-only frontmatter status projection', async () => {
    writeStructuredPlanFile(input, 'Status Projection Input', { status: 'needs-review' });
    const critique = path.join(tmp, 'clean.json');
    emptyCritique(critique);

    const result = await run({ FAKE_CODEX_OUTPUT: critique }, false);

    expect(result.status).toBe('clean');
    expect(result.convergence).toMatchObject({ decision: 'ready', satisfied: true });
    expect(result.convergence?.reasonCodes).not.toContain('fresh-review-required');
    expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toContain('status: clean');
  });

  it('preserves critic proof across repository-relative file-line normalization', async () => {
    writeStructuredPlanFile(input, 'Reference-normalization Input');
    const repositoryPrefix = `${process.cwd()}/`;
    writeFileSync(
      input,
      `${readFileSync(input, 'utf8')}\n- Verified anchor: \`file-line:${repositoryPrefix}package.json:1\`.\n`,
    );
    const critique = path.join(tmp, 'clean.json');
    emptyCritique(critique);
    const fixed = path.join(tmp, 'relative-reference.md');
    writeFileSync(
      fixed,
      readFileSync(input, 'utf8').replaceAll(`file-line:${repositoryPrefix}`, 'file-line:'),
    );
    const review = path.join(tmp, 'review.json');
    writeAcceptedReview(review);

    const result = await run(
      {
        FAKE_CODEX_OUTPUT: review,
        FAKE_CODEX_OUTPUT_CALLS: path.join(tmp, 'reference-codex.calls'),
        FAKE_CODEX_OUTPUT_1: critique,
        FAKE_CODEX_OUTPUT_2: review,
        FAKE_CLAUDE_MARKDOWN_RESULT: fixed,
      },
      true,
    );

    expect(result.status).toBe('clean');
    expect(result.convergence).toMatchObject({ decision: 'ready', satisfied: true });
    expect(result.convergence?.reasonCodes).not.toContain('fresh-review-required');
    expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toContain(
      '`file-line:package.json:1`',
    );
  });

  it('requires a fresh independent review after a substantive standard-risk fix pass', async () => {
    writeStructuredPlanFile(input, 'Pre-fix Input');
    writeFileSync(
      input,
      `${readFileSync(input, 'utf8')}\n- Broken reference: \`missing-file.ts:99999\`\n`,
    );
    const critique = path.join(tmp, 'clean.json');
    emptyCritique(critique);
    const fixed = path.join(tmp, 'fixed.md');
    writeStructuredPlanFile(fixed, 'Post-fix Candidate');
    const review = path.join(tmp, 'review.json');
    writeAcceptedReview(review);
    const codexCalls = path.join(tmp, 'codex.calls');

    const result = await run(
      {
        FAKE_CODEX_OUTPUT: review,
        FAKE_CODEX_OUTPUT_CALLS: codexCalls,
        FAKE_CODEX_OUTPUT_1: critique,
        FAKE_CODEX_OUTPUT_2: review,
        FAKE_CLAUDE_MARKDOWN_RESULT: fixed,
      },
      true,
    );

    expect(result.status).toBe('needs-review');
    expect(result.structuralStatus).toBe('clean');
    expect(result.convergence).toMatchObject({
      decision: 'unable-to-decide',
      satisfied: false,
    });
    expect(result.convergence?.reasonCodes).toContain('fresh-review-required');
    expect(result.convergence?.unresolvedCoverage).toContain(
      'canonical-plan:fresh-review-required',
    );
    expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toContain(
      '# Post-fix Candidate',
    );
    expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toContain(
      'status: needs-review',
    );
  });

  it('feeds structural reference review into the convergence decision', async () => {
    writeStructuredPlanFile(input, 'Reference Review Input');
    writeFileSync(
      input,
      `${readFileSync(input, 'utf8')}\n- Broken reference: \`missing-file.ts:99999\`\n`,
    );
    const critique = path.join(tmp, 'clean.json');
    emptyCritique(critique);

    const result = await run({ FAKE_CODEX_OUTPUT: critique }, false);

    expect(result.status).toBe('needs-review');
    expect(result.structuralStatus).toBe('needs-review');
    expect(result.convergence).toMatchObject({
      decision: 'unable-to-decide',
      satisfied: false,
    });
    expect(result.convergence?.reasonCodes).toContain('final-artifact-needs-review');
    expect(result.convergence?.reasonCodes).not.toContain('fresh-review-required');
    expect(result.convergence?.unresolvedCoverage).toContain('final-artifact:needs-review');
    expect(readFileSync(path.join(work, 'convergence.final.json'), 'utf8')).toContain(
      '"satisfied": false',
    );
  });

  it('does not let a final Judge replace fresh critic review after a high-risk fix', async () => {
    writeReadinessAssessment(assessment, true);
    writeStructuredPlanFile(input, 'High-risk Pre-fix Input');
    writeFileSync(
      input,
      `${readFileSync(input, 'utf8')}\n- Broken reference: \`missing-file.ts:99999\`\n`,
    );
    const critique = path.join(tmp, 'high-clean.json');
    emptyCritique(critique);
    const fixed = path.join(tmp, 'high-fixed.md');
    writeStructuredPlanFile(fixed, 'High-risk Post-fix Candidate');
    const review = path.join(tmp, 'high-review.json');
    writeAcceptedReview(review);
    const intermediate = path.join(tmp, 'intermediate-not-ready.json');
    const final = path.join(tmp, 'final-ready.json');
    writeJudgeVerdict(intermediate, false);
    writeJudgeVerdict(final, true);

    const result = await run(
      {
        FAKE_CODEX_OUTPUT: review,
        FAKE_CODEX_OUTPUT_CALLS: path.join(tmp, 'high-codex.calls'),
        FAKE_CODEX_OUTPUT_1: critique,
        FAKE_CODEX_OUTPUT_2: review,
        FAKE_CLAUDE_MARKDOWN_RESULT: fixed,
        FAKE_CLAUDE_JSON_RESULT: final,
        FAKE_CLAUDE_JSON_RESULT_1: intermediate,
        FAKE_CLAUDE_JSON_RESULT_2: final,
      },
      true,
    );

    expect(result.readiness).toMatchObject({ evaluated: true, ready: true });
    expect(result).toMatchObject({
      status: 'needs-review',
      convergence: {
        decision: 'unable-to-decide',
        satisfied: false,
        reasonCodes: ['fresh-review-required'],
      },
    });
    expect(result.convergence?.unresolvedCoverage).toContain(
      'canonical-plan:fresh-review-required',
    );
  });
});
