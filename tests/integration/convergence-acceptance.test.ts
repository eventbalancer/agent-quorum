import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConvergenceState } from '../../src/core/convergence.js';
import { schemaValidQuiet } from '../../src/core/schema.js';
import { Scratch } from '../../src/runtime/scratch.js';
import { runIterationLoop } from '../../src/stages/plan/loop.js';
import type { JsonValue } from '../../src/core/json.js';
import { fixtureMatrix, makeTestRunContext } from '../helpers/test-context.js';
import {
  captureStderr,
  withEnvAsync,
  writeFakeBin,
  writeStructuredPlanFile,
  type StderrCapture,
} from '../helpers/harness.js';

const REQUIRED_CONTEXT = [
  'original-scope',
  'authoritative-system-facts',
  'operator-decisions',
  'material-findings',
  'active-invariants',
  'quality-and-limits',
] as const;

const PLAN_SECTION_EVIDENCE: JsonValue[] = [{ kind: 'plan-section', section: 'Target State' }];

let tmp: string;
let fake: string;
let work: string;
let scratch: Scratch;
let capture: StderrCapture;

function writeJson(file: string, value: JsonValue): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function review(
  issueCount: number,
  invariantAssessments: JsonValue[] = [],
): Record<string, JsonValue> {
  return {
    considered_context: [...REQUIRED_CONTEXT],
    invariant_assessments: invariantAssessments,
    scope_coverage: ['direct-plan-scope'],
    issue_budget: { limit: 8, used: issueCount, exhausted: false },
    scan_complete: true,
    unresolved_coverage: [],
  };
}

function writePlan(
  version: number,
  title: string,
  targetState: string,
  status: 'clean' | 'needs-review' = 'clean',
): string {
  const file = path.join(work, `plan.v${version}.md`);
  writeStructuredPlanFile(file, title, { status });
  writeFileSync(file, readFileSync(file, 'utf8').replace('- Fixture target.', `- ${targetState}`));
  return file;
}

function seedInput(): void {
  const input = path.join(tmp, 'input.md');
  writeStructuredPlanFile(input, 'Input');
  writeFileSync(path.join(work, 'rejected-log.jsonl'), '');
}

function fakePath(): string {
  return `${fake}:${process.env.PATH ?? ''}`;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-convergence-acceptance.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  work = path.join(tmp, 'work');
  mkdirSync(work);
  scratch = Scratch.create('convergence-acceptance-test');
  capture = captureStderr();
  seedInput();
});

afterEach(() => {
  capture.restore();
  scratch.sweep();
  rmSync(tmp, { recursive: true, force: true });
});

