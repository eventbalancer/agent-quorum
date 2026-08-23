import type { ReadinessDecision, ReadinessLimit } from '../types.js';

export const CANONICAL_PROOF_HASH_MISMATCH = 'canonical-plan:proof-hash-mismatch';
export const DELIVERED_PLAN_FRESH_REVIEW_REQUIRED = 'canonical-plan:fresh-review-required';
export const FINAL_ARTIFACT_REVIEW_REQUIRED = 'final-artifact:needs-review';
export const FINAL_JUDGE_INCONSISTENT = 'final-judge:inconsistent-verdict';

export interface OccurrenceSourceFact {
  readonly source: string;
  readonly required: boolean;
  readonly available: boolean;
  readonly catalogExact: boolean;
  readonly current: boolean;
  readonly consistent: boolean;
  readonly conclusive: boolean;
}

export interface JudgeReadinessFacts {
  readonly required: boolean;
  readonly allowed: boolean;
  readonly evaluatedPlanVersion?: number;
  readonly approvedPlanVersion?: number;
  readonly verdict?: boolean;
}

export interface ReadinessFacts {
  readonly planVersion: number;
  readonly boundaryChallengeIds: readonly string[];
  readonly unresolvedMaterialQuestionIds: readonly string[];
  readonly unknownRiskDomainIds: readonly string[];
  readonly unavailableEvidenceIds: readonly string[];
  readonly hasCanonicalBindingMismatch: boolean;
  readonly hasFreshReviewMismatch: boolean;
  readonly hasFinalArtifactMismatch: boolean;
  readonly hasJudgeInconsistency: boolean;
  readonly exhaustedLimits: readonly ReadinessLimit[];
  readonly materialIssueIds: readonly string[];
  readonly deterministicMismatchIds: readonly string[];
  readonly isIndependentReviewCurrent: boolean;
  readonly isApplicableDomainScanComplete: boolean;
  readonly isExhaustiveApplicableScanRequired: boolean;
  readonly isDeterministicProofRequired: boolean;
  readonly isDeterministicProofComplete: boolean;
  readonly activeInvariantIds: readonly string[];
  readonly occurrenceSources: readonly OccurrenceSourceFact[];
  readonly resolvedOccurrenceIds: readonly string[];
  readonly violatedOccurrenceIds: readonly string[];
  readonly unresolvedOccurrenceIds: readonly string[];
  readonly disagreementOccurrenceIds: readonly string[];
  readonly isOccurrenceProofSatisfied: boolean;
  readonly judge: JudgeReadinessFacts;
  readonly criticCoverageGapIds: readonly string[];
  readonly criticScopeCoverageGapIds: readonly string[];
  readonly criticContextGapIds: readonly string[];
  readonly materialRevisionProofGapIds: readonly string[];
  readonly otherUnresolvedProofIds: readonly string[];
}

export interface ReadinessReduction {
  readonly decision: ReadinessDecision;
  readonly reasonCodes: readonly string[];
  readonly satisfied: boolean;
  readonly exhaustedLimits: readonly ReadinessLimit[];
  readonly unresolvedProofIds: readonly string[];
  readonly stopReason: string;
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return unique(values).sort((left, right) => left.localeCompare(right));
}

function sourceProofId(source: OccurrenceSourceFact): string {
  return `occurrence-source:${source.source}`;
}

function reduction(
  decision: ReadinessDecision,
  reasonCodes: readonly string[],
  unresolvedProofIds: readonly string[],
  exhaustedLimits: readonly ReadinessLimit[],
): ReadinessReduction {
  const stableReasonCodes = sortedUnique(reasonCodes);
  return {
    decision,
    reasonCodes: stableReasonCodes,
    satisfied: decision === 'ready',
    exhaustedLimits: sortedUnique(exhaustedLimits),
    unresolvedProofIds: sortedUnique(unresolvedProofIds),
    stopReason:
      decision === 'ready'
        ? 'ready'
        : `${decision}:${stableReasonCodes.length > 0 ? stableReasonCodes.join(',') : 'unspecified'}`,
  };
}

