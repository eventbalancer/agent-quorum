import type { RiskApplicability, RiskDomain, RiskLevel } from '../types.js';
import { canonicalJsonSha256, sha256, stableTupleId } from './digest.js';
import { isJsonObject, type JsonObject, type JsonValue } from './json.js';
import { cloneJsonValue } from './json-clone.js';
import {
  evidenceReferencesGroundedAgainstCandidate,
  evidenceReferencesStructurallyValid,
  type CandidateEvidenceTargetContext,
} from './metrics.js';
import { RETAINED_CONTEXT_CATEGORIES, RISK_DOMAINS } from './readiness-contract.js';
import {
  createReadinessProofCatalog,
  type AdmittedCreatorUpdateInput,
  type AdmittedCritiqueInput,
  type AdmittedJudgeProofInput,
  type BoundaryChallengeRecord,
  type CreatorTransitionReceipt,
  type FindingRecord,
  type OccurrenceCoverageSnapshot,
  type OccurrenceCandidateKind,
  type OccurrenceEvaluationStage,
  type OccurrenceSource,
  type OccurrenceSourceBinding,
  type OpportunityRecord,
  type RawOccurrenceDisposition,
  type ReadinessInvariantRecord,
  type ReadinessProofCatalog,
  type ReadinessRiskDomainRecord,
} from './readiness-proof.js';

export type ReadinessAdmissionRole =
  | 'critic'
  | 'creator-update'
  | 'fix-reviewer'
  | 'intermediate-judge'
  | 'final-judge';

export type ReadinessAdmissionCode =
  | 'invalid-artifact'
  | 'invalid-value'
  | 'plan-version-mismatch'
  | 'catalog-mismatch'
  | 'binding-mismatch'
  | 'missing-identity'
  | 'duplicate-identity'
  | 'unknown-identity'
  | 'cross-invariant'
  | 'invalid-disposition'
  | 'ungrounded-evidence'
  | 'summary-mismatch'
  | 'operator-supersession-mismatch';

export class ReadinessAdmissionError extends Error {
  override name = 'ReadinessAdmissionError';

  constructor(
    readonly role: ReadinessAdmissionRole,
    readonly code: ReadinessAdmissionCode,
    readonly path: string,
    detail: string,
  ) {
    super(`${role} admission rejected at ${path}: ${detail}`);
  }
}

export type CriticScopeToken = 'original-scope' | 'declared-scope' | 'direct-plan-scope';
export type MaterialIssueSeverity = 'blocker' | 'major';
export type IssueSeverity = MaterialIssueSeverity | 'minor' | 'nit';
export type IssueCategory =
  | 'correctness'
  | 'scope'
  | 'risk'
  | 'testability'
  | 'clarity'
  | 'convention'
  | 'missing_context'
  | 'assumption';

export interface AdmittedMaterialIssue {
  readonly id: string;
  readonly issueRef: string;
  readonly severity: MaterialIssueSeverity;
  readonly category: IssueCategory;
  readonly claim: string;
  readonly evidence: string;
  readonly evidenceRefs: readonly JsonValue[];
  readonly suggestedFix: string;
}

export interface AdmitCritiqueInput {
  readonly value: JsonValue;
  readonly catalog: ReadinessProofCatalog;
  readonly binding: OccurrenceSourceBinding;
  readonly evidenceContext: CandidateEvidenceTargetContext;
  readonly expectedScopeToken: CriticScopeToken;
  readonly issueBudgetLimit: number;
  readonly currentRiskDomains: readonly ReadinessRiskDomainRecord[];
  readonly admittedPriorIssueRefs: readonly string[];
}

export interface AdmittedCritique extends AdmittedCritiqueInput {
  readonly summary: string;
  readonly materialIssues: readonly AdmittedMaterialIssue[];
}

export interface ExpectedCreatorIssue {
  readonly id: string;
  readonly severity: MaterialIssueSeverity;
  readonly claim: string;
  readonly evidence: string;
  readonly suggestedFix: string;
  readonly provenance: 'critic' | 'intermediate-judge';
}

export type CreatorIssueVerdictValue =
  | 'accept'
  | 'reject_hallucinated'
  | 'reject_out_of_scope'
  | 'reject_taste'
  | 'downgrade';

export interface AdmittedCreatorIssueVerdict {
  readonly id: string;
  readonly verdict: CreatorIssueVerdictValue;
  readonly verdictReason: string;
  readonly finalSeverity: IssueSeverity;
  readonly duplicateOf: null;
}

export interface AdmitCreatorUpdateInput {
  readonly value: JsonValue;
  readonly currentCatalog: ReadinessProofCatalog;
  readonly fromPlanVersion: number;
  readonly expectedPlanVersion: number;
  readonly expectedIssues: readonly ExpectedCreatorIssue[];
  readonly retainedFindings: readonly FindingRecord[];
  readonly retainedInvariants: readonly ReadinessInvariantRecord[];
  readonly evidenceContext: CandidateEvidenceTargetContext;
  readonly operatorInterventionIds: readonly string[];
  readonly admittedCriticIssueRefs: readonly string[];
  readonly admittedJudgeRevisionIssueIds: readonly string[];
}

export interface AdmittedCreatorUpdate extends AdmittedCreatorUpdateInput {
  readonly verdicts: readonly AdmittedCreatorIssueVerdict[];
  readonly appliedIssueIds: readonly string[];
  readonly transitionReceipt: CreatorTransitionReceipt;
}

export interface AdmittedFixReviewerConcern {
  readonly id: string;
  readonly severity: IssueSeverity;
  readonly claim: string;
  readonly evidence: string;
}

export interface AdmitFixReviewerInput {
  readonly value: JsonValue;
  readonly catalog: ReadinessProofCatalog;
  readonly binding: OccurrenceSourceBinding;
  readonly evidenceContext: CandidateEvidenceTargetContext;
  readonly requirementReason: string;
}

export interface AdmittedFixReviewer {
  readonly required: true;
  readonly reason: string;
  readonly expectedBinding: OccurrenceSourceBinding;
  readonly snapshot: OccurrenceCoverageSnapshot;
  readonly materialIssueIds: readonly string[];
  readonly approval: 'accept' | 'accept_with_concerns' | 'reject';
  readonly concerns: readonly AdmittedFixReviewerConcern[];
  readonly coverageComplete: true;
  readonly unresolvedOccurrenceIds: readonly string[];
  readonly violatedOccurrenceIds: readonly string[];
  readonly satisfied: boolean;
}

export interface AdmittedJudgeRevisionIssue {
  readonly severity: MaterialIssueSeverity;
  readonly category: IssueCategory;
  readonly claim: string;
  readonly evidence: string;
  readonly evidenceRefs: readonly JsonValue[];
  readonly suggestedFix: string;
}

export interface AdmitJudgeInput {
  readonly value: JsonValue;
  readonly stage: 'intermediate' | 'final';
  readonly catalog: ReadinessProofCatalog;
  readonly binding: OccurrenceSourceBinding;
  readonly evidenceContext: CandidateEvidenceTargetContext;
}

export interface AdmittedJudge extends AdmittedJudgeProofInput {
  readonly rationale: string;
  readonly coverageComplete: true;
  readonly unresolvedOccurrenceIds: readonly string[];
  readonly violatedOccurrenceIds: readonly string[];
  readonly satisfied: boolean;
  readonly revisionIssue?: AdmittedJudgeRevisionIssue;
}

