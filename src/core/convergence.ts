import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { InputLimitSource } from './config.js';
import type { QualityMatrix } from './quality.js';
import { isJsonObject, type JsonObject, type JsonValue } from './json.js';
import {
  critiqueDuplicateIsValid,
  evidenceReferencesGrounded,
  type EvidenceTargetContext,
} from './metrics.js';
import type {
  CompletenessPromise,
  ConvergenceLimit,
  ConvergenceReport,
  Quality,
  ReadinessDecision,
  RiskApplicability,
  RiskDomain,
  RiskLevel,
  Role,
  RunMode,
} from '../types.js';

export const CONVERGENCE_SCHEMA_VERSION = 2;
export const CRITIC_ISSUE_BUDGET = 8;
export const CANONICAL_PROOF_HASH_MISMATCH = 'canonical-plan:proof-hash-mismatch';
export const DELIVERED_PLAN_FRESH_REVIEW_REQUIRED = 'canonical-plan:fresh-review-required';
export const FINAL_ARTIFACT_REVIEW_REQUIRED = 'final-artifact:needs-review';

export type ScopeSource = 'prompt' | 'direct-plan' | 'unavailable';
export type OccurrenceDisposition = 'satisfied' | 'violated' | 'not-applicable' | 'unresolved';

export interface ContextReduction {
  readonly category: string;
  readonly bytes: number;
}

export interface ContextDelivery {
  readonly role: Role;
  readonly stage: string;
  readonly planVersion: number;
  readonly mandatoryBytes: number;
  readonly optionalBytes: number;
  readonly totalInputBytes: number;
  readonly inputTokenLimit: number | null;
  readonly inputLimitSource: InputLimitSource;
  readonly reductions: readonly ContextReduction[];
  readonly omittedCategories: readonly string[];
}

export interface FindingDisposition {
  readonly scope: 'local' | 'cross-cutting' | 'unresolved';
  readonly rationale: string;
  readonly evidenceRefs?: readonly JsonValue[];
  readonly supersededBy?: string;
}

export interface FindingRecord {
  readonly id: string;
  readonly issueRef: string;
  readonly introducedPlanVersion: number;
  readonly severity: 'blocker' | 'major';
  readonly claim: string;
  readonly disposition: FindingDisposition;
}

export interface InvariantOccurrence {
  readonly id: string;
  readonly dimension: string;
  readonly subject: string;
  disposition: OccurrenceDisposition;
  evidenceRefs: readonly JsonValue[];
}

export interface InvariantRecord {
  readonly id: string;
  readonly sourceFinding: string;
  readonly statement: string;
  status: 'active' | 'resolved';
  occurrences: InvariantOccurrence[];
  lastReviewedPlanVersion?: number;
}

export interface ConvergenceIssueBudget {
  readonly limit: number;
  used: number;
  exhausted: boolean;
}

export interface ConvergenceState {
  readonly schemaVersion: 2;
  planVersion: number;
  readonly quality: Quality;
  readonly promise: CompletenessPromise;
  readonly requiredProofLevel: 'best-effort' | 'cumulative' | 'exhaustive';
  readonly requiresExhaustiveScan: boolean;
  readonly scopeSource: ScopeSource;
  readonly originalRequestAvailable: boolean;
  readonly sourceDigest: string;
  planSha256?: string;
  canonicalPlanSha256?: string;
  authoritativeDigest: string;
  operatorDecisionIds: string[];
  interventionIds: string[];
  findings: FindingRecord[];
  invariants: InvariantRecord[];
  relationshipIds: string[];
  contextDeliveries: ContextDelivery[];
  issueBudget: ConvergenceIssueBudget;
  iterationLimit: number;
  exhaustedLimits: ConvergenceLimit[];
  unresolvedCoverage: string[];
  lastCritiquedPlanVersion?: number;
  scanComplete: boolean;
  declaredScopeVerified: boolean;
  currentActionableIssues: string[];
  systemCheckPassed: boolean;
  systemMismatchIds: string[];
  requiredEvidenceUnavailable: string[];
  unresolvedMaterialQuestionIds: string[];
  readinessContractDigest?: string;
  judgeAllowed: boolean;
  exhaustiveApplicableDomains: boolean;
  riskDomains: RiskDomainRecord[];
  boundaryChallenges: BoundaryChallengeRecord[];
  opportunities: OpportunityRecord[];
  judgeApprovedPlanVersion?: number;
  judgeEvaluatedPlanVersion?: number;
  judgeReady?: boolean;
  decision: ReadinessDecision;
  reasonCodes: string[];
  stopReason: string;
  satisfied: boolean;
}

export interface CreateConvergenceStateInput {
  readonly quality: Quality;
  readonly matrix: QualityMatrix;
  readonly mode: RunMode;
  readonly sourceDigest: string;
  readonly authoritativeDigest: string;
  readonly relationshipIds: readonly string[];
  readonly maxIters: number;
}

export interface ConvergenceCheckResult {
  readonly passed: boolean;
  readonly mismatches: readonly string[];
  readonly requiredEvidenceUnavailable?: readonly string[];
}

export interface RiskDomainRecord {
  readonly domain: RiskDomain;
  applicability: RiskApplicability;
  risk: RiskLevel;
  rationale: string;
  evidenceRefs: readonly JsonValue[];
  complete: boolean;
  unavailableEvidence: string[];
  lastAssessedPlanVersion?: number;
}

export interface BoundaryChallengeRecord {
  readonly id: string;
  readonly kind: 'scope-expansion' | 'out-of-scope-removal' | 'assurance-appetite';
  readonly claim: string;
  readonly rationale: string;
  readonly evidenceRefs: readonly JsonValue[];
  readonly planVersion: number;
}

export interface OpportunityRecord {
  readonly fingerprint: string;
  readonly claim: string;
  readonly evidence: string;
  readonly suggestedImprovement: string;
  readonly evidenceRefs: readonly JsonValue[];
  readonly firstSeenPlanVersion: number;
  lastSeenPlanVersion: number;
}

export interface ReadinessPolicyRiskDomain {
  readonly domain: RiskDomain;
  readonly applicability: RiskApplicability;
  readonly risk: RiskLevel;
  readonly rationale: string;
  readonly evidenceRefs: readonly JsonValue[];
}

export interface ReadinessPolicyInput {
  readonly contractDigest: string;
  readonly judgeAllowed: boolean;
  readonly exhaustiveApplicableDomains: boolean;
  readonly unresolvedMaterialQuestionIds: readonly string[];
  readonly riskDomains: readonly ReadinessPolicyRiskDomain[];
}

