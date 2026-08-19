import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveResumeStale, lastStablePlan, prepareResume } from '../../src/stages/plan/resume.js';
import { resolveResumeWorkdir } from '../../src/core/resume.js';
import type { ResumeState } from '../../src/core/run-context.js';
import { HaltError } from '../../src/runtime/halt.js';
import { captureStderr, writeStructuredPlanFile, writeUpdate } from '../helpers/harness.js';
import { Scratch } from '../../src/runtime/scratch.js';
import { makeTestRunContext } from '../helpers/test-context.js';
import {
  classifyTerminal,
  createConvergenceState,
  fileSha256,
  readConvergenceState,
  recordCreatorUpdate,
  recordCritique,
  recordSystemCheck,
  writeConvergenceState,
} from '../../src/core/convergence.js';
import { qualityMatrix } from '../../src/core/quality.js';
import { validateSystemCoverage, writeSystemCheck } from '../../src/core/system-context.js';

let tmp: string;
let work: string;
let schema: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-resumetest.'));
  work = path.join(tmp, 'work');
  mkdirSync(work);
  schema = path.join(tmp, 'update.schema.json');
  writeFileSync(
    schema,
    `${JSON.stringify({ required: ['plan_version', 'plan_markdown'] }, null, 2)}\n`,
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('last stable plan', () => {
  it('treats v0 as always stable', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    expect(lastStablePlan(work, schema)).toBe(0);
  });

  it('accepts vN only when update.v(N-1) is schema-valid', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
    writeUpdate(path.join(work, 'update.v0.json'), 1);
    expect(lastStablePlan(work, schema)).toBe(1);
  });

  it('falls back past a plan whose update is invalid', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
    writeFileSync(path.join(work, 'update.v0.json'), '{"not": "an update"}\n');
    expect(lastStablePlan(work, schema)).toBe(0);
  });

  it('requires a matching valid convergence artifact once versioned state exists', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
    writeUpdate(path.join(work, 'update.v0.json'), 1);
    const state = createConvergenceState({
      quality: 'balanced',
      matrix: qualityMatrix('balanced'),
      mode: 'plan',
      sourceDigest: 'source',
      authoritativeDigest: 'system',
      relationshipIds: [],
      maxIters: 3,
    });
    writeConvergenceState(work, state);

    expect(lastStablePlan(work, schema)).toBe(0);
    writeFileSync(path.join(work, 'convergence.v1.json'), '{"schemaVersion":1,"planVersion":1}\n');
    expect(lastStablePlan(work, schema)).toBe(0);
    state.planVersion = 1;
    writeConvergenceState(work, state);
    expect(lastStablePlan(work, schema)).toBe(1);
  });

  it('does not select a revision whose rejected-disposition ledger boundary was not committed', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
    writeFileSync(
      path.join(work, 'update.v0.json'),
      `${JSON.stringify({
        plan_version: 1,
        plan_markdown: readFileSync(path.join(work, 'plan.v1.md'), 'utf8'),
        rejected_append: [
          { id: 'C1', claim: 'Interrupted rejected finding', reason: 'not_value_adding' },
        ],
      })}\n`,
    );
    writeFileSync(path.join(work, 'rejected-log.jsonl'), '');
    const state = createConvergenceState({
      quality: 'balanced',
      matrix: qualityMatrix('balanced'),
      mode: 'plan',
      sourceDigest: 'source',
      authoritativeDigest: 'system',
      relationshipIds: [],
      maxIters: 3,
    });
    writeConvergenceState(work, state);

    expect(lastStablePlan(work, schema)).toBe(0);
  });

  it('halts with exit 4 when no stable plan exists', () => {
    const capture = captureStderr();
    try {
      expect(() => lastStablePlan(work, schema)).toThrow(HaltError);
      expect(capture.text()).toContain('resume failed: no stable plan.vN.md found');
    } finally {
      capture.restore();
    }
  });
});