const APPLICABILITIES = ['applicable', 'not-applicable', 'unknown'] as const;
const RISK_LEVELS = ['standard', 'high'] as const;
const CRITIC_SCOPE_TOKENS = ['original-scope', 'declared-scope', 'direct-plan-scope'] as const;
const RAW_DISPOSITIONS = ['satisfied', 'violated', 'not-applicable', 'unresolved'] as const;
const MATERIAL_SEVERITIES = ['blocker', 'major'] as const;
const ISSUE_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
const ISSUE_CATEGORIES = [
  'correctness',
  'scope',
  'risk',
  'testability',
  'clarity',
  'convention',
  'missing_context',
  'assumption',
] as const;
const CREATOR_VERDICTS = [
  'accept',
  'reject_hallucinated',
  'reject_out_of_scope',
  'reject_taste',
  'downgrade',
] as const;
const SOURCE_BINDINGS = {
  critic: [{ kind: 'versioned-plan', stage: 'review' }],
  'fix-reviewer': [
    { kind: 'fix-proposal', stage: 'fix-proposal-review' },
    { kind: 'fix-applied', stage: 'fix-applied-review' },
  ],
  'intermediate-judge': [{ kind: 'versioned-plan', stage: 'intermediate-readiness' }],
  'final-judge': [{ kind: 'canonical-plan', stage: 'final-readiness' }],
} as const satisfies Readonly<
  Record<
    OccurrenceSource,
    readonly {
      readonly kind: OccurrenceCandidateKind;
      readonly stage: OccurrenceEvaluationStage;
    }[]
  >
>;

function reject(
  role: ReadinessAdmissionRole,
  code: ReadinessAdmissionCode,
  path: string,
  detail: string,
): never {
  throw new ReadinessAdmissionError(role, code, path, detail);
}

function objectValue(
  role: ReadinessAdmissionRole,
  value: JsonValue | undefined,
  path: string,
): JsonObject {
  return isJsonObject(value) ? value : reject(role, 'invalid-artifact', path, 'must be an object');
}

function arrayValue(
  role: ReadinessAdmissionRole,
  value: JsonValue | undefined,
  path: string,
): JsonValue[] {
  return Array.isArray(value) ? value : reject(role, 'invalid-artifact', path, 'must be an array');
}

function stringValue(
  role: ReadinessAdmissionRole,
  value: JsonValue | undefined,
  path: string,
): string {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : reject(role, 'invalid-value', path, 'must be a non-blank string');
}

function booleanValue(
  role: ReadinessAdmissionRole,
  value: JsonValue | undefined,
  path: string,
): boolean {
  return typeof value === 'boolean'
    ? value
    : reject(role, 'invalid-value', path, 'must be a boolean');
}

function integerValue(
  role: ReadinessAdmissionRole,
  value: JsonValue | undefined,
  path: string,
): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : reject(role, 'invalid-value', path, 'must be a non-negative integer');
}

function copiedJsonArray(
  role: ReadinessAdmissionRole,
  value: JsonValue | undefined,
  path: string,
): JsonValue[] {
  return arrayValue(role, value, path).map(cloneJsonValue);
}

function candidateGroundedEvidenceRefs(
  role: ReadinessAdmissionRole,
  value: JsonValue | undefined,
  path: string,
  context: CandidateEvidenceTargetContext,
): JsonValue[] {
  const evidenceRefs = copiedJsonArray(role, value, path);
  if (!evidenceReferencesGroundedAgainstCandidate(evidenceRefs, context)) {
    reject(
      role,
      'ungrounded-evidence',
      path,
      'does not contain evidence grounded against the reviewed candidate',
    );
  }
  return evidenceRefs;
}

