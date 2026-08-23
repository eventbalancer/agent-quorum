import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exemptFixPass,
  fixReviewCandidateDigest,
  runFixPass,
} from '../../src/stages/plan/fix-pass.js';
import { runTranslatePass } from '../../src/stages/plan/translate-pass.js';
import {
  createReadinessProofCatalog,
  createReadinessProofState,
  recordAdmittedFixReviewerProof,
  type ReadinessInvariantRecord,
  type ReadinessProofState,
} from '../../src/core/readiness-proof.js';
import {
  readReadinessProofState,
  writeReadinessProofState,
} from '../../src/core/readiness-store.js';
import type { RunContext } from '../../src/core/run-context.js';
import { Scratch } from '../../src/runtime/scratch.js';
import { setPlanFrontmatterStatus } from '../../src/stages/plan/plan-shape.js';
import {
  argvRecords,
  captureStderr,
  withEnvAsync,
  writeFakeBin,
  writeStructuredPlanFile,
  type StderrCapture,
} from '../helpers/harness.js';
import {
  fixtureMatrix,
  makeTestRunContext,
  type TestContextOptions,
} from '../helpers/test-context.js';

let tmp: string;
let fake: string;
let work: string;
let scratch: Scratch;
let capture: StderrCapture;

function makeContext(options: TestContextOptions = {}): RunContext {
  return makeTestRunContext(tmp, work, scratch, options);
}

function seedConvergedPlan(): string {
  const finalPlan = path.join(work, 'plan.final.md');
  writeStructuredPlanFile(finalPlan, 'Converged');
  return finalPlan;
}

function writeFindings(stale: number): void {
  const staleLines = Array.from({ length: stale }, (_, index) => ({
    file: 'stale.md',
    line: index + 9,
    actual_lines: 1,
  }));
  writeFileSync(
    path.join(work, 'findings.json'),
    `${JSON.stringify({ stale_lines: staleLines, ambiguous: [], unresolved: [] }, null, 2)}\n`,
  );
}

function writeReview(file: string, approval: string, concerns: unknown[]): void {
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        approval,
        coverage_complete: true,
        unresolved_occurrence_ids: [],
        invariant_assessments: [],
        concerns,
      },
      null,
      2,
    )}\n`,
  );
}

const ACTIVE_INVARIANTS: readonly ReadinessInvariantRecord[] = [
  {
    id: 'I-v0-C1',
    sourceFinding: 'v0.C1',
    statement: 'The repaired reference remains valid.',
    occurrences: [{ id: 'O-fixture', dimension: 'reference', subject: 'stale.md:9' }],
  },
];

function writeInvariantReview(
  file: string,
  approval: string,
  concerns: unknown[],
  disposition: 'satisfied' | 'violated' | 'not-applicable' | 'unresolved',
): void {
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        approval,
        coverage_complete: true,
        unresolved_occurrence_ids: disposition === 'unresolved' ? ['O-fixture'] : [],
        invariant_assessments: [
          {
            invariant_id: 'I-v0-C1',
            occurrences: [
              {
                occurrence_id: 'O-fixture',
                disposition,
                evidence_refs:
                  disposition === 'unresolved'
                    ? []
                    : [{ kind: 'plan-section', section: 'Verification' }],
              },
            ],
          },
        ],
        concerns,
      },
      null,
      2,
    )}\n`,
  );
}

function proofState(
  ctx: RunContext,
  invariants: readonly ReadinessInvariantRecord[] = [],
): ReadinessProofState {
  const catalog = createReadinessProofCatalog({
    expectedPlanVersion: 0,
    invariants: invariants.map((invariant) => ({
      invariantId: invariant.id,
      occurrenceIds: invariant.occurrences.map((occurrence) => occurrence.id),
    })),
    materialIssueIds: [],
  });
  return createReadinessProofState({
    quality: ctx.settings.quality,
    matrix: ctx.quality,
    mode: ctx.mode,
    sourceDigest: '4'.repeat(64),
    authoritativeDigest: ctx.systemContext.digest,
    relationshipIds: [],
    maxIters: ctx.settings.maxIters,
    trustedCatalog: catalog,
    invariants,
  });
}

function runTestFixPass(
  ctx: RunContext,
  finalPlan: string,
  proof: ReadinessProofState = proofState(ctx),
) {
  ctx.readinessProof = proof;
  return runFixPass(ctx, finalPlan, proof);
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-fixtest.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  work = path.join(tmp, 'work');
  mkdirSync(work);
  scratch = Scratch.create('fix-test');
  capture = captureStderr();
});