describe('stale artifact archive', () => {
  it('archives artifacts at/after the resume point plus final extras', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
    writeStructuredPlanFile(path.join(work, 'plan.v2.md'), 'V2');
    writeUpdate(path.join(work, 'update.v0.json'), 1);
    writeUpdate(path.join(work, 'update.v1.json'), 2);
    writeFileSync(path.join(work, 'critique.v0.json'), '{}\n');
    writeFileSync(path.join(work, 'critique.v1.json'), '{}\n');
    writeFileSync(path.join(work, 'update-meta.v1.json'), '{}\n');
    writeFileSync(path.join(work, 'plan.revision.v1.md'), '# R1\n');
    writeFileSync(path.join(work, 'plan.final.md'), '# Final\n');
    writeFileSync(path.join(work, 'summary.md'), '# Summary\n');
    writeFileSync(path.join(work, 'judge.final.raw'), '{}\n');
    writeFileSync(path.join(work, 'judge.final.json'), '{}\n');
    writeFileSync(path.join(work, 'judge.final.meta.json'), '{}\n');
    writeFileSync(path.join(work, 'judge.v0.json'), '{}\n');
    writeFileSync(path.join(work, 'judge.v1.json'), '{}\n');
    writeFileSync(path.join(work, 'judge.v2.json'), '{}\n');
    writeFileSync(path.join(work, 'plan.final.ru.md'), '# Localized final\n');
    writeFileSync(path.join(work, 'fix-applied-review.json'), '{}\n');

    const state: ResumeState = { startIter: 1, archivedCount: 0, archiveDir: '' };
    archiveResumeStale(work, state, 1);

    expect(state.archivedCount).toBe(14);
    expect(state.archiveDir.startsWith(path.join(work, 'stale.'))).toBe(true);
    expect(existsSync(path.join(work, 'plan.v0.md'))).toBe(true);
    expect(existsSync(path.join(work, 'plan.v1.md'))).toBe(true);
    expect(existsSync(path.join(work, 'update.v0.json'))).toBe(true);
    expect(existsSync(path.join(work, 'critique.v0.json'))).toBe(true);
    expect(existsSync(path.join(work, 'plan.v2.md'))).toBe(false);
    expect(existsSync(path.join(work, 'critique.v1.json'))).toBe(false);
    expect(existsSync(path.join(work, 'update.v1.json'))).toBe(false);
    expect(existsSync(path.join(work, 'update-meta.v1.json'))).toBe(false);
    expect(existsSync(path.join(work, 'plan.revision.v1.md'))).toBe(false);
    expect(existsSync(path.join(work, 'plan.final.md'))).toBe(false);
    expect(existsSync(path.join(work, 'summary.md'))).toBe(false);
    expect(existsSync(path.join(work, 'judge.v0.json'))).toBe(true);
    expect(existsSync(path.join(work, 'judge.v1.json'))).toBe(false);
    expect(existsSync(path.join(work, 'judge.v2.json'))).toBe(false);
    expect(existsSync(path.join(work, 'plan.final.ru.md'))).toBe(false);
    const archived = readdirSync(state.archiveDir).sort();
    expect(archived).toContain('plan.v2.md');
    expect(archived).toContain('plan.final.md');
    expect(archived).toContain('judge.final.raw');
    expect(archived).toContain('judge.final.json');
    expect(archived).toContain('judge.final.meta.json');
    expect(archived).toContain('judge.v1.json');
    expect(archived).toContain('judge.v2.json');
    expect(archived).toContain('plan.final.ru.md');
    expect(archived).toContain('fix-applied-review.json');
  });

  it('archives package artifacts alongside plan.final.md', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    writeFileSync(path.join(work, 'plan.final.md'), '# Final\n');
    writeFileSync(path.join(work, 'plan.split.json'), '{"decision":"split"}\n');
    writeFileSync(path.join(work, 'package-findings.json'), '{"stale_lines":[]}\n');
    const pkg = path.join(work, 'plan.package');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, 'README.md'), '# pack\n');

    const state: ResumeState = { startIter: 0, archivedCount: 0, archiveDir: '' };
    archiveResumeStale(work, state, 0);

    expect(existsSync(path.join(work, 'plan.split.json'))).toBe(false);
    expect(existsSync(path.join(work, 'package-findings.json'))).toBe(false);
    expect(existsSync(pkg)).toBe(false);
    const archived = readdirSync(state.archiveDir).sort();
    expect(archived).toContain('plan.split.json');
    expect(archived).toContain('package-findings.json');
    expect(archived).toContain('plan.package');
    expect(existsSync(path.join(state.archiveDir, 'plan.package', 'README.md'))).toBe(true);
  });

  it('archives nothing on a clean resume', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    const state: ResumeState = { startIter: 0, archivedCount: 0, archiveDir: '' };
    archiveResumeStale(work, state, 0);
    expect(state.archivedCount).toBe(0);
    expect(state.archiveDir).toBe('');
    expect(existsSync(path.join(work, 'plan.v0.md'))).toBe(true);
  });
});