const READINESS_DECISIONS: readonly ReadinessDecision[] = [
  'ready',
  'revision-required',
  'unable-to-decide',
  'limits-exhausted',
];

const RISK_DOMAINS: readonly RiskDomain[] = [
  'correctness',
  'public-compatibility',
  'data-migrations',
  'security-privacy-authorization',
  'concurrency-distributed-ordering',
  'cross-repository-delivery',
  'production-operability',
  'performance-cost',
];

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function stableTupleId(prefix: string, tuple: readonly JsonValue[]): string {
  const digest = createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
  return `${prefix}-${digest}`;
}

export function fileSha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function createConvergenceState(input: CreateConvergenceStateInput): ConvergenceState {
  const scopeSource: ScopeSource = input.mode === 'prompt' ? 'prompt' : 'direct-plan';
  return {
    schemaVersion: CONVERGENCE_SCHEMA_VERSION,
    planVersion: 0,
    quality: input.quality,
    promise: input.matrix.completenessPromise,
    requiredProofLevel: input.matrix.completenessPromise,
    requiresExhaustiveScan: input.matrix.requiresExhaustiveScan === 1,
    scopeSource,
    originalRequestAvailable: input.mode === 'prompt',
    sourceDigest: input.sourceDigest,
    authoritativeDigest: input.authoritativeDigest,
    operatorDecisionIds: [],
    interventionIds: [],
    findings: [],
    invariants: [],
    relationshipIds: [...input.relationshipIds],
    contextDeliveries: [],
    issueBudget: { limit: CRITIC_ISSUE_BUDGET, used: 0, exhausted: false },
    iterationLimit: input.maxIters,
    exhaustedLimits: [],
    unresolvedCoverage: [],
    scanComplete: false,
    declaredScopeVerified: input.mode === 'prompt',
    currentActionableIssues: [],
    systemCheckPassed: false,
    systemMismatchIds: [],
    requiredEvidenceUnavailable: [],
    unresolvedMaterialQuestionIds: [],
    judgeAllowed: input.matrix.judge === 1,
    exhaustiveApplicableDomains: input.matrix.requiresExhaustiveScan === 1,
    riskDomains: [],
    boundaryChallenges: [],
    opportunities: [],
    decision: 'revision-required',
    reasonCodes: ['not-independently-reviewed'],
    stopReason: 'revision-required:not-independently-reviewed',
    satisfied: false,
  };
}

export function applyReadinessPolicy(state: ConvergenceState, input: ReadinessPolicyInput): void {
  const preserveRiskProfile =
    state.readinessContractDigest === input.contractDigest && state.riskDomains.length > 0;
  state.readinessContractDigest = input.contractDigest;
  state.judgeAllowed = input.judgeAllowed;
  state.exhaustiveApplicableDomains = input.exhaustiveApplicableDomains;
  state.unresolvedMaterialQuestionIds = unique(input.unresolvedMaterialQuestionIds);
  state.riskDomains = input.riskDomains.map((assessment) => {
    const existing = preserveRiskProfile
      ? state.riskDomains.find((candidate) => candidate.domain === assessment.domain)
      : undefined;
    return existing === undefined
      ? {
          domain: assessment.domain,
          applicability: assessment.applicability,
          risk: assessment.risk,
          rationale: assessment.rationale,
          evidenceRefs: [...assessment.evidenceRefs],
          complete: false,
          unavailableEvidence: [],
        }
      : {
          ...existing,
          applicability: mergedApplicability(assessment.applicability, existing.applicability),
          risk: existing.risk === 'high' ? 'high' : assessment.risk,
        };
  });
  state.declaredScopeVerified = true;
  state.exhaustedLimits = state.exhaustedLimits.filter(
    (limit) => limit !== 'authoritative-scope' && limit !== 'assurance-appetite',
  );
  if (requiresReadinessJudge(state) && !state.judgeAllowed) {
    state.exhaustedLimits.push('assurance-appetite');
  }
  classifyTerminal(state);
}

export function applicableRiskDomains(state: ConvergenceState): RiskDomain[] {
  return state.riskDomains
    .filter((assessment) => assessment.applicability === 'applicable')
    .map((assessment) => assessment.domain);
}

export function highRiskDomains(state: ConvergenceState): RiskDomain[] {
  return state.riskDomains
    .filter((assessment) => assessment.applicability === 'applicable' && assessment.risk === 'high')
    .map((assessment) => assessment.domain);
}

export function requiresReadinessJudge(state: ConvergenceState): boolean {
  return highRiskDomains(state).length > 0;
}

export function requiresSystemCoverage(state: ConvergenceState): boolean {
  return applicableRiskDomains(state).includes('cross-repository-delivery');
}