describe('cumulative convergence acceptance', () => {
  it('allows an independent critic and creator to disagree with an earlier accepted conclusion', async () => {
    const originalPlan = writePlan(
      0,
      'Original accepted conclusion',
      'Migration validation precedes release publication.',
    );
    const currentPlan = writePlan(
      1,
      'Current disputed conclusion',
      'Migration validation precedes release publication.',
    );
    const revisedPlan = path.join(tmp, 'revised-plan.md');
    writeStructuredPlanFile(revisedPlan, 'Independently revised conclusion');

    const priorClaim = 'Release publication must remain after migration validation.';
    writeJson(path.join(work, 'critique.v0.json'), {
      plan_version: 0,
      summary: 'The original critic accepted the release ordering concern.',
      review: review(1),
      issues: [
        {
          id: 'C1',
          addresses: null,
          severity: 'major',
          category: 'correctness',
          claim: priorClaim,
          evidence: 'Target State',
          evidence_refs: PLAN_SECTION_EVIDENCE,
          invariant_id: null,
          introduced_by_revision: null,
          suggested_fix: 'Keep migration validation before publication.',
          confidence: 0.95,
          duplicate_of: null,
        },
      ],
    });
    writeJson(path.join(work, 'update.v0.json'), {
      plan_version: 1,
      plan_markdown: readFileSync(currentPlan, 'utf8'),
      issues: [
        {
          id: 'C1',
          verdict: 'accept',
          verdict_reason: 'EARLIER_ACCEPTED_CONCLUSION preserves the validated ordering.',
          final_severity: 'major',
          duplicate_of: null,
        },
      ],
      applied: ['C1'],
      rejected_append: [],
    });

    const conflictingClaim =
      'The retained ordering is over-broad because fixture publication is independent.';
    const laterCritique = path.join(tmp, 'later-critique.json');
    writeJson(laterCritique, {
      plan_version: 1,
      summary: 'Independent evidence conflicts with the earlier accepted conclusion.',
      review: review(1),
      issues: [
        {
          id: 'C1',
          addresses: 'v0.C1',
          severity: 'major',
          category: 'scope',
          claim: conflictingClaim,
          evidence: 'Target State',
          evidence_refs: PLAN_SECTION_EVIDENCE,
          invariant_id: null,
          introduced_by_revision: null,
          suggested_fix: 'Limit the ordering constraint to dependent publications.',
          confidence: 0.9,
          duplicate_of: null,
        },
      ],
    });
    const laterUpdate = path.join(tmp, 'later-update.json');
    writeJson(laterUpdate, {
      plan_version: 2,
      plan_markdown: readFileSync(revisedPlan, 'utf8'),
      issues: [
        {
          id: 'C1',
          verdict: 'downgrade',
          verdict_reason: 'The creator independently narrows the concern to a minor scope note.',
          final_severity: 'minor',
          duplicate_of: null,
        },
      ],
      applied: ['C1'],
      systemic_dispositions: [
        {
          issue_id: 'C1',
          scope: 'local',
          rationale: 'The disputed conclusion is confined to the target-state ordering statement.',
          evidence_refs: PLAN_SECTION_EVIDENCE,
          invariant: null,
        },
      ],
      rejected_append: [],
    });

    const ctx = makeTestRunContext(tmp, work, scratch, { maxIters: 2 });
    const criticPrompt = path.join(tmp, 'critic.prompt');
    const creatorPrompt = path.join(tmp, 'creator.prompt');
    const result = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: laterCritique,
        FAKE_CODEX_PROMPT: criticPrompt,
        FAKE_CLAUDE_JSON_RESULT: laterUpdate,
        FAKE_CLAUDE_PROMPT: creatorPrompt,
        FAKE_CLAUDE_REQUIRE_DRAFT7: '1',
      },
      () => runIterationLoop(ctx, 1),
    );

    const persistedUpdate = JSON.parse(readFileSync(path.join(work, 'update.v1.json'), 'utf8')) as {
      issues: { id: string; verdict: string; final_severity: string }[];
    };
    expect(result).toEqual({ iter: 2, converged: false });
    expect(persistedUpdate.issues).toEqual([
      expect.objectContaining({ id: 'C1', verdict: 'downgrade', final_severity: 'minor' }),
    ]);
    expect(readFileSync(criticPrompt, 'utf8')).toContain('EARLIER_ACCEPTED_CONCLUSION');
    expect(readFileSync(criticPrompt, 'utf8')).toContain('verdict=accept');
    expect(readFileSync(creatorPrompt, 'utf8')).toContain(conflictingClaim);
    expect(readFileSync(creatorPrompt, 'utf8')).toContain('EARLIER_ACCEPTED_CONCLUSION');
    expect(readFileSync(path.join(work, 'plan.v0.md'), 'utf8')).toBe(
      readFileSync(originalPlan, 'utf8'),
    );
  });

  it('blocks terminal success for a revision regression until a later current review resolves it', async () => {
    const invariantId = 'I-v0-C1';
    const phaseA = 'O-phase-a';
    const phaseB = 'O-phase-b';
    const originalPlan = writePlan(
      0,
      'Pre-revision plan',
      'Both phases preserve authorization before publication.',
    );
    const regressedPlan = writePlan(
      1,
      'Revision with regression',
      'Phase A fixes retry ordering, but Phase B publishes before authorization.',
      'needs-review',
    );
    const repairedPlan = path.join(tmp, 'repaired-plan.md');
    writeStructuredPlanFile(repairedPlan, 'Revision with invariant restored');
    writeFileSync(
      repairedPlan,
      readFileSync(repairedPlan, 'utf8').replace(
        '- Fixture target.',
        '- Phase A fixes retry ordering, and Phase B authorizes before publication.',
      ),
    );

    writeJson(path.join(work, 'critique.v0.json'), {
      plan_version: 0,
      summary: 'The first revision must fix retry ordering everywhere.',
      review: review(1),
      issues: [
        {
          id: 'C1',
          addresses: null,
          severity: 'major',
          category: 'correctness',
          claim: 'Retry ordering is incomplete.',
          evidence: 'Target State',
          evidence_refs: PLAN_SECTION_EVIDENCE,
          invariant_id: invariantId,
          introduced_by_revision: null,
          suggested_fix: 'Repair retry ordering without weakening authorization.',
          confidence: 1,
          duplicate_of: null,
        },
      ],
    });
    writeJson(path.join(work, 'update.v0.json'), {
      plan_version: 1,
      plan_markdown: readFileSync(regressedPlan, 'utf8'),
      issues: [
        {
          id: 'C1',
          verdict: 'accept',
          verdict_reason: 'The revision fixes retry ordering.',
          final_severity: 'major',
          duplicate_of: null,
        },
      ],
      applied: ['C1'],
      rejected_append: [],
    });

    const regressionCritique = path.join(tmp, 'regression-critique.json');
    writeJson(regressionCritique, {
      plan_version: 1,
      summary: 'The retry fix introduces an authorization contradiction in Phase B.',
      review: review(1, [
        {
          invariant_id: invariantId,
          complete: false,
          occurrences: [
            {
              occurrence_id: phaseA,
              disposition: 'satisfied',
              evidence_refs: PLAN_SECTION_EVIDENCE,
            },
            {
              occurrence_id: phaseB,
              disposition: 'violated',
              evidence_refs: PLAN_SECTION_EVIDENCE,
            },
          ],
        },
      ]),
      issues: [
        {
          id: 'C1',
          addresses: 'v0.C1',
          severity: 'major',
          category: 'correctness',
          claim: 'Phase B now publishes before its active authorization invariant.',
          evidence: 'Target State',
          evidence_refs: PLAN_SECTION_EVIDENCE,
          invariant_id: invariantId,
          introduced_by_revision: 'plan.v1.md',
          suggested_fix: 'Restore authorization before publication in Phase B.',
          confidence: 1,
          duplicate_of: null,
        },
      ],
    });
    const resolvedCritique = path.join(tmp, 'resolved-critique.json');
    writeJson(resolvedCritique, {
      plan_version: 2,
      summary: 'The current revision restores the invariant at both occurrences.',
      review: review(0, [
        {
          invariant_id: invariantId,
          complete: true,
          occurrences: [
            {
              occurrence_id: phaseA,
              disposition: 'satisfied',
              evidence_refs: PLAN_SECTION_EVIDENCE,
            },
            {
              occurrence_id: phaseB,
              disposition: 'satisfied',
              evidence_refs: PLAN_SECTION_EVIDENCE,
            },
          ],
        },
      ]),
      issues: [],
    });
    const repairUpdate = path.join(tmp, 'repair-update.json');
    writeJson(repairUpdate, {
      plan_version: 2,
      plan_markdown: readFileSync(repairedPlan, 'utf8'),
      issues: [
        {
          id: 'C1',
          verdict: 'accept',
          verdict_reason: 'The current revision restores authorization ordering in Phase B.',
          final_severity: 'major',
          duplicate_of: null,
        },
      ],
      applied: ['C1'],
      systemic_dispositions: [
        {
          issue_id: 'C1',
          scope: 'local',
          rationale: 'The regression is confined to the Phase B target-state statement.',
          evidence_refs: PLAN_SECTION_EVIDENCE,
          invariant: null,
        },
      ],
      rejected_append: [],
    });

    const ctx = makeTestRunContext(tmp, work, scratch, { maxIters: 3 });
    ctx.convergence.planVersion = 1;
    ctx.convergence.findings.push({
      id: invariantId,
      issueRef: 'v0.C1',
      introducedPlanVersion: 1,
      severity: 'major',
      claim: 'Authorization must precede publication in every phase.',
      disposition: {
        scope: 'cross-cutting',
        rationale: 'The ordering applies to every publication occurrence.',
        evidenceRefs: PLAN_SECTION_EVIDENCE,
      },
    });
    ctx.convergence.invariants.push({
      id: invariantId,
      sourceFinding: invariantId,
      statement: 'Authorization precedes publication.',
      status: 'active',
      occurrences: [
        {
          id: phaseA,
          dimension: 'phase',
          subject: 'Phase A',
          disposition: 'unresolved',
          evidenceRefs: [],
        },
        {
          id: phaseB,
          dimension: 'phase',
          subject: 'Phase B',
          disposition: 'unresolved',
          evidenceRefs: [],
        },
      ],
    });
    ctx.convergence.unresolvedCoverage.push(invariantId);

    const result = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT_CALLS: path.join(tmp, 'critic.calls'),
        FAKE_CODEX_OUTPUT_1: regressionCritique,
        FAKE_CODEX_OUTPUT_2: resolvedCritique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'critic.prompt'),
        FAKE_CLAUDE_JSON_RESULT: repairUpdate,
        FAKE_CLAUDE_REQUIRE_DRAFT7: '1',
      },
      () => runIterationLoop(ctx, 1),
    );

    const regressedState = readConvergenceState(path.join(work, 'convergence.v1.json'));
    const resolvedState = readConvergenceState(path.join(work, 'convergence.v2.json'));
    expect(result).toEqual({ iter: 2, converged: true });
    expect(regressedState).toMatchObject({
      planVersion: 1,
      satisfied: false,
      currentActionableIssues: ['v1.C1'],
    });
    expect(regressedState?.invariants[0]).toMatchObject({
      id: invariantId,
      status: 'active',
      lastReviewedPlanVersion: 1,
      occurrences: [
        { id: phaseA, disposition: 'satisfied' },
        { id: phaseB, disposition: 'violated' },
      ],
    });
    expect(readFileSync(regressedPlan, 'utf8')).toContain('status: needs-review');
    expect(resolvedState).toMatchObject({
      planVersion: 2,
      satisfied: true,
      stopReason: 'proof-satisfied',
      currentActionableIssues: [],
    });
    expect(resolvedState?.invariants[0]).toMatchObject({
      id: invariantId,
      status: 'resolved',
      lastReviewedPlanVersion: 2,
      occurrences: [
        { id: phaseA, disposition: 'satisfied' },
        { id: phaseB, disposition: 'satisfied' },
      ],
    });
    expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe(
      readFileSync(path.join(work, 'plan.v2.md'), 'utf8'),
    );
    expect(readFileSync(originalPlan, 'utf8')).toContain(
      'Both phases preserve authorization before publication.',
    );
  });

  it('accepts and preserves the enriched critic contract through Cursor orchestration', async () => {
    writePlan(0, 'Cursor enriched critique', 'The fixture target is independently reviewable.');
    const cursorCritique = path.join(tmp, 'cursor-critique.json');
    writeJson(cursorCritique, {
      plan_version: 0,
      summary: 'Cursor completed the enriched structured review.',
      review: review(1),
      issues: [
        {
          id: 'C1',
          addresses: null,
          severity: 'minor',
          category: 'clarity',
          claim: 'The target-state wording can be more explicit.',
          evidence: 'Target State',
          evidence_refs: PLAN_SECTION_EVIDENCE,
          invariant_id: null,
          introduced_by_revision: null,
          suggested_fix: 'Name the independently reviewed target.',
          confidence: 0.8,
          duplicate_of: null,
        },
      ],
    });

    const matrix = fixtureMatrix();
    matrix.critic = { runner: 'cursor', model: 'composer-2.5', reasoning: '' };
    const ctx = makeTestRunContext(tmp, work, scratch, { maxIters: 1, matrix });
    const promptCapture = path.join(tmp, 'cursor.prompt');
    const result = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CURSOR_JSON_RESULT: cursorCritique,
        FAKE_CURSOR_PROMPT: promptCapture,
      },
      () => runIterationLoop(ctx, 0),
    );

    const persistedCritique = path.join(work, 'critique.v0.json');
    const parsed = JSON.parse(readFileSync(persistedCritique, 'utf8')) as {
      review: { considered_context: string[]; scan_complete: boolean };
      issues: {
        evidence_refs: { kind: string; section: string }[];
        invariant_id: null;
        introduced_by_revision: null;
      }[];
    };
    const prompt = readFileSync(promptCapture, 'utf8');
    expect(result).toEqual({ iter: 0, converged: true });
    expect(schemaValidQuiet(persistedCritique, ctx.skills.criticSchema)).toBe(true);
    expect(parsed.review).toMatchObject({
      considered_context: [...REQUIRED_CONTEXT],
      scan_complete: true,
    });
    expect(parsed.issues[0]).toMatchObject({
      evidence_refs: PLAN_SECTION_EVIDENCE,
      invariant_id: null,
      introduced_by_revision: null,
    });
    expect(prompt).toContain('## JSON schema');
    expect(prompt).toContain('"invariant_assessments"');
    expect(prompt).toContain('## Mandatory retained run context');
    expect(path.basename(ctx.skills.criticSchema)).toBe('critique.schema.json');
  });
});