export function reduceReadiness(facts: ReadinessFacts): ReadinessReduction {
  const unresolvedProofIds = new Set(facts.otherUnresolvedProofIds);
  const primaryReasons: string[] = [];
  const exhaustedLimits = [...facts.exhaustedLimits];
  if (facts.judge.required && !facts.judge.allowed) {
    exhaustedLimits.push('assurance-appetite');
  }

  for (const challengeId of facts.boundaryChallengeIds) {
    unresolvedProofIds.add(`boundary-challenge:${challengeId}`);
  }
  if (facts.boundaryChallengeIds.length > 0) {
    primaryReasons.push('boundary-challenge');
  }

  for (const questionId of facts.unresolvedMaterialQuestionIds) {
    unresolvedProofIds.add(`material-question:${questionId}`);
  }
  if (facts.unresolvedMaterialQuestionIds.length > 0) {
    primaryReasons.push('material-question-unresolved');
  }

  for (const domainId of facts.unknownRiskDomainIds) {
    unresolvedProofIds.add(`risk-applicability:${domainId}`);
  }
  if (facts.unknownRiskDomainIds.length > 0) {
    primaryReasons.push('risk-applicability-unresolved');
  }

  for (const evidenceId of facts.unavailableEvidenceIds) {
    unresolvedProofIds.add(`plan.v${facts.planVersion}:required-evidence:${evidenceId}`);
  }
  if (facts.unavailableEvidenceIds.length > 0) {
    primaryReasons.push('required-evidence-unavailable');
  }

  if (facts.hasCanonicalBindingMismatch) {
    unresolvedProofIds.add(CANONICAL_PROOF_HASH_MISMATCH);
    primaryReasons.push('canonical-plan-binding-mismatch');
  }
  if (facts.hasFreshReviewMismatch) {
    unresolvedProofIds.add(DELIVERED_PLAN_FRESH_REVIEW_REQUIRED);
    primaryReasons.push('fresh-review-required');
  }
  if (facts.hasFinalArtifactMismatch) {
    unresolvedProofIds.add(FINAL_ARTIFACT_REVIEW_REQUIRED);
    primaryReasons.push('final-artifact-needs-review');
  }
  if (facts.hasJudgeInconsistency) {
    unresolvedProofIds.add(FINAL_JUDGE_INCONSISTENT);
    primaryReasons.push('judge-inconsistent-after-status-projection');
  }
  if (primaryReasons.length > 0) {
    return reduction('unable-to-decide', primaryReasons, [...unresolvedProofIds], exhaustedLimits);
  }

  if (exhaustedLimits.length > 0) {
    return reduction('limits-exhausted', exhaustedLimits, [...unresolvedProofIds], exhaustedLimits);
  }

  const revisionReasons: string[] = [];
  if (facts.materialIssueIds.length > 0) {
    revisionReasons.push('material-issues');
  }
  if (facts.deterministicMismatchIds.length > 0) {
    revisionReasons.push('deterministic-check-failed');
    for (const mismatchId of facts.deterministicMismatchIds) {
      unresolvedProofIds.add(mismatchId);
    }
  }
  if (revisionReasons.length > 0) {
    return reduction(
      'revision-required',
      revisionReasons,
      [...unresolvedProofIds],
      exhaustedLimits,
    );
  }

  const gateReasons: string[] = [];
  if (!facts.isIndependentReviewCurrent) {
    unresolvedProofIds.add(`plan.v${facts.planVersion}:not-independently-reviewed`);
    gateReasons.push('independent-review-required');
  }
  if (!facts.isApplicableDomainScanComplete) {
    unresolvedProofIds.add(`plan.v${facts.planVersion}:scan-incomplete`);
    gateReasons.push(
      facts.isExhaustiveApplicableScanRequired
        ? 'exhaustive-applicable-scan-incomplete'
        : 'applicable-domain-scan-incomplete',
    );
  }
  if (facts.isDeterministicProofRequired && !facts.isDeterministicProofComplete) {
    unresolvedProofIds.add(`plan.v${facts.planVersion}:system-check`);
    gateReasons.push('deterministic-check-incomplete');
  }

  for (const invariantId of facts.activeInvariantIds) {
    unresolvedProofIds.add(invariantId);
  }
  if (facts.activeInvariantIds.length > 0) {
    gateReasons.push('cross-cutting-invariant-coverage-incomplete');
  }

  const requiredSources = facts.occurrenceSources.filter((source) => source.required);
  for (const source of requiredSources) {
    if (
      !source.available ||
      !source.catalogExact ||
      !source.current ||
      !source.consistent ||
      !source.conclusive
    ) {
      unresolvedProofIds.add(sourceProofId(source));
    }
  }
  if (requiredSources.some((source) => !source.available)) {
    gateReasons.push('occurrence-source-missing');
  }
  if (requiredSources.some((source) => source.available && !source.catalogExact)) {
    gateReasons.push('occurrence-source-catalog-inexact');
  }
  if (requiredSources.some((source) => source.available && !source.current)) {
    gateReasons.push('occurrence-source-stale');
  }
  if (requiredSources.some((source) => source.available && !source.consistent)) {
    gateReasons.push('occurrence-source-inconsistent');
  }
  if (requiredSources.some((source) => source.available && !source.conclusive)) {
    gateReasons.push('occurrence-source-inconclusive');
  }

  for (const occurrenceId of facts.violatedOccurrenceIds) {
    unresolvedProofIds.add(occurrenceId);
  }
  if (facts.violatedOccurrenceIds.length > 0) {
    gateReasons.push('occurrence-proof-violated');
  }
  for (const occurrenceId of facts.unresolvedOccurrenceIds) {
    unresolvedProofIds.add(occurrenceId);
  }
  if (facts.unresolvedOccurrenceIds.length > 0) {
    gateReasons.push('occurrence-proof-unresolved');
  }
  for (const occurrenceId of facts.disagreementOccurrenceIds) {
    unresolvedProofIds.add(occurrenceId);
  }
  if (facts.disagreementOccurrenceIds.length > 0) {
    gateReasons.push('occurrence-source-disagreement');
  }
  if (!facts.isOccurrenceProofSatisfied) {
    gateReasons.push('occurrence-proof-incomplete');
  }

  if (facts.judge.required && facts.judge.allowed) {
    if (facts.judge.evaluatedPlanVersion !== facts.planVersion) {
      unresolvedProofIds.add(`plan.v${facts.planVersion}:judge`);
      gateReasons.push('judge-unavailable');
    } else if (
      facts.judge.verdict !== true ||
      facts.judge.approvedPlanVersion !== facts.planVersion
    ) {
      unresolvedProofIds.add(`plan.v${facts.planVersion}:judge`);
      gateReasons.push('judge-not-ready');
    }
  }
  if (facts.criticCoverageGapIds.length > 0) {
    for (const gapId of facts.criticCoverageGapIds) {
      unresolvedProofIds.add(gapId);
    }
    gateReasons.push('critic-coverage-unresolved');
  }
  for (const gapId of facts.criticScopeCoverageGapIds) {
    unresolvedProofIds.add(gapId);
  }
  if (facts.criticScopeCoverageGapIds.length > 0) {
    gateReasons.push('critic-scope-coverage-incomplete');
  }
  for (const gapId of facts.criticContextGapIds) {
    unresolvedProofIds.add(gapId);
  }
  if (facts.criticContextGapIds.length > 0) {
    gateReasons.push('critic-context-incomplete');
  }
  if (facts.materialRevisionProofGapIds.length > 0) {
    for (const gapId of facts.materialRevisionProofGapIds) {
      unresolvedProofIds.add(gapId);
    }
    gateReasons.push('material-revision-proof-incomplete');
  }
  if (facts.otherUnresolvedProofIds.length > 0) {
    gateReasons.push('proof-incomplete');
  }

  if (gateReasons.length > 0) {
    return reduction('unable-to-decide', gateReasons, [...unresolvedProofIds], exhaustedLimits);
  }
  return reduction('ready', [], [], exhaustedLimits);
}