function asString(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function assessmentDisposition(value: JsonValue | undefined): OccurrenceDisposition {
  return value === 'satisfied' || value === 'violated' || value === 'not-applicable'
    ? value
    : 'unresolved';
}

const REQUIRED_CRITIC_CONTEXT = [
  'original-scope',
  'authoritative-system-facts',
  'operator-decisions',
  'material-findings',
  'active-invariants',
  'quality-and-limits',
] as const;

function riskApplicability(value: JsonValue | undefined): RiskApplicability | undefined {
  return value === 'applicable' || value === 'not-applicable' || value === 'unknown'
    ? value
    : undefined;
}

function riskLevel(value: JsonValue | undefined): RiskLevel | undefined {
  return value === 'standard' || value === 'high' ? value : undefined;
}

function mergedApplicability(
  current: RiskApplicability,
  next: RiskApplicability | undefined,
): RiskApplicability {
  if (next === undefined || current === 'applicable') {
    return current;
  }
  if (next === 'applicable') {
    return 'applicable';
  }
  return next;
}

function recordRiskAssessment(
  state: ConvergenceState,
  object: JsonObject,
  planVersion: number,
  review: JsonObject,
  budgetMetadataValid: boolean,
): void {
  const assessments = Array.isArray(object.domain_assessments)
    ? object.domain_assessments.filter(isJsonObject)
    : [];
  for (const domain of state.riskDomains) {
    const assessment = assessments.find((candidate) => candidate.domain === domain.domain);
    if (assessment === undefined) {
      domain.complete = false;
      domain.unavailableEvidence = [];
      delete domain.lastAssessedPlanVersion;
      continue;
    }
    domain.applicability = mergedApplicability(
      domain.applicability,
      riskApplicability(assessment.applicability),
    );
    if (domain.risk !== 'high' && riskLevel(assessment.risk) === 'high') {
      domain.risk = 'high';
    }
    const rationale = asString(assessment.rationale).trim();
    if (rationale !== '') {
      domain.rationale = rationale;
    }
    domain.evidenceRefs = Array.isArray(assessment.evidence_refs) ? assessment.evidence_refs : [];
    domain.unavailableEvidence = Array.isArray(assessment.unavailable_evidence)
      ? assessment.unavailable_evidence.filter(
          (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
        )
      : [];
    domain.complete = assessment.complete === true && domain.unavailableEvidence.length === 0;
    domain.lastAssessedPlanVersion = planVersion;
  }

  const applicable = state.riskDomains.filter(
    (assessment) => assessment.applicability === 'applicable',
  );
  state.scanComplete =
    review.scan_complete === true &&
    budgetMetadataValid &&
    !state.issueBudget.exhausted &&
    applicable.every(
      (assessment) => assessment.complete && assessment.lastAssessedPlanVersion === planVersion,
    );
  state.declaredScopeVerified = true;

  const challenges = Array.isArray(object.boundary_challenges)
    ? object.boundary_challenges.filter(isJsonObject)
    : [];
  for (const challenge of challenges) {
    const id = asString(challenge.id).trim();
    const kind = challenge.kind;
    if (
      id === '' ||
      !(
        kind === 'scope-expansion' ||
        kind === 'out-of-scope-removal' ||
        kind === 'assurance-appetite'
      )
    ) {
      continue;
    }
    const record: BoundaryChallengeRecord = {
      id,
      kind,
      claim: asString(challenge.claim).trim(),
      rationale: asString(challenge.rationale).trim(),
      evidenceRefs: Array.isArray(challenge.evidence_refs) ? challenge.evidence_refs : [],
      planVersion,
    };
    state.boundaryChallenges = [
      ...state.boundaryChallenges.filter((entry) => entry.id !== record.id),
      record,
    ];
  }

  const opportunities = Array.isArray(object.opportunities)
    ? object.opportunities.filter(isJsonObject)
    : [];
  for (const opportunity of opportunities) {
    const claim = asString(opportunity.claim).trim();
    const evidence = asString(opportunity.evidence).trim();
    const suggestedImprovement = asString(opportunity.suggested_improvement).trim();
    if (claim === '' || suggestedImprovement === '') {
      continue;
    }
    const supplied = asString(opportunity.fingerprint).trim();
    const fingerprint =
      supplied === ''
        ? stableTupleId('opportunity', [claim, evidence, suggestedImprovement])
        : supplied;
    const existing = state.opportunities.find((entry) => entry.fingerprint === fingerprint);
    if (existing !== undefined) {
      existing.lastSeenPlanVersion = planVersion;
      continue;
    }
    state.opportunities.push({
      fingerprint,
      claim,
      evidence,
      suggestedImprovement,
      evidenceRefs: Array.isArray(opportunity.evidence_refs) ? opportunity.evidence_refs : [],
      firstSeenPlanVersion: planVersion,
      lastSeenPlanVersion: planVersion,
    });
  }
}

export function recordCritique(
  state: ConvergenceState,
  critique: JsonValue,
  planVersion: number,
  evidenceContext?: EvidenceTargetContext,
): void {
  const object = isJsonObject(critique) ? critique : {};
  state.unresolvedCoverage = state.unresolvedCoverage.filter(
    (id) =>
      !id.startsWith('critic-unresolved-') &&
      !/^plan\.v[0-9]+:(scan-incomplete|exhaustive-scan-incomplete|not-independently-reviewed|system-check|judge|authoritative-digest-changed|plan-digest-(?:changed|unavailable)|legacy-state-bootstrap|readiness-contract-proof-unbound|issue-budget-metadata|scope-coverage-incomplete|context-unconsidered:.+)$/.test(
        id,
      ),
  );
  const issues = Array.isArray(object.issues) ? object.issues.filter(isJsonObject) : [];
  const review = isJsonObject(object.review) ? object.review : {};
  state.planVersion = planVersion;
  state.lastCritiquedPlanVersion = planVersion;
  delete state.judgeApprovedPlanVersion;
  delete state.judgeEvaluatedPlanVersion;
  delete state.judgeReady;
  state.currentActionableIssues = issues
    .filter((issue) => issue.severity === 'blocker' || issue.severity === 'major')
    .filter(
      (issue) =>
        evidenceContext === undefined || !critiqueDuplicateIsValid(issue, evidenceContext.work),
    )
    .map((issue) => `v${planVersion}.${asString(issue.id)}`);
  state.issueBudget.used = issues.length;
  const budget = isJsonObject(review.issue_budget) ? review.issue_budget : {};
  const budgetMetadataValid =
    budget.limit === state.issueBudget.limit &&
    budget.used === issues.length &&
    issues.length <= state.issueBudget.limit;
  state.issueBudget.exhausted =
    budget.exhausted === true || issues.length > state.issueBudget.limit;
  const considered = new Set(
    Array.isArray(review.considered_context)
      ? review.considered_context.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
  const missingContext = REQUIRED_CRITIC_CONTEXT.filter((category) => !considered.has(category));
  const scopeCoverage = Array.isArray(review.scope_coverage)
    ? review.scope_coverage.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const scopeCoverageComplete =
    state.scopeSource === 'prompt'
      ? scopeCoverage.includes('declared-scope') || scopeCoverage.includes('original-scope')
      : scopeCoverage.includes('direct-plan-scope') || scopeCoverage.includes('declared-scope');
  if (state.readinessContractDigest !== undefined) {
    recordRiskAssessment(state, object, planVersion, review, budgetMetadataValid);
    state.scanComplete = state.scanComplete && missingContext.length === 0 && scopeCoverageComplete;
    state.declaredScopeVerified = scopeCoverageComplete;
    state.exhaustedLimits = state.exhaustedLimits.filter(
      (limit) => limit !== 'authoritative-scope',
    );
    state.unresolvedCoverage = state.unresolvedCoverage.filter(
      (id) => id !== 'direct-plan:declared-scope-unproved',
    );
  } else {
    state.scanComplete =
      review.scan_complete === true &&
      budgetMetadataValid &&
      !state.issueBudget.exhausted &&
      missingContext.length === 0 &&
      scopeCoverageComplete;
    state.declaredScopeVerified =
      state.scopeSource === 'prompt' ||
      scopeCoverage.some((entry) => entry === 'declared-scope' || entry === 'direct-plan-scope');
    if (state.declaredScopeVerified) {
      state.exhaustedLimits = state.exhaustedLimits.filter(
        (limit) => limit !== 'authoritative-scope',
      );
      state.unresolvedCoverage = state.unresolvedCoverage.filter(
        (id) => id !== 'direct-plan:declared-scope-unproved',
      );
    }
    if (!state.scanComplete) {
      state.unresolvedCoverage.push(`plan.v${planVersion}:scan-incomplete`);
    }
  }
  if (!budgetMetadataValid) {
    state.unresolvedCoverage.push(`plan.v${planVersion}:issue-budget-metadata`);
  }
  if (!scopeCoverageComplete) {
    state.unresolvedCoverage.push(`plan.v${planVersion}:scope-coverage-incomplete`);
  }
  state.unresolvedCoverage.push(
    ...missingContext.map((category) => `plan.v${planVersion}:context-unconsidered:${category}`),
  );
  if (state.issueBudget.exhausted) {
    state.exhaustedLimits.push('issue-budget');
  } else {
    state.exhaustedLimits = state.exhaustedLimits.filter((limit) => limit !== 'issue-budget');
  }

  const assessments = Array.isArray(review.invariant_assessments)
    ? review.invariant_assessments.filter(isJsonObject)
    : [];
  for (const invariant of state.invariants) {
    if (invariant.status !== 'active') {
      continue;
    }
    const assessment = assessments.find((candidate) => candidate.invariant_id === invariant.id);
    const occurrences =
      assessment !== undefined && Array.isArray(assessment.occurrences)
        ? assessment.occurrences.filter(isJsonObject)
        : [];
    for (const occurrence of invariant.occurrences) {
      const result = occurrences.find((candidate) => candidate.occurrence_id === occurrence.id);
      occurrence.disposition = assessmentDisposition(result?.disposition);
      occurrence.evidenceRefs =
        result !== undefined && Array.isArray(result.evidence_refs) ? result.evidence_refs : [];
    }
    invariant.lastReviewedPlanVersion = planVersion;
    const complete = assessment?.complete === true;
    invariant.status =
      complete &&
      invariant.occurrences.every(
        (occurrence) =>
          occurrence.disposition === 'satisfied' ||
          (occurrence.disposition === 'not-applicable' &&
            evidenceContext !== undefined &&
            evidenceReferencesGrounded(
              occurrence.evidenceRefs as JsonValue,
              evidenceContext,
              planVersion,
            )),
      )
        ? 'resolved'
        : 'active';
    if (invariant.status === 'active') {
      state.unresolvedCoverage.push(invariant.id);
    }
  }
  if (Array.isArray(review.unresolved_coverage)) {
    state.unresolvedCoverage.push(
      ...review.unresolved_coverage
        .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
        .map((value) => stableTupleId('critic-unresolved', [planVersion, value])),
    );
  }
  state.unresolvedCoverage = unique(state.unresolvedCoverage);
  state.exhaustedLimits = unique(state.exhaustedLimits);
}

function systemicDispositions(update: JsonObject): JsonObject[] {
  return Array.isArray(update.systemic_dispositions)
    ? update.systemic_dispositions.filter(isJsonObject)
    : [];
}

export function recordCreatorUpdate(
  state: ConvergenceState,
  critique: JsonValue,
  update: JsonValue,
  fromPlanVersion: number,
  evidenceContext?: EvidenceTargetContext,
): void {
  const critiqueObject = isJsonObject(critique) ? critique : {};
  const updateObject = isJsonObject(update) ? update : {};
  const critiqueIssues = Array.isArray(critiqueObject.issues)
    ? critiqueObject.issues.filter(isJsonObject)
    : [];
  const verdicts = Array.isArray(updateObject.issues)
    ? updateObject.issues.filter(isJsonObject)
    : [];
  const dispositions = systemicDispositions(updateObject);
  for (const issue of critiqueIssues) {
    const issueId = asString(issue.id);
    if (issueId !== '' && !verdicts.some((verdict) => verdict.id === issueId)) {
      state.unresolvedCoverage.push(`v${fromPlanVersion}.${issueId}:creator-verdict`);
    }
  }
  for (const verdict of verdicts) {
    if (!(verdict.verdict === 'accept' || verdict.verdict === 'downgrade')) {
      continue;
    }
    const issueId = asString(verdict.id);
    const issueRef = `v${fromPlanVersion}.${issueId}`;
    const issue = critiqueIssues.find((candidate) => candidate.id === issueId);
    const originalSeverity = issue?.severity;
    const materialSeverity =
      originalSeverity === 'blocker' || originalSeverity === 'major'
        ? originalSeverity
        : verdict.final_severity === 'blocker' || verdict.final_severity === 'major'
          ? verdict.final_severity
          : undefined;
    if (materialSeverity === undefined) {
      continue;
    }
    const disposition = dispositions.find((candidate) => candidate.issue_id === issueId);
    const scope =
      disposition?.scope === 'local' || disposition?.scope === 'cross-cutting'
        ? disposition.scope
        : 'unresolved';
    const findingId = `I-v${fromPlanVersion}-${issueId}`;
    const evidenceRefs =
      disposition !== undefined && Array.isArray(disposition.evidence_refs)
        ? disposition.evidence_refs
        : [];
    const finding: FindingRecord = {
      id: findingId,
      issueRef,
      introducedPlanVersion: fromPlanVersion + 1,
      severity: materialSeverity,
      claim: asString(issue?.claim),
      disposition: {
        scope,
        rationale: asString(disposition?.rationale).trim(),
        evidenceRefs,
        ...(typeof disposition?.superseded_by === 'string'
          ? { supersededBy: disposition.superseded_by }
          : {}),
      },
    };
    state.findings = [...state.findings.filter((entry) => entry.id !== findingId), finding];
    if (
      !Array.isArray(updateObject.applied) ||
      !updateObject.applied.some((applied) => applied === issueId)
    ) {
      state.unresolvedCoverage.push(`${findingId}:not-applied`);
    }
    if (
      finding.disposition.supersededBy !== undefined &&
      !state.interventionIds.includes(finding.disposition.supersededBy)
    ) {
      state.unresolvedCoverage.push(`${findingId}:invalid-operator-supersession`);
      continue;
    }
    const operatorSupersessionValid =
      finding.disposition.supersededBy !== undefined &&
      state.interventionIds.includes(finding.disposition.supersededBy);
    const localEvidenceGrounded =
      evidenceContext !== undefined &&
      evidenceReferencesGrounded(evidenceRefs, evidenceContext, fromPlanVersion + 1);
    if (
      scope === 'unresolved' ||
      finding.disposition.rationale === '' ||
      (scope === 'local' && !operatorSupersessionValid && !localEvidenceGrounded)
    ) {
      state.unresolvedCoverage.push(`${findingId}:systemic-disposition`);
      continue;
    }
    if (scope !== 'cross-cutting') {
      continue;
    }
    const proposed = isJsonObject(disposition?.invariant) ? disposition.invariant : {};
    const proposedOccurrences = Array.isArray(proposed.occurrences)
      ? proposed.occurrences.filter(isJsonObject)
      : [];
    const statement = asString(proposed.statement).trim();
    const occurrenceTuples = proposedOccurrences.map((occurrence) => ({
      dimension: asString(occurrence.dimension).trim(),
      subject: asString(occurrence.subject).trim(),
    }));
    const tupleKeys = occurrenceTuples.map(({ dimension, subject }) =>
      JSON.stringify([dimension, subject]),
    );
    if (
      statement === '' ||
      occurrenceTuples.length === 0 ||
      occurrenceTuples.some(({ dimension, subject }) => dimension === '' || subject === '') ||
      new Set(tupleKeys).size !== tupleKeys.length
    ) {
      state.unresolvedCoverage.push(`${findingId}:occurrence-matrix`);
      continue;
    }
    const invariant: InvariantRecord = {
      id: findingId,
      sourceFinding: findingId,
      statement,
      status: 'active',
      occurrences: occurrenceTuples.map(({ dimension, subject }) => {
        return {
          id: stableTupleId('O', [findingId, dimension, subject]),
          dimension,
          subject,
          disposition: 'unresolved',
          evidenceRefs: [],
        };
      }),
    };
    state.invariants = [
      ...state.invariants.filter((entry) => entry.id !== invariant.id),
      invariant,
    ];
  }
  state.planVersion = fromPlanVersion + 1;
  delete state.planSha256;
  delete state.canonicalPlanSha256;
  delete state.lastCritiquedPlanVersion;
  state.scanComplete = false;
  state.systemCheckPassed = false;
  state.systemMismatchIds = [];
  state.requiredEvidenceUnavailable = [];
  delete state.judgeApprovedPlanVersion;
  delete state.judgeEvaluatedPlanVersion;
  delete state.judgeReady;
  state.currentActionableIssues = [];
  for (const domain of state.riskDomains) {
    domain.complete = false;
    domain.unavailableEvidence = [];
    delete domain.lastAssessedPlanVersion;
  }
  for (const invariant of state.invariants) {
    invariant.status = 'active';
    delete invariant.lastReviewedPlanVersion;
    for (const occurrence of invariant.occurrences) {
      occurrence.disposition = 'unresolved';
      occurrence.evidenceRefs = [];
    }
  }
  state.unresolvedCoverage = unique([
    ...state.unresolvedCoverage,
    ...state.invariants.map((invariant) => invariant.id),
  ]);
}

function classifyLegacyTerminal(state: ConvergenceState, requiresJudge: boolean): ConvergenceState {
  const unresolved = new Set(state.unresolvedCoverage);
  for (const id of unresolved) {
    if (id.startsWith('context-omission-')) {
      unresolved.delete(id);
    }
  }
  for (const invariant of state.invariants) {
    if (
      invariant.status !== 'resolved' ||
      invariant.lastReviewedPlanVersion !== state.planVersion
    ) {
      unresolved.add(invariant.id);
    } else {
      unresolved.delete(invariant.id);
    }
  }
  if (state.lastCritiquedPlanVersion !== state.planVersion) {
    unresolved.add(`plan.v${state.planVersion}:not-independently-reviewed`);
  } else {
    unresolved.delete(`plan.v${state.planVersion}:not-independently-reviewed`);
  }
  if (!state.scanComplete) {
    unresolved.add(`plan.v${state.planVersion}:scan-incomplete`);
  }
  if (state.requiresExhaustiveScan && !state.scanComplete) {
    unresolved.add(`plan.v${state.planVersion}:exhaustive-scan-incomplete`);
  } else {
    unresolved.delete(`plan.v${state.planVersion}:exhaustive-scan-incomplete`);
  }
  if (state.requiresExhaustiveScan) {
    for (const delivery of state.contextDeliveries) {
      for (const category of delivery.omittedCategories) {
        unresolved.add(
          stableTupleId('context-omission', [
            delivery.role,
            delivery.stage,
            delivery.planVersion,
            category,
          ]),
        );
      }
    }
  }
  if (!state.systemCheckPassed) {
    unresolved.add(`plan.v${state.planVersion}:system-check`);
  } else {
    unresolved.delete(`plan.v${state.planVersion}:system-check`);
  }
  if (!state.declaredScopeVerified) {
    unresolved.add('direct-plan:declared-scope-unproved');
    state.exhaustedLimits = unique([...state.exhaustedLimits, 'authoritative-scope']);
  }
  if (requiresJudge && state.judgeApprovedPlanVersion !== state.planVersion) {
    unresolved.add(`plan.v${state.planVersion}:judge`);
  }
  state.unresolvedCoverage = [...unresolved].sort();
  state.exhaustedLimits = unique(state.exhaustedLimits);
  state.satisfied =
    state.currentActionableIssues.length === 0 &&
    state.unresolvedCoverage.length === 0 &&
    state.exhaustedLimits.length === 0;
  state.stopReason = state.satisfied
    ? 'proof-satisfied'
    : state.exhaustedLimits.length > 0
      ? `limit-exhausted:${state.exhaustedLimits.join(',')}`
      : `unresolved-coverage:${state.unresolvedCoverage.join(',')}`;
  state.decision = state.satisfied
    ? 'ready'
    : state.exhaustedLimits.length > 0
      ? 'limits-exhausted'
      : state.currentActionableIssues.length > 0
        ? 'revision-required'
        : 'unable-to-decide';
  state.reasonCodes = state.satisfied
    ? []
    : state.exhaustedLimits.length > 0
      ? [...state.exhaustedLimits]
      : state.currentActionableIssues.length > 0
        ? ['material-issues']
        : ['legacy-proof-incomplete'];
  return state;
}

function boundedUnresolvedBase(state: ConvergenceState): Set<string> {
  return new Set(
    state.unresolvedCoverage.filter(
      (id) =>
        !/^plan\.v[0-9]+:(?:scan-incomplete|exhaustive-scan-incomplete|not-independently-reviewed|system-check|judge|applicable-domain:.+|required-evidence:.+)$/.test(
          id,
        ) &&
        !id.startsWith('boundary-challenge:') &&
        !id.startsWith('material-question:') &&
        !id.startsWith('risk-applicability:'),
    ),
  );
}

function setBoundedDecision(
  state: ConvergenceState,
  decision: ReadinessDecision,
  reasonCodes: readonly string[],
  unresolved: Set<string>,
): ConvergenceState {
  state.decision = decision;
  state.reasonCodes = unique(reasonCodes);
  state.satisfied = decision === 'ready';
  state.unresolvedCoverage = [...unresolved].sort();
  state.exhaustedLimits = unique(state.exhaustedLimits);
  state.stopReason =
    decision === 'ready'
      ? 'ready'
      : `${decision}:${state.reasonCodes.length > 0 ? state.reasonCodes.join(',') : 'unspecified'}`;
  return state;
}

function classifyBoundedTerminal(state: ConvergenceState): ConvergenceState {
  const unresolved = boundedUnresolvedBase(state);
  const primaryUnable: string[] = [];

  for (const challenge of state.boundaryChallenges) {
    unresolved.add(`boundary-challenge:${challenge.id}`);
  }
  if (state.boundaryChallenges.length > 0) {
    primaryUnable.push('boundary-challenge');
  }

  for (const questionId of state.unresolvedMaterialQuestionIds) {
    unresolved.add(`material-question:${questionId}`);
  }
  if (state.unresolvedMaterialQuestionIds.length > 0) {
    primaryUnable.push('material-question-unresolved');
  }

  const unknownDomains = state.riskDomains.filter(
    (assessment) => assessment.applicability === 'unknown',
  );
  for (const assessment of unknownDomains) {
    unresolved.add(`risk-applicability:${assessment.domain}`);
  }
  if (unknownDomains.length > 0) {
    primaryUnable.push('risk-applicability-unresolved');
  }

  const assessmentEvidenceUnavailable = state.riskDomains.flatMap((assessment) =>
    assessment.applicability === 'applicable'
      ? assessment.unavailableEvidence.map((evidence) => `${assessment.domain}:${evidence}`)
      : [],
  );
  const evidenceUnavailable = unique([
    ...state.requiredEvidenceUnavailable,
    ...assessmentEvidenceUnavailable,
  ]);
  for (const evidence of evidenceUnavailable) {
    unresolved.add(`plan.v${state.planVersion}:required-evidence:${evidence}`);
  }
  if (evidenceUnavailable.length > 0) {
    primaryUnable.push('required-evidence-unavailable');
  }
  if (unresolved.has(CANONICAL_PROOF_HASH_MISMATCH)) {
    primaryUnable.push('canonical-plan-binding-mismatch');
  }
  if (unresolved.has(DELIVERED_PLAN_FRESH_REVIEW_REQUIRED)) {
    primaryUnable.push('fresh-review-required');
  }
  if (unresolved.has(FINAL_ARTIFACT_REVIEW_REQUIRED)) {
    primaryUnable.push('final-artifact-needs-review');
  }
  if (state.readinessContractDigest?.startsWith('legacy-derived:') === true) {
    primaryUnable.push('legacy-state-requires-review');
  }
  if (unresolved.has('final-judge:inconsistent-verdict')) {
    primaryUnable.push('judge-inconsistent-after-status-projection');
  }
  if (primaryUnable.length > 0) {
    return setBoundedDecision(state, 'unable-to-decide', primaryUnable, unresolved);
  }

  if (requiresReadinessJudge(state) && !state.judgeAllowed) {
    state.exhaustedLimits = unique([...state.exhaustedLimits, 'assurance-appetite']);
  }
  if (state.exhaustedLimits.length > 0) {
    return setBoundedDecision(state, 'limits-exhausted', state.exhaustedLimits, unresolved);
  }

  const revisionReasons: string[] = [];
  if (state.currentActionableIssues.length > 0) {
    revisionReasons.push('material-issues');
  }
  if (requiresSystemCoverage(state) && state.systemMismatchIds.length > 0) {
    revisionReasons.push('deterministic-check-failed');
    for (const mismatch of state.systemMismatchIds) {
      unresolved.add(mismatch);
    }
  }
  if (revisionReasons.length > 0) {
    return setBoundedDecision(state, 'revision-required', revisionReasons, unresolved);
  }

  const gateReasons: string[] = [];
  if (state.lastCritiquedPlanVersion !== state.planVersion) {
    unresolved.add(`plan.v${state.planVersion}:not-independently-reviewed`);
    gateReasons.push('independent-review-required');
  }
  const applicableDomainAssessmentIncomplete = state.riskDomains.some(
    (assessment) =>
      assessment.applicability === 'applicable' &&
      (!assessment.complete || assessment.lastAssessedPlanVersion !== state.planVersion),
  );
  if (!state.scanComplete || applicableDomainAssessmentIncomplete) {
    unresolved.add(`plan.v${state.planVersion}:scan-incomplete`);
    gateReasons.push(
      state.exhaustiveApplicableDomains
        ? 'exhaustive-applicable-scan-incomplete'
        : 'applicable-domain-scan-incomplete',
    );
  }
  if (requiresSystemCoverage(state) && !state.systemCheckPassed) {
    unresolved.add(`plan.v${state.planVersion}:system-check`);
    gateReasons.push('deterministic-check-incomplete');
  }
  const activeInvariants = state.invariants.filter(
    (invariant) =>
      invariant.status !== 'resolved' || invariant.lastReviewedPlanVersion !== state.planVersion,
  );
  if (highRiskDomains(state).length > 0 && activeInvariants.length > 0) {
    for (const invariant of activeInvariants) {
      unresolved.add(invariant.id);
    }
    gateReasons.push('cross-cutting-invariant-coverage-incomplete');
  }
  if (requiresReadinessJudge(state)) {
    if (state.judgeEvaluatedPlanVersion !== state.planVersion) {
      unresolved.add(`plan.v${state.planVersion}:judge`);
      gateReasons.push('judge-unavailable');
    } else if (state.judgeReady !== true || state.judgeApprovedPlanVersion !== state.planVersion) {
      unresolved.add(`plan.v${state.planVersion}:judge`);
      gateReasons.push('judge-not-ready');
    }
  }
  if ([...unresolved].some((id) => id.startsWith('critic-unresolved-'))) {
    gateReasons.push('critic-coverage-unresolved');
  }
  if ([...unresolved].some((id) => id.endsWith(':scope-coverage-incomplete'))) {
    gateReasons.push('critic-scope-coverage-incomplete');
  }
  if ([...unresolved].some((id) => id.includes(':context-unconsidered:'))) {
    gateReasons.push('critic-context-incomplete');
  }
  if (
    [...unresolved].some(
      (id) =>
        /^v[0-9]+\.[^:]+:creator-verdict$/.test(id) ||
        /^I-v[0-9]+-[^:]+:(?:not-applied|invalid-operator-supersession|systemic-disposition|occurrence-matrix)$/.test(
          id,
        ),
    )
  ) {
    gateReasons.push('material-revision-proof-incomplete');
  }
  if (gateReasons.length > 0) {
    return setBoundedDecision(state, 'unable-to-decide', gateReasons, unresolved);
  }
  return setBoundedDecision(state, 'ready', [], unresolved);
}

export function classifyTerminal(
  state: ConvergenceState,
  requiresJudge = requiresReadinessJudge(state),
): ConvergenceState {
  return state.readinessContractDigest === undefined
    ? classifyLegacyTerminal(state, requiresJudge)
    : classifyBoundedTerminal(state);
}

export function addConvergenceLimit(
  state: ConvergenceState,
  limit: ConvergenceLimit,
  unresolvedId: string,
): void {
  state.exhaustedLimits = unique([...state.exhaustedLimits, limit]);
  state.unresolvedCoverage = unique([...state.unresolvedCoverage, unresolvedId]);
}

export function recordSystemCheck(state: ConvergenceState, check: ConvergenceCheckResult): void {
  const previous = new Set([...state.systemMismatchIds, ...state.requiredEvidenceUnavailable]);
  state.unresolvedCoverage = state.unresolvedCoverage.filter((id) => !previous.has(id));
  state.systemMismatchIds = unique(check.mismatches);
  state.requiredEvidenceUnavailable = unique(check.requiredEvidenceUnavailable ?? []);
  state.systemCheckPassed = check.passed && state.requiredEvidenceUnavailable.length === 0;
  if (!state.systemCheckPassed) {
    state.unresolvedCoverage = unique([
      ...state.unresolvedCoverage,
      ...state.systemMismatchIds,
      ...state.requiredEvidenceUnavailable,
    ]);
  }
}

function writeOpportunities(work: string, state: ConvergenceState): void {
  const target = path.join(work, 'opportunities.json');
  const tmp = `${target}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ schemaVersion: 1, opportunities: state.opportunities }, null, 2)}\n`,
  );
  renameSync(tmp, target);
}

export function writeConvergenceState(
  work: string,
  state: ConvergenceState,
  name?: string,
): string {
  const target = path.join(work, name ?? `convergence.v${state.planVersion}.json`);
  const boundPlan =
    name === 'convergence.final.json'
      ? path.join(work, 'plan.final.md')
      : path.join(work, `plan.v${state.planVersion}.md`);
  if (existsSync(boundPlan)) {
    if (name === 'convergence.final.json') {
      const canonicalPlanSha256 = fileSha256(boundPlan);
      if (
        state.canonicalPlanSha256 !== undefined &&
        state.canonicalPlanSha256 !== canonicalPlanSha256
      ) {
        state.unresolvedCoverage = unique([
          ...state.unresolvedCoverage,
          CANONICAL_PROOF_HASH_MISMATCH,
        ]);
        classifyTerminal(state);
      }
      state.canonicalPlanSha256 = canonicalPlanSha256;
    } else {
      state.planSha256 = fileSha256(boundPlan);
    }
  } else if (name === 'convergence.final.json') {
    delete state.canonicalPlanSha256;
  } else {
    delete state.planSha256;
  }
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, target);
  writeOpportunities(work, state);
  return target;
}

function stringArray(value: JsonValue | undefined): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function validFinding(value: JsonValue): boolean {
  if (!isJsonObject(value) || !isJsonObject(value.disposition)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.issueRef === 'string' &&
    Number.isInteger(value.introducedPlanVersion) &&
    (value.severity === 'blocker' || value.severity === 'major') &&
    typeof value.claim === 'string' &&
    (value.disposition.scope === 'local' ||
      value.disposition.scope === 'cross-cutting' ||
      value.disposition.scope === 'unresolved') &&
    typeof value.disposition.rationale === 'string' &&
    (value.disposition.supersededBy === undefined ||
      typeof value.disposition.supersededBy === 'string')
  );
}

function validInvariant(value: JsonValue): boolean {
  if (!isJsonObject(value) || !Array.isArray(value.occurrences)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.sourceFinding === 'string' &&
    typeof value.statement === 'string' &&
    (value.status === 'active' || value.status === 'resolved') &&
    (value.lastReviewedPlanVersion === undefined ||
      Number.isInteger(value.lastReviewedPlanVersion)) &&
    value.occurrences.every(
      (occurrence) =>
        isJsonObject(occurrence) &&
        typeof occurrence.id === 'string' &&
        typeof occurrence.dimension === 'string' &&
        typeof occurrence.subject === 'string' &&
        (occurrence.disposition === 'satisfied' ||
          occurrence.disposition === 'violated' ||
          occurrence.disposition === 'not-applicable' ||
          occurrence.disposition === 'unresolved') &&
        Array.isArray(occurrence.evidenceRefs),
    )
  );
}

function validContextDelivery(value: JsonValue): boolean {
  return (
    isJsonObject(value) &&
    typeof value.role === 'string' &&
    typeof value.stage === 'string' &&
    Number.isInteger(value.planVersion) &&
    Number.isInteger(value.mandatoryBytes) &&
    Number.isInteger(value.optionalBytes) &&
    Number.isInteger(value.totalInputBytes) &&
    (value.inputTokenLimit === null || Number.isInteger(value.inputTokenLimit)) &&
    (value.inputLimitSource === 'operator' ||
      value.inputLimitSource === 'model-registry' ||
      value.inputLimitSource === 'unknown') &&
    Array.isArray(value.reductions) &&
    stringArray(value.omittedCategories)
  );
}

function validRiskDomainRecord(value: JsonValue): boolean {
  return (
    isJsonObject(value) &&
    RISK_DOMAINS.includes(value.domain as RiskDomain) &&
    (value.applicability === 'applicable' ||
      value.applicability === 'not-applicable' ||
      value.applicability === 'unknown') &&
    (value.risk === 'standard' || value.risk === 'high') &&
    typeof value.rationale === 'string' &&
    Array.isArray(value.evidenceRefs) &&
    typeof value.complete === 'boolean' &&
    stringArray(value.unavailableEvidence) &&
    (value.lastAssessedPlanVersion === undefined || Number.isInteger(value.lastAssessedPlanVersion))
  );
}

function validBoundaryChallenge(value: JsonValue): boolean {
  return (
    isJsonObject(value) &&
    typeof value.id === 'string' &&
    (value.kind === 'scope-expansion' ||
      value.kind === 'out-of-scope-removal' ||
      value.kind === 'assurance-appetite') &&
    typeof value.claim === 'string' &&
    typeof value.rationale === 'string' &&
    Array.isArray(value.evidenceRefs) &&
    Number.isInteger(value.planVersion)
  );
}

function validOpportunity(value: JsonValue): boolean {
  return (
    isJsonObject(value) &&
    typeof value.fingerprint === 'string' &&
    typeof value.claim === 'string' &&
    typeof value.evidence === 'string' &&
    typeof value.suggestedImprovement === 'string' &&
    Array.isArray(value.evidenceRefs) &&
    Number.isInteger(value.firstSeenPlanVersion) &&
    Number.isInteger(value.lastSeenPlanVersion)
  );
}

export function readConvergenceState(file: string): ConvergenceState | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
    if (
      !isJsonObject(value) ||
      !(value.schemaVersion === 1 || value.schemaVersion === CONVERGENCE_SCHEMA_VERSION) ||
      !Number.isInteger(value.planVersion) ||
      Number(value.planVersion) < 0 ||
      !(
        value.quality === 'quick' ||
        value.quality === 'balanced' ||
        value.quality === 'thorough'
      ) ||
      !(
        value.promise === 'best-effort' ||
        value.promise === 'cumulative' ||
        value.promise === 'exhaustive'
      ) ||
      !(
        value.requiredProofLevel === 'best-effort' ||
        value.requiredProofLevel === 'cumulative' ||
        value.requiredProofLevel === 'exhaustive'
      ) ||
      (value.requiresExhaustiveScan !== undefined &&
        typeof value.requiresExhaustiveScan !== 'boolean') ||
      !(
        value.scopeSource === 'prompt' ||
        value.scopeSource === 'direct-plan' ||
        value.scopeSource === 'unavailable'
      ) ||
      typeof value.originalRequestAvailable !== 'boolean' ||
      typeof value.sourceDigest !== 'string' ||
      (value.planSha256 !== undefined && typeof value.planSha256 !== 'string') ||
      (value.canonicalPlanSha256 !== undefined && typeof value.canonicalPlanSha256 !== 'string') ||
      typeof value.authoritativeDigest !== 'string' ||
      !stringArray(value.operatorDecisionIds) ||
      !stringArray(value.interventionIds) ||
      !Array.isArray(value.findings) ||
      !value.findings.every(validFinding) ||
      !Array.isArray(value.invariants) ||
      !value.invariants.every(validInvariant) ||
      !stringArray(value.relationshipIds) ||
      !Array.isArray(value.contextDeliveries) ||
      !value.contextDeliveries.every(validContextDelivery) ||
      !isJsonObject(value.issueBudget) ||
      !Number.isInteger(value.issueBudget.limit) ||
      !Number.isInteger(value.issueBudget.used) ||
      typeof value.issueBudget.exhausted !== 'boolean' ||
      !Number.isInteger(value.iterationLimit) ||
      !stringArray(value.exhaustedLimits) ||
      !value.exhaustedLimits.every((limit) =>
        [
          'issue-budget',
          'iteration-cap',
          'provider-context',
          'unknown-provider-context',
          'authoritative-scope',
          'assurance-appetite',
        ].includes(limit),
      ) ||
      !stringArray(value.unresolvedCoverage) ||
      (value.lastCritiquedPlanVersion !== undefined &&
        !Number.isInteger(value.lastCritiquedPlanVersion)) ||
      typeof value.scanComplete !== 'boolean' ||
      typeof value.declaredScopeVerified !== 'boolean' ||
      !stringArray(value.currentActionableIssues) ||
      typeof value.systemCheckPassed !== 'boolean' ||
      (value.systemMismatchIds !== undefined && !stringArray(value.systemMismatchIds)) ||
      (value.judgeApprovedPlanVersion !== undefined &&
        !Number.isInteger(value.judgeApprovedPlanVersion)) ||
      typeof value.stopReason !== 'string' ||
      typeof value.satisfied !== 'boolean'
    ) {
      return undefined;
    }
    if (value.schemaVersion === 1) {
      const migrated = {
        ...value,
        schemaVersion: CONVERGENCE_SCHEMA_VERSION,
        requiresExhaustiveScan:
          value.quality === 'thorough' || value.requiresExhaustiveScan === true,
        systemMismatchIds: value.systemMismatchIds ?? [],
        requiredEvidenceUnavailable: [],
        unresolvedMaterialQuestionIds: [],
        readinessContractDigest: `legacy-derived:${value.sourceDigest}`,
        judgeAllowed: value.quality !== 'quick',
        exhaustiveApplicableDomains: value.quality === 'thorough',
        riskDomains: RISK_DOMAINS.map((domain) => ({
          domain,
          applicability: 'unknown' as const,
          risk: 'standard' as const,
          rationale: 'Legacy convergence state requires a fresh applicability assessment.',
          evidenceRefs: [],
          complete: false,
          unavailableEvidence: [],
        })),
        boundaryChallenges: [],
        opportunities: [],
        decision: 'unable-to-decide' as const,
        reasonCodes: ['legacy-state-requires-review'],
        stopReason: 'unable-to-decide:legacy-state-requires-review',
        satisfied: false,
      } as unknown as ConvergenceState;
      return migrated;
    }
    if (
      !stringArray(value.requiredEvidenceUnavailable) ||
      !stringArray(value.unresolvedMaterialQuestionIds) ||
      (value.readinessContractDigest !== undefined &&
        typeof value.readinessContractDigest !== 'string') ||
      typeof value.judgeAllowed !== 'boolean' ||
      typeof value.exhaustiveApplicableDomains !== 'boolean' ||
      !Array.isArray(value.riskDomains) ||
      !value.riskDomains.every(validRiskDomainRecord) ||
      !Array.isArray(value.boundaryChallenges) ||
      !value.boundaryChallenges.every(validBoundaryChallenge) ||
      !Array.isArray(value.opportunities) ||
      !value.opportunities.every(validOpportunity) ||
      (value.judgeEvaluatedPlanVersion !== undefined &&
        !Number.isInteger(value.judgeEvaluatedPlanVersion)) ||
      (value.judgeReady !== undefined && typeof value.judgeReady !== 'boolean') ||
      !READINESS_DECISIONS.includes(value.decision as ReadinessDecision) ||
      !stringArray(value.reasonCodes)
    ) {
      return undefined;
    }
    return {
      ...value,
      requiresExhaustiveScan: value.quality === 'thorough' || value.requiresExhaustiveScan === true,
      systemMismatchIds: value.systemMismatchIds ?? [],
    } as unknown as ConvergenceState;
  } catch {
    return undefined;
  }
}

export function convergenceReport(work: string, state: ConvergenceState): ConvergenceReport {
  return {
    promise: state.promise,
    satisfied: state.satisfied,
    artifactPath: path.join(work, 'convergence.final.json'),
    exhaustedLimits: [...state.exhaustedLimits],
    unresolvedCoverage: [...state.unresolvedCoverage],
    decision: state.decision,
    reasonCodes: [...state.reasonCodes],
    applicableRiskDomains: applicableRiskDomains(state),
    highRiskDomains: highRiskDomains(state),
    opportunityCount: state.opportunities.length,
  };
}
