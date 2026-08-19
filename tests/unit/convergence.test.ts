import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
import type { JsonValue } from '../../src/core/json.js';

function state() {
  return createConvergenceState({
    quality: 'balanced',
    matrix: qualityMatrix('balanced'),
    mode: 'prompt',
    sourceDigest: 'source',
    authoritativeDigest: 'system',
    relationshipIds: [],
    maxIters: 3,
  });
}

const MATERIAL_CRITIQUE = {
  plan_version: 0,
  summary: 'systemic gap',
  issues: [
    {
      id: 'C1',
      addresses: null,
      severity: 'major',
      category: 'correctness',
      claim: 'All consumers must use the new contract.',
      evidence: '## Work Plan',
      suggested_fix: 'Cover every consumer.',
      confidence: 1,
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
    scope_coverage: ['declared-scope'],
    issue_budget: { limit: 8, used: 1, exhausted: false },
    scan_complete: true,
    unresolved_coverage: [],
  },
};

describe('convergence reducer', () => {
  it('requires a later independent review of every cross-cutting occurrence', () => {
    const current = state();
    recordCritique(current, MATERIAL_CRITIQUE, 0);
    recordCreatorUpdate(
      current,
      MATERIAL_CRITIQUE,
      {
        plan_version: 1,
        issues: [
          {
            id: 'C1',
            verdict: 'accept',
            verdict_reason: 'confirmed',
            final_severity: 'major',
            duplicate_of: null,
          },
        ],
        applied: ['C1'],
        systemic_dispositions: [
          {
            issue_id: 'C1',
            scope: 'cross-cutting',
            rationale: 'Three consumers share the contract.',
            invariant: {
              statement: 'Every consumer uses the same contract.',
              occurrences: [
                { dimension: 'consumer', subject: 'api' },
                { dimension: 'consumer', subject: 'worker' },
                { dimension: 'consumer', subject: 'cli' },
              ],
            },
          },
        ],
      },
      0,
    );

    const invariant = current.invariants[0];
    expect(invariant).toBeDefined();
    if (invariant === undefined) {
      throw new Error('expected invariant');
    }
    expect(invariant.occurrences).toHaveLength(3);
    const assessed = invariant.occurrences.slice(0, 2).map((occurrence) => ({
      occurrence_id: occurrence.id,
      disposition: 'satisfied',
      evidence_refs: [{ kind: 'plan-section', section: 'Work Plan' }],
    }));
    recordCritique(
      current,
      {
        plan_version: 1,
        summary: 'one occurrence omitted',
        issues: [],
        review: {
          ...MATERIAL_CRITIQUE.review,
          invariant_assessments: [
            { invariant_id: invariant.id, complete: false, occurrences: assessed },
          ],
          issue_budget: { limit: 8, used: 0, exhausted: false },
        },
      },
      1,
    );
    current.systemCheckPassed = true;
    current.judgeApprovedPlanVersion = 1;
    classifyTerminal(current, true);
    expect(current.satisfied).toBe(false);
    expect(current.unresolvedCoverage).toContain(invariant.id);

    recordCritique(
      current,
      {
        plan_version: 1,
        summary: 'all occurrences checked',
        issues: [],
        review: {
          ...MATERIAL_CRITIQUE.review,
          invariant_assessments: [
            {
              invariant_id: invariant.id,
              complete: true,
              occurrences: invariant.occurrences.map((occurrence) => ({
                occurrence_id: occurrence.id,
                disposition: 'satisfied',
                evidence_refs: [{ kind: 'plan-section', section: 'Work Plan' }],
              })),
            },
          ],
          issue_budget: { limit: 8, used: 0, exhausted: false },
        },
      },
      1,
    );
    current.systemCheckPassed = true;
    current.judgeApprovedPlanVersion = 1;
    classifyTerminal(current, true);
    expect(current.satisfied).toBe(true);
  });

  it('does not close not-applicable occurrences with nonexistent evidence targets', () => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-na-evidence.'));
    try {
      writeFileSync(path.join(work, 'plan.v1.md'), '# Plan\n\n## Work Plan\n');
      const current = state();
      recordCritique(current, MATERIAL_CRITIQUE, 0);
      recordCreatorUpdate(
        current,
        MATERIAL_CRITIQUE,
        {
          plan_version: 1,
          issues: [
            {
              id: 'C1',
              verdict: 'accept',
              verdict_reason: 'confirmed',
              final_severity: 'major',
              duplicate_of: null,
            },
          ],
          applied: ['C1'],
          systemic_dispositions: [
            {
              issue_id: 'C1',
              scope: 'cross-cutting',
              rationale: 'The contract has one declared occurrence.',
              invariant: {
                statement: 'The declared consumer is covered.',
                occurrences: [{ dimension: 'consumer', subject: 'api' }],
              },
            },
          ],
        },
        0,
      );
      const invariant = current.invariants[0];
      const occurrence = invariant?.occurrences[0];
      expect(occurrence).toBeDefined();
      if (invariant === undefined || occurrence === undefined) return;
      const critiqueWith = (evidence_refs: JsonValue[]) => ({
        plan_version: 1,
        summary: 'N/A assessment',
        issues: [],
        review: {
          ...MATERIAL_CRITIQUE.review,
          issue_budget: { limit: 8, used: 0, exhausted: false },
          invariant_assessments: [
            {
              invariant_id: invariant.id,
              complete: true,
              occurrences: [
                { occurrence_id: occurrence.id, disposition: 'not-applicable', evidence_refs },
              ],
            },
          ],
        },
      });

      recordCritique(
        current,
        critiqueWith([{ kind: 'file-line', path: 'missing.ts', line: 1 }]),
        1,
        { work, projectRoot: work },
      );
      expect(invariant.status).toBe('active');

      recordCritique(current, critiqueWith([{ kind: 'plan-section', section: 'Work Plan' }]), 1, {
        work,
        projectRoot: work,
      });
      expect(invariant.status).toBe('resolved');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'blank occurrence fields',
      occurrences: [{ dimension: ' ', subject: 'api' }],
    },
    {
      name: 'duplicate occurrence tuples',
      occurrences: [
        { dimension: 'consumer', subject: 'api' },
        { dimension: 'consumer', subject: 'api' },
      ],
    },
  ])('keeps $name unresolved', ({ occurrences }) => {
    const current = state();
    recordCritique(current, MATERIAL_CRITIQUE, 0);
    recordCreatorUpdate(
      current,
      MATERIAL_CRITIQUE,
      {
        plan_version: 1,
        issues: [
          {
            id: 'C1',
            verdict: 'accept',
            verdict_reason: 'confirmed',
            final_severity: 'major',
            duplicate_of: null,
          },
        ],
        applied: ['C1'],
        systemic_dispositions: [
          {
            issue_id: 'C1',
            scope: 'cross-cutting',
            rationale: 'Every occurrence must be explicit and unique.',
            invariant: { statement: 'Every consumer is covered.', occurrences },
          },
        ],
      },
      0,
    );
    expect(current.invariants).toHaveLength(0);
    expect(current.unresolvedCoverage).toContain('I-v0-C1:occurrence-matrix');
  });

  it('keeps missing enriched metadata unproved without invalidating legacy JSON', () => {
    const current = state();
    recordCritique(current, { plan_version: 0, summary: 'legacy', issues: [] }, 0);
    current.systemCheckPassed = true;
    current.judgeApprovedPlanVersion = 0;
    classifyTerminal(current, true);
    expect(current.satisfied).toBe(false);
    expect(current.unresolvedCoverage).toContain('plan.v0:scan-incomplete');
  });

  it('replaces deterministic mismatches when the current revision corrects them', () => {
    const current = state();
    recordCritique(
      current,
      {
        plan_version: 0,
        summary: 'complete scan',
        issues: [],
        review: {
          ...MATERIAL_CRITIQUE.review,
          issue_budget: { limit: 8, used: 0, exhausted: false },
        },
      },
      0,
    );
    recordSystemCheck(current, {
      passed: false,
      mismatches: ['R-fixture:missing', 'R-fixture:ordering'],
    });
    expect(current.unresolvedCoverage).toEqual(['R-fixture:missing', 'R-fixture:ordering']);
    current.judgeApprovedPlanVersion = 0;
    classifyTerminal(current, true);
    expect(current.unresolvedCoverage).toContain('plan.v0:system-check');

    recordSystemCheck(current, { passed: true, mismatches: [] });
    classifyTerminal(current, true);
    expect(current.systemCheckPassed).toBe(true);
    expect(current.systemMismatchIds).toEqual([]);
    expect(current.unresolvedCoverage).toEqual([]);
    expect(current.satisfied).toBe(true);
  });

  it('keeps a downgraded original major finding material and requires its disposition', () => {
    const current = state();
    const evidenceWork = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-local-evidence.'));
    writeFileSync(path.join(evidenceWork, 'plan.v1.md'), '# Plan\n\n## Work Plan\n');
    recordCritique(current, MATERIAL_CRITIQUE, 0);
    try {
      recordCreatorUpdate(
        current,
        MATERIAL_CRITIQUE,
        {
          plan_version: 1,
          issues: [
            {
              id: 'C1',
              verdict: 'downgrade',
              verdict_reason: 'lower impact',
              final_severity: 'minor',
              duplicate_of: null,
            },
          ],
          applied: ['C1'],
          systemic_dispositions: [
            {
              issue_id: 'C1',
              scope: 'local',
              rationale: 'The evidence names the only consumer in declared scope.',
              evidence_refs: [{ kind: 'plan-section', section: 'Work Plan' }],
              invariant: null,
            },
          ],
        },
        0,
        { work: evidenceWork, projectRoot: evidenceWork },
      );

      expect(current.findings).toMatchObject([
        { id: 'I-v0-C1', severity: 'major', disposition: { scope: 'local' } },
      ]);
      expect(current.unresolvedCoverage).not.toContain('I-v0-C1:systemic-disposition');
    } finally {
      rmSync(evidenceWork, { recursive: true, force: true });
    }
  });

  it('uses explicit issue-budget exhaustion independently of issue count and scan completeness', () => {
    const current = state();
    const issues = Array.from({ length: 8 }, (_, index) => ({
      ...MATERIAL_CRITIQUE.issues[0],
      id: `C${index + 1}`,
    }));
    recordCritique(
      current,
      {
        ...MATERIAL_CRITIQUE,
        issues,
        review: {
          ...MATERIAL_CRITIQUE.review,
          issue_budget: { limit: 8, used: 8, exhausted: false },
          scan_complete: true,
        },
      },
      0,
    );
    expect(current.issueBudget).toMatchObject({ used: 8, exhausted: false });
    expect(current.exhaustedLimits).not.toContain('issue-budget');

    recordCritique(
      current,
      {
        plan_version: 0,
        summary: 'incomplete without budget exhaustion',
        issues: [],
        review: {
          ...MATERIAL_CRITIQUE.review,
          issue_budget: { limit: 8, used: 0, exhausted: false },
          scan_complete: false,
        },
      },
      0,
    );
    expect(current.issueBudget.exhausted).toBe(false);
    expect(current.exhaustedLimits).not.toContain('issue-budget');
    expect(current.unresolvedCoverage).toContain('plan.v0:scan-incomplete');

    recordCritique(
      current,
      {
        plan_version: 0,
        summary: 'material findings may remain',
        issues: [],
        review: {
          ...MATERIAL_CRITIQUE.review,
          issue_budget: { limit: 8, used: 0, exhausted: true },
          scan_complete: false,
        },
      },
      0,
    );
    expect(current.issueBudget.exhausted).toBe(true);
    expect(current.exhaustedLimits).toContain('issue-budget');

    recordCritique(
      current,
      {
        plan_version: 0,
        summary: 'complete rescan',
        issues: [],
        review: {
          ...MATERIAL_CRITIQUE.review,
          issue_budget: { limit: 8, used: 0, exhausted: false },
          scan_complete: true,
        },
      },
      0,
    );
    expect(current.exhaustedLimits).not.toContain('issue-budget');
  });

  it('keeps incomplete context and inconsistent critic budget metadata unproved', () => {
    const missingContext = state();
    recordCritique(
      missingContext,
      {
        plan_version: 0,
        summary: 'claims completeness without considering limits',
        issues: [],
        review: {
          ...MATERIAL_CRITIQUE.review,
          considered_context: MATERIAL_CRITIQUE.review.considered_context.filter(
            (category) => category !== 'quality-and-limits',
          ),
          issue_budget: { limit: 8, used: 0, exhausted: false },
          scan_complete: true,
        },
      },
      0,
    );
    expect(missingContext.scanComplete).toBe(false);
    expect(missingContext.unresolvedCoverage).toContain(
      'plan.v0:context-unconsidered:quality-and-limits',
    );

    const overBudget = state();
    const issues = Array.from({ length: 9 }, (_, index) => ({
      ...MATERIAL_CRITIQUE.issues[0],
      id: `C${index + 1}`,
      severity: 'nit',
    }));
    recordCritique(
      overBudget,
      {
        ...MATERIAL_CRITIQUE,
        issues,
        review: {
          ...MATERIAL_CRITIQUE.review,
          issue_budget: { limit: 8, used: 9, exhausted: false },
          scan_complete: true,
        },
      },
      0,
    );
    expect(overBudget.scanComplete).toBe(false);
    expect(overBudget.exhaustedLimits).toContain('issue-budget');
    expect(overBudget.unresolvedCoverage).toContain('plan.v0:issue-budget-metadata');

    const inconsistent = state();
    recordCritique(
      inconsistent,
      {
        plan_version: 0,
        summary: 'wrong used count',
        issues: [],
        review: {
          ...MATERIAL_CRITIQUE.review,
          issue_budget: { limit: 7, used: 3, exhausted: false },
          scan_complete: true,
        },
      },
      0,
    );
    expect(inconsistent.scanComplete).toBe(false);
    expect(inconsistent.unresolvedCoverage).toContain('plan.v0:issue-budget-metadata');
  });

  it('replaces provider-owned unresolved coverage without persisting its raw text', () => {
    const current = state();
    const raw = 'operator secret copied from the prompt';
    recordCritique(
      current,
      {
        plan_version: 0,
        summary: 'unresolved',
        issues: [],
        review: { ...MATERIAL_CRITIQUE.review, unresolved_coverage: [raw] },
      },
      0,
    );
    expect(current.unresolvedCoverage.some((id) => id.startsWith('critic-unresolved-'))).toBe(true);
    expect(JSON.stringify(current)).not.toContain(raw);

    recordCritique(
      current,
      {
        plan_version: 0,
        summary: 'resolved',
        issues: [],
        review: MATERIAL_CRITIQUE.review,
      },
      0,
    );
    expect(current.unresolvedCoverage.some((id) => id.startsWith('critic-unresolved-'))).toBe(
      false,
    );
  });

  it('makes exhaustive scan proof an explicit thorough terminal requirement', () => {
    const current = createConvergenceState({
      quality: 'thorough',
      matrix: qualityMatrix('thorough'),
      mode: 'prompt',
      sourceDigest: 'source',
      authoritativeDigest: 'system',
      relationshipIds: [],
      maxIters: 3,
    });
    expect(current.requiresExhaustiveScan).toBe(true);

    recordCritique(
      current,
      {
        plan_version: 0,
        summary: 'incomplete exhaustive scan',
        issues: [],
        review: {
          ...MATERIAL_CRITIQUE.review,
          issue_budget: { limit: 8, used: 0, exhausted: false },
          scan_complete: false,
        },
      },
      0,
    );
    current.systemCheckPassed = true;
    current.judgeApprovedPlanVersion = 0;
    classifyTerminal(current, true);
    expect(current.satisfied).toBe(false);
    expect(current.unresolvedCoverage).toContain('plan.v0:exhaustive-scan-incomplete');

    recordCritique(
      current,
      {
        plan_version: 0,
        summary: 'exhaustive scan completed',
        issues: [],
        review: {
          ...MATERIAL_CRITIQUE.review,
          issue_budget: { limit: 8, used: 0, exhausted: false },
          scan_complete: true,
        },
      },
      0,
    );
    current.systemCheckPassed = true;
    current.judgeApprovedPlanVersion = 0;
    current.contextDeliveries.push({
      role: 'critic',
      stage: 'review',
      planVersion: 0,
      mandatoryBytes: 100,
      optionalBytes: 10,
      totalInputBytes: 110,
      inputTokenLimit: null,
      inputLimitSource: 'unknown',
      reductions: [],
      omittedCategories: ['non-relevant-topology-prose'],
    });
    classifyTerminal(current, true);
    expect(current.satisfied).toBe(false);
    expect(current.unresolvedCoverage).not.toContain('plan.v0:exhaustive-scan-incomplete');
    expect(current.unresolvedCoverage.some((id) => id.startsWith('context-omission-'))).toBe(true);

    current.contextDeliveries = [];
    classifyTerminal(current, true);
    expect(current.satisfied).toBe(true);
    expect(current.unresolvedCoverage.some((id) => id.startsWith('context-omission-'))).toBe(false);
  });

  it('binds versioned and canonical convergence artifacts to exact plan bytes', () => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-convergence-plan-binding.'));
    try {
      const versionedPlan = path.join(work, 'plan.v0.md');
      const finalPlan = path.join(work, 'plan.final.md');
      writeFileSync(versionedPlan, '# Versioned plan\n');
      writeFileSync(finalPlan, '# Canonical plan\n');
      const current = state();

      const versionedState = writeConvergenceState(work, current);
      expect(current.planSha256).toBe(fileSha256(versionedPlan));
      expect(readConvergenceState(versionedState)?.planSha256).toBe(fileSha256(versionedPlan));

      const originalPlanSha256 = current.planSha256;
      writeFileSync(versionedPlan, '# Mutated versioned plan\n');
      writeConvergenceState(work, current);
      expect(current.planSha256).toBe(fileSha256(versionedPlan));
      expect(current.planSha256).not.toBe(originalPlanSha256);

      const finalState = writeConvergenceState(work, current, 'convergence.final.json');
      expect(current.canonicalPlanSha256).toBe(fileSha256(finalPlan));
      expect(readConvergenceState(finalState)).toMatchObject({
        planSha256: fileSha256(versionedPlan),
        canonicalPlanSha256: fileSha256(finalPlan),
      });

      const originalCanonicalPlanSha256 = current.canonicalPlanSha256;
      current.satisfied = true;
      current.stopReason = 'proof-satisfied';
      writeFileSync(finalPlan, '# Mutated canonical plan\n');
      writeConvergenceState(work, current, 'convergence.final.json');
      expect(current.canonicalPlanSha256).toBe(fileSha256(finalPlan));
      expect(current.canonicalPlanSha256).not.toBe(originalCanonicalPlanSha256);
      expect(current.satisfied).toBe(false);
      expect(current.unresolvedCoverage).toContain('canonical-plan:proof-hash-mismatch');
      const persistedMutatedState = readConvergenceState(finalState);
      expect(persistedMutatedState).toMatchObject({
        canonicalPlanSha256: fileSha256(finalPlan),
        satisfied: false,
      });
      expect(persistedMutatedState?.unresolvedCoverage).toContain(
        'canonical-plan:proof-hash-mismatch',
      );

      current.planVersion = 1;
      writeConvergenceState(work, current);
      expect(current.planSha256).toBeUndefined();
      expect(
        JSON.parse(readFileSync(path.join(work, 'convergence.v1.json'), 'utf8')),
      ).not.toHaveProperty('planSha256');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('reads convergence artifacts without the additive exhaustive flag conservatively', () => {
    const legacy = createConvergenceState({
      quality: 'thorough',
      matrix: qualityMatrix('thorough'),
      mode: 'prompt',
      sourceDigest: 'source',
      authoritativeDigest: 'system',
      relationshipIds: [],
      maxIters: 3,
    });
    const serialized = { ...legacy } as Record<string, unknown>;
    delete serialized.requiresExhaustiveScan;
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-convergence-legacy.'));
    const file = path.join(tmp, 'convergence.json');
    try {
      writeFileSync(file, `${JSON.stringify(serialized)}\n`);
      const restored = readConvergenceState(file);
      expect(restored?.requiresExhaustiveScan).toBe(true);
      if (restored === undefined) {
        throw new Error('expected legacy convergence state');
      }
      restored.lastCritiquedPlanVersion = 0;
      restored.systemCheckPassed = true;
      restored.judgeApprovedPlanVersion = 0;
      classifyTerminal(restored, true);
      expect(restored.satisfied).toBe(false);
      expect(restored.unresolvedCoverage).toContain('plan.v0:exhaustive-scan-incomplete');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