describe('convergence-aware resume', () => {
  it('keeps the active rejected ledger intact when atomic reconciliation cannot commit', () => {
    const scratch = Scratch.create('resume-ledger-atomicity-test');
    const temporaryLedger = path.join(work, `rejected-log.jsonl.resume-${process.pid}`);
    try {
      writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
      writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
      writeUpdate(path.join(work, 'update.v0.json'), 1);
      const ctx = makeTestRunContext(tmp, work, scratch, {
        quality: 'balanced',
        maxIters: 3,
      });
      const state = createConvergenceState({
        quality: 'balanced',
        matrix: qualityMatrix('balanced'),
        mode: 'plan',
        sourceDigest: ctx.convergence.sourceDigest,
        authoritativeDigest: ctx.systemContext.digest,
        relationshipIds: [],
        maxIters: 3,
      });
      state.planVersion = 1;
      writeConvergenceState(work, state);
      const committed = { iter: 0, id: 'C1', claim: 'Committed rejection' };
      const stale = { iter: 1, id: 'C2', claim: 'Interrupted future rejection' };
      const original = `${JSON.stringify(committed)}\n${JSON.stringify(stale)}\n`;
      const rejectedLedger = path.join(work, 'rejected-log.jsonl');
      writeFileSync(rejectedLedger, original);
      mkdirSync(temporaryLedger);

      expect(() => prepareResume(ctx)).toThrow();
      expect(readFileSync(rejectedLedger, 'utf8')).toBe(original);

      rmSync(temporaryLedger, { recursive: true });
      expect(prepareResume(ctx)).toBe(1);
      expect(readFileSync(rejectedLedger, 'utf8')).toBe(`${JSON.stringify(committed)}\n`);
      const archives = readdirSync(work).filter((name) => name.startsWith('stale.'));
      expect(archives.length).toBeGreaterThan(0);
      expect(
        archives.some((archive) => {
          const archivedLedger = path.join(work, archive, 'rejected-log.jsonl');
          return existsSync(archivedLedger) && readFileSync(archivedLedger, 'utf8') === original;
        }),
      ).toBe(true);
    } finally {
      rmSync(temporaryLedger, { recursive: true, force: true });
      scratch.sweep();
    }
  });

  it('rejects changed input for a legacy resume before mutating its artifacts', () => {
    const scratch = Scratch.create('resume-legacy-source-contract');
    const original = path.join(tmp, 'original.md');
    const changed = path.join(tmp, 'input.md');
    writeStructuredPlanFile(original, 'Original');
    writeStructuredPlanFile(changed, 'Changed');
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'Original');
    const prompt = path.join(work, 'prompt.md');
    const system = path.join(work, 'system-context.json');
    const session = path.join(work, 'creator.session-id');
    writeFileSync(prompt, readFileSync(original));
    writeFileSync(system, 'legacy-system-context\n');
    writeFileSync(session, 'legacy-session\n');
    const before = [prompt, system, session].map((file) => readFileSync(file));
    const ctx = makeTestRunContext(tmp, work, scratch, {
      mode: 'prompt',
      quality: 'balanced',
      maxIters: 3,
      sourceDigest: fileSha256(changed),
    });
    const capture = captureStderr();
    try {
      expect(() => prepareResume(ctx)).toThrow(HaltError);
      expect(capture.text()).toContain('input source differs');
      expect([prompt, system, session].map((file) => readFileSync(file))).toEqual(before);
      expect(readdirSync(work).some((name) => name.startsWith('stale.'))).toBe(false);
    } finally {
      capture.restore();
      scratch.sweep();
    }
  });

  it.each([
    { name: 'input source', quality: 'balanced' as const, maxIters: 3, source: 'changed' },
    { name: 'quality', quality: 'quick' as const, maxIters: 3, source: 'test-source-digest' },
    {
      name: 'iteration limit',
      quality: 'balanced' as const,
      maxIters: 4,
      source: 'test-source-digest',
    },
  ])('rejects a resume whose $name differs from the selected run contract', (fixture) => {
    const scratch = Scratch.create(`resume-contract-${fixture.name.replaceAll(' ', '-')}`);
    const capture = captureStderr();
    try {
      writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
      writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
      writeUpdate(path.join(work, 'update.v0.json'), 1);
      const current = makeTestRunContext(tmp, work, scratch, {
        quality: fixture.quality,
        maxIters: fixture.maxIters,
      });
      const prior = createConvergenceState({
        quality: 'balanced',
        matrix: qualityMatrix('balanced'),
        mode: 'plan',
        sourceDigest: fixture.source,
        authoritativeDigest: current.systemContext.digest,
        relationshipIds: [],
        maxIters: 3,
      });
      prior.planVersion = 1;
      writeConvergenceState(work, prior);

      expect(() => prepareResume(current)).toThrow(HaltError);
      expect(capture.text()).toContain(`resume failed: ${fixture.name}`);
      expect(existsSync(path.join(work, 'plan.v1.md'))).toBe(true);
      expect(readdirSync(work).some((name) => name.startsWith('stale.'))).toBe(false);
    } finally {
      capture.restore();
      scratch.sweep();
    }
  });

  it('bootstraps a conservative state at the highest stable legacy plan', () => {
    const scratch = Scratch.create('resume-legacy-state-test');
    try {
      writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
      writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
      writeStructuredPlanFile(path.join(work, 'plan.v2.md'), 'V2');
      writeUpdate(path.join(work, 'update.v0.json'), 1);
      writeUpdate(path.join(work, 'update.v1.json'), 2);
      const ctx = makeTestRunContext(tmp, work, scratch, {
        quality: 'balanced',
        maxIters: 3,
        sourceDigest: fileSha256(path.join(work, 'plan.v0.md')),
      });

      expect(prepareResume(ctx)).toBe(2);
      expect(ctx.resume.startIter).toBe(2);
      expect(ctx.lastCritiqueIter).toBe(1);
      expect(ctx.convergence.planVersion).toBe(2);
      expect(ctx.convergence.lastCritiquedPlanVersion).toBeUndefined();
      expect(ctx.convergence.scanComplete).toBe(false);
      expect(ctx.convergence.systemCheckPassed).toBe(false);
      expect(ctx.convergence.unresolvedCoverage).toContain('plan.v2:legacy-state-bootstrap');
      expect(existsSync(path.join(work, 'convergence.v2.json'))).toBe(true);
      expect(existsSync(path.join(work, 'convergence.v0.json'))).toBe(false);
    } finally {
      scratch.sweep();
    }
  });

  it('matches uninterrupted convergence state after restoring a stable revision', () => {
    const scratch = Scratch.create('resume-state-equivalence-test');
    try {
      writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
      writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
      const planV1 = readFileSync(path.join(work, 'plan.v1.md'), 'utf8');
      const critique = {
        plan_version: 0,
        summary: 'A material cross-cutting gap and one rejected minor suggestion.',
        issues: [
          {
            id: 'C1',
            addresses: null,
            severity: 'major',
            category: 'correctness',
            claim: 'Every release consumer needs the same ordering guarantee.',
            evidence: '## Work Plan',
            evidence_refs: [{ kind: 'plan-section', section: 'Work Plan' }],
            invariant_id: null,
            introduced_by_revision: null,
            suggested_fix: 'Cover every consumer occurrence.',
            confidence: 0.95,
            duplicate_of: null,
          },
          {
            id: 'C2',
            addresses: null,
            severity: 'minor',
            category: 'clarity',
            claim: 'Rename the fixture phase.',
            evidence: 'P1 Fixture Phase',
            evidence_refs: [{ kind: 'plan-section', section: 'Work Plan' }],
            invariant_id: null,
            introduced_by_revision: null,
            suggested_fix: 'Use a shorter phase title.',
            confidence: 0.6,
            duplicate_of: null,
          },
        ],
        review: {
          considered_context: [
            'original-scope',
            'authoritative-system-facts',
            'operator-decisions',
            'material-findings',
            'active-invariants',
            'quality-and-limits',
          ],
          invariant_assessments: [],
          scope_coverage: ['direct-plan-scope'],
          issue_budget: { limit: 8, used: 2, exhausted: false },
          scan_complete: true,
          unresolved_coverage: [],
        },
      };
      const update = {
        plan_version: 1,
        plan_markdown: planV1,
        issues: [
          {
            id: 'C1',
            verdict: 'accept',
            verdict_reason: 'The ordering gap is material and evidenced.',
            final_severity: 'major',
            duplicate_of: null,
          },
          {
            id: 'C2',
            verdict: 'reject_taste',
            verdict_reason: 'The existing title is clear and the change is taste-only.',
            final_severity: 'minor',
            duplicate_of: null,
          },
        ],
        applied: ['C1'],
        systemic_dispositions: [
          {
            issue_id: 'C1',
            scope: 'cross-cutting',
            rationale: 'The same ordering contract applies to both consumers.',
            invariant: {
              statement: 'Every consumer runs only after its producer is ready.',
              occurrences: [
                { dimension: 'consumer', subject: 'api' },
                { dimension: 'consumer', subject: 'worker' },
              ],
            },
          },
        ],
        rejected_append: [
          {
            id: 'C2',
            claim: 'Rename the fixture phase.',
            reason: 'not_value_adding',
          },
        ],
      };
      writeFileSync(path.join(work, 'critique.v0.json'), `${JSON.stringify(critique)}\n`);
      writeFileSync(path.join(work, 'update.v0.json'), `${JSON.stringify(update)}\n`);

      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      ctx.convergence.operatorDecisionIds = ['op-clarify-scope'];
      ctx.convergence.interventionIds = ['op-clarify-scope', 'i-release-order'];
      ctx.convergence.contextDeliveries.push({
        role: 'critic',
        stage: 'review',
        planVersion: 0,
        mandatoryBytes: 1_200,
        optionalBytes: 300,
        totalInputBytes: 9_000,
        inputTokenLimit: 200_000,
        inputLimitSource: 'model-registry',
        reductions: [],
        omittedCategories: [],
      });
      recordCritique(ctx.convergence, critique, 0);
      recordSystemCheck(ctx.convergence, { passed: true, mismatches: [] });
      classifyTerminal(ctx.convergence, false);
      ctx.lastCritiqueIter = 0;
      ctx.convergence.contextDeliveries.push({
        role: 'creator',
        stage: 'revision',
        planVersion: 0,
        mandatoryBytes: 1_500,
        optionalBytes: 600,
        totalInputBytes: 11_000,
        inputTokenLimit: 200_000,
        inputLimitSource: 'operator',
        reductions: [{ category: 'resolved-minor-history', bytes: 80 }],
        omittedCategories: ['resolved-nits'],
      });
      recordCreatorUpdate(ctx.convergence, critique, update, 0);
      const uninterruptedLastCritiqueIter = ctx.lastCritiqueIter;
      writeConvergenceState(work, ctx.convergence);
      const uninterruptedState = structuredClone(ctx.convergence);
      writeFileSync(path.join(work, 'system-check.v0.json'), '{"passed":true}\n');

      writeStructuredPlanFile(path.join(work, 'plan.v2.md'), 'Interrupted V2');
      writeUpdate(path.join(work, 'update.v1.json'), 2);
      writeFileSync(path.join(work, 'critique.v1.json'), '{"stale":true}\n');
      writeFileSync(path.join(work, 'system-check.v2.json'), '{"stale":true}\n');
      const keptRejected = { iter: 0, id: 'C2', disposition: 'reject_taste' };
      const staleRejected = { iter: 1, id: 'C9', disposition: 'reject_taste' };
      writeFileSync(
        path.join(work, 'rejected-log.jsonl'),
        `${JSON.stringify(keptRejected)}\n${JSON.stringify(staleRejected)}\n`,
      );
      const keptDecision = {
        intervention_id: 'op-clarify-scope',
        target: 'creator',
        plan_ref: 'plan.v0.md',
      };
      const keptMigration = {
        intervention_id: 'i-release-order',
        target: 'creator',
        plan_ref: 'plan.v1.md',
      };
      const staleMigration = {
        intervention_id: 'i-stale',
        target: 'creator',
        plan_ref: 'plan.v2.md',
      };
      writeFileSync(
        path.join(work, 'operator-intervention-migrations.jsonl'),
        `${JSON.stringify(keptDecision)}\n${JSON.stringify(keptMigration)}\n${JSON.stringify(staleMigration)}\n`,
      );

      expect(prepareResume(ctx)).toBe(1);
      expect(ctx.resume.startIter).toBe(1);
      expect(ctx.lastCritiqueIter).toBe(uninterruptedLastCritiqueIter);
      expect(ctx.convergence).toEqual(uninterruptedState);
      expect(ctx.convergence.findings).toHaveLength(1);
      expect(ctx.convergence.findings[0]?.issueRef).toBe('v0.C1');
      expect(ctx.convergence.invariants[0]?.occurrences).toHaveLength(2);
      expect(ctx.convergence.operatorDecisionIds).toEqual(['op-clarify-scope']);
      expect(ctx.convergence.interventionIds).toEqual(['op-clarify-scope', 'i-release-order']);
      expect(ctx.convergence.contextDeliveries).toHaveLength(2);
      expect(ctx.convergence.issueBudget).toEqual({ limit: 8, used: 2, exhausted: false });
      expect(ctx.convergence.iterationLimit).toBe(3);
      expect(readFileSync(path.join(work, 'rejected-log.jsonl'), 'utf8')).toBe(
        `${JSON.stringify(keptRejected)}\n`,
      );
      expect(readFileSync(path.join(work, 'operator-intervention-migrations.jsonl'), 'utf8')).toBe(
        `${JSON.stringify(keptDecision)}\n${JSON.stringify(keptMigration)}\n`,
      );
      expect(readFileSync(path.join(work, 'critique.v0.json'), 'utf8')).toBe(
        `${JSON.stringify(critique)}\n`,
      );
      expect(readFileSync(path.join(work, 'update.v0.json'), 'utf8')).toBe(
        `${JSON.stringify(update)}\n`,
      );
      expect(existsSync(path.join(work, 'system-check.v0.json'))).toBe(true);
      expect(existsSync(path.join(work, 'plan.v2.md'))).toBe(false);
      expect(existsSync(path.join(work, 'critique.v1.json'))).toBe(false);
      expect(existsSync(path.join(work, 'update.v1.json'))).toBe(false);
      expect(existsSync(path.join(work, 'system-check.v2.json'))).toBe(false);
      expect(ctx.resume.archiveDir).not.toBe('');
      expect(readdirSync(ctx.resume.archiveDir)).toEqual(
        expect.arrayContaining([
          'plan.v2.md',
          'critique.v1.json',
          'update.v1.json',
          'system-check.v2.json',
          'rejected-log.jsonl',
          'operator-intervention-migrations.jsonl',
        ]),
      );
    } finally {
      scratch.sweep();
    }
  });

  it('invalidates restored review and deterministic coverage when authoritative facts change', () => {
    const scratch = Scratch.create('resume-authoritative-change-test');
    try {
      writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
      writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
      writeUpdate(path.join(work, 'update.v0.json'), 1);
      const ctx = makeTestRunContext(tmp, work, scratch, {
        quality: 'balanced',
        maxIters: 3,
      });
      ctx.convergence.planVersion = 1;
      ctx.convergence.authoritativeDigest = 'previous-system-digest';
      ctx.convergence.relationshipIds = ['R-stale'];
      ctx.convergence.lastCritiquedPlanVersion = 1;
      ctx.convergence.judgeApprovedPlanVersion = 1;
      ctx.convergence.scanComplete = true;
      ctx.convergence.systemCheckPassed = true;
      writeConvergenceState(work, ctx.convergence);
      writeFileSync(path.join(work, 'system-check.v1.json'), '{"passed":true}\n');

      expect(prepareResume(ctx)).toBe(1);
      expect(ctx.lastCritiqueIter).toBe(0);
      expect(ctx.convergence.authoritativeDigest).toBe(ctx.systemContext.digest);
      expect(ctx.convergence.relationshipIds).toEqual([]);
      expect(ctx.convergence.lastCritiquedPlanVersion).toBeUndefined();
      expect(ctx.convergence.judgeApprovedPlanVersion).toBeUndefined();
      expect(ctx.convergence.scanComplete).toBe(false);
      expect(ctx.convergence.systemCheckPassed).toBe(false);
      expect(ctx.convergence.exhaustedLimits).toContain('authoritative-scope');
      expect(ctx.convergence.unresolvedCoverage).toContain('plan.v1:authoritative-digest-changed');
      expect(existsSync(path.join(work, 'system-check.v1.json'))).toBe(false);
      expect(ctx.resume.archiveDir).not.toBe('');
      expect(readdirSync(ctx.resume.archiveDir)).toContain('system-check.v1.json');
      expect(readdirSync(ctx.resume.archiveDir)).toContain('convergence.v1.json');
    } finally {
      scratch.sweep();
    }
  });

  it('invalidates all proof when selected plan bytes change without a version change', () => {
    const scratch = Scratch.create('resume-same-version-plan-mutation');
    try {
      writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
      writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
      writeUpdate(path.join(work, 'update.v0.json'), 1);
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      ctx.convergence.planVersion = 1;
      ctx.convergence.lastCritiquedPlanVersion = 1;
      ctx.convergence.judgeApprovedPlanVersion = 1;
      ctx.convergence.scanComplete = true;
      ctx.convergence.systemCheckPassed = true;
      ctx.convergence.satisfied = true;
      ctx.convergence.stopReason = 'proof-satisfied';
      ctx.convergence.canonicalPlanSha256 = 'stale-canonical-proof';
      ctx.convergence.invariants = [
        {
          id: 'I-v0-C1',
          sourceFinding: 'I-v0-C1',
          statement: 'Every consumer uses the current plan contract.',
          status: 'resolved',
          lastReviewedPlanVersion: 1,
          occurrences: [
            {
              id: 'O-fixture',
              dimension: 'consumer',
              subject: 'api',
              disposition: 'satisfied',
              evidenceRefs: [{ kind: 'plan-section', section: 'Work Plan' }],
            },
          ],
        },
      ];
      writeConvergenceState(work, ctx.convergence);
      const originalPlanSha256 = ctx.convergence.planSha256;
      writeSystemCheck(
        work,
        validateSystemCoverage(ctx.systemContext, path.join(work, 'plan.v1.md'), 1),
      );
      const checkBeforeMutation = JSON.parse(
        readFileSync(path.join(work, 'system-check.v1.json'), 'utf8'),
      ) as { planSha256: string };
      expect(checkBeforeMutation.planSha256).toBe(originalPlanSha256);
      writeFileSync(
        path.join(work, 'plan.v1.md'),
        `${readFileSync(path.join(work, 'plan.v1.md'), 'utf8')}\nchanged\n`,
      );
      const changedPlanSha256 = fileSha256(path.join(work, 'plan.v1.md'));
      expect(changedPlanSha256).not.toBe(originalPlanSha256);

      expect(prepareResume(ctx)).toBe(1);
      expect(ctx.lastCritiqueIter).toBe(0);
      expect(ctx.convergence.planSha256).toBe(changedPlanSha256);
      expect(ctx.convergence.canonicalPlanSha256).toBeUndefined();
      expect(ctx.convergence.lastCritiquedPlanVersion).toBeUndefined();
      expect(ctx.convergence.judgeApprovedPlanVersion).toBeUndefined();
      expect(ctx.convergence.scanComplete).toBe(false);
      expect(ctx.convergence.systemCheckPassed).toBe(false);
      expect(ctx.convergence.satisfied).toBe(false);
      expect(ctx.convergence.stopReason).toBe('plan.v1:plan-digest-changed');
      expect(ctx.convergence.unresolvedCoverage).toEqual(
        expect.arrayContaining([
          'plan.v1:plan-digest-changed',
          'plan.v1:not-independently-reviewed',
          'plan.v1:scan-incomplete',
          'plan.v1:system-check',
          'I-v0-C1',
        ]),
      );
      expect(ctx.convergence.invariants[0]).toMatchObject({
        status: 'active',
        occurrences: [{ disposition: 'unresolved', evidenceRefs: [] }],
      });
      expect(ctx.convergence.invariants[0]?.lastReviewedPlanVersion).toBeUndefined();
      expect(existsSync(path.join(work, 'system-check.v1.json'))).toBe(false);
      expect(readdirSync(ctx.resume.archiveDir)).toEqual(
        expect.arrayContaining(['convergence.v1.json', 'system-check.v1.json']),
      );
      expect(
        JSON.parse(readFileSync(path.join(ctx.resume.archiveDir, 'system-check.v1.json'), 'utf8')),
      ).toMatchObject({ planSha256: originalPlanSha256, passed: true });
      expect(
        JSON.parse(readFileSync(path.join(ctx.resume.archiveDir, 'convergence.v1.json'), 'utf8')),
      ).toMatchObject({
        planSha256: originalPlanSha256,
        canonicalPlanSha256: 'stale-canonical-proof',
        satisfied: true,
      });
      expect(readConvergenceState(path.join(work, 'convergence.v1.json'))).toEqual(ctx.convergence);
    } finally {
      scratch.sweep();
    }
  });

  it('invalidates deterministic proof when system-check plan hash mismatches unchanged bytes', () => {
    const scratch = Scratch.create('resume-system-check-plan-digest');
    try {
      writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
      writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
      writeUpdate(path.join(work, 'update.v0.json'), 1);
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      ctx.convergence.planVersion = 1;
      ctx.convergence.lastCritiquedPlanVersion = 1;
      ctx.convergence.judgeApprovedPlanVersion = 1;
      ctx.convergence.scanComplete = true;
      ctx.convergence.systemCheckPassed = true;
      ctx.convergence.satisfied = true;
      ctx.convergence.stopReason = 'proof-satisfied';
      writeConvergenceState(work, ctx.convergence);
      const selectedPlanSha256 = fileSha256(path.join(work, 'plan.v1.md'));
      const mismatchedPlanSha256 = '0'.repeat(64);
      const check = validateSystemCoverage(ctx.systemContext, path.join(work, 'plan.v1.md'), 1);
      writeSystemCheck(work, { ...check, planSha256: mismatchedPlanSha256 });

      expect(ctx.convergence.planSha256).toBe(selectedPlanSha256);
      expect(check.planSha256).toBe(selectedPlanSha256);
      expect(mismatchedPlanSha256).not.toBe(selectedPlanSha256);
      expect(prepareResume(ctx)).toBe(1);

      expect(ctx.convergence.planSha256).toBe(selectedPlanSha256);
      expect(ctx.convergence.lastCritiquedPlanVersion).toBe(1);
      expect(ctx.convergence.judgeApprovedPlanVersion).toBe(1);
      expect(ctx.convergence.scanComplete).toBe(true);
      expect(ctx.convergence.systemCheckPassed).toBe(false);
      expect(ctx.convergence.systemMismatchIds).toEqual([]);
      expect(ctx.convergence.satisfied).toBe(false);
      expect(ctx.convergence.stopReason).toBe('plan.v1:system-check');
      expect(ctx.convergence.unresolvedCoverage).toContain('plan.v1:system-check');
      expect(existsSync(path.join(work, 'system-check.v1.json'))).toBe(false);
      expect(readdirSync(ctx.resume.archiveDir)).toEqual(
        expect.arrayContaining(['convergence.v1.json', 'system-check.v1.json']),
      );
      expect(
        JSON.parse(readFileSync(path.join(ctx.resume.archiveDir, 'system-check.v1.json'), 'utf8')),
      ).toMatchObject({ planSha256: mismatchedPlanSha256, passed: true });
      expect(
        JSON.parse(readFileSync(path.join(ctx.resume.archiveDir, 'convergence.v1.json'), 'utf8')),
      ).toMatchObject({
        planSha256: selectedPlanSha256,
        systemCheckPassed: true,
        satisfied: true,
      });
    } finally {
      scratch.sweep();
    }
  });

  it('accepts a pre-hash convergence state but requires fresh proof', () => {
    const scratch = Scratch.create('resume-pre-hash-convergence-state');
    try {
      writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
      writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
      writeUpdate(path.join(work, 'update.v0.json'), 1);
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      ctx.convergence.planVersion = 1;
      ctx.convergence.lastCritiquedPlanVersion = 1;
      ctx.convergence.judgeApprovedPlanVersion = 1;
      ctx.convergence.scanComplete = true;
      ctx.convergence.systemCheckPassed = true;
      ctx.convergence.satisfied = true;
      ctx.convergence.stopReason = 'proof-satisfied';
      const stateFile = writeConvergenceState(work, ctx.convergence);
      const legacy = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
      delete legacy.planSha256;
      delete legacy.canonicalPlanSha256;
      writeFileSync(stateFile, `${JSON.stringify(legacy, null, 2)}\n`);
      writeSystemCheck(
        work,
        validateSystemCoverage(ctx.systemContext, path.join(work, 'plan.v1.md'), 1),
      );

      expect(readConvergenceState(stateFile)).toBeDefined();
      expect(prepareResume(ctx)).toBe(1);
      expect(ctx.convergence.planSha256).toBe(fileSha256(path.join(work, 'plan.v1.md')));
      expect(ctx.convergence.lastCritiquedPlanVersion).toBeUndefined();
      expect(ctx.convergence.judgeApprovedPlanVersion).toBeUndefined();
      expect(ctx.convergence.scanComplete).toBe(false);
      expect(ctx.convergence.systemCheckPassed).toBe(false);
      expect(ctx.convergence.satisfied).toBe(false);
      expect(ctx.convergence.stopReason).toBe('plan.v1:plan-digest-unavailable');
      expect(ctx.convergence.unresolvedCoverage).toContain('plan.v1:plan-digest-unavailable');
      expect(
        JSON.parse(readFileSync(path.join(ctx.resume.archiveDir, 'convergence.v1.json'), 'utf8')),
      ).not.toHaveProperty('planSha256');
      expect(readConvergenceState(stateFile)).toEqual(ctx.convergence);
    } finally {
      scratch.sweep();
    }
  });
});

