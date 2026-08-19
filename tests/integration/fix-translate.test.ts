import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFixPass } from '../../src/stages/plan/fix-pass.js';
import { runTranslatePass } from '../../src/stages/plan/translate-pass.js';
import { writeConvergenceState } from '../../src/core/convergence.js';
import type { RunContext } from '../../src/core/run-context.js';
import { Scratch } from '../../src/runtime/scratch.js';
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

function addActiveInvariant(ctx: RunContext): void {
  ctx.convergence.invariants = [
    {
      id: 'I-v0-C1',
      sourceFinding: 'I-v0-C1',
      statement: 'The repaired reference remains valid.',
      status: 'resolved',
      lastReviewedPlanVersion: 0,
      occurrences: [
        {
          id: 'O-fixture',
          dimension: 'reference',
          subject: 'stale.md:9',
          disposition: 'satisfied',
          evidenceRefs: [],
        },
      ],
    },
  ];
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
  it('skips without findings.json and with zero findings', async () => {
    const finalPlan = seedConvergedPlan();
    const ctx = makeContext();
    await runFixPass(ctx, finalPlan);
    expect(capture.text()).toContain('fix-pass: no findings.json — skipping');

    writeFindings(0);
    await runFixPass(ctx, finalPlan);
    expect(capture.text()).toContain('fix-pass: 0 findings — skipping');
    expect(existsSync(path.join(work, 'plan.final.before-fix.md'))).toBe(false);
  });

  it('consumes a clean Claude review with a draft-07 schema', async () => {
    const finalPlan = seedConvergedPlan();
    const before = readFileSync(finalPlan, 'utf8');
    writeFindings(1);
    const proposal = path.join(tmp, 'proposal.md');
    writeStructuredPlanFile(proposal, 'Fixed Proposal');
    const review = path.join(tmp, 'review.json');
    writeReview(review, 'accept', []);
    const matrix = fixtureMatrix();
    matrix.reviewer = {
      runner: 'claude',
      model: 'claude-opus-4-8',
      reasoning: 'xhigh',
    };
    const ctx = makeContext({ matrix });

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: proposal,
        FAKE_CLAUDE_JSON_RESULT: review,
        FAKE_CLAUDE_REQUIRE_DRAFT7: '1',
      },
      () => runFixPass(ctx, finalPlan),
    );

    expect(capture.text()).toContain('fix-pass: clean accept, using proposal as final plan');
    expect(JSON.parse(readFileSync(path.join(work, 'fix-review.json'), 'utf8'))).toEqual({
      approval: 'accept',
      coverage_complete: true,
      unresolved_occurrence_ids: [],
      invariant_assessments: [],
      concerns: [],
    });
    expect(readFileSync(finalPlan, 'utf8')).toBe(readFileSync(proposal, 'utf8'));
    expect(readFileSync(path.join(work, 'plan.final.before-fix.md'), 'utf8')).toBe(before);
    expect(capture.text()).toContain('fix-pass: done (backup at plan.final.before-fix.md)');
  });

  it('concerns route through the apply step', async () => {
    const finalPlan = seedConvergedPlan();
    writeFindings(1);
    const proposal = path.join(tmp, 'proposal.md');
    writeStructuredPlanFile(proposal, 'Fixed Proposal');
    const applied = path.join(tmp, 'applied.md');
    writeStructuredPlanFile(applied, 'Applied Fix');
    const review = path.join(tmp, 'review.json');
    writeReview(review, 'accept_with_concerns', [
      { id: 'R1', claim: 'apply concern', evidence: 'stale.md:9', severity: 'major' },
    ]);
    const appliedReview = path.join(tmp, 'applied-review.json');
    writeReview(appliedReview, 'accept', []);
    const ctx = makeContext();

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_CALLS: path.join(tmp, 'claude.calls'),
        FAKE_CLAUDE_MARKDOWN_RESULT: proposal,
        FAKE_CLAUDE_MARKDOWN_RESULT_2: applied,
        FAKE_CODEX_OUTPUT: review,
        FAKE_CODEX_OUTPUT_CALLS: path.join(tmp, 'codex.calls'),
        FAKE_CODEX_OUTPUT_1: review,
        FAKE_CODEX_OUTPUT_2: appliedReview,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () => runFixPass(ctx, finalPlan),
    );

    expect(capture.text()).toContain('fix-pass: step 3 — claude apply');
    expect(capture.text()).toContain('fix-pass: step 4 — codex review exact applied candidate');
    expect(readFileSync(finalPlan, 'utf8')).toBe(readFileSync(applied, 'utf8'));
  });

  it('independently reviews an accepted proposal when active invariant coverage is missing', async () => {
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
    const appliedReview = path.join(tmp, 'applied-review.json');
    writeFileSync(
      appliedReview,
      `${JSON.stringify(
        {
          approval: 'reject',
          coverage_complete: false,
          unresolved_occurrence_ids: ['O-fixture'],
          invariant_assessments: [
            {
              invariant_id: 'I-v0-C1',
              satisfied: false,
              unresolved_occurrence_ids: ['O-fixture'],
            },
          ],
          concerns: [
            {
              id: 'R1',
              claim: 'The proposal regresses the active invariant.',
              evidence: 'stale.md:9',
              severity: 'major',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const ctx = makeContext();
    addActiveInvariant(ctx);

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: proposal,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CODEX_OUTPUT_CALLS: path.join(tmp, 'codex.calls'),
        FAKE_CODEX_OUTPUT_1: incompleteReview,
        FAKE_CODEX_OUTPUT_2: appliedReview,
      },
      () => runFixPass(ctx, finalPlan),
    );

    expect(capture.text()).toContain(
      'proposal accepted without complete invariant coverage — reviewing exact candidate',
    );
    expect(capture.text()).toContain('fix-pass: step 4 — codex review exact applied candidate');
    expect(capture.text()).toContain(
      'exact applied candidate was not independently approved — restoring backup',
    );
    expect(readFileSync(finalPlan, 'utf8')).toBe(before);
  });

  it('propose failure keeps the pre-fix canonical plan', async () => {
    const finalPlan = seedConvergedPlan();
    const before = readFileSync(finalPlan, 'utf8');
    writeFindings(2);
    const ctx = makeContext();

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_ATTEMPTS: path.join(tmp, 'claude.attempts'),
        FAKE_CLAUDE_FAILS: '9',
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () => runFixPass(ctx, finalPlan),
    );

    expect(capture.text()).toContain('keeping pre-fix canonical plan, fix-pass skipped');
    expect(readFileSync(finalPlan, 'utf8')).toBe(before);
  });

  it('shape-broken proposal keeps the pre-fix canonical plan', async () => {
    const finalPlan = seedConvergedPlan();
    const before = readFileSync(finalPlan, 'utf8');
    writeFindings(1);
    const broken = path.join(tmp, 'broken.md');
    writeFileSync(broken, '# Just a summary\n\nNot a full plan.\n');
    const ctx = makeContext();

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: broken,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () => runFixPass(ctx, finalPlan),
    );

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
      () => runFixPass(ctx, finalPlan),
    );

    expect(readFileSync(finalPlan, 'utf8')).toBe(readFileSync(cleanProposal, 'utf8'));
    expect(existsSync(path.join(work, 'fix-proposal.md.raw'))).toBe(true);
    expect(capture.text()).toContain('fix-pass: clean accept');
  });

  it('rejects a bad apply output after a blocker/major review', async () => {
    const finalPlan = seedConvergedPlan();
    const before = readFileSync(finalPlan, 'utf8');
    writeFindings(1);
    const proposal = path.join(tmp, 'proposal.md');
    writeStructuredPlanFile(proposal, 'Fixed Proposal');
    const brokenApply = path.join(tmp, 'broken-apply.md');
    writeFileSync(brokenApply, '# Not a plan\n');
    const review = path.join(tmp, 'review.json');
    writeReview(review, 'accept_with_concerns', [
      { id: 'R1', claim: 'major concern', evidence: 'stale.md:9', severity: 'major' },
    ]);
    const ctx = makeContext();

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_CALLS: path.join(tmp, 'claude.calls'),
        FAKE_CLAUDE_MARKDOWN_RESULT: proposal,
        FAKE_CLAUDE_MARKDOWN_RESULT_2: brokenApply,
        FAKE_CODEX_OUTPUT: review,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () => runFixPass(ctx, finalPlan),
    );

    expect(capture.text()).toContain(
      'fix-pass: apply output rejected after blocker/major review — keeping pre-fix canonical plan',
    );
    expect(readFileSync(finalPlan, 'utf8')).toBe(before);
  });

  it('rejected apply output falls back to the proposal when no blockers/majors remain', async () => {
    const finalPlan = seedConvergedPlan();
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

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_CALLS: path.join(tmp, 'claude.calls'),
        FAKE_CLAUDE_MARKDOWN_RESULT: proposal,
        FAKE_CLAUDE_MARKDOWN_RESULT_2: brokenApply,
        FAKE_CODEX_OUTPUT: review,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () => runFixPass(ctx, finalPlan),
    );

    expect(capture.text()).toContain(
      'fix-pass: apply output rejected — using validated proposal as final',
    );
    expect(readFileSync(finalPlan, 'utf8')).toBe(readFileSync(proposal, 'utf8'));
  });

  it('re-reviews an invalid-apply fallback when proposal invariant coverage is incomplete', async () => {
    const finalPlan = seedConvergedPlan();
    const before = readFileSync(finalPlan, 'utf8');
    writeFindings(1);
    const proposal = path.join(tmp, 'proposal.md');
    writeStructuredPlanFile(proposal, 'Invariant Regression');
    const brokenApply = path.join(tmp, 'broken-apply.md');
    writeFileSync(brokenApply, '# Not a plan\n');
    const incompleteReview = path.join(tmp, 'incomplete-review.json');
    writeFileSync(
      incompleteReview,
      `${JSON.stringify({
        approval: 'accept_with_concerns',
        coverage_complete: false,
        unresolved_occurrence_ids: ['O-fixture'],
        invariant_assessments: [],
        concerns: [{ id: 'R1', claim: 'minor concern', evidence: 'stale.md:9', severity: 'minor' }],
      })}\n`,
    );
    const rejectedReview = path.join(tmp, 'rejected-review.json');
    writeFileSync(
      rejectedReview,
      `${JSON.stringify({
        approval: 'reject',
        coverage_complete: false,
        unresolved_occurrence_ids: ['O-fixture'],
        invariant_assessments: [],
        concerns: [
          { id: 'R2', claim: 'invariant unresolved', evidence: 'stale.md:9', severity: 'major' },
        ],
      })}\n`,
    );
    const ctx = makeContext();
    addActiveInvariant(ctx);

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_CALLS: path.join(tmp, 'claude.calls'),
        FAKE_CLAUDE_MARKDOWN_RESULT: proposal,
        FAKE_CLAUDE_MARKDOWN_RESULT_2: brokenApply,
        FAKE_CODEX_OUTPUT_CALLS: path.join(tmp, 'codex.calls'),
        FAKE_CODEX_OUTPUT: incompleteReview,
        FAKE_CODEX_OUTPUT_1: incompleteReview,
        FAKE_CODEX_OUTPUT_2: rejectedReview,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () => runFixPass(ctx, finalPlan),
    );

    expect(capture.text()).toContain('using validated proposal as final');
    expect(capture.text()).toContain('review exact applied candidate');
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
    const versionedState = writeConvergenceState(work, ctx.convergence);
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
    expect(ctx.convergence.contextDeliveries).toEqual([
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