afterEach(() => {
  capture.restore();
  scratch.sweep();
  rmSync(tmp, { recursive: true, force: true });
});

function fakePath(): string {
  return `${fake}:${process.env.PATH ?? ''}`;
}

describe('fix pass', () => {
  it('returns explicit disabled and no-findings exemptions', async () => {
    expect(exemptFixPass('disabled')).toEqual({
      retainedReplacement: false,
      requirement: { required: false, reason: 'disabled' },
    });
    const finalPlan = seedConvergedPlan();
    const ctx = makeContext();
    expect(await runTestFixPass(ctx, finalPlan)).toEqual(exemptFixPass('no-findings'));
    expect(capture.text()).toContain('fix-pass: no findings.json — skipping');

    writeFindings(0);
    expect(await runTestFixPass(ctx, finalPlan)).toEqual(exemptFixPass('no-findings'));
    expect(capture.text()).toContain('fix-pass: 0 findings — skipping');
    expect(existsSync(path.join(work, 'plan.final.before-fix.md'))).toBe(false);
  });

  it('returns exact admitted proposal evidence with status-normalized identity', async () => {
    const finalPlan = seedConvergedPlan();
    const before = readFileSync(finalPlan, 'utf8');
    writeFindings(1);
    const proposal = path.join(tmp, 'proposal.md');
    writeStructuredPlanFile(proposal, 'Fixed Proposal');
    const review = path.join(tmp, 'review.json');
    writeInvariantReview(review, 'accept', [], 'satisfied');
    const matrix = fixtureMatrix();
    matrix.reviewer = {
      runner: 'claude',
      model: 'claude-opus-4-8',
      reasoning: 'xhigh',
    };
    const ctx = makeContext({ matrix });
    const proof = proofState(ctx, ACTIVE_INVARIANTS);

    const outcome = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: proposal,
        FAKE_CLAUDE_JSON_RESULT: review,
        FAKE_CLAUDE_REQUIRE_DRAFT7: '1',
      },
      () => runTestFixPass(ctx, finalPlan, proof),
    );

    expect(outcome.retainedReplacement).toBe(true);
    if (!outcome.retainedReplacement) {
      throw new Error('expected retained proposal outcome');
    }
    expect(outcome.candidate).toEqual({
      kind: 'fix-proposal',
      planVersion: 0,
      path: finalPlan,
      contentDigest: fixReviewCandidateDigest(finalPlan),
    });
    expect(outcome.requirement).toEqual({
      required: true,
      reason: 'fix-pass-replacement-retained',
      expectedBinding: outcome.review.expectedBinding,
    });
    expect(outcome.review.snapshot).toEqual({
      source: 'fix-reviewer',
      catalogDigest: outcome.review.snapshot.catalogDigest,
      binding: outcome.requirement.expectedBinding,
      occurrences: [
        {
          invariantId: 'I-v0-C1',
          occurrenceId: 'O-fixture',
          disposition: 'satisfied',
          evidenceGrounded: true,
        },
      ],
    });
    const recorded = recordAdmittedFixReviewerProof(ctx.readinessProof, outcome.review);
    expect(recorded.sources.find((source) => source.source === 'fix-reviewer')).toEqual({
      source: 'fix-reviewer',
      requirement: outcome.requirement,
      snapshot: outcome.review.snapshot,
    });
    expect(readFileSync(finalPlan, 'utf8')).toBe(readFileSync(proposal, 'utf8'));
    const retainedDigest = outcome.candidate.contentDigest;
    setPlanFrontmatterStatus(finalPlan, 'needs-review');
    expect(fixReviewCandidateDigest(finalPlan)).toBe(retainedDigest);
    const nonStatusMutation = path.join(tmp, 'non-status-mutation.md');
    writeFileSync(
      nonStatusMutation,
      readFileSync(finalPlan, 'utf8').replace('# Fixed Proposal', '# Mutated Proposal'),
    );
    expect(fixReviewCandidateDigest(nonStatusMutation)).not.toBe(retainedDigest);
    expect(capture.text()).toContain('fix-pass: clean accept, using proposal as final plan');
    expect(JSON.parse(readFileSync(path.join(work, 'fix-review.json'), 'utf8'))).toMatchObject({
      approval: 'accept',
      coverage_complete: true,
      unresolved_occurrence_ids: [],
      concerns: [],
    });
    expect(readFileSync(path.join(work, 'plan.final.before-fix.md'), 'utf8')).toBe(before);
    expect(capture.text()).toContain('fix-pass: done (backup at plan.final.before-fix.md)');
  });

  it('retries a schema-valid fix review with ungrounded candidate evidence', async () => {
    const finalPlan = seedConvergedPlan();
    writeFindings(1);
    const proposal = path.join(tmp, 'proposal.md');
    writeStructuredPlanFile(proposal, 'Fix Review Retry');
    const validReview = path.join(tmp, 'valid-review.json');
    writeInvariantReview(validReview, 'accept', [], 'satisfied');
    const invalidReview = path.join(tmp, 'invalid-review.json');
    const invalidValue = JSON.parse(readFileSync(validReview, 'utf8')) as {
      invariant_assessments: { occurrences: { evidence_refs: unknown[] }[] }[];
    };
    const occurrence = invalidValue.invariant_assessments[0]?.occurrences[0];
    if (occurrence === undefined) {
      throw new TypeError('missing fix-review occurrence fixture');
    }
    occurrence.evidence_refs = [{ kind: 'plan-section', section: 'Invented Section' }];
    writeFileSync(invalidReview, `${JSON.stringify(invalidValue, null, 2)}\n`);
    const calls = path.join(tmp, 'review.calls');
    const prompt = path.join(tmp, 'review.prompt');
    const matrix = fixtureMatrix();
    matrix.reviewer = {
      runner: 'claude',
      model: 'claude-opus-4-8',
      reasoning: 'xhigh',
    };
    const ctx = makeContext({ matrix });
    ctx.provider = {
      ...ctx.provider,
      retry: { retryCount: 1, retryDelaySeconds: 0 },
    };
    ctx.passes.fixPass = {
      ...ctx.passes.fixPass,
      retryCount: 1,
    };
    const proof = proofState(ctx, ACTIVE_INVARIANTS);

    const outcome = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: proposal,
        FAKE_CLAUDE_JSON_RESULT: validReview,
        FAKE_CLAUDE_JSON_CALLS: calls,
        FAKE_CLAUDE_JSON_RESULT_1: invalidReview,
        FAKE_CLAUDE_JSON_RESULT_2: validReview,
        FAKE_CLAUDE_PROMPT: prompt,
      },
      () => runTestFixPass(ctx, finalPlan, proof),
    );

    expect(outcome.retainedReplacement).toBe(true);
    expect(readFileSync(calls, 'utf8')).toBe('2');
    expect(readFileSync(prompt, 'utf8')).toContain('## Deterministic semantic-admission repair');
    expect(readFileSync(prompt, 'utf8')).toContain('## Deterministic candidate evidence anchors');
    expect(capture.text()).toContain(
      'fix-reviewer output failed semantic admission (code=ungrounded-evidence',
    );
  });

  it('admits a separate exact applied review before retaining changed bytes', async () => {
    const finalPlan = seedConvergedPlan();
    writeFindings(1);
    const proposal = path.join(tmp, 'proposal.md');
    writeStructuredPlanFile(proposal, 'Fixed Proposal');
    const applied = path.join(tmp, 'applied.md');
    writeStructuredPlanFile(applied, 'Applied Fix');
    const review = path.join(tmp, 'review.json');
    writeReview(review, 'reject', [
      { id: 'R1', claim: 'apply concern', evidence: 'stale.md:9', severity: 'major' },
    ]);
    const appliedReview = path.join(tmp, 'applied-review.json');
    writeReview(appliedReview, 'accept', []);
    const reviewPrompt = path.join(tmp, 'codex.prompt');
    const ctx = makeContext();

    const outcome = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_CALLS: path.join(tmp, 'claude.calls'),
        FAKE_CLAUDE_MARKDOWN_RESULT: proposal,
        FAKE_CLAUDE_MARKDOWN_RESULT_2: applied,
        FAKE_CODEX_OUTPUT: review,
        FAKE_CODEX_OUTPUT_CALLS: path.join(tmp, 'codex.calls'),
        FAKE_CODEX_OUTPUT_1: review,
        FAKE_CODEX_OUTPUT_2: appliedReview,
        FAKE_CODEX_PROMPT: reviewPrompt,
      },
      () => runTestFixPass(ctx, finalPlan),
    );

    expect(outcome.retainedReplacement).toBe(true);
    if (!outcome.retainedReplacement) {
      throw new Error('expected retained applied outcome');
    }
    expect(outcome.candidate).toMatchObject({
      kind: 'fix-applied',
      planVersion: 0,
      path: finalPlan,
      contentDigest: fixReviewCandidateDigest(finalPlan),
    });
    expect(outcome.requirement.expectedBinding.candidate.kind).toBe('fix-applied');
    expect(outcome.requirement.expectedBinding.lineage.evaluationStage).toBe('fix-applied-review');
    expect(outcome.review.materialIssueIds).toEqual([]);
    expect(outcome.review.snapshot.binding).toEqual(outcome.requirement.expectedBinding);
    expect(readFileSync(reviewPrompt, 'utf8')).toContain(
      `occurrence_source_lineage_digest: ${outcome.requirement.expectedBinding.lineage.lineageDigest}`,
    );
    expect(capture.text()).toContain('fix-pass: step 3 — claude apply');
    expect(capture.text()).toContain('fix-pass: step 4 — codex review exact applied candidate');
    expect(readFileSync(finalPlan, 'utf8')).toBe(readFileSync(applied, 'utf8'));
  });

  it('rejects an incomplete proposal review before candidate adoption', async () => {
    const finalPlan = seedConvergedPlan();
    const before = readFileSync(finalPlan, 'utf8');
    writeFindings(1);
    const proposal = path.join(tmp, 'proposal.md');
    writeStructuredPlanFile(proposal, 'Invariant Regression');
    const incompleteReview = path.join(tmp, 'incomplete-review.json');
    writeFileSync(
      incompleteReview,
      `${JSON.stringify({ approval: 'accept', concerns: [] }, null, 2)}\n`,
    );
    const ctx = makeContext();
    const proof = proofState(ctx, ACTIVE_INVARIANTS);

    const outcome = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: proposal,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CODEX_OUTPUT: incompleteReview,
      },
      () => runTestFixPass(ctx, finalPlan, proof),
    );

    expect(outcome).toEqual(exemptFixPass('review-failed'));
    expect(capture.text()).toContain('fix-pass: review failed');
    expect(readFileSync(finalPlan, 'utf8')).toBe(before);
  });

  it('returns proposal-failed without retaining provider output', async () => {
    const finalPlan = seedConvergedPlan();
    const before = readFileSync(finalPlan, 'utf8');
    writeFindings(2);
    const ctx = makeContext();

    const outcome = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_ATTEMPTS: path.join(tmp, 'claude.attempts'),
        FAKE_CLAUDE_FAILS: '9',
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () => runTestFixPass(ctx, finalPlan),
    );

    expect(outcome).toEqual(exemptFixPass('proposal-failed'));
    expect(capture.text()).toContain('keeping pre-fix canonical plan, fix-pass skipped');
    expect(readFileSync(finalPlan, 'utf8')).toBe(before);
  });

  it('classifies shape-broken proposal output as proposal-failed', async () => {
    const finalPlan = seedConvergedPlan();
    const before = readFileSync(finalPlan, 'utf8');
    writeFindings(1);
    const broken = path.join(tmp, 'broken.md');
    writeFileSync(broken, '# Just a summary\n\nNot a full plan.\n');
    const ctx = makeContext();

    const outcome = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: broken,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () => runTestFixPass(ctx, finalPlan),
    );

    expect(outcome).toEqual(exemptFixPass('proposal-failed'));
    expect(capture.text()).toContain('fix-pass: proposal output failed the plan-shape gate');
    expect(readFileSync(finalPlan, 'utf8')).toBe(before);
  });

  it('heals a wrapped proposal before accepting it', async () => {
    const finalPlan = seedConvergedPlan();
    writeFindings(1);
    const cleanProposal = path.join(tmp, 'clean-proposal.md');
    writeStructuredPlanFile(cleanProposal, 'Healed Proposal');
    const wrapped = path.join(tmp, 'wrapped-proposal.md');
    writeFileSync(
      wrapped,
      `The Write tool isn't available, so here is the plan:\n\n${readFileSync(cleanProposal, 'utf8')}`,
    );
    const review = path.join(tmp, 'review.json');
    writeReview(review, 'accept', []);
    const ctx = makeContext();

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: wrapped,
        FAKE_CODEX_OUTPUT: review,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () => runTestFixPass(ctx, finalPlan),
    );

    expect(readFileSync(finalPlan, 'utf8')).toBe(readFileSync(cleanProposal, 'utf8'));
    expect(existsSync(path.join(work, 'fix-proposal.md.raw'))).toBe(true);
    expect(capture.text()).toContain('fix-pass: clean accept');
  });

  it('returns replacement-rejected when changed output fails validation', async () => {
    const finalPlan = seedConvergedPlan();
    const before = readFileSync(finalPlan, 'utf8');
    writeFindings(1);
    const proposal = path.join(tmp, 'proposal.md');
    writeStructuredPlanFile(proposal, 'Fixed Proposal');
    const brokenApply = path.join(tmp, 'broken-apply.md');
    writeFileSync(brokenApply, '# Not a plan\n');
    const review = path.join(tmp, 'review.json');
    writeReview(review, 'reject', [
      { id: 'R1', claim: 'major concern', evidence: 'stale.md:9', severity: 'major' },
    ]);
    const ctx = makeContext();

    const outcome = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_CALLS: path.join(tmp, 'claude.calls'),
        FAKE_CLAUDE_MARKDOWN_RESULT: proposal,
        FAKE_CLAUDE_MARKDOWN_RESULT_2: brokenApply,
        FAKE_CODEX_OUTPUT: review,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () => runTestFixPass(ctx, finalPlan),
    );

    expect(outcome).toEqual(exemptFixPass('replacement-rejected'));
    expect(capture.text()).toContain('fix-pass: apply output rejected');
    expect(readFileSync(finalPlan, 'utf8')).toBe(before);
  });

  it('does not bind a proposal review to failed changed bytes', async () => {
    const finalPlan = seedConvergedPlan();
    const before = readFileSync(finalPlan, 'utf8');
    writeFindings(1);
    const proposal = path.join(tmp, 'proposal.md');
    writeStructuredPlanFile(proposal, 'Fixed Proposal');
    const brokenApply = path.join(tmp, 'broken-apply.md');
    writeFileSync(brokenApply, '# Not a plan\n');
    const review = path.join(tmp, 'review.json');
    writeReview(review, 'accept_with_concerns', [
      { id: 'R1', claim: 'minor nit', evidence: 'stale.md:9', severity: 'minor' },
    ]);
    const ctx = makeContext();

    const outcome = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_CALLS: path.join(tmp, 'claude.calls'),
        FAKE_CLAUDE_MARKDOWN_RESULT: proposal,
        FAKE_CLAUDE_MARKDOWN_RESULT_2: brokenApply,
        FAKE_CODEX_OUTPUT: review,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () => runTestFixPass(ctx, finalPlan),
    );

    expect(outcome).toEqual(exemptFixPass('replacement-rejected'));
    expect(readFileSync(finalPlan, 'utf8')).toBe(before);
  });

  it('restores the pre-fix plan when an admitted applied review is inconclusive', async () => {
    const finalPlan = seedConvergedPlan();
    const before = readFileSync(finalPlan, 'utf8');
    writeFindings(1);
    const proposal = path.join(tmp, 'proposal.md');
    writeStructuredPlanFile(proposal, 'Invariant Regression');
    const applied = path.join(tmp, 'applied.md');
    writeStructuredPlanFile(applied, 'Applied Invariant Regression');
    const proposalReview = path.join(tmp, 'proposal-review.json');
    writeInvariantReview(
      proposalReview,
      'reject',
      [{ id: 'R1', claim: 'apply the repair', evidence: 'stale.md:9', severity: 'major' }],
      'satisfied',
    );
    const appliedReview = path.join(tmp, 'applied-review.json');
    writeInvariantReview(appliedReview, 'accept', [], 'unresolved');
    const ctx = makeContext();
    const proof = proofState(ctx, ACTIVE_INVARIANTS);

    const outcome = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_CALLS: path.join(tmp, 'claude.calls'),
        FAKE_CLAUDE_MARKDOWN_RESULT: proposal,
        FAKE_CLAUDE_MARKDOWN_RESULT_2: applied,
        FAKE_CODEX_OUTPUT_CALLS: path.join(tmp, 'codex.calls'),
        FAKE_CODEX_OUTPUT_1: proposalReview,
        FAKE_CODEX_OUTPUT_2: appliedReview,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () => runTestFixPass(ctx, finalPlan, proof),
    );

    expect(outcome).toEqual(exemptFixPass('pre-fix-restored'));
    expect(capture.text()).toContain('restoring backup');
    expect(readFileSync(finalPlan, 'utf8')).toBe(before);
  });
});