describe('resume workdir resolution', () => {
  function makeRun(name: string): string {
    const dir = path.join(tmp, 'plans', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'plan.v0.md'), '# V0\n');
    return dir;
  }

  it('resolves a single matching workdir', () => {
    const dir = makeRun('loop-feature');
    const result = resolveResumeWorkdir(path.join(tmp, 'plans'), 'feature');
    expect(result).toEqual({ kind: 'resolved', dir });
  });

  it('returns none with guidance when nothing matches', () => {
    mkdirSync(path.join(tmp, 'plans'), { recursive: true });
    const capture = captureStderr();
    try {
      const result = resolveResumeWorkdir(path.join(tmp, 'plans'), 'ghost');
      expect(result).toEqual({ kind: 'none' });
      expect(capture.text()).toContain('resume: no existing workdir with state for ghost');
      expect(capture.text()).toContain('set AGENT_QUORUM_WORK_DIR to override');
    } finally {
      capture.restore();
    }
  });

  it('prefers the quality-suffixed dir among ambiguous candidates', () => {
    makeRun('loop-feature');
    const balanced = makeRun('loop-feature-balanced');
    const result = resolveResumeWorkdir(path.join(tmp, 'plans'), 'feature', 'balanced');
    expect(result).toEqual({ kind: 'resolved', dir: balanced });
  });

  it('reports ambiguity when no quality disambiguates', () => {
    makeRun('loop-feature');
    makeRun('loop-feature-thorough');
    const capture = captureStderr();
    try {
      const result = resolveResumeWorkdir(path.join(tmp, 'plans'), 'feature');
      expect(result).toEqual({ kind: 'ambiguous' });
      expect(capture.text()).toContain('resume: ambiguous workdir for feature; candidates:');
    } finally {
      capture.restore();
    }
  });
});
