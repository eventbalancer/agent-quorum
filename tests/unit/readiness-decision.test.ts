import { describe, expect, it } from 'vitest';
import {
  reduceReadiness,
  type OccurrenceSourceFact,
  type ReadinessFacts,
} from '../../src/core/readiness-decision.js';

function occurrenceSource(
  source: string,
  overrides: Partial<OccurrenceSourceFact> = {},
): OccurrenceSourceFact {
  return {
    source,
    required: true,
    available: true,
    catalogExact: true,
    current: true,
    consistent: true,
    conclusive: true,
    ...overrides,
  };
}

function facts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    planVersion: 2,
    boundaryChallengeIds: [],
    unresolvedMaterialQuestionIds: [],
    unknownRiskDomainIds: [],
    unavailableEvidenceIds: [],
    hasCanonicalBindingMismatch: false,
    hasFreshReviewMismatch: false,
    hasFinalArtifactMismatch: false,
    hasJudgeInconsistency: false,
    exhaustedLimits: [],
    materialIssueIds: [],
    deterministicMismatchIds: [],
    isIndependentReviewCurrent: true,
    isApplicableDomainScanComplete: true,
    isExhaustiveApplicableScanRequired: false,
    isDeterministicProofRequired: false,
    isDeterministicProofComplete: true,
    activeInvariantIds: [],
    occurrenceSources: [occurrenceSource('critic')],
    resolvedOccurrenceIds: ['O-1'],
    violatedOccurrenceIds: [],
    unresolvedOccurrenceIds: [],
    disagreementOccurrenceIds: [],
    isOccurrenceProofSatisfied: true,
    judge: {
      required: false,
      allowed: false,
    },
    criticCoverageGapIds: [],
    criticScopeCoverageGapIds: [],
    criticContextGapIds: [],
    materialRevisionProofGapIds: [],
    otherUnresolvedProofIds: [],
    ...overrides,
  };
}