function uniqueStrings(
  role: ReadinessAdmissionRole,
  value: JsonValue | undefined,
  path: string,
): string[] {
  const result = arrayValue(role, value, path).map((entry, index) =>
    stringValue(role, entry, `${path}[${index}]`),
  );
  if (new Set(result).size !== result.length) {
    reject(role, 'duplicate-identity', path, 'must not contain duplicate entries');
  }
  return result;
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort((a, b) => a.localeCompare(b));
  const sortedRight = [...right].sort((a, b) => a.localeCompare(b));
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function exactIdentitySet<T extends string>(
  role: ReadinessAdmissionRole,
  actual: readonly T[],
  expected: readonly T[],
  path: string,
): T[] {
  if (new Set(actual).size !== actual.length) {
    reject(role, 'duplicate-identity', path, 'contains a duplicate identity');
  }
  const expectedSet = new Set(expected);
  const unknown = actual.find((identity) => !expectedSet.has(identity));
  if (unknown !== undefined) {
    reject(role, 'unknown-identity', path, `contains unknown identity ${unknown}`);
  }
  const actualSet = new Set(actual);
  const missing = expected.find((identity) => !actualSet.has(identity));
  if (missing !== undefined) {
    reject(role, 'missing-identity', path, `is missing identity ${missing}`);
  }
  return [...expected];
}

function assertCatalog(role: ReadinessAdmissionRole, catalog: ReadinessProofCatalog): void {
  let canonical: ReadinessProofCatalog;
  try {
    canonical = createReadinessProofCatalog({
      expectedPlanVersion: catalog.expectedPlanVersion,
      invariants: catalog.invariants,
      materialIssueIds: catalog.materialIssueIds,
    });
  } catch (error) {
    reject(
      role,
      'catalog-mismatch',
      'catalog',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    !sameOrderedStrings(catalog.riskDomainIds, RISK_DOMAINS) ||
    !sameOrderedStrings(catalog.retainedContextCategories, RETAINED_CONTEXT_CATEGORIES) ||
    canonicalJsonSha256(catalog.invariants) !== canonicalJsonSha256(canonical.invariants) ||
    !sameOrderedStrings(catalog.materialIssueIds, canonical.materialIssueIds) ||
    catalog.digest !== canonical.digest
  ) {
    reject(role, 'catalog-mismatch', 'catalog', 'does not match its canonical trusted identity');
  }
}

function copiedBinding(binding: OccurrenceSourceBinding): OccurrenceSourceBinding {
  return {
    candidate: { ...binding.candidate },
    lineage: { ...binding.lineage },
  };
}

function assertBinding(
  role: ReadinessAdmissionRole,
  source: OccurrenceSource,
  catalog: ReadinessProofCatalog,
  binding: OccurrenceSourceBinding,
  evidenceContext: CandidateEvidenceTargetContext,
): void {
  const allowed = SOURCE_BINDINGS[source].some(
    (candidate) =>
      candidate.kind === binding.candidate.kind &&
      candidate.stage === binding.lineage.evaluationStage,
  );
  if (
    !allowed ||
    binding.candidate.planVersion !== catalog.expectedPlanVersion ||
    evidenceContext.planVersion !== catalog.expectedPlanVersion ||
    binding.candidate.contentDigest !== sha256(evidenceContext.candidateContent) ||
    binding.lineage.lineageDigest.trim() === ''
  ) {
    reject(role, 'binding-mismatch', 'binding', 'does not match the source and trusted catalog');
  }
}

interface AdmittedOccurrences {
  readonly snapshot: OccurrenceCoverageSnapshot;
  readonly unresolvedOccurrenceIds: readonly string[];
  readonly violatedOccurrenceIds: readonly string[];
  readonly satisfied: boolean;
}

function occurrenceAssessments(
  role: ReadinessAdmissionRole,
  source: OccurrenceSource,
  value: JsonValue | undefined,
  catalog: ReadinessProofCatalog,
  binding: OccurrenceSourceBinding,
  evidenceContext: CandidateEvidenceTargetContext,
  requireCompleteField: boolean,
): AdmittedOccurrences {
  assertCatalog(role, catalog);
  assertBinding(role, source, catalog, binding, evidenceContext);
  const assessments = arrayValue(role, value, 'invariant_assessments');
  const expectedInvariants = new Map(
    catalog.invariants.map(
      (invariant) => [invariant.invariantId, invariant.occurrenceIds] as const,
    ),
  );
  const occurrenceOwners = new Map(
    catalog.invariants.flatMap((invariant) =>
      invariant.occurrenceIds.map((id) => [id, invariant.invariantId] as const),
    ),
  );
  const seenInvariants = new Set<string>();
  const seenOccurrences = new Set<string>();
  const occurrences: OccurrenceCoverageSnapshot['occurrences'][number][] = [];

  assessments.forEach((entry, invariantIndex) => {
    const path = `invariant_assessments[${invariantIndex}]`;
    const assessment = objectValue(role, entry, path);
    const invariantId = stringValue(role, assessment.invariant_id, `${path}.invariant_id`);
    if (seenInvariants.has(invariantId)) {
      reject(role, 'duplicate-identity', `${path}.invariant_id`, `duplicates ${invariantId}`);
    }
    const expectedOccurrenceIds = expectedInvariants.get(invariantId);
    if (expectedOccurrenceIds === undefined) {
      reject(role, 'unknown-identity', `${path}.invariant_id`, `unknown invariant ${invariantId}`);
    }
    seenInvariants.add(invariantId);
    const localSeen = new Set<string>();
    arrayValue(role, assessment.occurrences, `${path}.occurrences`).forEach(
      (rawOccurrence, occurrenceIndex) => {
        const occurrencePath = `${path}.occurrences[${occurrenceIndex}]`;
        const occurrence = objectValue(role, rawOccurrence, occurrencePath);
        const occurrenceId = stringValue(
          role,
          occurrence.occurrence_id,
          `${occurrencePath}.occurrence_id`,
        );
        const owner = occurrenceOwners.get(occurrenceId);
        if (owner === undefined) {
          reject(
            role,
            'unknown-identity',
            `${occurrencePath}.occurrence_id`,
            `unknown occurrence ${occurrenceId}`,
          );
        }
        if (owner !== invariantId) {
          reject(
            role,
            'cross-invariant',
            `${occurrencePath}.occurrence_id`,
            `${occurrenceId} belongs to ${owner}`,
          );
        }
        if (seenOccurrences.has(occurrenceId)) {
          reject(
            role,
            'duplicate-identity',
            `${occurrencePath}.occurrence_id`,
            `duplicates ${occurrenceId}`,
          );
        }
        localSeen.add(occurrenceId);
        seenOccurrences.add(occurrenceId);
        const disposition = occurrence.disposition;
        if (
          typeof disposition !== 'string' ||
          !(RAW_DISPOSITIONS as readonly string[]).includes(disposition)
        ) {
          reject(role, 'invalid-disposition', `${occurrencePath}.disposition`, 'is not supported');
        }
        const evidenceRefs = arrayValue(
          role,
          occurrence.evidence_refs,
          `${occurrencePath}.evidence_refs`,
        );
        if (evidenceRefs.length > 0 && !evidenceReferencesStructurallyValid(evidenceRefs)) {
          reject(
            role,
            'ungrounded-evidence',
            `${occurrencePath}.evidence_refs`,
            'is structurally invalid',
          );
        }
        const evidenceGrounded = evidenceReferencesGroundedAgainstCandidate(
          evidenceRefs,
          evidenceContext,
        );
        if (disposition !== 'unresolved' && !evidenceGrounded) {
          reject(
            role,
            'ungrounded-evidence',
            `${occurrencePath}.evidence_refs`,
            `${disposition} requires evidence grounded against the exact candidate`,
          );
        }
        const admittedDisposition = disposition as RawOccurrenceDisposition;
        occurrences.push(
          admittedDisposition === 'unresolved'
            ? { invariantId, occurrenceId, disposition: 'unresolved', evidenceGrounded }
            : {
                invariantId,
                occurrenceId,
                disposition: admittedDisposition,
                evidenceGrounded: true,
              },
        );
      },
    );
    const missingOccurrence = expectedOccurrenceIds.find((id) => !localSeen.has(id));
    if (missingOccurrence !== undefined) {
      reject(
        role,
        'missing-identity',
        `${path}.occurrences`,
        `is missing occurrence ${missingOccurrence}`,
      );
    }
    if (localSeen.size !== expectedOccurrenceIds.length) {
      reject(role, 'unknown-identity', `${path}.occurrences`, 'contains extra occurrences');
    }
    if (requireCompleteField && assessment.complete !== true) {
      reject(role, 'summary-mismatch', `${path}.complete`, 'must be true for exact coverage');
    }
  });

  const missingInvariant = catalog.invariants.find(
    (invariant) => !seenInvariants.has(invariant.invariantId),
  );
  if (missingInvariant !== undefined) {
    reject(
      role,
      'missing-identity',
      'invariant_assessments',
      `is missing invariant ${missingInvariant.invariantId}`,
    );
  }
  if (seenInvariants.size !== catalog.invariants.length) {
    reject(role, 'unknown-identity', 'invariant_assessments', 'contains extra invariants');
  }

  occurrences.sort(
    (left, right) =>
      left.occurrenceId.localeCompare(right.occurrenceId) ||
      left.invariantId.localeCompare(right.invariantId),
  );
  const unresolvedOccurrenceIds = occurrences
    .filter((entry) => entry.disposition === 'unresolved')
    .map((entry) => entry.occurrenceId);
  const violatedOccurrenceIds = occurrences
    .filter((entry) => entry.disposition === 'violated')
    .map((entry) => entry.occurrenceId);
  return {
    snapshot: {
      source,
      catalogDigest: catalog.digest,
      binding: copiedBinding(binding),
      occurrences,
    },
    unresolvedOccurrenceIds,
    violatedOccurrenceIds,
    satisfied: unresolvedOccurrenceIds.length === 0 && violatedOccurrenceIds.length === 0,
  };
}

function assertCoverageSummary(
  role: ReadinessAdmissionRole,
  root: JsonObject,
  derived: AdmittedOccurrences,
): void {
  if (!booleanValue(role, root.coverage_complete, 'coverage_complete')) {
    reject(role, 'summary-mismatch', 'coverage_complete', 'must be true for exact coverage');
  }
  const supplied = uniqueStrings(role, root.unresolved_occurrence_ids, 'unresolved_occurrence_ids');
  if (!sameStringSet(supplied, derived.unresolvedOccurrenceIds)) {
    reject(
      role,
      'summary-mismatch',
      'unresolved_occurrence_ids',
      'does not match derived unresolved occurrences',
    );
  }
}

function riskApplicability(
  role: ReadinessAdmissionRole,
  value: JsonValue | undefined,
  path: string,
): RiskApplicability {
  return typeof value === 'string' && (APPLICABILITIES as readonly string[]).includes(value)
    ? (value as RiskApplicability)
    : reject(role, 'invalid-value', path, 'is not a supported applicability');
}

function riskLevel(
  role: ReadinessAdmissionRole,
  value: JsonValue | undefined,
  path: string,
): RiskLevel {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value)
    ? (value as RiskLevel)
    : reject(role, 'invalid-value', path, 'is not a supported risk level');
}

function exactRiskRecords(
  role: ReadinessAdmissionRole,
  records: readonly ReadinessRiskDomainRecord[],
  path: string,
): Map<RiskDomain, ReadinessRiskDomainRecord> {
  const domains = records.map((record) => record.domain);
  exactIdentitySet(role, domains, RISK_DOMAINS, path);
  return new Map(records.map((record) => [record.domain, record] as const));
}

function admittedRiskDomains(
  root: JsonObject,
  planVersion: number,
  current: readonly ReadinessRiskDomainRecord[],
  evidenceContext: CandidateEvidenceTargetContext,
): ReadinessRiskDomainRecord[] {
  const role = 'critic';
  const currentByDomain = exactRiskRecords(role, current, 'currentRiskDomains');
  const rawAssessments = arrayValue(role, root.domain_assessments, 'domain_assessments');
  const assessmentByDomain = new Map<RiskDomain, JsonObject>();
  for (const [index, rawAssessment] of rawAssessments.entries()) {
    const path = `domain_assessments[${index}]`;
    const assessment = objectValue(role, rawAssessment, path);
    const rawDomain = stringValue(role, assessment.domain, `${path}.domain`);
    if (!(RISK_DOMAINS as readonly string[]).includes(rawDomain)) {
      reject(role, 'unknown-identity', `${path}.domain`, `unknown risk domain ${rawDomain}`);
    }
    const domain = rawDomain as RiskDomain;
    if (assessmentByDomain.has(domain)) {
      reject(role, 'duplicate-identity', `${path}.domain`, `duplicates ${domain}`);
    }
    assessmentByDomain.set(domain, assessment);
  }
  const missing = RISK_DOMAINS.find((domain) => !assessmentByDomain.has(domain));
  if (missing !== undefined) {
    reject(role, 'missing-identity', 'domain_assessments', `is missing domain ${missing}`);
  }
  if (assessmentByDomain.size !== RISK_DOMAINS.length) {
    reject(role, 'unknown-identity', 'domain_assessments', 'contains extra domains');
  }

  return RISK_DOMAINS.map((domain) => {
    const assessment = assessmentByDomain.get(domain);
    const prior = currentByDomain.get(domain);
    if (assessment === undefined || prior === undefined) {
      return reject(role, 'missing-identity', 'domain_assessments', `is missing domain ${domain}`);
    }
    const unavailableEvidence = uniqueStrings(
      role,
      assessment.unavailable_evidence,
      `domain_assessments.${domain}.unavailable_evidence`,
    );
    const suppliedComplete = booleanValue(
      role,
      assessment.complete,
      `domain_assessments.${domain}.complete`,
    );
    if (suppliedComplete && unavailableEvidence.length > 0) {
      reject(
        role,
        'summary-mismatch',
        `domain_assessments.${domain}.complete`,
        'cannot be true when required evidence is unavailable',
      );
    }
    const suppliedApplicability = riskApplicability(
      role,
      assessment.applicability,
      `domain_assessments.${domain}.applicability`,
    );
    const suppliedRisk = riskLevel(role, assessment.risk, `domain_assessments.${domain}.risk`);
    if (prior.applicability === 'applicable' && suppliedApplicability !== 'applicable') {
      reject(
        role,
        'summary-mismatch',
        `domain_assessments.${domain}.applicability`,
        'cannot weaken the frozen applicable-domain floor',
      );
    }
    if (prior.risk === 'high' && suppliedRisk !== 'high') {
      reject(
        role,
        'summary-mismatch',
        `domain_assessments.${domain}.risk`,
        'cannot weaken the frozen high-risk floor',
      );
    }
    const evidenceRefs = copiedJsonArray(
      role,
      assessment.evidence_refs,
      `domain_assessments.${domain}.evidence_refs`,
    );
    if (suppliedComplete && suppliedApplicability === 'unknown') {
      reject(
        role,
        'summary-mismatch',
        `domain_assessments.${domain}.complete`,
        'cannot be true while applicability is unknown',
      );
    }
    if (
      suppliedApplicability !== 'unknown' &&
      !evidenceReferencesGroundedAgainstCandidate(evidenceRefs, evidenceContext)
    ) {
      reject(
        role,
        'ungrounded-evidence',
        `domain_assessments.${domain}.evidence_refs`,
        'conclusive domain applicability is not grounded against the reviewed candidate',
      );
    }
    return {
      domain,
      applicability: suppliedApplicability,
      risk: suppliedRisk,
      rationale: stringValue(role, assessment.rationale, `domain_assessments.${domain}.rationale`),
      evidenceRefs,
      complete: suppliedComplete,
      unavailableEvidence,
      lastAssessedPlanVersion: planVersion,
    };
  });
}

function issueCategory(
  role: ReadinessAdmissionRole,
  value: JsonValue | undefined,
  path: string,
): IssueCategory {
  return typeof value === 'string' && (ISSUE_CATEGORIES as readonly string[]).includes(value)
    ? (value as IssueCategory)
    : reject(role, 'invalid-value', path, 'is not a supported issue category');
}

function issueSeverity(
  role: ReadinessAdmissionRole,
  value: JsonValue | undefined,
  path: string,
): IssueSeverity {
  return typeof value === 'string' && (ISSUE_SEVERITIES as readonly string[]).includes(value)
    ? (value as IssueSeverity)
    : reject(role, 'invalid-value', path, 'is not a supported issue severity');
}

function validateCriticIssueLineage(
  issue: JsonObject,
  pathLabel: string,
  input: AdmitCritiqueInput,
  planVersion: number,
): void {
  if (issue.addresses !== null) {
    const addresses = stringValue('critic', issue.addresses, `${pathLabel}.addresses`);
    const match = /^v([0-9]+)\.C[0-9]+$/.exec(addresses);
    if (match?.[1] === undefined) {
      reject('critic', 'invalid-value', `${pathLabel}.addresses`, 'has invalid issue lineage');
    }
    if (Number(match[1]) >= planVersion) {
      reject(
        'critic',
        'plan-version-mismatch',
        `${pathLabel}.addresses`,
        'must reference an issue from an earlier plan version',
      );
    }
    if (!input.admittedPriorIssueRefs.includes(addresses)) {
      reject(
        'critic',
        'unknown-identity',
        `${pathLabel}.addresses`,
        `does not identify an admitted prior critique issue: ${addresses}`,
      );
    }
  }
  if (issue.invariant_id !== undefined && issue.invariant_id !== null) {
    const invariantId = stringValue('critic', issue.invariant_id, `${pathLabel}.invariant_id`);
    if (!input.catalog.invariants.some((invariant) => invariant.invariantId === invariantId)) {
      reject(
        'critic',
        'unknown-identity',
        `${pathLabel}.invariant_id`,
        `does not identify a trusted invariant: ${invariantId}`,
      );
    }
  }
  if (issue.introduced_by_revision !== undefined && issue.introduced_by_revision !== null) {
    const introducedBy = stringValue(
      'critic',
      issue.introduced_by_revision,
      `${pathLabel}.introduced_by_revision`,
    );
    if (planVersion === 0 || introducedBy !== `plan.v${planVersion}.md`) {
      reject(
        'critic',
        'plan-version-mismatch',
        `${pathLabel}.introduced_by_revision`,
        'must identify the exact current revision candidate',
      );
    }
  }
}

function admittedCriticIssues(
  root: JsonObject,
  input: AdmitCritiqueInput,
  planVersion: number,
): AdmittedMaterialIssue[] {
  const role = 'critic';
  const seen = new Set<string>();
  return arrayValue(role, root.issues, 'issues').map((rawIssue, index) => {
    const path = `issues[${index}]`;
    const issue = objectValue(role, rawIssue, path);
    validateCriticIssueLineage(issue, path, input, planVersion);
    const id = stringValue(role, issue.id, `${path}.id`);
    if (!/^C[0-9]+$/.test(id)) {
      reject(role, 'invalid-value', `${path}.id`, 'must use the C<number> identity format');
    }
    if (seen.has(id)) {
      reject(role, 'duplicate-identity', `${path}.id`, `duplicates ${id}`);
    }
    seen.add(id);
    const severity = issueSeverity(role, issue.severity, `${path}.severity`);
    if (!(MATERIAL_SEVERITIES as readonly string[]).includes(severity)) {
      reject(role, 'invalid-value', `${path}.severity`, 'must be blocker or major');
    }
    if (issue.duplicate_of !== null) {
      reject(role, 'invalid-value', `${path}.duplicate_of`, 'material issues cannot be duplicates');
    }
    return {
      id,
      issueRef: `v${planVersion}.${id}`,
      severity: severity as MaterialIssueSeverity,
      category: issueCategory(role, issue.category, `${path}.category`),
      claim: stringValue(role, issue.claim, `${path}.claim`),
      evidence: stringValue(role, issue.evidence, `${path}.evidence`),
      evidenceRefs: candidateGroundedEvidenceRefs(
        role,
        issue.evidence_refs,
        `${path}.evidence_refs`,
        input.evidenceContext,
      ),
      suggestedFix: stringValue(role, issue.suggested_fix, `${path}.suggested_fix`),
    };
  });
}

function admittedBoundaryChallenges(
  root: JsonObject,
  planVersion: number,
  evidenceContext: CandidateEvidenceTargetContext,
): BoundaryChallengeRecord[] {
  const role = 'critic';
  const seen = new Set<string>();
  return arrayValue(role, root.boundary_challenges, 'boundary_challenges').map(
    (rawChallenge, index) => {
      const path = `boundary_challenges[${index}]`;
      const challenge = objectValue(role, rawChallenge, path);
      const id = stringValue(role, challenge.id, `${path}.id`);
      if (seen.has(id)) {
        reject(role, 'duplicate-identity', `${path}.id`, `duplicates ${id}`);
      }
      seen.add(id);
      const kind = challenge.kind;
      if (
        kind !== 'scope-expansion' &&
        kind !== 'out-of-scope-removal' &&
        kind !== 'assurance-appetite'
      ) {
        reject(role, 'invalid-value', `${path}.kind`, 'is not a supported boundary challenge');
      }
      return {
        id,
        kind,
        claim: stringValue(role, challenge.claim, `${path}.claim`),
        rationale: stringValue(role, challenge.rationale, `${path}.rationale`),
        evidenceRefs: candidateGroundedEvidenceRefs(
          role,
          challenge.evidence_refs,
          `${path}.evidence_refs`,
          evidenceContext,
        ),
        planVersion,
      };
    },
  );
}

function admittedOpportunities(
  root: JsonObject,
  planVersion: number,
  evidenceContext: CandidateEvidenceTargetContext,
): OpportunityRecord[] {
  const role = 'critic';
  const seen = new Set<string>();
  return arrayValue(role, root.opportunities, 'opportunities').map((rawOpportunity, index) => {
    const path = `opportunities[${index}]`;
    const opportunity = objectValue(role, rawOpportunity, path);
    const fingerprint = stringValue(role, opportunity.fingerprint, `${path}.fingerprint`);
    if (seen.has(fingerprint)) {
      reject(role, 'duplicate-identity', `${path}.fingerprint`, `duplicates ${fingerprint}`);
    }
    seen.add(fingerprint);
    return {
      fingerprint,
      claim: stringValue(role, opportunity.claim, `${path}.claim`),
      evidence: stringValue(role, opportunity.evidence, `${path}.evidence`),
      suggestedImprovement: stringValue(
        role,
        opportunity.suggested_improvement,
        `${path}.suggested_improvement`,
      ),
      evidenceRefs: candidateGroundedEvidenceRefs(
        role,
        opportunity.evidence_refs,
        `${path}.evidence_refs`,
        evidenceContext,
      ),
      firstSeenPlanVersion: planVersion,
      lastSeenPlanVersion: planVersion,
    };
  });
}

export function admitCritique(input: AdmitCritiqueInput): AdmittedCritique {
  const role = 'critic';
  const root = objectValue(role, input.value, 'critique');
  const planVersion = integerValue(role, root.plan_version, 'plan_version');
  if (planVersion !== input.catalog.expectedPlanVersion) {
    reject(
      role,
      'plan-version-mismatch',
      'plan_version',
      `expected ${input.catalog.expectedPlanVersion}, received ${planVersion}`,
    );
  }
  const admittedPriorIssueRefs = new Set<string>();
  for (const [index, issueRef] of input.admittedPriorIssueRefs.entries()) {
    const match = /^v([0-9]+)\.C[0-9]+$/.exec(issueRef);
    if (
      match?.[1] === undefined ||
      Number(match[1]) >= planVersion ||
      admittedPriorIssueRefs.has(issueRef)
    ) {
      reject(
        role,
        'invalid-value',
        `admittedPriorIssueRefs[${index}]`,
        'must be a unique issue reference from an earlier admitted critique',
      );
    }
    admittedPriorIssueRefs.add(issueRef);
  }
  const review = objectValue(role, root.review, 'review');
  const consideredContext = uniqueStrings(
    role,
    review.considered_context,
    'review.considered_context',
  );
  exactIdentitySet(
    role,
    consideredContext,
    input.catalog.retainedContextCategories,
    'review.considered_context',
  );
  const scopeCoverage = uniqueStrings(role, review.scope_coverage, 'review.scope_coverage');
  const unknownScopeToken = scopeCoverage.find(
    (token) => !(CRITIC_SCOPE_TOKENS as readonly string[]).includes(token),
  );
  if (unknownScopeToken !== undefined) {
    reject(
      role,
      'unknown-identity',
      'review.scope_coverage',
      `contains unknown token ${unknownScopeToken}`,
    );
  }
  if (!scopeCoverage.includes(input.expectedScopeToken)) {
    reject(
      role,
      'missing-identity',
      'review.scope_coverage',
      `is missing expected token ${input.expectedScopeToken}`,
    );
  }
  if (!Number.isInteger(input.issueBudgetLimit) || input.issueBudgetLimit < 0) {
    reject(role, 'invalid-value', 'issueBudgetLimit', 'must be a non-negative integer');
  }

  const materialIssues = admittedCriticIssues(root, input, planVersion);
  const budget = objectValue(role, review.issue_budget, 'review.issue_budget');
  const budgetLimit = integerValue(role, budget.limit, 'review.issue_budget.limit');
  const budgetUsed = integerValue(role, budget.used, 'review.issue_budget.used');
  const budgetExhausted = booleanValue(role, budget.exhausted, 'review.issue_budget.exhausted');
  if (budgetLimit !== input.issueBudgetLimit || budgetUsed !== materialIssues.length) {
    reject(
      role,
      'summary-mismatch',
      'review.issue_budget',
      'does not match the trusted limit and admitted material issue count',
    );
  }
  if (budgetUsed > budgetLimit) {
    reject(role, 'summary-mismatch', 'review.issue_budget.used', 'exceeds the trusted limit');
  }

  const occurrences = occurrenceAssessments(
    role,
    'critic',
    review.invariant_assessments,
    input.catalog,
    input.binding,
    input.evidenceContext,
    true,
  );
  const riskDomains = admittedRiskDomains(
    root,
    planVersion,
    input.currentRiskDomains,
    input.evidenceContext,
  );
  const unresolvedCoverage = uniqueStrings(
    role,
    review.unresolved_coverage,
    'review.unresolved_coverage',
  );
  const criticCoverageGapIds = unresolvedCoverage.map((value) =>
    stableTupleId('critic-unresolved', [planVersion, value]),
  );
  const suppliedScanComplete = booleanValue(role, review.scan_complete, 'review.scan_complete');
  const domainScanComplete = riskDomains.every(
    (domain) =>
      domain.applicability !== 'unknown' &&
      domain.complete &&
      domain.lastAssessedPlanVersion === planVersion,
  );

  return {
    planVersion,
    snapshot: occurrences.snapshot,
    scanComplete: suppliedScanComplete && domainScanComplete && criticCoverageGapIds.length === 0,
    declaredScopeVerified: true,
    materialIssueIds: materialIssues.map((issue) => issue.issueRef),
    issueBudgetUsed: budgetUsed,
    issueBudgetExhausted: budgetExhausted,
    riskDomains,
    criticCoverageGapIds,
    criticScopeCoverageGapIds: [],
    criticContextGapIds: [],
    boundaryChallenges: admittedBoundaryChallenges(root, planVersion, input.evidenceContext),
    opportunities: admittedOpportunities(root, planVersion, input.evidenceContext),
    summary: typeof root.summary === 'string' ? root.summary.trim() : '',
    materialIssues,
  };
}

function expectedCreatorIssues(
  role: ReadinessAdmissionRole,
  issues: readonly ExpectedCreatorIssue[],
): Map<string, ExpectedCreatorIssue> {
  const byId = new Map<string, ExpectedCreatorIssue>();
  for (const [index, issue] of issues.entries()) {
    const path = `expectedIssues[${index}]`;
    if (
      issue.id.trim() === '' ||
      issue.claim.trim() === '' ||
      issue.evidence.trim() === '' ||
      issue.suggestedFix.trim() === ''
    ) {
      reject(role, 'invalid-value', path, 'must contain non-blank identity and evidence fields');
    }
    if (!(MATERIAL_SEVERITIES as readonly string[]).includes(issue.severity)) {
      reject(role, 'invalid-value', `${path}.severity`, 'must be blocker or major');
    }
    if (byId.has(issue.id)) {
      reject(role, 'duplicate-identity', `${path}.id`, `duplicates ${issue.id}`);
    }
    byId.set(issue.id, { ...issue });
  }
  return byId;
}

function creatorVerdicts(
  root: JsonObject,
  expectedById: ReadonlyMap<string, ExpectedCreatorIssue>,
): AdmittedCreatorIssueVerdict[] {
  const role = 'creator-update';
  const seen = new Set<string>();
  const verdicts = arrayValue(role, root.issues, 'issues').map((rawVerdict, index) => {
    const path = `issues[${index}]`;
    const verdictObject = objectValue(role, rawVerdict, path);
    const id = stringValue(role, verdictObject.id, `${path}.id`);
    if (seen.has(id)) {
      reject(role, 'duplicate-identity', `${path}.id`, `duplicates ${id}`);
    }
    seen.add(id);
    const expected = expectedById.get(id);
    if (expected === undefined) {
      reject(role, 'unknown-identity', `${path}.id`, `does not match a critique issue`);
    }
    const rawValue = verdictObject.verdict;
    if (
      typeof rawValue !== 'string' ||
      !(CREATOR_VERDICTS as readonly string[]).includes(rawValue)
    ) {
      reject(role, 'invalid-value', `${path}.verdict`, 'is not a supported verdict');
    }
    const verdict = rawValue as CreatorIssueVerdictValue;
    const verdictReason = stringValue(role, verdictObject.verdict_reason, `${path}.verdict_reason`);
    if (verdictObject.duplicate_of !== null) {
      reject(
        role,
        'invalid-value',
        `${path}.duplicate_of`,
        'must be null for current creator verdicts',
      );
    }
    const finalSeverity = issueSeverity(
      role,
      verdictObject.final_severity,
      `${path}.final_severity`,
    );
    const severityOrder: readonly IssueSeverity[] = ['blocker', 'major', 'minor', 'nit'];
    const expectedRank = severityOrder.indexOf(expected.severity);
    const finalRank = severityOrder.indexOf(finalSeverity);
    if (
      (verdict === 'downgrade' && finalRank <= expectedRank) ||
      (verdict !== 'downgrade' && finalSeverity !== expected.severity)
    ) {
      reject(
        role,
        'summary-mismatch',
        `${path}.final_severity`,
        'does not match the admitted critique severity and verdict',
      );
    }
    return {
      id,
      verdict,
      verdictReason,
      finalSeverity,
      duplicateOf: null,
    };
  });
  const missing = [...expectedById.keys()].find((id) => !seen.has(id));
  if (missing !== undefined) {
    reject(role, 'missing-identity', 'issues', `is missing verdict for ${missing}`);
  }
  if (seen.size !== expectedById.size) {
    reject(role, 'unknown-identity', 'issues', 'contains extra verdict identities');
  }
  return verdicts;
}

function copiedFindings(findings: readonly FindingRecord[]): FindingRecord[] {
  return findings.map((finding) => ({
    ...finding,
    disposition: {
      ...finding.disposition,
      evidenceRefs: finding.disposition.evidenceRefs.map(cloneJsonValue),
    },
  }));
}

function copiedInvariants(
  invariants: readonly ReadinessInvariantRecord[],
): ReadinessInvariantRecord[] {
  return invariants.map((invariant) => ({
    ...invariant,
    occurrences: invariant.occurrences.map((occurrence) => ({ ...occurrence })),
  }));
}

function assertRetainedInvariantIdentities(
  catalog: ReadinessProofCatalog,
  invariants: readonly ReadinessInvariantRecord[],
): void {
  const role = 'creator-update';
  const byId = new Map<string, ReadinessInvariantRecord>();
  for (const invariant of invariants) {
    if (byId.has(invariant.id)) {
      reject(role, 'duplicate-identity', 'retainedInvariants', `duplicates ${invariant.id}`);
    }
    byId.set(invariant.id, invariant);
  }
  for (const expected of catalog.invariants) {
    const retained = byId.get(expected.invariantId);
    if (retained === undefined) {
      reject(role, 'missing-identity', 'retainedInvariants', `is missing ${expected.invariantId}`);
    }
    if (
      !sameStringSet(
        retained.occurrences.map((entry) => entry.id),
        expected.occurrenceIds,
      )
    ) {
      reject(
        role,
        'catalog-mismatch',
        `retainedInvariants.${expected.invariantId}`,
        'occurrences do not match the current catalog',
      );
    }
  }
  const extra = invariants.find(
    (invariant) => !catalog.invariants.some((entry) => entry.invariantId === invariant.id),
  );
  if (extra !== undefined) {
    reject(
      role,
      'unknown-identity',
      'retainedInvariants',
      `contains ${extra.id} outside the current catalog`,
    );
  }
}

function optionalSupersession(
  role: ReadinessAdmissionRole,
  disposition: JsonObject,
  operatorInterventionIds: ReadonlySet<string>,
  path: string,
): string | undefined {
  if (disposition.superseded_by === null || disposition.superseded_by === undefined) {
    return undefined;
  }
  const supersededBy = stringValue(role, disposition.superseded_by, `${path}.superseded_by`);
  if (!operatorInterventionIds.has(supersededBy)) {
    reject(
      role,
      'operator-supersession-mismatch',
      `${path}.superseded_by`,
      `unknown operator intervention ${supersededBy}`,
    );
  }
  return supersededBy;
}

interface CreatorDispositionResult {
  readonly finding: FindingRecord;
  readonly invariant?: ReadinessInvariantRecord;
}

function creatorDisposition(
  rawDisposition: JsonObject,
  issue: ExpectedCreatorIssue,
  severity: MaterialIssueSeverity,
  input: AdmitCreatorUpdateInput,
  index: number,
): CreatorDispositionResult {
  const role = 'creator-update';
  const path = `systemic_dispositions[${index}]`;
  const rationale = stringValue(role, rawDisposition.rationale, `${path}.rationale`);
  const evidenceRefs =
    rawDisposition.evidence_refs === undefined
      ? []
      : copiedJsonArray(role, rawDisposition.evidence_refs, `${path}.evidence_refs`);
  const supersededBy = optionalSupersession(
    role,
    rawDisposition,
    new Set(input.operatorInterventionIds),
    path,
  );
  if (
    supersededBy === undefined &&
    !evidenceReferencesGroundedAgainstCandidate(evidenceRefs, input.evidenceContext)
  ) {
    reject(
      role,
      'ungrounded-evidence',
      `${path}.evidence_refs`,
      'systemic disposition evidence is not grounded against the revised candidate',
    );
  }
  const findingId = `I-v${input.fromPlanVersion}-${issue.id}`;
  const baseFinding = {
    id: findingId,
    issueRef: `v${input.fromPlanVersion}.${issue.id}`,
    introducedPlanVersion: input.expectedPlanVersion,
    severity,
    claim: issue.claim,
  } as const;

  if (rawDisposition.scope === 'local') {
    if (isJsonObject(rawDisposition.invariant)) {
      reject(role, 'invalid-value', `${path}.invariant`, 'must be null for a local disposition');
    }
    return {
      finding: {
        ...baseFinding,
        disposition: {
          scope: 'local',
          rationale,
          evidenceRefs,
          ...(supersededBy === undefined ? {} : { supersededBy }),
        },
      },
    };
  }

  if (rawDisposition.scope !== 'cross-cutting') {
    return reject(role, 'invalid-value', `${path}.scope`, 'must be local or cross-cutting');
  }
  const proposed = objectValue(role, rawDisposition.invariant, `${path}.invariant`);
  const statement = stringValue(role, proposed.statement, `${path}.invariant.statement`);
  const tupleKeys = new Set<string>();
  const occurrenceData = arrayValue(
    role,
    proposed.occurrences,
    `${path}.invariant.occurrences`,
  ).map((rawOccurrence, occurrenceIndex) => {
    const occurrencePath = `${path}.invariant.occurrences[${occurrenceIndex}]`;
    const occurrence = objectValue(role, rawOccurrence, occurrencePath);
    const dimension = stringValue(role, occurrence.dimension, `${occurrencePath}.dimension`);
    const subject = stringValue(role, occurrence.subject, `${occurrencePath}.subject`);
    const tuple = JSON.stringify([dimension, subject]);
    if (tupleKeys.has(tuple)) {
      reject(role, 'duplicate-identity', occurrencePath, 'duplicates an occurrence tuple');
    }
    tupleKeys.add(tuple);
    return { dimension, subject };
  });
  if (occurrenceData.length === 0) {
    reject(
      role,
      'missing-identity',
      `${path}.invariant.occurrences`,
      'must contain at least one occurrence',
    );
  }
  const invariant: ReadinessInvariantRecord = {
    id: findingId,
    sourceFinding: findingId,
    statement,
    occurrences: occurrenceData.map(({ dimension, subject }) => ({
      id: stableTupleId('O', [findingId, dimension, subject]),
      dimension,
      subject,
    })),
  };
  return {
    finding: {
      ...baseFinding,
      disposition: {
        scope: 'cross-cutting',
        rationale,
        evidenceRefs,
        ...(supersededBy === undefined ? {} : { supersededBy }),
      },
    },
    invariant,
  };
}

export function admitCreatorUpdate(input: AdmitCreatorUpdateInput): AdmittedCreatorUpdate {
  const role = 'creator-update';
  const root = objectValue(role, input.value, 'creator update');
  const providerPlanVersion = integerValue(role, root.plan_version, 'plan_version');
  if (providerPlanVersion !== input.expectedPlanVersion) {
    reject(
      role,
      'plan-version-mismatch',
      'plan_version',
      `expected ${input.expectedPlanVersion}, received ${providerPlanVersion}`,
    );
  }
  if (
    input.expectedPlanVersion !== input.fromPlanVersion + 1 ||
    input.currentCatalog.expectedPlanVersion !== input.fromPlanVersion ||
    input.evidenceContext.planVersion !== input.expectedPlanVersion
  ) {
    reject(role, 'plan-version-mismatch', 'expectedPlanVersion', 'lineage is not exactly one step');
  }
  assertCatalog(role, input.currentCatalog);
  assertRetainedInvariantIdentities(input.currentCatalog, input.retainedInvariants);
  if (arrayValue(role, root.rejected_append, 'rejected_append').length > 0) {
    reject(
      role,
      'unknown-identity',
      'rejected_append',
      'must be empty because the current critic contract admits only material issues',
    );
  }
  const expectedById = expectedCreatorIssues(role, input.expectedIssues);
  const admittedCriticIssueRefs = [...input.admittedCriticIssueRefs].sort();
  if (new Set(admittedCriticIssueRefs).size !== admittedCriticIssueRefs.length) {
    reject(role, 'duplicate-identity', 'admittedCriticIssueRefs', 'must not contain duplicates');
  }
  for (const [index, issueRef] of admittedCriticIssueRefs.entries()) {
    const match = /^v([0-9]+)\.C[0-9]+$/.exec(issueRef);
    if (match?.[1] === undefined || Number(match[1]) > input.fromPlanVersion) {
      reject(
        role,
        'invalid-value',
        `admittedCriticIssueRefs[${index}]`,
        'must identify an issue from the current or an earlier admitted critique',
      );
    }
  }
  const expectedCurrentIssueRefs = [...expectedById.values()]
    .filter((issue) => issue.provenance === 'critic')
    .map((issue) => issue.id)
    .map((id) => `v${input.fromPlanVersion}.${id}`)
    .sort();
  const admittedCurrentIssueRefs = admittedCriticIssueRefs.filter((issueRef) =>
    issueRef.startsWith(`v${input.fromPlanVersion}.`),
  );
  if (!sameOrderedStrings(admittedCurrentIssueRefs, expectedCurrentIssueRefs)) {
    reject(
      role,
      'catalog-mismatch',
      'admittedCriticIssueRefs',
      'does not match the exact current admitted critique issue catalog',
    );
  }
  const expectedJudgeRevisionIssueIds = [...expectedById.values()]
    .filter((issue) => issue.provenance === 'intermediate-judge')
    .map((issue) =>
      stableTupleId('judge-revision', [
        input.fromPlanVersion,
        issue.claim,
        issue.evidence,
        issue.suggestedFix,
      ]),
    )
    .sort();
  const admittedJudgeRevisionIssueIds = [...input.admittedJudgeRevisionIssueIds].sort();
  if (
    new Set(admittedJudgeRevisionIssueIds).size !== admittedJudgeRevisionIssueIds.length ||
    !sameOrderedStrings(admittedJudgeRevisionIssueIds, expectedJudgeRevisionIssueIds)
  ) {
    reject(
      role,
      'catalog-mismatch',
      'admittedJudgeRevisionIssueIds',
      'does not match the exact admitted intermediate-Judge revision catalog',
    );
  }
  const parsedVerdicts = creatorVerdicts(root, expectedById);
  const acceptedVerdicts = parsedVerdicts.filter(
    (verdict) => verdict.verdict === 'accept' || verdict.verdict === 'downgrade',
  );
  const materialIds = new Set(acceptedVerdicts.map((verdict) => verdict.id));

  const appliedIssueIds = uniqueStrings(role, root.applied, 'applied');
  const acceptedIds = new Set(acceptedVerdicts.map((verdict) => verdict.id));
  const invalidApplied = appliedIssueIds.find((id) => !acceptedIds.has(id));
  if (invalidApplied !== undefined) {
    reject(role, 'unknown-identity', 'applied', `${invalidApplied} is not an accepted issue`);
  }
  const missingApplied = [...materialIds].find((id) => !appliedIssueIds.includes(id));
  if (missingApplied !== undefined) {
    reject(role, 'missing-identity', 'applied', `is missing material issue ${missingApplied}`);
  }

  const dispositionByIssue = new Map<
    string,
    { readonly value: JsonObject; readonly index: number }
  >();
  arrayValue(role, root.systemic_dispositions, 'systemic_dispositions').forEach(
    (rawDisposition, index) => {
      const path = `systemic_dispositions[${index}]`;
      const disposition = objectValue(role, rawDisposition, path);
      const issueId = stringValue(role, disposition.issue_id, `${path}.issue_id`);
      if (dispositionByIssue.has(issueId)) {
        reject(role, 'duplicate-identity', `${path}.issue_id`, `duplicates ${issueId}`);
      }
      if (!materialIds.has(issueId)) {
        reject(
          role,
          'unknown-identity',
          `${path}.issue_id`,
          `${issueId} is not an accepted material issue`,
        );
      }
      dispositionByIssue.set(issueId, { value: disposition, index });
    },
  );
  const missingDisposition = [...materialIds].find((id) => !dispositionByIssue.has(id));
  if (missingDisposition !== undefined) {
    reject(
      role,
      'missing-identity',
      'systemic_dispositions',
      `is missing material issue ${missingDisposition}`,
    );
  }

  const newResults = acceptedVerdicts.map((verdict) => {
    const expected = expectedById.get(verdict.id);
    const disposition = dispositionByIssue.get(verdict.id);
    if (expected === undefined || disposition === undefined) {
      return reject(role, 'missing-identity', 'systemic_dispositions', `is missing ${verdict.id}`);
    }
    return creatorDisposition(
      disposition.value,
      expected,
      expected.severity,
      input,
      disposition.index,
    );
  });
  const findings = copiedFindings(input.retainedFindings);
  const findingIds = new Set(findings.map((finding) => finding.id));
  for (const result of newResults) {
    if (findingIds.has(result.finding.id)) {
      reject(role, 'duplicate-identity', 'systemic_dispositions', `recreates ${result.finding.id}`);
    }
    findingIds.add(result.finding.id);
    findings.push(result.finding);
  }
  const invariants = copiedInvariants(input.retainedInvariants);
  const invariantIds = new Set(invariants.map((invariant) => invariant.id));
  for (const result of newResults) {
    if (result.invariant === undefined) {
      continue;
    }
    if (invariantIds.has(result.invariant.id)) {
      reject(
        role,
        'duplicate-identity',
        'systemic_dispositions',
        `recreates ${result.invariant.id}`,
      );
    }
    invariantIds.add(result.invariant.id);
    invariants.push(result.invariant);
  }
  let nextCatalog: ReadinessProofCatalog;
  try {
    nextCatalog = createReadinessProofCatalog({
      expectedPlanVersion: input.expectedPlanVersion,
      invariants: invariants.map((invariant) => ({
        invariantId: invariant.id,
        occurrenceIds: invariant.occurrences.map((occurrence) => occurrence.id),
      })),
      materialIssueIds: [
        ...input.currentCatalog.materialIssueIds,
        ...newResults.map((result) => result.finding.id),
      ],
    });
  } catch (error) {
    reject(
      role,
      'catalog-mismatch',
      'nextCatalog',
      error instanceof Error ? error.message : String(error),
    );
  }

  const normalizedVerdicts = parsedVerdicts.map(
    ({ id, verdict, verdictReason, finalSeverity, duplicateOf }) => ({
      id,
      verdict,
      verdictReason,
      finalSeverity,
      duplicateOf,
    }),
  );
  const transitionReceipt: CreatorTransitionReceipt = {
    schemaVersion: 1,
    fromPlanVersion: input.fromPlanVersion,
    toPlanVersion: input.expectedPlanVersion,
    fromCatalogDigest: input.currentCatalog.digest,
    expectedIssuesDigest: canonicalJsonSha256(input.expectedIssues),
    updateDigest: canonicalJsonSha256(input.value),
    candidateDigest: sha256(input.evidenceContext.candidateContent),
    nextCatalogDigest: nextCatalog.digest,
    admittedFactsDigest: canonicalJsonSha256({
      verdicts: normalizedVerdicts,
      appliedIssueIds,
      findings,
      invariants,
      materialRevisionProofGapIds: [],
    }),
    admittedCriticIssueRefsDigest: canonicalJsonSha256(admittedCriticIssueRefs),
  };
  return {
    fromPlanVersion: input.fromPlanVersion,
    nextCatalog,
    findings,
    invariants,
    materialRevisionProofGapIds: [],
    verdicts: normalizedVerdicts,
    appliedIssueIds,
    transitionReceipt,
  };
}

function reviewerConcerns(root: JsonObject): AdmittedFixReviewerConcern[] {
  const role = 'fix-reviewer';
  const seen = new Set<string>();
  return arrayValue(role, root.concerns, 'concerns').map((rawConcern, index) => {
    const path = `concerns[${index}]`;
    const concern = objectValue(role, rawConcern, path);
    const id = stringValue(role, concern.id, `${path}.id`);
    if (seen.has(id)) {
      reject(role, 'duplicate-identity', `${path}.id`, `duplicates ${id}`);
    }
    seen.add(id);
    return {
      id,
      severity: issueSeverity(role, concern.severity, `${path}.severity`),
      claim: stringValue(role, concern.claim, `${path}.claim`),
      evidence: stringValue(role, concern.evidence, `${path}.evidence`),
    };
  });
}

export function admitFixReviewer(input: AdmitFixReviewerInput): AdmittedFixReviewer {
  const role = 'fix-reviewer';
  const root = objectValue(role, input.value, 'fix review');
  const occurrences = occurrenceAssessments(
    role,
    'fix-reviewer',
    root.invariant_assessments,
    input.catalog,
    input.binding,
    input.evidenceContext,
    false,
  );
  assertCoverageSummary(role, root, occurrences);
  const concerns = reviewerConcerns(root);
  const materialConcerns = concerns.filter(
    (concern) => concern.severity === 'blocker' || concern.severity === 'major',
  );
  const hasMinorConcern = concerns.some((concern) => concern.severity === 'minor');
  const expectedApproval =
    materialConcerns.length > 0 ? 'reject' : hasMinorConcern ? 'accept_with_concerns' : 'accept';
  if (root.approval !== expectedApproval) {
    reject(
      role,
      'summary-mismatch',
      'approval',
      `must be ${expectedApproval} for the supplied concerns`,
    );
  }
  const reason = stringValue(role, input.requirementReason, 'requirementReason');
  return {
    required: true,
    reason,
    expectedBinding: copiedBinding(input.binding),
    snapshot: occurrences.snapshot,
    materialIssueIds: materialConcerns.map((concern) => `fix-reviewer:${concern.id}`),
    approval: expectedApproval,
    concerns,
    coverageComplete: true,
    unresolvedOccurrenceIds: occurrences.unresolvedOccurrenceIds,
    violatedOccurrenceIds: occurrences.violatedOccurrenceIds,
    satisfied: occurrences.satisfied,
  };
}

function judgeRevisionIssue(
  role: 'intermediate-judge' | 'final-judge',
  root: JsonObject,
  ready: boolean,
  evidenceContext: CandidateEvidenceTargetContext,
): AdmittedJudgeRevisionIssue | undefined {
  const value = root.revision_issue;
  if (value === undefined) {
    reject(role, 'invalid-artifact', 'revision_issue', 'is required');
  }
  if (value === null) {
    return undefined;
  }
  if (ready) {
    reject(role, 'summary-mismatch', 'revision_issue', 'must be null for a ready verdict');
  }
  if (role === 'final-judge') {
    reject(role, 'summary-mismatch', 'revision_issue', 'must be null for a final verdict');
  }
  const revision = objectValue(role, value, 'revision_issue');
  const evidenceRefs = copiedJsonArray(
    role,
    revision.evidence_refs,
    'revision_issue.evidence_refs',
  );
  if (!evidenceReferencesGroundedAgainstCandidate(evidenceRefs, evidenceContext)) {
    reject(
      role,
      'ungrounded-evidence',
      'revision_issue.evidence_refs',
      'is not grounded against the exact candidate',
    );
  }
  const severity = issueSeverity(role, revision.severity, 'revision_issue.severity');
  if (!(MATERIAL_SEVERITIES as readonly string[]).includes(severity)) {
    reject(role, 'invalid-value', 'revision_issue.severity', 'must be blocker or major');
  }
  return {
    severity: severity as MaterialIssueSeverity,
    category: issueCategory(role, revision.category, 'revision_issue.category'),
    claim: stringValue(role, revision.claim, 'revision_issue.claim'),
    evidence: stringValue(role, revision.evidence, 'revision_issue.evidence'),
    evidenceRefs,
    suggestedFix: stringValue(role, revision.suggested_fix, 'revision_issue.suggested_fix'),
  };
}

export function admitJudge(input: AdmitJudgeInput): AdmittedJudge {
  const role = input.stage === 'intermediate' ? 'intermediate-judge' : 'final-judge';
  const source = role;
  const root = objectValue(role, input.value, 'Judge verdict');
  const occurrences = occurrenceAssessments(
    role,
    source,
    root.invariant_assessments,
    input.catalog,
    input.binding,
    input.evidenceContext,
    false,
  );
  assertCoverageSummary(role, root, occurrences);
  const ready = booleanValue(role, root.ready, 'ready');
  if (ready && !occurrences.satisfied) {
    reject(
      role,
      'summary-mismatch',
      'ready',
      'cannot be true when occurrence proof is violated or unresolved',
    );
  }
  const revisionIssue = judgeRevisionIssue(role, root, ready, input.evidenceContext);
  const materialIssueIds =
    revisionIssue === undefined
      ? []
      : [
          stableTupleId('judge-revision', [
            input.catalog.expectedPlanVersion,
            revisionIssue.claim,
            revisionIssue.evidence,
            revisionIssue.suggestedFix,
          ]),
        ];
  return {
    stage: input.stage,
    snapshot: occurrences.snapshot,
    verdict: ready,
    ...(ready ? { approvedPlanVersion: input.catalog.expectedPlanVersion } : {}),
    materialIssueIds,
    rationale: typeof root.rationale === 'string' ? root.rationale.trim() : '',
    coverageComplete: true,
    unresolvedOccurrenceIds: occurrences.unresolvedOccurrenceIds,
    violatedOccurrenceIds: occurrences.violatedOccurrenceIds,
    satisfied: occurrences.satisfied,
    ...(revisionIssue === undefined ? {} : { revisionIssue }),
  };
}