describe('translate pass', () => {
  it('writes localized final markdown through the translator role', async () => {
    const finalPlan = seedConvergedPlan();
    const outLocalized = path.join(work, 'plan.final.pt-BR.md');
    const translated = path.join(tmp, 'translated.md');
    writeFileSync(
      translated,
      readFileSync(finalPlan, 'utf8').replace('# Converged', '# Plano convergido'),
    );
    const argvLog = path.join(tmp, 'claude.argv');
    const promptLog = path.join(tmp, 'claude.prompt');
    const ctx = makeContext({ locale: 'pt-BR' });
    ctx.readinessProof = proofState(ctx);
    const versionedState = writeReadinessProofState(
      path.join(work, `convergence.v${ctx.readinessProof.planVersion}.json`),
      ctx.readinessProof,
    );
    const versionedBefore = readFileSync(versionedState);

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: translated,
        FAKE_CLAUDE_ARGV_LOG: argvLog,
        FAKE_CLAUDE_PROMPT: promptLog,
      },
      () => runTranslatePass(ctx, finalPlan, outLocalized),
    );

    expect(readFileSync(outLocalized, 'utf8')).toBe(readFileSync(translated, 'utf8'));
    expect(readFileSync(promptLog, 'utf8')).toContain('## Target locale\npt-BR');
    expect(capture.text()).toContain('translate-pass: done');
    expect(readFileSync(versionedState)).toEqual(versionedBefore);
    expect(readReadinessProofState(versionedState).contextDeliveries).toEqual([]);
    expect(ctx.readinessProof.contextDeliveries).toEqual([
      expect.objectContaining({ role: 'translator', stage: 'translate' }),
    ]);
    const record = argvRecords(argvLog)[0] ?? [];
    expect(record[record.indexOf('--permission-mode') + 1]).toBe('default');
  });

  it('rejects a translation that changes canonical frontmatter or durable coverage', async () => {
    const finalPlan = seedConvergedPlan();
    const relationshipId = `R-${'a'.repeat(64)}`;
    const canonical = `${readFileSync(finalPlan, 'utf8')}\n## System Coverage\n\n| Relationship ID | Type | Producer/authority | Consumer/executor | Implementation phase | Release stage/gate | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |\n| ${relationshipId} | ci-trigger | build | deploy | P1 | P1 | workflow.yml:1 |\n`;
    writeFileSync(finalPlan, canonical);
    const invalid = path.join(tmp, 'invalid-translation.md');
    writeFileSync(
      invalid,
      canonical.replace('status: clean', 'status: needs-review').replace(relationshipId, 'R-bad'),
    );
    const outLocalized = path.join(work, 'plan.final.ru.md');
    const ctx = makeContext({ locale: 'ru' });

    await withEnvAsync({ PATH: fakePath(), FAKE_CLAUDE_MARKDOWN_RESULT: invalid }, () =>
      runTranslatePass(ctx, finalPlan, outLocalized),
    );

    expect(existsSync(outLocalized)).toBe(false);
    expect(capture.text()).toContain('rejected localized output');
  });

  it('failure is non-fatal and leaves no localized artifact', async () => {
    const finalPlan = seedConvergedPlan();
    const outLocalized = path.join(work, 'plan.final.ru.md');
    const ctx = makeContext();

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_ATTEMPTS: path.join(tmp, 'claude.attempts'),
        FAKE_CLAUDE_FAILS: '9',
      },
      () => runTranslatePass(ctx, finalPlan, outLocalized),
    );

    expect(existsSync(outLocalized)).toBe(false);
    expect(capture.text()).toContain('translate-pass: failed/timed out');
    expect(capture.text()).toContain('English plan.final.md unaffected');
  });

  it('skips when there is no final plan', async () => {
    const outLocalized = path.join(work, 'plan.final.ru.md');
    const ctx = makeContext();
    await runTranslatePass(ctx, path.join(work, 'plan.final.md'), outLocalized);
    expect(capture.text()).toContain('translate-pass: no final plan — skipping');
  });
});