describe('reduceReadiness', () => {
  it('implements all four decisions with the frozen priority', () => {
    expect(reduceReadiness(facts())).toMatchObject({
      decision: 'ready',
      reasonCodes: [],
      satisfied: true,
    });

    expect(reduceReadiness(facts({ materialIssueIds: ['C1'] }))).toMatchObject({
      decision: 'revision-required',
      reasonCodes: ['material-issues'],
      satisfied: false,
    });

    expect(
      reduceReadiness(
        facts({
          exhaustedLimits: ['iteration-cap'],
          materialIssueIds: ['C1'],
        }),
      ),
    ).toMatchObject({
      decision: 'limits-exhausted',
      reasonCodes: ['iteration-cap'],
    });

    expect(
      reduceReadiness(
        facts({
          boundaryChallengeIds: ['scope-fork'],
          exhaustedLimits: ['iteration-cap'],
          materialIssueIds: ['C1'],
        }),
      ),
    ).toMatchObject({
      decision: 'unable-to-decide',
      reasonCodes: ['boundary-challenge'],
    });
  });

  it.each([
    {
      name: 'unresolved material question',
      overrides: { unresolvedMaterialQuestionIds: ['Q1'] },
      reason: 'material-question-unresolved',
    },
    {
      name: 'unknown risk applicability',
      overrides: { unknownRiskDomainIds: ['correctness'] },
      reason: 'risk-applicability-unresolved',
    },
    {
      name: 'unavailable evidence',
      overrides: { unavailableEvidenceIds: ['policy'] },
      reason: 'required-evidence-unavailable',
    },
    {
      name: 'canonical mismatch',
      overrides: { hasCanonicalBindingMismatch: true },
      reason: 'canonical-plan-binding-mismatch',
    },
    {
      name: 'fresh review mismatch',
      overrides: { hasFreshReviewMismatch: true },
      reason: 'fresh-review-required',
    },
    {
      name: 'final artifact mismatch',
      overrides: { hasFinalArtifactMismatch: true },
      reason: 'final-artifact-needs-review',
    },
    {
      name: 'Judge inconsistency',
      overrides: { hasJudgeInconsistency: true },
      reason: 'judge-inconsistent-after-status-projection',
    },
  ])('classifies primary inability for $name', ({ overrides, reason }) => {
    const result = reduceReadiness(facts(overrides));
    expect(result.decision).toBe('unable-to-decide');
    expect(result.reasonCodes).toContain(reason);
  });

  it('derives Judge appetite and applicability only from normalized facts', () => {
    expect(reduceReadiness(facts()).decision).toBe('ready');
    expect(
      reduceReadiness(
        facts({
          judge: { required: true, allowed: false },
        }),
      ),
    ).toMatchObject({
      decision: 'limits-exhausted',
      reasonCodes: ['assurance-appetite'],
    });
    expect(
      reduceReadiness(
        facts({
          judge: { required: true, allowed: true },
        }),
      ),
    ).toMatchObject({ decision: 'unable-to-decide', reasonCodes: ['judge-unavailable'] });
    expect(
      reduceReadiness(
        facts({
          judge: {
            required: true,
            allowed: true,
            evaluatedPlanVersion: 2,
            approvedPlanVersion: 2,
            verdict: true,
          },
        }),
      ).decision,
    ).toBe('ready');
  });

  it.each([
    {
      name: 'stale independent review',
      overrides: { isIndependentReviewCurrent: false },
      reason: 'independent-review-required',
      unresolvedId: 'plan.v2:not-independently-reviewed',
    },
    {
      name: 'applicable-domain scan',
      overrides: { isApplicableDomainScanComplete: false },
      reason: 'applicable-domain-scan-incomplete',
      unresolvedId: 'plan.v2:scan-incomplete',
    },
    {
      name: 'exhaustive applicable-domain scan',
      overrides: {
        isApplicableDomainScanComplete: false,
        isExhaustiveApplicableScanRequired: true,
      },
      reason: 'exhaustive-applicable-scan-incomplete',
      unresolvedId: 'plan.v2:scan-incomplete',
    },
    {
      name: 'required deterministic proof',
      overrides: {
        isDeterministicProofRequired: true,
        isDeterministicProofComplete: false,
      },
      reason: 'deterministic-check-incomplete',
      unresolvedId: 'plan.v2:system-check',
    },
    {
      name: 'active invariant',
      overrides: { activeInvariantIds: ['I-active'] },
      reason: 'cross-cutting-invariant-coverage-incomplete',
      unresolvedId: 'I-active',
    },
    {
      name: 'critic coverage gap',
      overrides: { criticCoverageGapIds: ['critic-unresolved-a'] },
      reason: 'critic-coverage-unresolved',
      unresolvedId: 'critic-unresolved-a',
    },
    {
      name: 'critic scope gap',
      overrides: { criticScopeCoverageGapIds: ['plan.v2:scope-coverage-incomplete'] },
      reason: 'critic-scope-coverage-incomplete',
      unresolvedId: 'plan.v2:scope-coverage-incomplete',
    },
    {
      name: 'critic context gap',
      overrides: { criticContextGapIds: ['plan.v2:context-unconsidered:original-scope'] },
      reason: 'critic-context-incomplete',
      unresolvedId: 'plan.v2:context-unconsidered:original-scope',
    },
    {
      name: 'material revision proof gap',
      overrides: { materialRevisionProofGapIds: ['v2.C1:creator-verdict'] },
      reason: 'material-revision-proof-incomplete',
      unresolvedId: 'v2.C1:creator-verdict',
    },
    {
      name: 'other proof gap',
      overrides: { otherUnresolvedProofIds: ['proof-gap'] },
      reason: 'proof-incomplete',
      unresolvedId: 'proof-gap',
    },
    {
      name: 'stale Judge version',
      overrides: {
        judge: {
          required: true,
          allowed: true,
          evaluatedPlanVersion: 1,
          approvedPlanVersion: 1,
          verdict: true,
        },
      },
      reason: 'judge-unavailable',
      unresolvedId: 'plan.v2:judge',
    },
    {
      name: 'negative Judge verdict',
      overrides: {
        judge: {
          required: true,
          allowed: true,
          evaluatedPlanVersion: 2,
          verdict: false,
        },
      },
      reason: 'judge-not-ready',
      unresolvedId: 'plan.v2:judge',
    },
  ])('rejects the $name gate', ({ overrides, reason, unresolvedId }) => {
    const result = reduceReadiness(facts(overrides));
    expect(result).toMatchObject({ decision: 'unable-to-decide', satisfied: false });
    expect(result.reasonCodes).toContain(reason);
    expect(result.unresolvedProofIds).toContain(unresolvedId);
  });

  it('keeps admitted material revision work above proof-gate failures', () => {
    expect(
      reduceReadiness(
        facts({
          materialIssueIds: ['C1'],
          isIndependentReviewCurrent: false,
          activeInvariantIds: ['I-active'],
        }),
      ),
    ).toMatchObject({ decision: 'revision-required', reasonCodes: ['material-issues'] });
  });

  it.each([
    {
      name: 'satisfied',
      overrides: {},
      decision: 'ready',
      reasons: [],
    },
    {
      name: 'grounded not-applicable normalized to resolved',
      overrides: { resolvedOccurrenceIds: ['O-not-applicable'] },
      decision: 'ready',
      reasons: [],
    },
    {
      name: 'violated with material work',
      overrides: {
        resolvedOccurrenceIds: [],
        violatedOccurrenceIds: ['O-1'],
        isOccurrenceProofSatisfied: false,
        materialIssueIds: ['C1'],
      },
      decision: 'revision-required',
      reasons: ['material-issues'],
    },
    {
      name: 'violated without material work',
      overrides: {
        resolvedOccurrenceIds: [],
        violatedOccurrenceIds: ['O-1'],
        isOccurrenceProofSatisfied: false,
      },
      decision: 'unable-to-decide',
      reasons: ['occurrence-proof-incomplete', 'occurrence-proof-violated'],
    },
    {
      name: 'unresolved',
      overrides: {
        resolvedOccurrenceIds: [],
        unresolvedOccurrenceIds: ['O-1'],
        isOccurrenceProofSatisfied: false,
      },
      decision: 'unable-to-decide',
      reasons: ['occurrence-proof-incomplete', 'occurrence-proof-unresolved'],
    },
    {
      name: 'resolved and violated disagreement',
      overrides: {
        violatedOccurrenceIds: ['O-1'],
        disagreementOccurrenceIds: ['O-1'],
        isOccurrenceProofSatisfied: false,
      },
      decision: 'unable-to-decide',
      reasons: [
        'occurrence-proof-incomplete',
        'occurrence-proof-violated',
        'occurrence-source-disagreement',
      ],
    },
  ])('maps the $name occurrence outcome', ({ overrides, decision, reasons }) => {
    const result = reduceReadiness(facts(overrides));
    expect(result.decision).toBe(decision);
    expect(result.reasonCodes).toEqual(reasons);
  });

  it('keeps unavailable evidence above an unresolved occurrence', () => {
    expect(
      reduceReadiness(
        facts({
          unavailableEvidenceIds: ['repository-topology'],
          resolvedOccurrenceIds: [],
          unresolvedOccurrenceIds: ['O-1'],
          isOccurrenceProofSatisfied: false,
        }),
      ),
    ).toMatchObject({
      decision: 'unable-to-decide',
      reasonCodes: ['required-evidence-unavailable'],
    });
  });

  it.each([
    {
      name: 'missing',
      source: occurrenceSource('fix-reviewer', { available: false }),
      reasons: ['occurrence-proof-incomplete', 'occurrence-source-missing'],
    },
    {
      name: 'stale',
      source: occurrenceSource('fix-reviewer', { current: false }),
      reasons: ['occurrence-proof-incomplete', 'occurrence-source-stale'],
    },
    {
      name: 'inexact',
      source: occurrenceSource('fix-reviewer', { catalogExact: false }),
      reasons: ['occurrence-proof-incomplete', 'occurrence-source-catalog-inexact'],
    },
    {
      name: 'inconsistent',
      source: occurrenceSource('fix-reviewer', { consistent: false }),
      reasons: ['occurrence-proof-incomplete', 'occurrence-source-inconsistent'],
    },
  ])('rejects a $name conditionally required fix-review source', ({ source, reasons }) => {
    const result = reduceReadiness(
      facts({
        occurrenceSources: [occurrenceSource('critic'), source],
        isOccurrenceProofSatisfied: false,
      }),
    );
    expect(result.decision).toBe('unable-to-decide');
    expect(result.reasonCodes).toEqual(reasons);
    expect(result.unresolvedProofIds).toContain('occurrence-source:fix-reviewer');
  });

  it('allows an explicit fix-review exemption without weakening other gates', () => {
    const result = reduceReadiness(
      facts({
        occurrenceSources: [
          occurrenceSource('critic'),
          occurrenceSource('fix-reviewer', {
            required: false,
            catalogExact: false,
            current: false,
            consistent: false,
            conclusive: false,
          }),
        ],
      }),
    );
    expect(result.decision).toBe('ready');
  });

  it('requires active invariant occurrence proof for standard-risk work', () => {
    expect(
      reduceReadiness(
        facts({
          resolvedOccurrenceIds: [],
          unresolvedOccurrenceIds: ['O-standard'],
          isOccurrenceProofSatisfied: false,
          judge: { required: false, allowed: false },
        }),
      ),
    ).toMatchObject({
      decision: 'unable-to-decide',
      reasonCodes: ['occurrence-proof-incomplete', 'occurrence-proof-unresolved'],
    });
  });

  it('rejects an active invariant even when its occurrence catalog is empty', () => {
    expect(
      reduceReadiness(
        facts({
          activeInvariantIds: ['I-empty'],
          resolvedOccurrenceIds: [],
          isOccurrenceProofSatisfied: false,
        }),
      ),
    ).toMatchObject({
      decision: 'unable-to-decide',
      reasonCodes: ['cross-cutting-invariant-coverage-incomplete', 'occurrence-proof-incomplete'],
      unresolvedProofIds: ['I-empty'],
    });
  });

  it('rejects a violated conditionally required fix-review source', () => {
    expect(
      reduceReadiness(
        facts({
          occurrenceSources: [occurrenceSource('critic'), occurrenceSource('fix-reviewer')],
          resolvedOccurrenceIds: [],
          violatedOccurrenceIds: ['O-fix'],
          isOccurrenceProofSatisfied: false,
        }),
      ),
    ).toMatchObject({
      decision: 'unable-to-decide',
      reasonCodes: ['occurrence-proof-incomplete', 'occurrence-proof-violated'],
      unresolvedProofIds: ['O-fix'],
    });
  });

  it('is deterministic under source and identifier permutations', () => {
    const left = facts({
      occurrenceSources: [
        occurrenceSource('final-judge', { current: false }),
        occurrenceSource('fix-reviewer', { current: false }),
        occurrenceSource('critic'),
      ],
      resolvedOccurrenceIds: [],
      unresolvedOccurrenceIds: ['O-2', 'O-1'],
      isOccurrenceProofSatisfied: false,
      otherUnresolvedProofIds: ['proof-b', 'proof-a'],
    });
    const right = facts({
      occurrenceSources: [...left.occurrenceSources].reverse(),
      resolvedOccurrenceIds: [],
      unresolvedOccurrenceIds: ['O-1', 'O-2'],
      isOccurrenceProofSatisfied: false,
      otherUnresolvedProofIds: ['proof-a', 'proof-b'],
    });
    expect(reduceReadiness(left)).toEqual(reduceReadiness(right));
    expect(reduceReadiness(left)).toEqual(reduceReadiness(left));
  });

  it('is deterministic under exhausted-limit permutations', () => {
    const left = reduceReadiness(facts({ exhaustedLimits: ['iteration-cap', 'issue-budget'] }));
    const right = reduceReadiness(facts({ exhaustedLimits: ['issue-budget', 'iteration-cap'] }));
    expect(left).toEqual(right);
    expect(left).toMatchObject({
      decision: 'limits-exhausted',
      exhaustedLimits: ['issue-budget', 'iteration-cap'],
      reasonCodes: ['issue-budget', 'iteration-cap'],
    });
  });
});
