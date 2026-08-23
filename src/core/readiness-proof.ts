import type {
  CompletenessPromise,
  Quality,
  RiskApplicability,
  RiskDomain,
  RiskLevel,
  Role,
  RunMode,
} from '../types.js';
import type { InputLimitSource } from './config.js';
import { canonicalJsonSha256, stableTupleId } from './digest.js';
import type { JsonObject, JsonValue } from './json.js';
import { cloneJsonValue } from './json-clone.js';
import type { QualityMatrix } from './quality.js';
import {
  reduceReadiness,
  type OccurrenceSourceFact,
  type ReadinessFacts,
  type ReadinessReduction,
} from './readiness-decision.js';
import {
  RETAINED_CONTEXT_CATEGORIES,
  RISK_DOMAINS,
  parseReadinessContract,
  type ReadinessContract,
  type ReadinessDomainAssessment,
  type RetainedContextCategory,
} from './readiness-contract.js';

export { RETAINED_CONTEXT_CATEGORIES, type RetainedContextCategory } from './readiness-contract.js';

export const READINESS_PROOF_SCHEMA_VERSION = 3 as const;

export const READINESS_RISK_DOMAINS = RISK_DOMAINS;

export const OCCURRENCE_SOURCES = [
  'critic',
  'fix-reviewer',
  'intermediate-judge',
  'final-judge',
] as const;

export type OccurrenceSource = (typeof OCCURRENCE_SOURCES)[number];
const SOURCE_REQUIREMENT_REASONS = {
  critic: {
    required: ['independent-critic-required'],
    exempt: [],
  },
  'fix-reviewer': {
    required: ['fix-pass-replacement-retained', 'fix-pass-replacement-proof-stale'],
    exempt: [
      'not-required',
      'not-evaluated-for-current-candidate',
      'disabled',
      'no-findings',
      'proposal-failed',
      'review-failed',
      'replacement-rejected',
      'pre-fix-restored',
    ],
  },
  'intermediate-judge': {
    required: ['applicable-high-risk-judge-required'],
    exempt: ['not-required', 'standard-risk-judge-exempt'],
  },
  'final-judge': {
    required: ['applicable-high-risk-judge-required'],
    exempt: ['not-required', 'standard-risk-judge-exempt', 'canonical-plan-not-bound'],
  },
} as const satisfies Record<
  OccurrenceSource,
  { readonly required: readonly string[]; readonly exempt: readonly string[] }
>;
export type RawOccurrenceDisposition = 'satisfied' | 'violated' | 'not-applicable' | 'unresolved';
export type NormalizedOccurrenceOutcome = 'resolved' | 'violated' | 'unresolved';

export interface ReadinessInvariantCatalogEntry {
  readonly invariantId: string;
  readonly occurrenceIds: readonly string[];
}

export interface ReadinessProofCatalog {
  readonly expectedPlanVersion: number;
  readonly riskDomainIds: readonly RiskDomain[];
  readonly invariants: readonly ReadinessInvariantCatalogEntry[];
  readonly materialIssueIds: readonly string[];
  readonly retainedContextCategories: readonly RetainedContextCategory[];
  readonly digest: string;
}

export interface CreateReadinessProofCatalogInput {
  readonly expectedPlanVersion: number;
  readonly invariants: readonly ReadinessInvariantCatalogEntry[];
  readonly materialIssueIds: readonly string[];
}

export type OccurrenceCandidateKind =
  | 'versioned-plan'
  | 'fix-proposal'
  | 'fix-applied'
  | 'canonical-plan';

export type OccurrenceEvaluationStage =
  | 'review'
  | 'fix-proposal-review'
  | 'fix-applied-review'
  | 'intermediate-readiness'
  | 'final-readiness';

export interface OccurrenceCandidateBinding {
  readonly kind: OccurrenceCandidateKind;
  readonly planVersion: number;
  readonly contentDigest: string;
}

export interface OccurrenceLineageBinding {
  readonly evaluationStage: OccurrenceEvaluationStage;
  readonly lineageDigest: string;
}

export interface OccurrenceSourceBinding {
  readonly candidate: OccurrenceCandidateBinding;
  readonly lineage: OccurrenceLineageBinding;
}

export type OccurrenceSourceRequirement =
  | {
      readonly required: true;
      readonly reason: string;
      readonly expectedBinding: OccurrenceSourceBinding;
    }
  | {
      readonly required: false;
      readonly reason: string;
    };

export type RequiredOccurrenceSourceRequirement = Extract<
  OccurrenceSourceRequirement,
  { readonly required: true }
>;

export type CreateOccurrenceSourceRequirements = Readonly<{
  critic: RequiredOccurrenceSourceRequirement;
}> &
  Readonly<Partial<Record<Exclude<OccurrenceSource, 'critic'>, OccurrenceSourceRequirement>>>;

interface AdmittedOccurrenceBase {
  readonly invariantId: string;
  readonly occurrenceId: string;
}

export type AdmittedOccurrenceDisposition =
  | (AdmittedOccurrenceBase & {
      readonly disposition: 'satisfied' | 'violated' | 'not-applicable';
      readonly evidenceGrounded: true;
    })
  | (AdmittedOccurrenceBase & {
      readonly disposition: 'unresolved';
      readonly evidenceGrounded: boolean;
    });

export interface OccurrenceCoverageSnapshot {
  readonly source: OccurrenceSource;
  readonly catalogDigest: string;
  readonly binding: OccurrenceSourceBinding;
  readonly occurrences: readonly AdmittedOccurrenceDisposition[];
}

export interface OccurrenceSourceSlot {
  readonly source: OccurrenceSource;
  readonly requirement: OccurrenceSourceRequirement;
  readonly snapshot?: OccurrenceCoverageSnapshot;
}

export interface OccurrenceAggregateOutcome {
  readonly invariantId: string;
  readonly occurrenceId: string;
  readonly outcome: NormalizedOccurrenceOutcome;
}

export interface OccurrenceSourceState {
  readonly source: OccurrenceSource;
  readonly required: boolean;
  readonly available: boolean;
  readonly catalogExact: boolean;
  readonly current: boolean;
  readonly consistent: boolean;
  readonly conclusive: boolean;
}

export interface OccurrenceCoverageLedger {
  readonly expectedOccurrenceIds: readonly string[];
  readonly sources: readonly OccurrenceSourceState[];
  readonly outcomes: readonly OccurrenceAggregateOutcome[];
  readonly resolvedOccurrenceIds: readonly string[];
  readonly violatedOccurrenceIds: readonly string[];
  readonly unresolvedOccurrenceIds: readonly string[];
  readonly disagreementOccurrenceIds: readonly string[];
  readonly catalogExact: boolean;
  readonly sourcesCurrent: boolean;
  readonly sourcesConclusive: boolean;
  readonly sourceConsistent: boolean;
  readonly proofSatisfied: boolean;
  readonly reasonCodes: readonly string[];
}

export type ScopeSource = 'prompt' | 'direct-plan';
export type ReadinessLimit = 'issue-budget' | 'iteration-cap' | 'assurance-appetite';

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
  readonly evidenceRefs: readonly JsonValue[];
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

export interface ReadinessInvariantOccurrence {
  readonly id: string;
  readonly dimension: string;
  readonly subject: string;
}

export interface ReadinessInvariantRecord {
  readonly id: string;
  readonly sourceFinding: string;
  readonly statement: string;
  readonly occurrences: readonly ReadinessInvariantOccurrence[];
}

export interface ReadinessIssueBudget {
  readonly limit: number;
  readonly used: number;
  readonly exhausted: boolean;
}

export interface ReadinessRiskDomainRecord {
  readonly domain: RiskDomain;
  readonly applicability: RiskApplicability;
  readonly risk: RiskLevel;
  readonly rationale: string;
  readonly evidenceRefs: readonly JsonValue[];
  readonly complete: boolean;
  readonly unavailableEvidence: readonly string[];
  readonly lastAssessedPlanVersion?: number;
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
  readonly lastSeenPlanVersion: number;
}

export interface SystemProofBinding {
  readonly planVersion: number;
  readonly planSha256: string;
  readonly authoritativeDigest: string;
}

export interface CreatorTransitionReceipt {
  readonly schemaVersion: 1;
  readonly fromPlanVersion: number;
  readonly toPlanVersion: number;
  readonly fromCatalogDigest: string;
  readonly expectedIssuesDigest: string;
  readonly updateDigest: string;
  readonly candidateDigest: string;
  readonly nextCatalogDigest: string;
  readonly admittedFactsDigest: string;
  readonly admittedCriticIssueRefsDigest: string;
}

export interface ReadinessProofState {
  readonly schemaVersion: typeof READINESS_PROOF_SCHEMA_VERSION;
  readonly planVersion: number;
  readonly quality: Quality;
  readonly promise: CompletenessPromise;
  readonly requiredProofLevel: CompletenessPromise;
  readonly requiresExhaustiveScan: boolean;
  readonly scopeSource: ScopeSource;
  readonly originalRequestAvailable: boolean;
  readonly sourceDigest: string;
  readonly planSha256?: string;
  readonly canonicalPlanSha256?: string;
  readonly creatorTransitionReceipt?: CreatorTransitionReceipt;
  readonly authoritativeDigest: string;
  readonly operatorDecisionIds: readonly string[];
  readonly interventionIds: readonly string[];
  readonly findings: readonly FindingRecord[];
  readonly invariants: readonly ReadinessInvariantRecord[];
  readonly relationshipIds: readonly string[];
  readonly contextDeliveries: readonly ContextDelivery[];
  readonly issueBudget: ReadinessIssueBudget;
  readonly iterationLimit: number;
  readonly exhaustedLimits: readonly ReadinessLimit[];
  readonly lastCritiquedPlanVersion?: number;
  readonly scanComplete: boolean;
  readonly declaredScopeVerified: boolean;
  readonly admittedCriticIssueRefs: readonly string[];
  readonly criticMaterialIssueIds: readonly string[];
  readonly fixReviewerMaterialIssueIds: readonly string[];
  readonly intermediateJudgeMaterialIssueIds: readonly string[];
  readonly finalJudgeMaterialIssueIds: readonly string[];
  readonly currentActionableIssues: readonly string[];
  readonly systemCheckPassed: boolean;
  readonly systemMismatchIds: readonly string[];
  readonly requiredEvidenceUnavailable: readonly string[];
  readonly systemProofBinding?: SystemProofBinding;
  readonly unresolvedMaterialQuestionIds: readonly string[];
  readonly readinessContractDigest?: string;
  readonly judgeAllowed: boolean;
  readonly exhaustiveApplicableDomains: boolean;
  readonly riskDomains: readonly ReadinessRiskDomainRecord[];
  readonly boundaryChallenges: readonly BoundaryChallengeRecord[];
  readonly opportunities: readonly OpportunityRecord[];
  readonly judgeApprovedPlanVersion?: number;
  readonly judgeEvaluatedPlanVersion?: number;
  readonly judgeReady?: boolean;
  readonly criticCoverageGapIds: readonly string[];
  readonly criticScopeCoverageGapIds: readonly string[];
  readonly criticContextGapIds: readonly string[];
  readonly materialRevisionProofGapIds: readonly string[];
  readonly otherUnresolvedProofIds: readonly string[];
  readonly hasCanonicalBindingMismatch: boolean;
  readonly hasFreshReviewMismatch: boolean;
  readonly hasFinalArtifactMismatch: boolean;
  readonly hasJudgeInconsistency: boolean;
  readonly catalog: ReadinessProofCatalog;
  readonly sources: readonly OccurrenceSourceSlot[];
  readonly occurrenceCoverage: OccurrenceCoverageLedger;
  readonly reduction: ReadinessReduction;
}

export interface CreateReadinessProofStateInput {
  readonly quality: Quality;
  readonly matrix: QualityMatrix;
  readonly mode: RunMode;
  readonly sourceDigest: string;
  readonly authoritativeDigest: string;
  readonly relationshipIds: readonly string[];
  readonly maxIters: number;
  readonly trustedCatalog?: ReadinessProofCatalog;
  readonly findings?: readonly FindingRecord[];
  readonly invariants?: readonly ReadinessInvariantRecord[];
}

export interface RecordInterventionsInput {
  readonly interventionIds: readonly string[];
  readonly operatorDecisionIds?: readonly string[];
}

export interface RecordAuthoritativeContextInput {
  readonly authoritativeDigest: string;
  readonly relationshipIds: readonly string[];
}

export interface AdmittedCritiqueInput {
  readonly planVersion: number;
  readonly snapshot: OccurrenceCoverageSnapshot;
  readonly scanComplete: boolean;
  readonly declaredScopeVerified: boolean;
  readonly materialIssueIds: readonly string[];
  readonly issueBudgetUsed: number;
  readonly issueBudgetExhausted: boolean;
  readonly riskDomains: readonly ReadinessRiskDomainRecord[];
  readonly criticCoverageGapIds: readonly string[];
  readonly criticScopeCoverageGapIds: readonly string[];
  readonly criticContextGapIds: readonly string[];
  readonly boundaryChallenges: readonly BoundaryChallengeRecord[];
  readonly opportunities: readonly OpportunityRecord[];
}

export interface AdmittedCreatorUpdateInput {
  readonly fromPlanVersion: number;
  readonly nextCatalog: ReadinessProofCatalog;
  readonly findings: readonly FindingRecord[];
  readonly invariants: readonly ReadinessInvariantRecord[];
  readonly materialRevisionProofGapIds: readonly string[];
  readonly transitionReceipt: CreatorTransitionReceipt;
}

export type AdmittedFixReviewerProofInput =
  | {
      readonly required: true;
      readonly reason: string;
      readonly expectedBinding: OccurrenceSourceBinding;
      readonly snapshot?: OccurrenceCoverageSnapshot;
      readonly materialIssueIds: readonly string[];
    }
  | {
      readonly required: false;
      readonly reason: string;
    };

export interface AddReadinessLimitInput {
  readonly limit: ReadinessLimit;
  readonly unresolvedProofId?: string;
}

export interface AdmittedSystemProofInput {
  readonly binding: SystemProofBinding;
  readonly passed: boolean;
  readonly mismatchIds: readonly string[];
  readonly unavailableEvidenceIds: readonly string[];
}

export interface AdmittedJudgeProofInput {
  readonly stage: 'intermediate' | 'final';
  readonly snapshot: OccurrenceCoverageSnapshot;
  readonly verdict: boolean;
  readonly approvedPlanVersion?: number;
  readonly materialIssueIds: readonly string[];
}

export interface BindVersionedPlanInput {
  readonly planVersion: number;
  readonly planSha256: string;
  readonly criticLineageDigest: string;
  readonly intermediateJudgeLineageDigest?: string;
}

export interface BindCanonicalPlanInput {
  readonly planVersion: number;
  readonly canonicalPlanSha256: string;
  readonly finalJudgeLineageDigest?: string;
  readonly compatibleWithVersionedProof: boolean;
}

export interface FinalArtifactReviewInput {
  readonly planVersion: number;
  readonly canonicalPlanSha256: string;
  readonly fresh: boolean;
  readonly judgeConsistent: boolean;
}

export interface CreateOccurrenceSourceBindingInput {
  readonly source: OccurrenceSource;
  readonly candidateKind: OccurrenceCandidateKind;
  readonly contentDigest: string;
}

export interface OccurrenceSourceProjection extends OccurrenceSourceState {
  readonly reason: string;
  readonly expectedBinding?: OccurrenceSourceBinding;
  readonly snapshot?: OccurrenceCoverageSnapshot;
}

export interface OccurrenceCoverageProjection {
  readonly catalogDigest: string;
  readonly expectedPlanVersion: number;
  readonly riskDomainIds: readonly RiskDomain[];
  readonly invariants: readonly ReadinessInvariantCatalogEntry[];
  readonly materialIssueIds: readonly string[];
  readonly retainedContextCategories: readonly RetainedContextCategory[];
  readonly expectedOccurrenceIds: readonly string[];
  readonly sources: readonly OccurrenceSourceProjection[];
  readonly outcomes: readonly OccurrenceAggregateOutcome[];
  readonly resolvedOccurrenceIds: readonly string[];
  readonly violatedOccurrenceIds: readonly string[];
  readonly unresolvedOccurrenceIds: readonly string[];
  readonly disagreementOccurrenceIds: readonly string[];
  readonly catalogExact: boolean;
  readonly sourcesCurrent: boolean;
  readonly sourcesConclusive: boolean;
  readonly sourceConsistent: boolean;
  readonly proofSatisfied: boolean;
  readonly reasonCodes: readonly string[];
}

const CANDIDATE_KINDS = [
  'versioned-plan',
  'fix-proposal',
  'fix-applied',
  'canonical-plan',
] as const;
const OCCURRENCE_EVALUATION_STAGES = [
  'review',
  'fix-proposal-review',
  'fix-applied-review',
  'intermediate-readiness',
  'final-readiness',
] as const;
const RAW_DISPOSITIONS = ['satisfied', 'violated', 'not-applicable', 'unresolved'] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UNBOUND_SHA256_PATTERN = /^unbound:[0-9a-f]{64}$/;

function isOccurrenceCandidateKind(value: string): value is OccurrenceCandidateKind {
  return CANDIDATE_KINDS.some((candidateKind) => candidateKind === value);
}

function isOccurrenceEvaluationStage(value: string): value is OccurrenceEvaluationStage {
  return OCCURRENCE_EVALUATION_STAGES.some((stage) => stage === value);
}

const SOURCE_BINDINGS: Readonly<
  Record<
    OccurrenceSource,
    readonly {
      readonly kind: OccurrenceCandidateKind;
      readonly stage: OccurrenceEvaluationStage;
    }[]
  >
> = {
  critic: [{ kind: 'versioned-plan', stage: 'review' }],
  'fix-reviewer': [
    { kind: 'fix-proposal', stage: 'fix-proposal-review' },
    { kind: 'fix-applied', stage: 'fix-applied-review' },
  ],
  'intermediate-judge': [{ kind: 'versioned-plan', stage: 'intermediate-readiness' }],
  'final-judge': [{ kind: 'canonical-plan', stage: 'final-readiness' }],
};

export function createOccurrenceSourceBinding(
  state: ReadinessProofState,
  input: CreateOccurrenceSourceBindingInput,
): OccurrenceSourceBinding {
  const allowed = SOURCE_BINDINGS[input.source].find(
    (candidate) => candidate.kind === input.candidateKind,
  );
  if (allowed === undefined) {
    throw new TypeError(`candidate kind is invalid for source: ${input.source}`);
  }
  const contentDigest = requiredSha256(input.contentDigest, 'candidate contentDigest');
  const candidate: OccurrenceCandidateBinding = {
    kind: input.candidateKind,
    planVersion: state.planVersion,
    contentDigest,
  };
  return {
    candidate,
    lineage: {
      evaluationStage: allowed.stage,
      lineageDigest: canonicalJsonSha256({
        schemaVersion: state.schemaVersion,
        source: input.source,
        candidate,
        evaluationStage: allowed.stage,
        catalogDigest: state.catalog.digest,
        readinessContractDigest: state.readinessContractDigest ?? null,
        sourceDigest: state.sourceDigest,
        authoritativeDigest: state.authoritativeDigest,
        operatorDecisionIds: state.operatorDecisionIds,
        interventionIds: state.interventionIds,
      }),
    },
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sortedUnique<T extends string>(values: readonly T[], label: string): T[] {
  const normalized = values.map((value) => {
    requiredId(value, label);
    return value;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

function sortedSet<T extends string>(values: readonly T[], label: string): T[] {
  return [...new Set(values)].sort((left, right) => {
    requiredId(left, label);
    requiredId(right, label);
    return left.localeCompare(right);
  });
}

function requiredId(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredSha256(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase 64-character SHA-256 digest`);
  }
  return value;
}

function requiredOccurrenceBindingDigest(
  value: string,
  label: string,
  allowUnbound: boolean,
): boolean {
  if (SHA256_PATTERN.test(value)) {
    return false;
  }
  if (allowUnbound && UNBOUND_SHA256_PATTERN.test(value)) {
    return true;
  }
  throw new TypeError(
    `${label} must be a lowercase 64-character SHA-256 digest${allowUnbound ? ' or unbound SHA-256 digest' : ''}`,
  );
}

function copyBinding(
  binding: OccurrenceSourceBinding,
  allowUnbound = false,
): OccurrenceSourceBinding {
  assertBinding(binding, allowUnbound);
  return {
    candidate: {
      kind: binding.candidate.kind,
      planVersion: binding.candidate.planVersion,
      contentDigest: binding.candidate.contentDigest,
    },
    lineage: {
      evaluationStage: binding.lineage.evaluationStage,
      lineageDigest: binding.lineage.lineageDigest,
    },
  };
}

function copyRequirement(
  source: OccurrenceSource,
  requirement: OccurrenceSourceRequirement,
): OccurrenceSourceRequirement {
  if (source === 'critic' && !requirement.required) {
    throw new TypeError('critic occurrence source must be required');
  }
  const allowedReasons = requirement.required
    ? SOURCE_REQUIREMENT_REASONS[source].required
    : SOURCE_REQUIREMENT_REASONS[source].exempt;
  if (!(allowedReasons as readonly string[]).includes(requirement.reason)) {
    throw new TypeError(`source requirement reason is invalid for ${source}`);
  }
  return requirement.required
    ? {
        required: true,
        reason: requirement.reason,
        expectedBinding: copyBinding(requirement.expectedBinding, true),
      }
    : { required: false, reason: requirement.reason };
}

function assertBinding(binding: OccurrenceSourceBinding, allowUnbound = false): void {
  if (!CANDIDATE_KINDS.includes(binding.candidate.kind)) {
    throw new TypeError('candidate kind is invalid');
  }
  if (!Number.isInteger(binding.candidate.planVersion) || binding.candidate.planVersion < 0) {
    throw new TypeError('candidate planVersion must be a non-negative integer');
  }
  const candidateUnbound = requiredOccurrenceBindingDigest(
    binding.candidate.contentDigest,
    'candidate contentDigest',
    allowUnbound,
  );
  requiredId(binding.lineage.evaluationStage, 'lineage evaluationStage');
  const lineageUnbound = requiredOccurrenceBindingDigest(
    binding.lineage.lineageDigest,
    'lineage lineageDigest',
    allowUnbound,
  );
  if (candidateUnbound !== lineageUnbound) {
    throw new TypeError('occurrence binding must not mix bound and unbound digests');
  }
}

function assertSourceBinding(
  source: OccurrenceSource,
  binding: OccurrenceSourceBinding,
  allowUnbound = false,
): void {
  assertBinding(binding, allowUnbound);
  if (
    !SOURCE_BINDINGS[source].some(
      (allowed) =>
        allowed.kind === binding.candidate.kind &&
        allowed.stage === binding.lineage.evaluationStage,
    )
  ) {
    throw new TypeError(`candidate binding is invalid for source: ${source}`);
  }
}

function bindingMatches(left: OccurrenceSourceBinding, right: OccurrenceSourceBinding): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function copySnapshot(snapshot: OccurrenceCoverageSnapshot): OccurrenceCoverageSnapshot {
  if (!OCCURRENCE_SOURCES.includes(snapshot.source)) {
    throw new TypeError('occurrence source is invalid');
  }
  requiredSha256(snapshot.catalogDigest, 'snapshot catalogDigest');
  const occurrences = snapshot.occurrences.map((entry) => {
    const rawEntry: { readonly evidenceGrounded?: unknown } = entry;
    const evidenceGrounded = rawEntry.evidenceGrounded;
    requiredId(entry.invariantId, 'snapshot invariantId');
    requiredId(entry.occurrenceId, 'snapshot occurrenceId');
    if (!RAW_DISPOSITIONS.includes(entry.disposition)) {
      throw new TypeError('snapshot disposition is invalid');
    }
    if (typeof evidenceGrounded !== 'boolean') {
      throw new TypeError('snapshot evidenceGrounded must be boolean');
    }
    if (entry.disposition !== 'unresolved' && !evidenceGrounded) {
      throw new TypeError(`${entry.disposition} occurrence evidence must be grounded`);
    }
    return {
      invariantId: entry.invariantId,
      occurrenceId: entry.occurrenceId,
      disposition: entry.disposition,
      evidenceGrounded,
    } as AdmittedOccurrenceDisposition;
  });
  occurrences.sort((left, right) => {
    return (
      left.occurrenceId.localeCompare(right.occurrenceId) ||
      left.invariantId.localeCompare(right.invariantId) ||
      left.disposition.localeCompare(right.disposition)
    );
  });
  return {
    source: snapshot.source,
    catalogDigest: snapshot.catalogDigest,
    binding: copyBinding(snapshot.binding),
    occurrences,
  };
}

export function createReadinessProofCatalog(
  input: CreateReadinessProofCatalogInput,
): ReadinessProofCatalog {
  if (!Number.isInteger(input.expectedPlanVersion) || input.expectedPlanVersion < 0) {
    throw new TypeError('expectedPlanVersion must be a non-negative integer');
  }
  const invariantIds = sortedUnique(
    input.invariants.map((invariant) => invariant.invariantId),
    'catalog invariant IDs',
  );
  const byInvariantId = new Map(
    input.invariants.map((invariant) => [invariant.invariantId, invariant] as const),
  );
  const occurrenceIds = new Set<string>();
  const invariants = invariantIds.map((invariantId) => {
    const inputInvariant = byInvariantId.get(invariantId);
    if (inputInvariant === undefined) {
      throw new TypeError(`catalog invariant is unavailable: ${invariantId}`);
    }
    const normalizedOccurrenceIds = sortedUnique(
      inputInvariant.occurrenceIds,
      `catalog occurrence IDs for ${invariantId}`,
    );
    for (const occurrenceId of normalizedOccurrenceIds) {
      if (occurrenceIds.has(occurrenceId)) {
        throw new TypeError(`catalog occurrence belongs to multiple invariants: ${occurrenceId}`);
      }
      occurrenceIds.add(occurrenceId);
    }
    return { invariantId, occurrenceIds: normalizedOccurrenceIds };
  });
  const identity = {
    expectedPlanVersion: input.expectedPlanVersion,
    riskDomainIds: [...READINESS_RISK_DOMAINS],
    invariants,
    materialIssueIds: sortedUnique(input.materialIssueIds, 'catalog material issue IDs'),
    retainedContextCategories: [...RETAINED_CONTEXT_CATEGORIES],
  };
  return {
    ...identity,
    digest: canonicalJsonSha256(identity),
  };
}

function catalogOccurrenceMap(catalog: ReadinessProofCatalog): Map<string, string> {
  return new Map(
    catalog.invariants.flatMap((invariant) =>
      invariant.occurrenceIds.map((occurrenceId) => [occurrenceId, invariant.invariantId] as const),
    ),
  );
}

function normalizedOutcome(entry: AdmittedOccurrenceDisposition): NormalizedOccurrenceOutcome {
  if (entry.disposition === 'violated') {
    return 'violated';
  }
  if (entry.disposition === 'unresolved') {
    return 'unresolved';
  }
  return 'resolved';
}

interface PreliminarySourceState {
  readonly slot: OccurrenceSourceSlot;
  readonly required: boolean;
  readonly available: boolean;
  readonly catalogExact: boolean;
  readonly current: boolean;
  readonly conclusive: boolean;
}

function snapshotCatalogExact(
  catalog: ReadinessProofCatalog,
  snapshot: OccurrenceCoverageSnapshot | undefined,
): boolean {
  if (snapshot?.catalogDigest !== catalog.digest) {
    return false;
  }
  const expected = catalogOccurrenceMap(catalog);
  if (snapshot.occurrences.length !== expected.size) {
    return false;
  }
  const seen = new Set<string>();
  for (const entry of snapshot.occurrences) {
    if (seen.has(entry.occurrenceId) || expected.get(entry.occurrenceId) !== entry.invariantId) {
      return false;
    }
    seen.add(entry.occurrenceId);
  }
  return seen.size === expected.size;
}

function preliminarySourceState(
  catalog: ReadinessProofCatalog,
  slot: OccurrenceSourceSlot,
): PreliminarySourceState {
  if (!slot.requirement.required) {
    return {
      slot,
      required: false,
      available: slot.snapshot !== undefined,
      catalogExact: true,
      current: true,
      conclusive: true,
    };
  }
  const catalogExact = snapshotCatalogExact(catalog, slot.snapshot);
  const current =
    slot.snapshot !== undefined &&
    bindingMatches(slot.snapshot.binding, slot.requirement.expectedBinding);
  const conclusive =
    catalogExact &&
    current &&
    slot.snapshot.occurrences.every((entry) => normalizedOutcome(entry) !== 'unresolved');
  return {
    slot,
    required: true,
    available: slot.snapshot !== undefined,
    catalogExact,
    current,
    conclusive,
  };
}

interface SourceOccurrenceOutcome {
  readonly source: OccurrenceSource;
  readonly outcome: NormalizedOccurrenceOutcome;
}

function sourceOutcomeForOccurrence(
  sourceState: PreliminarySourceState,
  invariantId: string,
  occurrenceId: string,
): SourceOccurrenceOutcome {
  if (
    !sourceState.required ||
    !sourceState.catalogExact ||
    !sourceState.current ||
    sourceState.slot.snapshot === undefined
  ) {
    return { source: sourceState.slot.source, outcome: 'unresolved' };
  }
  const entry = sourceState.slot.snapshot.occurrences.find(
    (candidate) => candidate.invariantId === invariantId && candidate.occurrenceId === occurrenceId,
  );
  return {
    source: sourceState.slot.source,
    outcome: entry === undefined ? 'unresolved' : normalizedOutcome(entry),
  };
}

function coverageReasonCodes(
  sourceStates: readonly OccurrenceSourceState[],
  violatedOccurrenceIds: readonly string[],
  unresolvedOccurrenceIds: readonly string[],
  disagreementOccurrenceIds: readonly string[],
): string[] {
  const reasons: string[] = [];
  for (const source of sourceStates.filter((candidate) => candidate.required)) {
    if (!source.available) {
      reasons.push(`occurrence-source:${source.source}:missing`);
    }
    if (!source.catalogExact) {
      reasons.push(`occurrence-source:${source.source}:catalog-inexact`);
    }
    if (!source.current) {
      reasons.push(`occurrence-source:${source.source}:stale`);
    }
    if (!source.conclusive) {
      reasons.push(`occurrence-source:${source.source}:inconclusive`);
    }
    if (!source.consistent) {
      reasons.push(`occurrence-source:${source.source}:inconsistent`);
    }
  }
  reasons.push(
    ...violatedOccurrenceIds.map((occurrenceId) => `occurrence:${occurrenceId}:violated`),
    ...unresolvedOccurrenceIds.map((occurrenceId) => `occurrence:${occurrenceId}:unresolved`),
    ...disagreementOccurrenceIds.map((occurrenceId) => `occurrence:${occurrenceId}:disagreement`),
  );
  return reasons;
}

function reconcileOccurrenceCoverage(
  catalog: ReadinessProofCatalog,
  slots: readonly OccurrenceSourceSlot[],
): OccurrenceCoverageLedger {
  const preliminary = slots.map((slot) => preliminarySourceState(catalog, slot));
  const requiredSources = preliminary.filter((source) => source.required);
  const disagreementSources = new Set<OccurrenceSource>();
  const disagreementOccurrenceIds: string[] = [];
  const outcomes: OccurrenceAggregateOutcome[] = [];

  for (const invariant of catalog.invariants) {
    for (const occurrenceId of invariant.occurrenceIds) {
      const sourceOutcomes = requiredSources.map((source) =>
        sourceOutcomeForOccurrence(source, invariant.invariantId, occurrenceId),
      );
      const resolvedSources = sourceOutcomes.filter((entry) => entry.outcome === 'resolved');
      const violatedSources = sourceOutcomes.filter((entry) => entry.outcome === 'violated');
      const disagreement = resolvedSources.length > 0 && violatedSources.length > 0;
      if (disagreement) {
        disagreementOccurrenceIds.push(occurrenceId);
        for (const entry of [...resolvedSources, ...violatedSources]) {
          disagreementSources.add(entry.source);
        }
      }
      const outcome: NormalizedOccurrenceOutcome =
        violatedSources.length > 0
          ? 'violated'
          : sourceOutcomes.every((entry) => entry.outcome === 'resolved')
            ? 'resolved'
            : 'unresolved';
      outcomes.push({ invariantId: invariant.invariantId, occurrenceId, outcome });
    }
  }

  const sourceStates = preliminary.map((source) => ({
    source: source.slot.source,
    required: source.required,
    available: source.available,
    catalogExact: source.catalogExact,
    current: source.current,
    consistent: !disagreementSources.has(source.slot.source),
    conclusive: source.conclusive,
  }));
  const resolvedOccurrenceIds = outcomes
    .filter((outcome) => outcome.outcome === 'resolved')
    .map((outcome) => outcome.occurrenceId);
  const violatedOccurrenceIds = outcomes
    .filter((outcome) => outcome.outcome === 'violated')
    .map((outcome) => outcome.occurrenceId);
  const unresolvedOccurrenceIds = outcomes
    .filter((outcome) => outcome.outcome === 'unresolved')
    .map((outcome) => outcome.occurrenceId);
  const catalogExact = sourceStates
    .filter((source) => source.required)
    .every((source) => source.catalogExact);
  const sourcesCurrent = sourceStates
    .filter((source) => source.required)
    .every((source) => source.current);
  const sourcesConclusive = sourceStates
    .filter((source) => source.required)
    .every((source) => source.conclusive);
  const sourceConsistent = sourceStates
    .filter((source) => source.required)
    .every((source) => source.consistent);
  const proofSatisfied =
    catalogExact &&
    sourcesCurrent &&
    sourcesConclusive &&
    sourceConsistent &&
    violatedOccurrenceIds.length === 0 &&
    unresolvedOccurrenceIds.length === 0 &&
    disagreementOccurrenceIds.length === 0;

  return {
    expectedOccurrenceIds: outcomes.map((outcome) => outcome.occurrenceId),
    sources: sourceStates,
    outcomes,
    resolvedOccurrenceIds,
    violatedOccurrenceIds,
    unresolvedOccurrenceIds,
    disagreementOccurrenceIds,
    catalogExact,
    sourcesCurrent,
    sourcesConclusive,
    sourceConsistent,
    proofSatisfied,
    reasonCodes: coverageReasonCodes(
      sourceStates,
      violatedOccurrenceIds,
      unresolvedOccurrenceIds,
      disagreementOccurrenceIds,
    ),
  };
}

function defaultRequirement(): OccurrenceSourceRequirement {
  return { required: false, reason: 'not-required' };
}

export const READINESS_ISSUE_BUDGET = 8;
const UNBOUND_BINDING_PREFIX = 'unbound:';
const QUALITY_VALUES = ['quick', 'balanced', 'thorough'] as const;
const COMPLETENESS_PROMISES = ['best-effort', 'cumulative', 'exhaustive'] as const;
const READINESS_LIMITS = ['issue-budget', 'iteration-cap', 'assurance-appetite'] as const;

type ReadinessProofSeed = Omit<
  ReadinessProofState,
  'schemaVersion' | 'occurrenceCoverage' | 'reduction'
>;
type OptionalReadinessProofSeedKey =
  | 'planSha256'
  | 'canonicalPlanSha256'
  | 'creatorTransitionReceipt'
  | 'lastCritiquedPlanVersion'
  | 'systemProofBinding'
  | 'readinessContractDigest'
  | 'judgeApprovedPlanVersion'
  | 'judgeEvaluatedPlanVersion'
  | 'judgeReady';
type ReadinessProofSeedOverrides = Partial<
  Omit<ReadinessProofSeed, OptionalReadinessProofSeedKey>
> & {
  [Key in OptionalReadinessProofSeedKey]?: ReadinessProofSeed[Key] | undefined;
};
type ReadinessProofWithoutReduction = Omit<ReadinessProofState, 'reduction'>;

function copyCreatorTransitionReceipt(receipt: CreatorTransitionReceipt): CreatorTransitionReceipt {
  const digests = [
    receipt.fromCatalogDigest,
    receipt.expectedIssuesDigest,
    receipt.updateDigest,
    receipt.candidateDigest,
    receipt.nextCatalogDigest,
    receipt.admittedFactsDigest,
    receipt.admittedCriticIssueRefsDigest,
  ];
  if (
    !Number.isInteger(receipt.fromPlanVersion) ||
    receipt.fromPlanVersion < 0 ||
    receipt.toPlanVersion !== receipt.fromPlanVersion + 1 ||
    digests.some((digest) => !/^[a-f0-9]{64}$/.test(digest))
  ) {
    throw new TypeError('creator transition receipt is invalid');
  }
  return { ...receipt };
}

function copyFindings(findings: readonly FindingRecord[]): FindingRecord[] {
  const ids = sortedUnique(
    findings.map((finding) => finding.id),
    'finding IDs',
  );
  const byId = new Map(findings.map((finding) => [finding.id, finding] as const));
  return ids.map((id) => {
    const finding = byId.get(id);
    if (finding === undefined) {
      throw new TypeError(`finding is unavailable: ${id}`);
    }
    requiredId(finding.issueRef, 'finding issueRef');
    requiredId(finding.claim, 'finding claim');
    requiredId(finding.disposition.rationale, 'finding disposition rationale');
    if (!Number.isInteger(finding.introducedPlanVersion) || finding.introducedPlanVersion < 0) {
      throw new TypeError('finding introducedPlanVersion must be a non-negative integer');
    }
    const rawFinding: { readonly severity?: unknown } = finding;
    if (rawFinding.severity !== 'blocker' && rawFinding.severity !== 'major') {
      throw new TypeError('finding severity is invalid');
    }
    if (!['local', 'cross-cutting', 'unresolved'].includes(finding.disposition.scope)) {
      throw new TypeError('finding disposition scope is invalid');
    }
    return {
      id,
      issueRef: finding.issueRef,
      introducedPlanVersion: finding.introducedPlanVersion,
      severity: finding.severity,
      claim: finding.claim,
      disposition: {
        scope: finding.disposition.scope,
        rationale: finding.disposition.rationale,
        evidenceRefs: finding.disposition.evidenceRefs.map(cloneJsonValue),
        ...(finding.disposition.supersededBy === undefined
          ? {}
          : {
              supersededBy: requiredId(
                finding.disposition.supersededBy,
                'finding disposition supersededBy',
              ),
            }),
      },
    };
  });
}

function copyInvariants(
  invariants: readonly ReadinessInvariantRecord[],
): ReadinessInvariantRecord[] {
  const ids = sortedUnique(
    invariants.map((invariant) => invariant.id),
    'invariant record IDs',
  );
  const byId = new Map(invariants.map((invariant) => [invariant.id, invariant] as const));
  const occurrenceIds = new Set<string>();
  return ids.map((id) => {
    const invariant = byId.get(id);
    if (invariant === undefined) {
      throw new TypeError(`invariant record is unavailable: ${id}`);
    }
    requiredId(invariant.sourceFinding, 'invariant sourceFinding');
    requiredId(invariant.statement, 'invariant statement');
    const orderedOccurrenceIds = sortedUnique(
      invariant.occurrences.map((occurrence) => occurrence.id),
      `invariant occurrence IDs for ${id}`,
    );
    const byOccurrenceId = new Map(
      invariant.occurrences.map((occurrence) => [occurrence.id, occurrence] as const),
    );
    return {
      id,
      sourceFinding: invariant.sourceFinding,
      statement: invariant.statement,
      occurrences: orderedOccurrenceIds.map((occurrenceId) => {
        if (occurrenceIds.has(occurrenceId)) {
          throw new TypeError(`invariant occurrence belongs to multiple records: ${occurrenceId}`);
        }
        occurrenceIds.add(occurrenceId);
        const occurrence = byOccurrenceId.get(occurrenceId);
        if (occurrence === undefined) {
          throw new TypeError(`invariant occurrence is unavailable: ${occurrenceId}`);
        }
        return {
          id: occurrenceId,
          dimension: requiredId(occurrence.dimension, 'invariant occurrence dimension'),
          subject: requiredId(occurrence.subject, 'invariant occurrence subject'),
        };
      }),
    };
  });
}

function copyContextDelivery(delivery: ContextDelivery): ContextDelivery {
  const rawDelivery: {
    readonly role?: unknown;
    readonly inputLimitSource?: unknown;
  } = delivery;
  if (
    !['creator', 'critic', 'fixer', 'reviewer', 'translator', 'judge'].includes(
      String(rawDelivery.role),
    )
  ) {
    throw new TypeError('context delivery role is invalid');
  }
  if (!['operator', 'model-registry', 'unknown'].includes(String(rawDelivery.inputLimitSource))) {
    throw new TypeError('context delivery inputLimitSource is invalid');
  }
  requiredId(delivery.stage, 'context delivery stage');
  if (!Number.isInteger(delivery.planVersion) || delivery.planVersion < 0) {
    throw new TypeError('context delivery planVersion must be a non-negative integer');
  }
  for (const value of [delivery.mandatoryBytes, delivery.optionalBytes, delivery.totalInputBytes]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError('context delivery byte counts must be non-negative integers');
    }
  }
  if (
    delivery.inputTokenLimit !== null &&
    (!Number.isInteger(delivery.inputTokenLimit) || delivery.inputTokenLimit < 0)
  ) {
    throw new TypeError('context delivery inputTokenLimit must be null or a non-negative integer');
  }
  return {
    role: delivery.role,
    stage: delivery.stage,
    planVersion: delivery.planVersion,
    mandatoryBytes: delivery.mandatoryBytes,
    optionalBytes: delivery.optionalBytes,
    totalInputBytes: delivery.totalInputBytes,
    inputTokenLimit: delivery.inputTokenLimit,
    inputLimitSource: delivery.inputLimitSource,
    reductions: delivery.reductions.map((reduction) => {
      if (!Number.isInteger(reduction.bytes) || reduction.bytes < 0) {
        throw new TypeError('context reduction bytes must be a non-negative integer');
      }
      return {
        category: requiredId(reduction.category, 'context reduction category'),
        bytes: reduction.bytes,
      };
    }),
    omittedCategories: sortedUnique(delivery.omittedCategories, 'omitted context categories'),
  };
}

function copyRiskDomains(
  riskDomains: readonly ReadinessRiskDomainRecord[],
): ReadinessRiskDomainRecord[] {
  const seen = new Set<RiskDomain>();
  for (const assessment of riskDomains) {
    if (seen.has(assessment.domain)) {
      throw new TypeError(`risk domain assessments contain a duplicate: ${assessment.domain}`);
    }
    seen.add(assessment.domain);
  }
  return READINESS_RISK_DOMAINS.flatMap((domain) => {
    const assessment = riskDomains.find((entry) => entry.domain === domain);
    if (assessment === undefined) {
      return [];
    }
    requiredId(assessment.rationale, 'risk domain rationale');
    const rawAssessment: {
      readonly applicability?: unknown;
      readonly risk?: unknown;
      readonly complete?: unknown;
    } = assessment;
    if (
      !['applicable', 'not-applicable', 'unknown'].includes(String(rawAssessment.applicability))
    ) {
      throw new TypeError('risk domain applicability is invalid');
    }
    if (!['standard', 'high'].includes(String(rawAssessment.risk))) {
      throw new TypeError('risk domain risk is invalid');
    }
    if (typeof rawAssessment.complete !== 'boolean') {
      throw new TypeError('risk domain complete must be boolean');
    }
    if (
      assessment.lastAssessedPlanVersion !== undefined &&
      (!Number.isInteger(assessment.lastAssessedPlanVersion) ||
        assessment.lastAssessedPlanVersion < 0)
    ) {
      throw new TypeError('risk domain lastAssessedPlanVersion must be a non-negative integer');
    }
    return [
      {
        domain,
        applicability: assessment.applicability,
        risk: assessment.risk,
        rationale: assessment.rationale,
        evidenceRefs: assessment.evidenceRefs.map(cloneJsonValue),
        complete: assessment.complete,
        unavailableEvidence: sortedUnique(
          assessment.unavailableEvidence,
          `unavailable evidence for ${domain}`,
        ),
        ...(assessment.lastAssessedPlanVersion === undefined
          ? {}
          : { lastAssessedPlanVersion: assessment.lastAssessedPlanVersion }),
      },
    ];
  });
}

function invalidateRiskDomainAssessment(
  assessment: ReadinessRiskDomainRecord,
): ReadinessRiskDomainRecord {
  return {
    domain: assessment.domain,
    applicability: assessment.applicability,
    risk: assessment.risk,
    rationale: assessment.rationale,
    evidenceRefs: assessment.evidenceRefs.map(cloneJsonValue),
    complete: false,
    unavailableEvidence: [],
  };
}

function copyBoundaryChallenges(
  challenges: readonly BoundaryChallengeRecord[],
): BoundaryChallengeRecord[] {
  const ids = sortedUnique(
    challenges.map((challenge) => challenge.id),
    'boundary challenge IDs',
  );
  const byId = new Map(challenges.map((challenge) => [challenge.id, challenge] as const));
  return ids.map((id) => {
    const challenge = byId.get(id);
    if (challenge === undefined) {
      throw new TypeError(`boundary challenge is unavailable: ${id}`);
    }
    if (!Number.isInteger(challenge.planVersion) || challenge.planVersion < 0) {
      throw new TypeError('boundary challenge planVersion must be a non-negative integer');
    }
    const rawChallenge: { readonly kind?: unknown } = challenge;
    if (
      !['scope-expansion', 'out-of-scope-removal', 'assurance-appetite'].includes(
        String(rawChallenge.kind),
      )
    ) {
      throw new TypeError('boundary challenge kind is invalid');
    }
    return {
      id,
      kind: challenge.kind,
      claim: requiredId(challenge.claim, 'boundary challenge claim'),
      rationale: requiredId(challenge.rationale, 'boundary challenge rationale'),
      evidenceRefs: challenge.evidenceRefs.map(cloneJsonValue),
      planVersion: challenge.planVersion,
    };
  });
}

function copyOpportunities(opportunities: readonly OpportunityRecord[]): OpportunityRecord[] {
  const fingerprints = sortedUnique(
    opportunities.map((opportunity) => opportunity.fingerprint),
    'opportunity fingerprints',
  );
  const byFingerprint = new Map(
    opportunities.map((opportunity) => [opportunity.fingerprint, opportunity] as const),
  );
  return fingerprints.map((fingerprint) => {
    const opportunity = byFingerprint.get(fingerprint);
    if (opportunity === undefined) {
      throw new TypeError(`opportunity is unavailable: ${fingerprint}`);
    }
    if (
      !Number.isInteger(opportunity.firstSeenPlanVersion) ||
      opportunity.firstSeenPlanVersion < 0 ||
      !Number.isInteger(opportunity.lastSeenPlanVersion) ||
      opportunity.lastSeenPlanVersion < opportunity.firstSeenPlanVersion
    ) {
      throw new TypeError('opportunity plan versions are invalid');
    }
    return {
      fingerprint,
      claim: requiredId(opportunity.claim, 'opportunity claim'),
      evidence: opportunity.evidence,
      suggestedImprovement: requiredId(
        opportunity.suggestedImprovement,
        'opportunity suggestedImprovement',
      ),
      evidenceRefs: opportunity.evidenceRefs.map(cloneJsonValue),
      firstSeenPlanVersion: opportunity.firstSeenPlanVersion,
      lastSeenPlanVersion: opportunity.lastSeenPlanVersion,
    };
  });
}

function canonicalCatalog(catalog: ReadinessProofCatalog): ReadinessProofCatalog {
  requiredSha256(catalog.digest, 'catalog digest');
  const canonical = createReadinessProofCatalog({
    expectedPlanVersion: catalog.expectedPlanVersion,
    invariants: catalog.invariants,
    materialIssueIds: catalog.materialIssueIds,
  });
  if (canonicalJson(canonical) !== canonicalJson(catalog)) {
    throw new TypeError('readiness proof catalog is not canonical');
  }
  return canonical;
}

function copySourceSlots(
  catalog: ReadinessProofCatalog,
  sources: readonly OccurrenceSourceSlot[],
): OccurrenceSourceSlot[] {
  const copiedSources = OCCURRENCE_SOURCES.map((source) => {
    const slot = sources.find((candidate) => candidate.source === source);
    if (slot === undefined) {
      throw new TypeError(`occurrence source slot is unavailable: ${source}`);
    }
    const requirement = copyRequirement(source, slot.requirement);
    return {
      source,
      requirement,
      ...(slot.snapshot === undefined ? {} : { snapshot: copySnapshot(slot.snapshot) }),
    };
  });
  if (new Set(sources.map((source) => source.source)).size !== OCCURRENCE_SOURCES.length) {
    throw new TypeError('occurrence sources must contain every source exactly once');
  }
  for (const slot of copiedSources) {
    if (slot.source === 'critic' && !slot.requirement.required) {
      throw new TypeError('critic occurrence source must be required');
    }
    if (
      slot.requirement.required &&
      slot.requirement.expectedBinding.candidate.planVersion !== catalog.expectedPlanVersion
    ) {
      throw new TypeError(`source binding plan version does not match catalog: ${slot.source}`);
    }
    if (slot.requirement.required) {
      assertSourceBinding(slot.source, slot.requirement.expectedBinding, true);
    }
  }
  return copiedSources;
}

function activeInvariantIds(
  catalog: ReadinessProofCatalog,
  coverage: OccurrenceCoverageLedger,
): string[] {
  const resolved = new Set(coverage.resolvedOccurrenceIds);
  return catalog.invariants
    .filter(
      (invariant) =>
        invariant.occurrenceIds.length === 0 ||
        invariant.occurrenceIds.some((occurrenceId) => !resolved.has(occurrenceId)),
    )
    .map((invariant) => invariant.invariantId);
}

function readinessFacts(state: ReadinessProofWithoutReduction): ReadinessFacts {
  const applicableRiskDomains = state.riskDomains.filter(
    (assessment) => assessment.applicability === 'applicable',
  );
  const deterministicProofRequired = applicableRiskDomains.some(
    (assessment) => assessment.domain === 'cross-repository-delivery',
  );
  const applicableDomainAssessmentIncomplete = applicableRiskDomains.some(
    (assessment) =>
      !assessment.complete || assessment.lastAssessedPlanVersion !== state.planVersion,
  );
  const unavailableEvidenceIds = [
    ...state.requiredEvidenceUnavailable,
    ...applicableRiskDomains.flatMap((assessment) =>
      assessment.unavailableEvidence.map((evidence) =>
        stableTupleId('domain-evidence-unavailable', [assessment.domain, evidence]),
      ),
    ),
  ];
  const contextOmissionIds = state.requiresExhaustiveScan
    ? state.contextDeliveries.flatMap((delivery) =>
        delivery.omittedCategories.map((category) =>
          stableTupleId('context-omission', [
            delivery.role,
            delivery.stage,
            delivery.planVersion,
            category,
          ]),
        ),
      )
    : [];
  const critic = state.occurrenceCoverage.sources.find((source) => source.source === 'critic');
  const judgeRequired = state.riskDomains.some(
    (assessment) => assessment.applicability === 'applicable' && assessment.risk === 'high',
  );
  return {
    planVersion: state.planVersion,
    boundaryChallengeIds: state.boundaryChallenges.map((challenge) => challenge.id),
    unresolvedMaterialQuestionIds: state.unresolvedMaterialQuestionIds,
    unknownRiskDomainIds: state.riskDomains
      .filter((assessment) => assessment.applicability === 'unknown')
      .map((assessment) => assessment.domain),
    unavailableEvidenceIds: [...new Set(unavailableEvidenceIds)],
    hasCanonicalBindingMismatch: state.hasCanonicalBindingMismatch,
    hasFreshReviewMismatch: state.hasFreshReviewMismatch,
    hasFinalArtifactMismatch: state.hasFinalArtifactMismatch,
    hasJudgeInconsistency: state.hasJudgeInconsistency,
    exhaustedLimits: state.exhaustedLimits,
    materialIssueIds: state.currentActionableIssues,
    deterministicMismatchIds: deterministicProofRequired ? state.systemMismatchIds : [],
    isIndependentReviewCurrent:
      state.lastCritiquedPlanVersion === state.planVersion &&
      critic?.available === true &&
      critic.current,
    isApplicableDomainScanComplete: state.scanComplete && !applicableDomainAssessmentIncomplete,
    isExhaustiveApplicableScanRequired: state.exhaustiveApplicableDomains,
    isDeterministicProofRequired: deterministicProofRequired,
    isDeterministicProofComplete: state.systemCheckPassed,
    activeInvariantIds: activeInvariantIds(state.catalog, state.occurrenceCoverage),
    occurrenceSources: state.occurrenceCoverage.sources.map((source) => ({ ...source })),
    resolvedOccurrenceIds: state.occurrenceCoverage.resolvedOccurrenceIds,
    violatedOccurrenceIds: state.occurrenceCoverage.violatedOccurrenceIds,
    unresolvedOccurrenceIds: state.occurrenceCoverage.unresolvedOccurrenceIds,
    disagreementOccurrenceIds: state.occurrenceCoverage.disagreementOccurrenceIds,
    isOccurrenceProofSatisfied: state.occurrenceCoverage.proofSatisfied,
    judge: {
      required: judgeRequired,
      allowed: state.judgeAllowed,
      ...(state.judgeEvaluatedPlanVersion === undefined
        ? {}
        : { evaluatedPlanVersion: state.judgeEvaluatedPlanVersion }),
      ...(state.judgeApprovedPlanVersion === undefined
        ? {}
        : { approvedPlanVersion: state.judgeApprovedPlanVersion }),
      ...(state.judgeReady === undefined ? {} : { verdict: state.judgeReady }),
    },
    criticCoverageGapIds: state.criticCoverageGapIds,
    criticScopeCoverageGapIds: state.criticScopeCoverageGapIds,
    criticContextGapIds: state.criticContextGapIds,
    materialRevisionProofGapIds: state.materialRevisionProofGapIds,
    otherUnresolvedProofIds: [...state.otherUnresolvedProofIds, ...contextOmissionIds],
  };
}

function buildState(seed: ReadinessProofSeed): ReadinessProofState {
  if (!Number.isInteger(seed.planVersion) || seed.planVersion < 0) {
    throw new TypeError('planVersion must be a non-negative integer');
  }
  if (!QUALITY_VALUES.includes(seed.quality)) {
    throw new TypeError('quality is invalid');
  }
  if (!COMPLETENESS_PROMISES.includes(seed.promise)) {
    throw new TypeError('promise is invalid');
  }
  const expectedPromise: CompletenessPromise =
    seed.quality === 'quick'
      ? 'best-effort'
      : seed.quality === 'balanced'
        ? 'cumulative'
        : 'exhaustive';
  if (seed.promise !== expectedPromise) {
    throw new TypeError('promise must match quality');
  }
  if (seed.requiredProofLevel !== seed.promise) {
    throw new TypeError('requiredProofLevel must equal promise');
  }
  if (seed.requiresExhaustiveScan !== (seed.quality === 'thorough')) {
    throw new TypeError('requiresExhaustiveScan must match quality');
  }
  if (seed.exhaustiveApplicableDomains !== seed.requiresExhaustiveScan) {
    throw new TypeError('exhaustiveApplicableDomains must match exhaustive scan policy');
  }
  if (seed.judgeAllowed !== (seed.quality !== 'quick')) {
    throw new TypeError('judgeAllowed must match quality');
  }
  if (seed.originalRequestAvailable !== (seed.scopeSource === 'prompt')) {
    throw new TypeError('originalRequestAvailable must match scopeSource');
  }
  requiredSha256(seed.sourceDigest, 'sourceDigest');
  requiredSha256(seed.authoritativeDigest, 'authoritativeDigest');
  if (seed.planSha256 !== undefined) {
    requiredSha256(seed.planSha256, 'planSha256');
  }
  if (seed.canonicalPlanSha256 !== undefined) {
    requiredSha256(seed.canonicalPlanSha256, 'canonicalPlanSha256');
  }
  if (seed.readinessContractDigest !== undefined) {
    requiredSha256(seed.readinessContractDigest, 'readinessContractDigest');
  }
  const catalog = canonicalCatalog(seed.catalog);
  if (seed.planVersion !== catalog.expectedPlanVersion) {
    throw new TypeError('planVersion must equal catalog expectedPlanVersion');
  }
  const creatorTransitionReceipt =
    seed.creatorTransitionReceipt === undefined
      ? undefined
      : copyCreatorTransitionReceipt(seed.creatorTransitionReceipt);
  if (
    creatorTransitionReceipt !== undefined &&
    (creatorTransitionReceipt.toPlanVersion !== seed.planVersion ||
      creatorTransitionReceipt.nextCatalogDigest !== catalog.digest ||
      (seed.planSha256 !== undefined &&
        creatorTransitionReceipt.candidateDigest !== seed.planSha256))
  ) {
    throw new TypeError('creator transition receipt does not match the current candidate');
  }
  if (!Number.isInteger(seed.issueBudget.limit) || seed.issueBudget.limit < 0) {
    throw new TypeError('issueBudget.limit must be a non-negative integer');
  }
  if (!Number.isInteger(seed.issueBudget.used) || seed.issueBudget.used < 0) {
    throw new TypeError('issueBudget.used must be a non-negative integer');
  }
  if (seed.issueBudget.used > seed.issueBudget.limit && !seed.issueBudget.exhausted) {
    throw new TypeError('issueBudget must be exhausted when used exceeds limit');
  }
  if (!Number.isInteger(seed.iterationLimit) || seed.iterationLimit < 1) {
    throw new TypeError('iterationLimit must be a positive integer');
  }
  for (const [label, version] of [
    ['lastCritiquedPlanVersion', seed.lastCritiquedPlanVersion],
    ['judgeApprovedPlanVersion', seed.judgeApprovedPlanVersion],
    ['judgeEvaluatedPlanVersion', seed.judgeEvaluatedPlanVersion],
  ] as const) {
    if (version !== undefined && (!Number.isInteger(version) || version !== seed.planVersion)) {
      throw new TypeError(`${label} must equal the current plan version`);
    }
  }
  if (
    seed.judgeApprovedPlanVersion !== undefined &&
    (seed.judgeReady !== true || seed.judgeEvaluatedPlanVersion !== seed.planVersion)
  ) {
    throw new TypeError('Judge approval requires a current positive evaluation');
  }
  if (seed.judgeReady !== undefined && seed.judgeEvaluatedPlanVersion === undefined) {
    throw new TypeError('Judge verdict requires a current evaluation version');
  }
  if (seed.systemProofBinding !== undefined) {
    requiredSha256(seed.systemProofBinding.planSha256, 'system proof planSha256');
    requiredSha256(seed.systemProofBinding.authoritativeDigest, 'system proof authoritativeDigest');
    if (
      seed.systemProofBinding.planVersion !== seed.planVersion ||
      seed.systemProofBinding.planSha256 !== (seed.canonicalPlanSha256 ?? seed.planSha256) ||
      seed.systemProofBinding.authoritativeDigest !== seed.authoritativeDigest
    ) {
      throw new TypeError(
        'system proof binding must match the current plan and authoritative digest',
      );
    }
  }
  if (
    seed.systemProofBinding === undefined &&
    (seed.systemCheckPassed ||
      seed.systemMismatchIds.length > 0 ||
      seed.requiredEvidenceUnavailable.length > 0)
  ) {
    throw new TypeError('system proof facts require a current system proof binding');
  }
  if (
    seed.systemCheckPassed &&
    (seed.systemMismatchIds.length > 0 || seed.requiredEvidenceUnavailable.length > 0)
  ) {
    throw new TypeError('passing system proof cannot retain proof gaps');
  }
  const sources = copySourceSlots(catalog, seed.sources);
  const occurrenceCoverage = reconcileOccurrenceCoverage(catalog, sources);
  for (const [source, materialIssueIds] of [
    ['critic', seed.criticMaterialIssueIds],
    ['fix-reviewer', seed.fixReviewerMaterialIssueIds],
    ['intermediate-judge', seed.intermediateJudgeMaterialIssueIds],
    ['final-judge', seed.finalJudgeMaterialIssueIds],
  ] as const) {
    if (
      materialIssueIds.length > 0 &&
      sources.find((slot) => slot.source === source)?.snapshot === undefined
    ) {
      throw new TypeError(`${source} material issues require a current admitted snapshot`);
    }
  }
  const findings = copyFindings(seed.findings);
  const invariants = copyInvariants(seed.invariants);
  assertCatalogMatchesInvariants(catalog, invariants);
  const contextDeliveries = seed.contextDeliveries.map(copyContextDelivery);
  if (contextDeliveries.some((delivery) => delivery.planVersion > seed.planVersion)) {
    throw new TypeError('context delivery planVersion cannot exceed the current plan version');
  }
  const riskDomains = copyRiskDomains(seed.riskDomains);
  if (
    (seed.readinessContractDigest === undefined && riskDomains.length > 0) ||
    (seed.readinessContractDigest !== undefined &&
      riskDomains.length !== READINESS_RISK_DOMAINS.length)
  ) {
    throw new TypeError('risk domains must match frozen-contract availability');
  }
  if (
    riskDomains.some(
      (assessment) =>
        assessment.lastAssessedPlanVersion !== undefined &&
        assessment.lastAssessedPlanVersion !== seed.planVersion,
    )
  ) {
    throw new TypeError('risk domain assessment versions must equal the current plan version');
  }
  const boundaryChallenges = copyBoundaryChallenges(seed.boundaryChallenges);
  if (boundaryChallenges.some((challenge) => challenge.planVersion > seed.planVersion)) {
    throw new TypeError('boundary challenge planVersion cannot exceed the current plan version');
  }
  const opportunities = copyOpportunities(seed.opportunities);
  if (opportunities.some((opportunity) => opportunity.lastSeenPlanVersion > seed.planVersion)) {
    throw new TypeError('opportunity planVersion cannot exceed the current plan version');
  }
  const admittedCriticIssueRefs = sortedUnique(
    seed.admittedCriticIssueRefs,
    'admitted critic issue refs',
  );
  if (
    admittedCriticIssueRefs.some((issueRef) => {
      const match = /^v([0-9]+)\.C[0-9]+$/.exec(issueRef);
      return match?.[1] === undefined || Number(match[1]) > seed.planVersion;
    })
  ) {
    throw new TypeError('admitted critic issue refs must identify current or prior plan versions');
  }
  const currentCriticIssueRefs = admittedCriticIssueRefs.filter((issueRef) =>
    issueRef.startsWith(`v${seed.planVersion}.`),
  );
  if (
    canonicalJson(currentCriticIssueRefs) !== canonicalJson([...seed.criticMaterialIssueIds].sort())
  ) {
    throw new TypeError('current admitted critic issue refs must match critic material issues');
  }
  const priorCriticIssueRefs = admittedCriticIssueRefs.filter(
    (issueRef) => !issueRef.startsWith(`v${seed.planVersion}.`),
  );
  if (
    (priorCriticIssueRefs.length > 0 && creatorTransitionReceipt === undefined) ||
    (creatorTransitionReceipt !== undefined &&
      creatorTransitionReceipt.admittedCriticIssueRefsDigest !==
        canonicalJsonSha256(priorCriticIssueRefs))
  ) {
    throw new TypeError('admitted critic issue history does not match the creator receipt');
  }
  const withoutReduction: ReadinessProofWithoutReduction = {
    schemaVersion: READINESS_PROOF_SCHEMA_VERSION,
    planVersion: seed.planVersion,
    quality: seed.quality,
    promise: seed.promise,
    requiredProofLevel: seed.requiredProofLevel,
    requiresExhaustiveScan: seed.requiresExhaustiveScan,
    scopeSource: seed.scopeSource,
    originalRequestAvailable: seed.originalRequestAvailable,
    sourceDigest: seed.sourceDigest,
    ...(seed.planSha256 === undefined
      ? {}
      : { planSha256: requiredSha256(seed.planSha256, 'planSha256') }),
    ...(seed.canonicalPlanSha256 === undefined
      ? {}
      : {
          canonicalPlanSha256: requiredSha256(seed.canonicalPlanSha256, 'canonicalPlanSha256'),
        }),
    ...(creatorTransitionReceipt === undefined ? {} : { creatorTransitionReceipt }),
    authoritativeDigest: seed.authoritativeDigest,
    operatorDecisionIds: sortedUnique(seed.operatorDecisionIds, 'operator decision IDs'),
    interventionIds: sortedUnique(seed.interventionIds, 'intervention IDs'),
    findings,
    invariants,
    relationshipIds: sortedUnique(seed.relationshipIds, 'relationship IDs'),
    contextDeliveries,
    issueBudget: { ...seed.issueBudget },
    iterationLimit: seed.iterationLimit,
    exhaustedLimits: sortedUnique(seed.exhaustedLimits, 'exhausted limits'),
    ...(seed.lastCritiquedPlanVersion === undefined
      ? {}
      : { lastCritiquedPlanVersion: seed.lastCritiquedPlanVersion }),
    scanComplete: seed.scanComplete,
    declaredScopeVerified: seed.declaredScopeVerified,
    admittedCriticIssueRefs,
    criticMaterialIssueIds: sortedUnique(seed.criticMaterialIssueIds, 'critic material issue IDs'),
    fixReviewerMaterialIssueIds: sortedUnique(
      seed.fixReviewerMaterialIssueIds,
      'fix-reviewer material issue IDs',
    ),
    intermediateJudgeMaterialIssueIds: sortedUnique(
      seed.intermediateJudgeMaterialIssueIds,
      'intermediate Judge material issue IDs',
    ),
    finalJudgeMaterialIssueIds: sortedUnique(
      seed.finalJudgeMaterialIssueIds,
      'final Judge material issue IDs',
    ),
    currentActionableIssues: sortedSet(
      [
        ...seed.criticMaterialIssueIds,
        ...seed.fixReviewerMaterialIssueIds,
        ...seed.intermediateJudgeMaterialIssueIds,
        ...seed.finalJudgeMaterialIssueIds,
      ],
      'current actionable issue IDs',
    ),
    systemCheckPassed: seed.systemCheckPassed,
    systemMismatchIds: sortedUnique(seed.systemMismatchIds, 'system mismatch IDs'),
    requiredEvidenceUnavailable: sortedUnique(
      seed.requiredEvidenceUnavailable,
      'required unavailable evidence IDs',
    ),
    ...(seed.systemProofBinding === undefined
      ? {}
      : {
          systemProofBinding: {
            planVersion: seed.systemProofBinding.planVersion,
            planSha256: seed.systemProofBinding.planSha256,
            authoritativeDigest: seed.systemProofBinding.authoritativeDigest,
          },
        }),
    unresolvedMaterialQuestionIds: sortedUnique(
      seed.unresolvedMaterialQuestionIds,
      'unresolved material question IDs',
    ),
    ...(seed.readinessContractDigest === undefined
      ? {}
      : {
          readinessContractDigest: requiredSha256(
            seed.readinessContractDigest,
            'readinessContractDigest',
          ),
        }),
    judgeAllowed: seed.judgeAllowed,
    exhaustiveApplicableDomains: seed.exhaustiveApplicableDomains,
    riskDomains,
    boundaryChallenges,
    opportunities,
    ...(seed.judgeApprovedPlanVersion === undefined
      ? {}
      : { judgeApprovedPlanVersion: seed.judgeApprovedPlanVersion }),
    ...(seed.judgeEvaluatedPlanVersion === undefined
      ? {}
      : { judgeEvaluatedPlanVersion: seed.judgeEvaluatedPlanVersion }),
    ...(seed.judgeReady === undefined ? {} : { judgeReady: seed.judgeReady }),
    criticCoverageGapIds: sortedUnique(seed.criticCoverageGapIds, 'critic coverage gap IDs'),
    criticScopeCoverageGapIds: sortedUnique(
      seed.criticScopeCoverageGapIds,
      'critic scope coverage gap IDs',
    ),
    criticContextGapIds: sortedUnique(seed.criticContextGapIds, 'critic context gap IDs'),
    materialRevisionProofGapIds: sortedUnique(
      seed.materialRevisionProofGapIds,
      'material revision proof gap IDs',
    ),
    otherUnresolvedProofIds: sortedUnique(
      seed.otherUnresolvedProofIds,
      'other unresolved proof IDs',
    ),
    hasCanonicalBindingMismatch: seed.hasCanonicalBindingMismatch,
    hasFreshReviewMismatch: seed.hasFreshReviewMismatch,
    hasFinalArtifactMismatch: seed.hasFinalArtifactMismatch,
    hasJudgeInconsistency: seed.hasJudgeInconsistency,
    catalog,
    sources,
    occurrenceCoverage,
  };
  return { ...withoutReduction, reduction: reduceReadiness(readinessFacts(withoutReduction)) };
}

function stateSeed(
  state: ReadinessProofState,
  overrides: ReadinessProofSeedOverrides = {},
): ReadinessProofSeed {
  const merged = { ...state, ...overrides };
  const {
    planSha256,
    canonicalPlanSha256,
    creatorTransitionReceipt,
    lastCritiquedPlanVersion,
    systemProofBinding,
    readinessContractDigest,
    judgeApprovedPlanVersion,
    judgeEvaluatedPlanVersion,
    judgeReady,
    ...required
  } = merged;
  return {
    ...required,
    ...(planSha256 === undefined ? {} : { planSha256 }),
    ...(canonicalPlanSha256 === undefined ? {} : { canonicalPlanSha256 }),
    ...(creatorTransitionReceipt === undefined ? {} : { creatorTransitionReceipt }),
    ...(lastCritiquedPlanVersion === undefined ? {} : { lastCritiquedPlanVersion }),
    ...(systemProofBinding === undefined ? {} : { systemProofBinding }),
    ...(readinessContractDigest === undefined ? {} : { readinessContractDigest }),
    ...(judgeApprovedPlanVersion === undefined ? {} : { judgeApprovedPlanVersion }),
    ...(judgeEvaluatedPlanVersion === undefined ? {} : { judgeEvaluatedPlanVersion }),
    ...(judgeReady === undefined ? {} : { judgeReady }),
  };
}

function unboundBinding(source: OccurrenceSource, planVersion: number): OccurrenceSourceBinding {
  const allowed = SOURCE_BINDINGS[source][0];
  if (allowed === undefined) {
    throw new TypeError(`candidate binding is unavailable for source: ${source}`);
  }
  return {
    candidate: {
      kind: allowed.kind,
      planVersion,
      contentDigest: `${UNBOUND_BINDING_PREFIX}${canonicalJsonSha256({
        source,
        planVersion,
        state: 'unbound',
      })}`,
    },
    lineage: {
      evaluationStage: allowed.stage,
      lineageDigest: `${UNBOUND_BINDING_PREFIX}${canonicalJsonSha256({
        source,
        planVersion,
        lineage: 'unbound',
      })}`,
    },
  };
}

function sourceSlots(
  catalog: ReadinessProofCatalog,
  requirements: CreateOccurrenceSourceRequirements,
): OccurrenceSourceSlot[] {
  return OCCURRENCE_SOURCES.map((source) => ({
    source,
    requirement: copyRequirement(source, requirements[source] ?? defaultRequirement()),
  }));
}

function baseSeed(
  catalog: ReadinessProofCatalog,
  sources: readonly OccurrenceSourceSlot[],
  input?: CreateReadinessProofStateInput,
  invariantFallback: readonly ReadinessInvariantRecord[] = [],
): ReadinessProofSeed {
  const quality = input?.quality ?? 'balanced';
  const promise = input?.matrix.completenessPromise ?? 'cumulative';
  const mode = input?.mode ?? 'plan';
  return {
    planVersion: catalog.expectedPlanVersion,
    quality,
    promise,
    requiredProofLevel: promise,
    requiresExhaustiveScan: input?.matrix.requiresExhaustiveScan === 1,
    scopeSource: mode === 'prompt' ? 'prompt' : 'direct-plan',
    originalRequestAvailable: mode === 'prompt',
    sourceDigest:
      input?.sourceDigest ?? canonicalJsonSha256({ catalog: catalog.digest, source: 'unbound' }),
    authoritativeDigest:
      input?.authoritativeDigest ??
      canonicalJsonSha256({ catalog: catalog.digest, authoritative: 'unbound' }),
    operatorDecisionIds: [],
    interventionIds: [],
    findings: input?.findings ?? [],
    invariants: input?.invariants ?? invariantFallback,
    relationshipIds: input?.relationshipIds ?? [],
    contextDeliveries: [],
    issueBudget: { limit: READINESS_ISSUE_BUDGET, used: 0, exhausted: false },
    iterationLimit: input?.maxIters ?? 1,
    exhaustedLimits: [],
    scanComplete: false,
    declaredScopeVerified: mode === 'prompt',
    admittedCriticIssueRefs: [],
    criticMaterialIssueIds: [],
    fixReviewerMaterialIssueIds: [],
    intermediateJudgeMaterialIssueIds: [],
    finalJudgeMaterialIssueIds: [],
    currentActionableIssues: [],
    systemCheckPassed: false,
    systemMismatchIds: [],
    requiredEvidenceUnavailable: [],
    unresolvedMaterialQuestionIds: [],
    judgeAllowed: input === undefined ? true : input.matrix.judge === 1,
    exhaustiveApplicableDomains: input?.matrix.requiresExhaustiveScan === 1,
    riskDomains: [],
    boundaryChallenges: [],
    opportunities: [],
    criticCoverageGapIds: [],
    criticScopeCoverageGapIds: [],
    criticContextGapIds: [],
    materialRevisionProofGapIds: [],
    otherUnresolvedProofIds: [],
    hasCanonicalBindingMismatch: false,
    hasFreshReviewMismatch: false,
    hasFinalArtifactMismatch: false,
    hasJudgeInconsistency: false,
    catalog,
    sources,
  };
}

export function createReadinessProofState(
  input: CreateReadinessProofStateInput,
): ReadinessProofState;
export function createReadinessProofState(
  catalog: ReadinessProofCatalog,
  requirements: CreateOccurrenceSourceRequirements,
): ReadinessProofState;
export function createReadinessProofState(
  inputOrCatalog: CreateReadinessProofStateInput | ReadinessProofCatalog,
  requirements?: CreateOccurrenceSourceRequirements,
): ReadinessProofState {
  if ('quality' in inputOrCatalog) {
    const catalog = canonicalCatalog(
      inputOrCatalog.trustedCatalog ??
        createReadinessProofCatalog({
          expectedPlanVersion: 0,
          invariants: [],
          materialIssueIds: [],
        }),
    );
    const critic: RequiredOccurrenceSourceRequirement = {
      required: true,
      reason: 'independent-critic-required',
      expectedBinding: unboundBinding('critic', catalog.expectedPlanVersion),
    };
    const sources = sourceSlots(catalog, { critic });
    return buildState(baseSeed(catalog, sources, inputOrCatalog));
  }
  if (requirements === undefined) {
    throw new TypeError('occurrence source requirements are required');
  }
  const catalog = canonicalCatalog(inputOrCatalog);
  const sources = sourceSlots(catalog, requirements);
  const invariantFallback = catalog.invariants.map((invariant) => ({
    id: invariant.invariantId,
    sourceFinding: `catalog:${invariant.invariantId}`,
    statement: `Trusted invariant ${invariant.invariantId}`,
    occurrences: invariant.occurrenceIds.map((occurrenceId) => ({
      id: occurrenceId,
      dimension: 'catalog-occurrence',
      subject: occurrenceId,
    })),
  }));
  return buildState(baseSeed(catalog, sources, undefined, invariantFallback));
}

function requiresJudge(riskDomains: readonly ReadinessRiskDomainRecord[]): boolean {
  return riskDomains.some(
    (assessment) => assessment.applicability === 'applicable' && assessment.risk === 'high',
  );
}

function replaceSourceSlotRequirement(
  sources: readonly OccurrenceSourceSlot[],
  source: OccurrenceSource,
  requirement: OccurrenceSourceRequirement,
): OccurrenceSourceSlot[] {
  return sources.map((slot) => {
    if (slot.source !== source) {
      return slot;
    }
    const copiedRequirement = copyRequirement(source, requirement);
    const retainSnapshot =
      copiedRequirement.required &&
      slot.snapshot !== undefined &&
      bindingMatches(slot.snapshot.binding, copiedRequirement.expectedBinding);
    return {
      source,
      requirement: copiedRequirement,
      ...(retainSnapshot ? { snapshot: slot.snapshot } : {}),
    };
  });
}

function judgeRequirement(
  catalog: ReadinessProofCatalog,
  riskDomains: readonly ReadinessRiskDomainRecord[],
): OccurrenceSourceRequirement {
  return requiresJudge(riskDomains)
    ? {
        required: true,
        reason: 'applicable-high-risk-judge-required',
        expectedBinding: unboundBinding('intermediate-judge', catalog.expectedPlanVersion),
      }
    : { required: false, reason: 'standard-risk-judge-exempt' };
}

function riskDomainFromContract(
  assessment: ReadinessDomainAssessment,
  existing: ReadinessRiskDomainRecord | undefined,
): ReadinessRiskDomainRecord {
  return existing === undefined
    ? {
        domain: assessment.domain,
        applicability: assessment.applicability,
        risk: assessment.risk,
        rationale: assessment.rationale,
        evidenceRefs: assessment.evidenceRefs.map(cloneJsonValue),
        complete: false,
        unavailableEvidence: [],
      }
    : {
        ...existing,
        applicability:
          existing.applicability === 'applicable' ? 'applicable' : assessment.applicability,
        risk: existing.risk === 'high' ? 'high' : assessment.risk,
      };
}

export function applyFrozenReadinessContract(
  state: ReadinessProofState,
  contract: ReadinessContract,
): ReadinessProofState {
  parseReadinessContract(contract as unknown as JsonValue);
  if (contract.sourceDigest !== state.sourceDigest) {
    throw new TypeError('frozen readiness contract source digest does not match state');
  }
  if (contract.systemDigest !== state.authoritativeDigest) {
    throw new TypeError('frozen readiness contract system digest does not match state');
  }
  if (contract.appetite.quality !== state.quality) {
    throw new TypeError('frozen readiness contract quality does not match state');
  }
  const sameContract = state.readinessContractDigest === contract.contractDigest;
  const riskDomains = contract.domainAssessments.map((assessment) =>
    riskDomainFromContract(
      assessment,
      sameContract
        ? state.riskDomains.find((candidate) => candidate.domain === assessment.domain)
        : undefined,
    ),
  );
  let sources = state.sources;
  if (!sameContract) {
    sources = replaceSourceSlotRequirement(
      sources,
      'intermediate-judge',
      judgeRequirement(state.catalog, riskDomains),
    );
    sources = replaceSourceSlotRequirement(sources, 'final-judge', {
      required: false,
      reason: 'canonical-plan-not-bound',
    });
  }
  if (!sameContract && state.readinessContractDigest !== undefined) {
    sources = sources.map((slot) => ({ source: slot.source, requirement: slot.requirement }));
  }
  const assuranceLimitRequired = requiresJudge(riskDomains) && !contract.appetite.judgeAllowed;
  return buildState(
    stateSeed(state, {
      readinessContractDigest: contract.contractDigest,
      operatorDecisionIds: contract.operatorDecisionIds,
      issueBudget: {
        limit: contract.appetite.issueBudget,
        used: sameContract ? state.issueBudget.used : 0,
        exhausted: sameContract ? state.issueBudget.exhausted : false,
      },
      iterationLimit: contract.appetite.iterationLimit,
      exhaustedLimits: assuranceLimitRequired
        ? sortedSet([...state.exhaustedLimits, 'assurance-appetite'], 'exhausted limits')
        : state.exhaustedLimits.filter((limit) => limit !== 'assurance-appetite'),
      unresolvedMaterialQuestionIds: contract.unresolvedMaterialQuestions.map(
        (question) => question.id,
      ),
      judgeAllowed: contract.appetite.judgeAllowed,
      exhaustiveApplicableDomains: contract.appetite.exhaustiveApplicableDomains,
      riskDomains,
      declaredScopeVerified: state.declaredScopeVerified,
      sources,
      ...(!sameContract && state.readinessContractDigest !== undefined
        ? {
            lastCritiquedPlanVersion: undefined,
            scanComplete: false,
            criticMaterialIssueIds: [],
            fixReviewerMaterialIssueIds: [],
            intermediateJudgeMaterialIssueIds: [],
            finalJudgeMaterialIssueIds: [],
            systemCheckPassed: false,
            systemMismatchIds: [],
            requiredEvidenceUnavailable: [],
            systemProofBinding: undefined,
            judgeApprovedPlanVersion: undefined,
            judgeEvaluatedPlanVersion: undefined,
            judgeReady: undefined,
            criticCoverageGapIds: [],
            criticScopeCoverageGapIds: [],
            criticContextGapIds: [],
          }
        : {}),
    }),
  );
}

export function recordInterventions(
  state: ReadinessProofState,
  input: RecordInterventionsInput,
): ReadinessProofState {
  const interventionIds = sortedUnique(input.interventionIds, 'intervention IDs');
  const operatorDecisionIds =
    input.operatorDecisionIds === undefined
      ? state.operatorDecisionIds
      : sortedUnique(input.operatorDecisionIds, 'operator decision IDs');
  if (
    canonicalJson(interventionIds) === canonicalJson(state.interventionIds) &&
    canonicalJson(operatorDecisionIds) === canonicalJson(state.operatorDecisionIds)
  ) {
    return buildState(stateSeed(state));
  }
  return invalidateFullReviewProof(
    buildState(stateSeed(state, { interventionIds, operatorDecisionIds })),
  );
}

export function recordContextDelivery(
  state: ReadinessProofState,
  delivery: ContextDelivery,
): ReadinessProofState {
  const copied = copyContextDelivery(delivery);
  const keyMatches = (candidate: ContextDelivery): boolean =>
    candidate.role === copied.role &&
    candidate.stage === copied.stage &&
    candidate.planVersion === copied.planVersion;
  const existing = state.contextDeliveries.find(keyMatches);
  const updated = buildState(
    stateSeed(state, {
      contextDeliveries: [...state.contextDeliveries.filter((entry) => !keyMatches(entry)), copied],
    }),
  );
  if (existing !== undefined && canonicalJson(existing) === canonicalJson(copied)) {
    return updated;
  }
  const source: OccurrenceSource | undefined =
    copied.role === 'critic'
      ? 'critic'
      : copied.role === 'reviewer'
        ? 'fix-reviewer'
        : copied.role === 'judge'
          ? copied.stage.includes('final')
            ? 'final-judge'
            : 'intermediate-judge'
          : undefined;
  return source === undefined ||
    state.sources.find((slot) => slot.source === source)?.snapshot === undefined
    ? updated
    : invalidateOccurrenceCoverageSource(updated, source);
}

function mergedOpportunities(
  existing: readonly OpportunityRecord[],
  admitted: readonly OpportunityRecord[],
): OpportunityRecord[] {
  const byFingerprint = new Map(
    existing.map((opportunity) => [opportunity.fingerprint, opportunity] as const),
  );
  for (const opportunity of admitted) {
    const prior = byFingerprint.get(opportunity.fingerprint);
    byFingerprint.set(
      opportunity.fingerprint,
      prior === undefined
        ? opportunity
        : {
            ...opportunity,
            firstSeenPlanVersion: Math.min(
              prior.firstSeenPlanVersion,
              opportunity.firstSeenPlanVersion,
            ),
            lastSeenPlanVersion: Math.max(
              prior.lastSeenPlanVersion,
              opportunity.lastSeenPlanVersion,
            ),
          },
    );
  }
  return [...byFingerprint.values()];
}

export function recordAdmittedCritique(
  state: ReadinessProofState,
  input: AdmittedCritiqueInput,
): ReadinessProofState {
  if (input.planVersion !== state.planVersion) {
    throw new TypeError('admitted critique plan version does not match state');
  }
  if (input.snapshot.source !== 'critic') {
    throw new TypeError('admitted critique snapshot source must be critic');
  }
  if (!Number.isInteger(input.issueBudgetUsed) || input.issueBudgetUsed < 0) {
    throw new TypeError('admitted critique issue budget use must be a non-negative integer');
  }
  let withoutDownstreamSnapshots = state.sources.map((slot) =>
    slot.source === 'critic' ? slot : { source: slot.source, requirement: slot.requirement },
  );
  for (const source of ['intermediate-judge', 'final-judge'] as const) {
    const slot = state.sources.find((candidate) => candidate.source === source);
    const requirement =
      source === 'final-judge'
        ? ({ required: false, reason: 'canonical-plan-not-bound' } as const)
        : requiresJudge(input.riskDomains) && slot?.requirement.required === true
          ? slot.requirement
          : judgeRequirement(state.catalog, input.riskDomains);
    withoutDownstreamSnapshots = replaceSourceSlotRequirement(
      withoutDownstreamSnapshots,
      source,
      requirement,
    ).map((candidate) =>
      candidate.source === source ? { source, requirement: candidate.requirement } : candidate,
    );
  }
  const replacedFacts = buildState(
    stateSeed(state, {
      sources: withoutDownstreamSnapshots,
      lastCritiquedPlanVersion: input.planVersion,
      scanComplete: input.scanComplete,
      declaredScopeVerified: input.declaredScopeVerified,
      admittedCriticIssueRefs: state.admittedCriticIssueRefs.filter(
        (issueRef) => !issueRef.startsWith(`v${input.planVersion}.`),
      ),
      criticMaterialIssueIds: [],
      fixReviewerMaterialIssueIds: [],
      intermediateJudgeMaterialIssueIds: [],
      finalJudgeMaterialIssueIds: [],
      issueBudget: {
        limit: state.issueBudget.limit,
        used: input.issueBudgetUsed,
        exhausted: input.issueBudgetExhausted,
      },
      exhaustedLimits: input.issueBudgetExhausted
        ? sortedSet([...state.exhaustedLimits, 'issue-budget'], 'exhausted limits')
        : state.exhaustedLimits.filter((limit) => limit !== 'issue-budget'),
      riskDomains: input.riskDomains,
      criticCoverageGapIds: input.criticCoverageGapIds,
      criticScopeCoverageGapIds: input.criticScopeCoverageGapIds,
      criticContextGapIds: input.criticContextGapIds,
      boundaryChallenges: input.boundaryChallenges,
      opportunities: mergedOpportunities(state.opportunities, input.opportunities),
      judgeApprovedPlanVersion: undefined,
      judgeEvaluatedPlanVersion: undefined,
      judgeReady: undefined,
      hasFreshReviewMismatch: false,
      hasJudgeInconsistency: false,
    }),
  );
  const admitted = replaceOccurrenceCoverageSnapshot(replacedFacts, input.snapshot);
  return buildState(
    stateSeed(admitted, {
      admittedCriticIssueRefs: [...admitted.admittedCriticIssueRefs, ...input.materialIssueIds],
      criticMaterialIssueIds: input.materialIssueIds,
    }),
  );
}

function assertCatalogMatchesInvariants(
  catalog: ReadinessProofCatalog,
  invariants: readonly ReadinessInvariantRecord[],
): void {
  const identities = invariants.map((invariant) => ({
    invariantId: invariant.id,
    occurrenceIds: invariant.occurrences.map((occurrence) => occurrence.id),
  }));
  if (canonicalJson(catalog.invariants) !== canonicalJson(identities)) {
    throw new TypeError('invariant metadata does not match readiness proof catalog');
  }
}

export function recordAdmittedCreatorUpdate(
  state: ReadinessProofState,
  input: AdmittedCreatorUpdateInput,
): ReadinessProofState {
  if (input.fromPlanVersion !== state.planVersion) {
    throw new TypeError('creator update fromPlanVersion does not match state');
  }
  const nextCatalog = canonicalCatalog(input.nextCatalog);
  if (nextCatalog.expectedPlanVersion !== state.planVersion + 1) {
    throw new TypeError('creator update catalog must advance exactly one plan version');
  }
  if (
    input.transitionReceipt.admittedCriticIssueRefsDigest !==
    canonicalJsonSha256(state.admittedCriticIssueRefs)
  ) {
    throw new TypeError('creator transition receipt does not match admitted critic issue history');
  }
  const invariants = copyInvariants(input.invariants);
  assertCatalogMatchesInvariants(nextCatalog, invariants);
  const critic: RequiredOccurrenceSourceRequirement = {
    required: true,
    reason: 'independent-critic-required',
    expectedBinding: unboundBinding('critic', nextCatalog.expectedPlanVersion),
  };
  let sources = sourceSlots(nextCatalog, {
    critic,
    'fix-reviewer': { required: false, reason: 'not-evaluated-for-current-candidate' },
    'intermediate-judge': judgeRequirement(nextCatalog, state.riskDomains),
    'final-judge': { required: false, reason: 'canonical-plan-not-bound' },
  });
  sources = sources.map((slot) => ({ source: slot.source, requirement: slot.requirement }));
  return buildState(
    stateSeed(state, {
      planVersion: nextCatalog.expectedPlanVersion,
      planSha256: undefined,
      canonicalPlanSha256: undefined,
      creatorTransitionReceipt: input.transitionReceipt,
      findings: input.findings,
      invariants,
      catalog: nextCatalog,
      sources,
      lastCritiquedPlanVersion: undefined,
      scanComplete: false,
      admittedCriticIssueRefs: state.admittedCriticIssueRefs,
      criticMaterialIssueIds: [],
      fixReviewerMaterialIssueIds: [],
      intermediateJudgeMaterialIssueIds: [],
      finalJudgeMaterialIssueIds: [],
      systemCheckPassed: false,
      systemMismatchIds: [],
      requiredEvidenceUnavailable: [],
      systemProofBinding: undefined,
      riskDomains: state.riskDomains.map(invalidateRiskDomainAssessment),
      judgeApprovedPlanVersion: undefined,
      judgeEvaluatedPlanVersion: undefined,
      judgeReady: undefined,
      criticCoverageGapIds: [],
      criticScopeCoverageGapIds: [],
      criticContextGapIds: [],
      materialRevisionProofGapIds: input.materialRevisionProofGapIds,
      hasCanonicalBindingMismatch: false,
      hasFreshReviewMismatch: false,
      hasFinalArtifactMismatch: false,
      hasJudgeInconsistency: false,
    }),
  );
}

export function recordAdmittedFixReviewerProof(
  state: ReadinessProofState,
  input: AdmittedFixReviewerProofInput,
): ReadinessProofState {
  if (!input.required) {
    return buildState(
      stateSeed(setOccurrenceSourceRequirement(state, 'fix-reviewer', input), {
        fixReviewerMaterialIssueIds: [],
      }),
    );
  }
  if (input.snapshot === undefined && input.materialIssueIds.length > 0) {
    throw new TypeError('fix-reviewer material issues require an admitted snapshot');
  }
  let next = setOccurrenceSourceRequirement(state, 'fix-reviewer', {
    required: true,
    reason: input.reason,
    expectedBinding: input.expectedBinding,
  });
  if (input.snapshot === undefined) {
    return invalidateOccurrenceCoverageSource(next, 'fix-reviewer');
  }
  next = replaceOccurrenceCoverageSnapshot(next, input.snapshot);
  return buildState(stateSeed(next, { fixReviewerMaterialIssueIds: input.materialIssueIds }));
}

export function addReadinessLimit(
  state: ReadinessProofState,
  input: AddReadinessLimitInput,
): ReadinessProofState {
  if (!READINESS_LIMITS.includes(input.limit)) {
    throw new TypeError('readiness limit is invalid');
  }
  return buildState(
    stateSeed(state, {
      exhaustedLimits: sortedSet([...state.exhaustedLimits, input.limit], 'exhausted limits'),
      ...(input.limit === 'issue-budget'
        ? { issueBudget: { ...state.issueBudget, exhausted: true } }
        : {}),
      otherUnresolvedProofIds:
        input.unresolvedProofId === undefined
          ? state.otherUnresolvedProofIds
          : sortedSet(
              [...state.otherUnresolvedProofIds, input.unresolvedProofId],
              'other unresolved proof IDs',
            ),
    }),
  );
}

export function recordSystemProof(
  state: ReadinessProofState,
  input: AdmittedSystemProofInput,
): ReadinessProofState {
  requiredSha256(input.binding.planSha256, 'system proof planSha256');
  requiredSha256(input.binding.authoritativeDigest, 'system proof authoritativeDigest');
  const currentPlanSha256 = state.canonicalPlanSha256 ?? state.planSha256;
  if (
    input.binding.planVersion !== state.planVersion ||
    input.binding.planSha256 !== currentPlanSha256 ||
    input.binding.authoritativeDigest !== state.authoritativeDigest
  ) {
    throw new TypeError('system proof binding does not match current state');
  }
  if (input.passed && (input.mismatchIds.length > 0 || input.unavailableEvidenceIds.length > 0)) {
    throw new TypeError('passing system proof cannot contain mismatches or unavailable evidence');
  }
  return buildState(
    stateSeed(state, {
      systemProofBinding: { ...input.binding },
      systemCheckPassed: input.passed,
      systemMismatchIds: input.mismatchIds,
      requiredEvidenceUnavailable: input.unavailableEvidenceIds,
    }),
  );
}

export function recordAdmittedJudgeProof(
  state: ReadinessProofState,
  input: AdmittedJudgeProofInput,
): ReadinessProofState {
  const source = input.stage === 'intermediate' ? 'intermediate-judge' : 'final-judge';
  if (input.snapshot.source !== source) {
    throw new TypeError(`admitted ${input.stage} Judge snapshot source is invalid`);
  }
  if (input.stage === 'final' && input.materialIssueIds.length > 0) {
    throw new TypeError('final Judge proof cannot synthesize material revision issues');
  }
  if (input.verdict && input.approvedPlanVersion !== state.planVersion) {
    throw new TypeError('ready Judge proof must approve the current plan version');
  }
  if (!input.verdict && input.approvedPlanVersion !== undefined) {
    throw new TypeError('negative Judge proof cannot approve a plan version');
  }
  let next = state;
  if (input.stage === 'intermediate') {
    next = invalidateOccurrenceCoverageSource(next, 'final-judge');
  }
  next = buildState(
    stateSeed(next, {
      ...(input.stage === 'intermediate'
        ? { intermediateJudgeMaterialIssueIds: [] }
        : { finalJudgeMaterialIssueIds: [] }),
      judgeEvaluatedPlanVersion: state.planVersion,
      ...(input.approvedPlanVersion === undefined
        ? { judgeApprovedPlanVersion: undefined }
        : { judgeApprovedPlanVersion: input.approvedPlanVersion }),
      judgeReady: input.verdict,
      hasJudgeInconsistency: false,
    }),
  );
  next = replaceOccurrenceCoverageSnapshot(next, input.snapshot);
  return buildState(
    stateSeed(next, {
      ...(input.stage === 'intermediate'
        ? { intermediateJudgeMaterialIssueIds: input.materialIssueIds }
        : { finalJudgeMaterialIssueIds: input.materialIssueIds }),
    }),
  );
}

export function bindVersionedPlan(
  state: ReadinessProofState,
  input: BindVersionedPlanInput,
): ReadinessProofState {
  if (input.planVersion !== state.planVersion) {
    throw new TypeError('versioned plan binding plan version does not match state');
  }
  requiredSha256(input.planSha256, 'versioned plan SHA-256');
  requiredSha256(input.criticLineageDigest, 'critic lineage digest');
  if (input.intermediateJudgeLineageDigest !== undefined) {
    requiredSha256(input.intermediateJudgeLineageDigest, 'intermediate Judge lineage digest');
  }
  const judgeRequired = requiresJudge(state.riskDomains);
  if (judgeRequired && input.intermediateJudgeLineageDigest === undefined) {
    throw new TypeError('intermediate Judge lineage digest is required for high-risk proof');
  }
  const changed = state.planSha256 !== undefined && state.planSha256 !== input.planSha256;
  let sources = replaceSourceSlotRequirement(state.sources, 'critic', {
    required: true,
    reason: 'independent-critic-required',
    expectedBinding: {
      candidate: {
        kind: 'versioned-plan',
        planVersion: input.planVersion,
        contentDigest: input.planSha256,
      },
      lineage: {
        evaluationStage: 'review',
        lineageDigest: input.criticLineageDigest,
      },
    },
  });
  sources = replaceSourceSlotRequirement(
    sources,
    'intermediate-judge',
    judgeRequired
      ? {
          required: true,
          reason: 'applicable-high-risk-judge-required',
          expectedBinding: {
            candidate: {
              kind: 'versioned-plan',
              planVersion: input.planVersion,
              contentDigest: input.planSha256,
            },
            lineage: {
              evaluationStage: 'intermediate-readiness',
              lineageDigest: requiredSha256(
                input.intermediateJudgeLineageDigest ?? '',
                'intermediate Judge lineage digest',
              ),
            },
          },
        }
      : { required: false, reason: 'standard-risk-judge-exempt' },
  );
  const rebound = buildState(
    stateSeed(state, {
      planSha256: input.planSha256,
      sources,
      ...(changed
        ? {
            canonicalPlanSha256: undefined,
            lastCritiquedPlanVersion: undefined,
            scanComplete: false,
            criticMaterialIssueIds: [],
            fixReviewerMaterialIssueIds: [],
            intermediateJudgeMaterialIssueIds: [],
            finalJudgeMaterialIssueIds: [],
            systemCheckPassed: false,
            systemMismatchIds: [],
            requiredEvidenceUnavailable: [],
            systemProofBinding: undefined,
            judgeApprovedPlanVersion: undefined,
            judgeEvaluatedPlanVersion: undefined,
            judgeReady: undefined,
            hasCanonicalBindingMismatch: false,
            hasFreshReviewMismatch: false,
            hasFinalArtifactMismatch: false,
            hasJudgeInconsistency: false,
          }
        : {}),
    }),
  );
  return changed ? invalidateOccurrenceCoverageSources(rebound, OCCURRENCE_SOURCES) : rebound;
}

export function bindCanonicalPlan(
  state: ReadinessProofState,
  input: BindCanonicalPlanInput,
): ReadinessProofState {
  if (input.planVersion !== state.planVersion) {
    throw new TypeError('canonical plan binding plan version does not match state');
  }
  requiredSha256(input.canonicalPlanSha256, 'canonical plan SHA-256');
  if (input.finalJudgeLineageDigest !== undefined) {
    requiredSha256(input.finalJudgeLineageDigest, 'final Judge lineage digest');
  }
  const judgeRequired = requiresJudge(state.riskDomains);
  if (judgeRequired && input.finalJudgeLineageDigest === undefined) {
    throw new TypeError('final Judge lineage digest is required for high-risk proof');
  }
  const changed =
    state.canonicalPlanSha256 !== undefined &&
    state.canonicalPlanSha256 !== input.canonicalPlanSha256;
  const deterministicBindingChanged =
    state.systemProofBinding !== undefined &&
    state.systemProofBinding.planSha256 !== input.canonicalPlanSha256;
  const sources = replaceSourceSlotRequirement(
    state.sources,
    'final-judge',
    judgeRequired
      ? {
          required: true,
          reason: 'applicable-high-risk-judge-required',
          expectedBinding: {
            candidate: {
              kind: 'canonical-plan',
              planVersion: input.planVersion,
              contentDigest: input.canonicalPlanSha256,
            },
            lineage: {
              evaluationStage: 'final-readiness',
              lineageDigest: requiredSha256(
                input.finalJudgeLineageDigest ?? '',
                'final Judge lineage digest',
              ),
            },
          },
        }
      : { required: false, reason: 'standard-risk-judge-exempt' },
  );
  const rebound = buildState(
    stateSeed(state, {
      canonicalPlanSha256: input.canonicalPlanSha256,
      sources,
      hasCanonicalBindingMismatch: !input.compatibleWithVersionedProof,
      hasFreshReviewMismatch: !input.compatibleWithVersionedProof,
      ...(changed
        ? {
            finalJudgeMaterialIssueIds: [],
            judgeApprovedPlanVersion: undefined,
            judgeEvaluatedPlanVersion: undefined,
            judgeReady: undefined,
          }
        : {}),
      ...(deterministicBindingChanged
        ? {
            systemCheckPassed: false,
            systemMismatchIds: [],
            requiredEvidenceUnavailable: [],
            systemProofBinding: undefined,
          }
        : {}),
    }),
  );
  return changed ? invalidateOccurrenceCoverageSource(rebound, 'final-judge') : rebound;
}

export function markFinalArtifactReview(
  state: ReadinessProofState,
  input: FinalArtifactReviewInput,
): ReadinessProofState {
  requiredSha256(input.canonicalPlanSha256, 'canonical plan SHA-256');
  if (
    input.planVersion !== state.planVersion ||
    input.canonicalPlanSha256 !== state.canonicalPlanSha256
  ) {
    throw new TypeError('final artifact review binding does not match current canonical plan');
  }
  return buildState(
    stateSeed(state, {
      hasFreshReviewMismatch: !input.fresh,
      hasFinalArtifactMismatch: !input.fresh,
      hasJudgeInconsistency: !input.judgeConsistent,
    }),
  );
}

export function addBoundaryChallenge(
  state: ReadinessProofState,
  challenge: BoundaryChallengeRecord,
): ReadinessProofState {
  const copied = copyBoundaryChallenges([challenge])[0];
  if (copied === undefined) {
    throw new TypeError('boundary challenge is unavailable');
  }
  return buildState(
    stateSeed(state, {
      boundaryChallenges: [
        ...state.boundaryChallenges.filter((entry) => entry.id !== copied.id),
        copied,
      ],
    }),
  );
}

export function invalidateFullReviewProof(state: ReadinessProofState): ReadinessProofState {
  return buildState(
    stateSeed(state, {
      sources: state.sources.map((slot) => ({
        source: slot.source,
        requirement: slot.requirement,
      })),
      lastCritiquedPlanVersion: undefined,
      scanComplete: false,
      admittedCriticIssueRefs: state.admittedCriticIssueRefs.filter(
        (issueRef) => !issueRef.startsWith(`v${state.planVersion}.`),
      ),
      criticMaterialIssueIds: [],
      fixReviewerMaterialIssueIds: [],
      intermediateJudgeMaterialIssueIds: [],
      finalJudgeMaterialIssueIds: [],
      systemCheckPassed: false,
      systemMismatchIds: [],
      requiredEvidenceUnavailable: [],
      systemProofBinding: undefined,
      riskDomains: state.riskDomains.map(invalidateRiskDomainAssessment),
      judgeApprovedPlanVersion: undefined,
      judgeEvaluatedPlanVersion: undefined,
      judgeReady: undefined,
      criticCoverageGapIds: [],
      criticScopeCoverageGapIds: [],
      criticContextGapIds: [],
    }),
  );
}

export function invalidateDeterministicProof(state: ReadinessProofState): ReadinessProofState {
  return buildState(
    stateSeed(state, {
      systemCheckPassed: false,
      systemMismatchIds: [],
      requiredEvidenceUnavailable: [],
      systemProofBinding: undefined,
    }),
  );
}

export function invalidateFinalizationProof(state: ReadinessProofState): ReadinessProofState {
  const hadFinalJudgeProof =
    state.canonicalPlanSha256 !== undefined ||
    state.sources.find((slot) => slot.source === 'final-judge')?.snapshot !== undefined;
  let sources = replaceSourceSlotRequirement(state.sources, 'fix-reviewer', {
    required: false,
    reason: 'not-evaluated-for-current-candidate',
  });
  sources = replaceSourceSlotRequirement(sources, 'final-judge', {
    required: false,
    reason: 'canonical-plan-not-bound',
  });
  const retainSystemProof =
    state.systemProofBinding === undefined ||
    state.systemProofBinding.planSha256 === state.planSha256;
  return buildState(
    stateSeed(state, {
      canonicalPlanSha256: undefined,
      sources,
      fixReviewerMaterialIssueIds: [],
      finalJudgeMaterialIssueIds: [],
      hasCanonicalBindingMismatch: false,
      hasFreshReviewMismatch: false,
      hasFinalArtifactMismatch: false,
      hasJudgeInconsistency: false,
      ...(!retainSystemProof
        ? {
            systemCheckPassed: false,
            systemMismatchIds: [],
            requiredEvidenceUnavailable: [],
            systemProofBinding: undefined,
          }
        : {}),
      ...(hadFinalJudgeProof
        ? {
            judgeApprovedPlanVersion: undefined,
            judgeEvaluatedPlanVersion: undefined,
            judgeReady: undefined,
          }
        : {}),
    }),
  );
}

export function recordAuthoritativeContext(
  state: ReadinessProofState,
  input: RecordAuthoritativeContextInput,
): ReadinessProofState {
  const authoritativeDigest = requiredSha256(input.authoritativeDigest, 'authoritative digest');
  const relationshipIds = sortedUnique(input.relationshipIds, 'relationship IDs');
  if (
    authoritativeDigest === state.authoritativeDigest &&
    canonicalJson(relationshipIds) === canonicalJson(state.relationshipIds)
  ) {
    return buildState(stateSeed(state));
  }
  const invalidated = invalidateFinalizationProof(invalidateFullReviewProof(state));
  return buildState(stateSeed(invalidated, { authoritativeDigest, relationshipIds }));
}

export function reduceReadinessProofState(state: ReadinessProofState): ReadinessProofState {
  return buildState(stateSeed(state));
}

export function setOccurrenceSourceRequirement(
  state: ReadinessProofState,
  source: OccurrenceSource,
  requirement: OccurrenceSourceRequirement,
): ReadinessProofState {
  if (!OCCURRENCE_SOURCES.includes(source)) {
    throw new TypeError('occurrence source is invalid');
  }
  const copiedRequirement = copyRequirement(source, requirement);
  if (source === 'critic' && !copiedRequirement.required) {
    throw new TypeError('critic occurrence source must be required');
  }
  if (
    copiedRequirement.required &&
    copiedRequirement.expectedBinding.candidate.planVersion !== state.catalog.expectedPlanVersion
  ) {
    throw new TypeError(`source binding plan version does not match catalog: ${source}`);
  }
  if (copiedRequirement.required) {
    assertSourceBinding(source, copiedRequirement.expectedBinding, true);
  }
  const sources = state.sources.map((slot) =>
    slot.source === source
      ? {
          source,
          requirement: copiedRequirement,
          ...(copiedRequirement.required &&
          slot.snapshot !== undefined &&
          bindingMatches(slot.snapshot.binding, copiedRequirement.expectedBinding)
            ? { snapshot: slot.snapshot }
            : {}),
        }
      : slot,
  );
  const retainedSnapshot = sources.find((slot) => slot.source === source)?.snapshot;
  return buildState(
    stateSeed(state, {
      sources,
      ...(retainedSnapshot === undefined && source === 'critic'
        ? { criticMaterialIssueIds: [] }
        : {}),
      ...(retainedSnapshot === undefined && source === 'fix-reviewer'
        ? { fixReviewerMaterialIssueIds: [] }
        : {}),
      ...(retainedSnapshot === undefined && source === 'intermediate-judge'
        ? { intermediateJudgeMaterialIssueIds: [] }
        : {}),
      ...(retainedSnapshot === undefined && source === 'final-judge'
        ? { finalJudgeMaterialIssueIds: [] }
        : {}),
    }),
  );
}

export function replaceOccurrenceCoverageSnapshot(
  state: ReadinessProofState,
  snapshot: OccurrenceCoverageSnapshot,
): ReadinessProofState {
  const canonicalSnapshot = copySnapshot(snapshot);
  const slot = state.sources.find((candidate) => candidate.source === canonicalSnapshot.source);
  if (slot === undefined) {
    throw new TypeError(`occurrence source slot is unavailable: ${canonicalSnapshot.source}`);
  }
  if (!slot.requirement.required) {
    throw new TypeError(
      `cannot attach a snapshot to an exempt source: ${canonicalSnapshot.source}`,
    );
  }
  if (
    slot.requirement.expectedBinding.candidate.contentDigest.startsWith(UNBOUND_BINDING_PREFIX) ||
    slot.requirement.expectedBinding.lineage.lineageDigest.startsWith(UNBOUND_BINDING_PREFIX)
  ) {
    throw new TypeError(
      `occurrence source binding must be rebound before admission: ${snapshot.source}`,
    );
  }
  assertSourceBinding(canonicalSnapshot.source, canonicalSnapshot.binding);
  if (canonicalSnapshot.catalogDigest !== state.catalog.digest) {
    throw new TypeError(`snapshot catalog digest is stale: ${canonicalSnapshot.source}`);
  }
  if (!bindingMatches(canonicalSnapshot.binding, slot.requirement.expectedBinding)) {
    throw new TypeError(`snapshot binding is stale: ${canonicalSnapshot.source}`);
  }
  if (!snapshotCatalogExact(state.catalog, canonicalSnapshot)) {
    throw new TypeError(
      `snapshot occurrence coverage is not catalog-exact: ${canonicalSnapshot.source}`,
    );
  }
  const sources = state.sources.map((candidate) =>
    candidate.source === canonicalSnapshot.source
      ? { ...candidate, snapshot: canonicalSnapshot }
      : candidate,
  );
  return buildState(stateSeed(state, { sources }));
}

export function invalidateOccurrenceCoverageSource(
  state: ReadinessProofState,
  source: OccurrenceSource,
): ReadinessProofState {
  if (!OCCURRENCE_SOURCES.includes(source)) {
    throw new TypeError('occurrence source is invalid');
  }
  return invalidateOccurrenceCoverageSources(state, [source]);
}

export function invalidateOccurrenceCoverageSources(
  state: ReadinessProofState,
  sources: readonly OccurrenceSource[],
): ReadinessProofState {
  const invalidated = new Set(sources);
  for (const source of invalidated) {
    if (!OCCURRENCE_SOURCES.includes(source)) {
      throw new TypeError('occurrence source is invalid');
    }
  }
  const invalidatedFixReviewer = invalidated.has('fix-reviewer');
  const invalidatedIntermediateJudge = invalidated.has('intermediate-judge');
  const invalidatedFinalJudge = invalidated.has('final-judge');
  return buildState(
    stateSeed(state, {
      sources: state.sources.map((slot) =>
        invalidated.has(slot.source)
          ? { source: slot.source, requirement: slot.requirement }
          : slot,
      ),
      ...(invalidated.has('critic')
        ? {
            admittedCriticIssueRefs: state.admittedCriticIssueRefs.filter(
              (issueRef) => !issueRef.startsWith(`v${state.planVersion}.`),
            ),
            criticMaterialIssueIds: [],
          }
        : {}),
      ...(invalidatedFixReviewer ? { fixReviewerMaterialIssueIds: [] } : {}),
      ...(invalidatedIntermediateJudge ? { intermediateJudgeMaterialIssueIds: [] } : {}),
      ...(invalidatedFinalJudge ? { finalJudgeMaterialIssueIds: [] } : {}),
    }),
  );
}

export function projectOccurrenceCoverage(
  state: ReadinessProofState,
): OccurrenceCoverageProjection {
  const sourceState = new Map(
    state.occurrenceCoverage.sources.map((source) => [source.source, source] as const),
  );
  return {
    catalogDigest: state.catalog.digest,
    expectedPlanVersion: state.catalog.expectedPlanVersion,
    riskDomainIds: [...state.catalog.riskDomainIds],
    invariants: state.catalog.invariants.map((invariant) => ({
      invariantId: invariant.invariantId,
      occurrenceIds: [...invariant.occurrenceIds],
    })),
    materialIssueIds: [...state.catalog.materialIssueIds],
    retainedContextCategories: [...state.catalog.retainedContextCategories],
    expectedOccurrenceIds: [...state.occurrenceCoverage.expectedOccurrenceIds],
    sources: state.sources.map((slot) => {
      const status = sourceState.get(slot.source);
      if (status === undefined) {
        throw new TypeError(`occurrence source status is unavailable: ${slot.source}`);
      }
      return {
        ...status,
        reason: slot.requirement.reason,
        ...(slot.requirement.required
          ? { expectedBinding: copyBinding(slot.requirement.expectedBinding, true) }
          : {}),
        ...(slot.snapshot === undefined ? {} : { snapshot: copySnapshot(slot.snapshot) }),
      };
    }),
    outcomes: state.occurrenceCoverage.outcomes.map((outcome) => ({ ...outcome })),
    resolvedOccurrenceIds: [...state.occurrenceCoverage.resolvedOccurrenceIds],
    violatedOccurrenceIds: [...state.occurrenceCoverage.violatedOccurrenceIds],
    unresolvedOccurrenceIds: [...state.occurrenceCoverage.unresolvedOccurrenceIds],
    disagreementOccurrenceIds: [...state.occurrenceCoverage.disagreementOccurrenceIds],
    catalogExact: state.occurrenceCoverage.catalogExact,
    sourcesCurrent: state.occurrenceCoverage.sourcesCurrent,
    sourcesConclusive: state.occurrenceCoverage.sourcesConclusive,
    sourceConsistent: state.occurrenceCoverage.sourceConsistent,
    proofSatisfied: state.occurrenceCoverage.proofSatisfied,
    reasonCodes: [...state.occurrenceCoverage.reasonCodes],
  };
}

export function occurrenceSourceFacts(state: ReadinessProofState): readonly OccurrenceSourceFact[] {
  return state.occurrenceCoverage.sources.map((source) => ({ ...source }));
}

export class ReadinessProofValidationError extends TypeError {
  public constructor(message: string) {
    super(`Invalid readiness proof state: ${message}`);
    this.name = 'ReadinessProofValidationError';
  }
}

function invalidState(message: string): never {
  throw new ReadinessProofValidationError(message);
}

function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    return invalidState(`${label} must be an object`);
  }
  return value;
}

function arrayValue(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) {
    return invalidState(`${label} must be an array`);
  }
  return value;
}

function stringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string') {
    return invalidState(`${label} must be a string`);
  }
  return value;
}

function sha256Value(value: JsonValue | undefined, label: string): string {
  const parsed = stringValue(value, label);
  if (!SHA256_PATTERN.test(parsed)) {
    return invalidState(`${label} must be a lowercase 64-character SHA-256 digest`);
  }
  return parsed;
}

function occurrenceBindingDigestValue(
  value: JsonValue | undefined,
  label: string,
  allowUnbound: boolean,
): { readonly value: string; readonly unbound: boolean } {
  const parsed = stringValue(value, label);
  if (SHA256_PATTERN.test(parsed)) {
    return { value: parsed, unbound: false };
  }
  if (allowUnbound && UNBOUND_SHA256_PATTERN.test(parsed)) {
    return { value: parsed, unbound: true };
  }
  return invalidState(
    `${label} must be a lowercase 64-character SHA-256 digest${allowUnbound ? ' or unbound SHA-256 digest' : ''}`,
  );
}

function integerValue(value: JsonValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return invalidState(`${label} must be an integer`);
  }
  return value;
}

function booleanValue(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== 'boolean') {
    return invalidState(`${label} must be boolean`);
  }
  return value;
}

function enumStringValue<const Values extends readonly string[]>(
  value: JsonValue | undefined,
  values: Values,
  label: string,
): Values[number] {
  const parsed = stringValue(value, label);
  if (!(values as readonly string[]).includes(parsed)) {
    return invalidState(`${label} is invalid`);
  }
  return parsed;
}

function stringArrayValue(value: JsonValue | undefined, label: string): string[] {
  return arrayValue(value, label).map((entry, index) => stringValue(entry, `${label}[${index}]`));
}

function parseFinding(value: JsonValue, label: string): FindingRecord {
  const object = objectValue(value, label);
  const disposition = objectValue(object.disposition, `${label}.disposition`);
  return {
    id: stringValue(object.id, `${label}.id`),
    issueRef: stringValue(object.issueRef, `${label}.issueRef`),
    introducedPlanVersion: integerValue(
      object.introducedPlanVersion,
      `${label}.introducedPlanVersion`,
    ),
    severity: enumStringValue(object.severity, ['blocker', 'major'] as const, `${label}.severity`),
    claim: stringValue(object.claim, `${label}.claim`),
    disposition: {
      scope: enumStringValue(
        disposition.scope,
        ['local', 'cross-cutting', 'unresolved'] as const,
        `${label}.disposition.scope`,
      ),
      rationale: stringValue(disposition.rationale, `${label}.disposition.rationale`),
      evidenceRefs: arrayValue(disposition.evidenceRefs, `${label}.disposition.evidenceRefs`),
      ...('supersededBy' in disposition
        ? {
            supersededBy: stringValue(
              disposition.supersededBy,
              `${label}.disposition.supersededBy`,
            ),
          }
        : {}),
    },
  };
}

function parseInvariant(value: JsonValue, label: string): ReadinessInvariantRecord {
  const object = objectValue(value, label);
  return {
    id: stringValue(object.id, `${label}.id`),
    sourceFinding: stringValue(object.sourceFinding, `${label}.sourceFinding`),
    statement: stringValue(object.statement, `${label}.statement`),
    occurrences: arrayValue(object.occurrences, `${label}.occurrences`).map((entry, index) => {
      const occurrence = objectValue(entry, `${label}.occurrences[${index}]`);
      return {
        id: stringValue(occurrence.id, `${label}.occurrences[${index}].id`),
        dimension: stringValue(occurrence.dimension, `${label}.occurrences[${index}].dimension`),
        subject: stringValue(occurrence.subject, `${label}.occurrences[${index}].subject`),
      };
    }),
  };
}

function parseContextDelivery(value: JsonValue, label: string): ContextDelivery {
  const object = objectValue(value, label);
  return {
    role: enumStringValue(
      object.role,
      ['creator', 'critic', 'fixer', 'reviewer', 'translator', 'judge'] as const,
      `${label}.role`,
    ),
    stage: stringValue(object.stage, `${label}.stage`),
    planVersion: integerValue(object.planVersion, `${label}.planVersion`),
    mandatoryBytes: integerValue(object.mandatoryBytes, `${label}.mandatoryBytes`),
    optionalBytes: integerValue(object.optionalBytes, `${label}.optionalBytes`),
    totalInputBytes: integerValue(object.totalInputBytes, `${label}.totalInputBytes`),
    inputTokenLimit:
      object.inputTokenLimit === null
        ? null
        : integerValue(object.inputTokenLimit, `${label}.inputTokenLimit`),
    inputLimitSource: enumStringValue(
      object.inputLimitSource,
      ['operator', 'model-registry', 'unknown'] as const,
      `${label}.inputLimitSource`,
    ),
    reductions: arrayValue(object.reductions, `${label}.reductions`).map((entry, index) => {
      const reduction = objectValue(entry, `${label}.reductions[${index}]`);
      return {
        category: stringValue(reduction.category, `${label}.reductions[${index}].category`),
        bytes: integerValue(reduction.bytes, `${label}.reductions[${index}].bytes`),
      };
    }),
    omittedCategories: stringArrayValue(object.omittedCategories, `${label}.omittedCategories`),
  };
}

function parseRiskDomain(value: JsonValue, label: string): ReadinessRiskDomainRecord {
  const object = objectValue(value, label);
  return {
    domain: enumStringValue(object.domain, READINESS_RISK_DOMAINS, `${label}.domain`),
    applicability: enumStringValue(
      object.applicability,
      ['applicable', 'not-applicable', 'unknown'] as const,
      `${label}.applicability`,
    ),
    risk: enumStringValue(object.risk, ['standard', 'high'] as const, `${label}.risk`),
    rationale: stringValue(object.rationale, `${label}.rationale`),
    evidenceRefs: arrayValue(object.evidenceRefs, `${label}.evidenceRefs`),
    complete: booleanValue(object.complete, `${label}.complete`),
    unavailableEvidence: stringArrayValue(
      object.unavailableEvidence,
      `${label}.unavailableEvidence`,
    ),
    ...('lastAssessedPlanVersion' in object
      ? {
          lastAssessedPlanVersion: integerValue(
            object.lastAssessedPlanVersion,
            `${label}.lastAssessedPlanVersion`,
          ),
        }
      : {}),
  };
}

function parseBoundaryChallenge(value: JsonValue, label: string): BoundaryChallengeRecord {
  const object = objectValue(value, label);
  return {
    id: stringValue(object.id, `${label}.id`),
    kind: enumStringValue(
      object.kind,
      ['scope-expansion', 'out-of-scope-removal', 'assurance-appetite'] as const,
      `${label}.kind`,
    ),
    claim: stringValue(object.claim, `${label}.claim`),
    rationale: stringValue(object.rationale, `${label}.rationale`),
    evidenceRefs: arrayValue(object.evidenceRefs, `${label}.evidenceRefs`),
    planVersion: integerValue(object.planVersion, `${label}.planVersion`),
  };
}

function parseOpportunity(value: JsonValue, label: string): OpportunityRecord {
  const object = objectValue(value, label);
  return {
    fingerprint: stringValue(object.fingerprint, `${label}.fingerprint`),
    claim: stringValue(object.claim, `${label}.claim`),
    evidence: stringValue(object.evidence, `${label}.evidence`),
    suggestedImprovement: stringValue(object.suggestedImprovement, `${label}.suggestedImprovement`),
    evidenceRefs: arrayValue(object.evidenceRefs, `${label}.evidenceRefs`),
    firstSeenPlanVersion: integerValue(
      object.firstSeenPlanVersion,
      `${label}.firstSeenPlanVersion`,
    ),
    lastSeenPlanVersion: integerValue(object.lastSeenPlanVersion, `${label}.lastSeenPlanVersion`),
  };
}

function parseSystemProofBinding(value: JsonValue | undefined, label: string): SystemProofBinding {
  const object = objectValue(value, label);
  return {
    planVersion: integerValue(object.planVersion, `${label}.planVersion`),
    planSha256: sha256Value(object.planSha256, `${label}.planSha256`),
    authoritativeDigest: sha256Value(object.authoritativeDigest, `${label}.authoritativeDigest`),
  };
}

function parseCreatorTransitionReceipt(
  value: JsonValue | undefined,
  label: string,
): CreatorTransitionReceipt {
  const object = objectValue(value, label);
  const schemaVersion = integerValue(object.schemaVersion, `${label}.schemaVersion`);
  if (schemaVersion !== 1) {
    return invalidState(`${label}.schemaVersion must be 1`);
  }
  return copyCreatorTransitionReceipt({
    schemaVersion,
    fromPlanVersion: integerValue(object.fromPlanVersion, `${label}.fromPlanVersion`),
    toPlanVersion: integerValue(object.toPlanVersion, `${label}.toPlanVersion`),
    fromCatalogDigest: sha256Value(object.fromCatalogDigest, `${label}.fromCatalogDigest`),
    expectedIssuesDigest: sha256Value(object.expectedIssuesDigest, `${label}.expectedIssuesDigest`),
    updateDigest: sha256Value(object.updateDigest, `${label}.updateDigest`),
    candidateDigest: sha256Value(object.candidateDigest, `${label}.candidateDigest`),
    nextCatalogDigest: sha256Value(object.nextCatalogDigest, `${label}.nextCatalogDigest`),
    admittedFactsDigest: sha256Value(object.admittedFactsDigest, `${label}.admittedFactsDigest`),
    admittedCriticIssueRefsDigest: sha256Value(
      object.admittedCriticIssueRefsDigest,
      `${label}.admittedCriticIssueRefsDigest`,
    ),
  });
}

function parseLifecycleSeed(
  object: JsonObject,
  catalog: ReadinessProofCatalog,
  sources: readonly OccurrenceSourceSlot[],
): ReadinessProofSeed {
  const issueBudget = objectValue(object.issueBudget, 'issueBudget');
  return {
    planVersion: integerValue(object.planVersion, 'planVersion'),
    quality: enumStringValue(object.quality, QUALITY_VALUES, 'quality'),
    promise: enumStringValue(object.promise, COMPLETENESS_PROMISES, 'promise'),
    requiredProofLevel: enumStringValue(
      object.requiredProofLevel,
      COMPLETENESS_PROMISES,
      'requiredProofLevel',
    ),
    requiresExhaustiveScan: booleanValue(object.requiresExhaustiveScan, 'requiresExhaustiveScan'),
    scopeSource: enumStringValue(
      object.scopeSource,
      ['prompt', 'direct-plan'] as const,
      'scopeSource',
    ),
    originalRequestAvailable: booleanValue(
      object.originalRequestAvailable,
      'originalRequestAvailable',
    ),
    sourceDigest: sha256Value(object.sourceDigest, 'sourceDigest'),
    ...('planSha256' in object ? { planSha256: sha256Value(object.planSha256, 'planSha256') } : {}),
    ...('canonicalPlanSha256' in object
      ? {
          canonicalPlanSha256: sha256Value(object.canonicalPlanSha256, 'canonicalPlanSha256'),
        }
      : {}),
    ...('creatorTransitionReceipt' in object
      ? {
          creatorTransitionReceipt: parseCreatorTransitionReceipt(
            object.creatorTransitionReceipt,
            'creatorTransitionReceipt',
          ),
        }
      : {}),
    authoritativeDigest: sha256Value(object.authoritativeDigest, 'authoritativeDigest'),
    operatorDecisionIds: stringArrayValue(object.operatorDecisionIds, 'operatorDecisionIds'),
    interventionIds: stringArrayValue(object.interventionIds, 'interventionIds'),
    findings: arrayValue(object.findings, 'findings').map((entry, index) =>
      parseFinding(entry, `findings[${index}]`),
    ),
    invariants: arrayValue(object.invariants, 'invariants').map((entry, index) =>
      parseInvariant(entry, `invariants[${index}]`),
    ),
    relationshipIds: stringArrayValue(object.relationshipIds, 'relationshipIds'),
    contextDeliveries: arrayValue(object.contextDeliveries, 'contextDeliveries').map(
      (entry, index) => parseContextDelivery(entry, `contextDeliveries[${index}]`),
    ),
    issueBudget: {
      limit: integerValue(issueBudget.limit, 'issueBudget.limit'),
      used: integerValue(issueBudget.used, 'issueBudget.used'),
      exhausted: booleanValue(issueBudget.exhausted, 'issueBudget.exhausted'),
    },
    iterationLimit: integerValue(object.iterationLimit, 'iterationLimit'),
    exhaustedLimits: arrayValue(object.exhaustedLimits, 'exhaustedLimits').map((entry, index) =>
      enumStringValue(entry, READINESS_LIMITS, `exhaustedLimits[${index}]`),
    ),
    ...('lastCritiquedPlanVersion' in object
      ? {
          lastCritiquedPlanVersion: integerValue(
            object.lastCritiquedPlanVersion,
            'lastCritiquedPlanVersion',
          ),
        }
      : {}),
    scanComplete: booleanValue(object.scanComplete, 'scanComplete'),
    declaredScopeVerified: booleanValue(object.declaredScopeVerified, 'declaredScopeVerified'),
    admittedCriticIssueRefs: stringArrayValue(
      object.admittedCriticIssueRefs,
      'admittedCriticIssueRefs',
    ),
    criticMaterialIssueIds: stringArrayValue(
      object.criticMaterialIssueIds,
      'criticMaterialIssueIds',
    ),
    fixReviewerMaterialIssueIds: stringArrayValue(
      object.fixReviewerMaterialIssueIds,
      'fixReviewerMaterialIssueIds',
    ),
    intermediateJudgeMaterialIssueIds: stringArrayValue(
      object.intermediateJudgeMaterialIssueIds,
      'intermediateJudgeMaterialIssueIds',
    ),
    finalJudgeMaterialIssueIds: stringArrayValue(
      object.finalJudgeMaterialIssueIds,
      'finalJudgeMaterialIssueIds',
    ),
    currentActionableIssues: stringArrayValue(
      object.currentActionableIssues,
      'currentActionableIssues',
    ),
    systemCheckPassed: booleanValue(object.systemCheckPassed, 'systemCheckPassed'),
    systemMismatchIds: stringArrayValue(object.systemMismatchIds, 'systemMismatchIds'),
    requiredEvidenceUnavailable: stringArrayValue(
      object.requiredEvidenceUnavailable,
      'requiredEvidenceUnavailable',
    ),
    ...('systemProofBinding' in object
      ? {
          systemProofBinding: parseSystemProofBinding(
            object.systemProofBinding,
            'systemProofBinding',
          ),
        }
      : {}),
    unresolvedMaterialQuestionIds: stringArrayValue(
      object.unresolvedMaterialQuestionIds,
      'unresolvedMaterialQuestionIds',
    ),
    ...('readinessContractDigest' in object
      ? {
          readinessContractDigest: sha256Value(
            object.readinessContractDigest,
            'readinessContractDigest',
          ),
        }
      : {}),
    judgeAllowed: booleanValue(object.judgeAllowed, 'judgeAllowed'),
    exhaustiveApplicableDomains: booleanValue(
      object.exhaustiveApplicableDomains,
      'exhaustiveApplicableDomains',
    ),
    riskDomains: arrayValue(object.riskDomains, 'riskDomains').map((entry, index) =>
      parseRiskDomain(entry, `riskDomains[${index}]`),
    ),
    boundaryChallenges: arrayValue(object.boundaryChallenges, 'boundaryChallenges').map(
      (entry, index) => parseBoundaryChallenge(entry, `boundaryChallenges[${index}]`),
    ),
    opportunities: arrayValue(object.opportunities, 'opportunities').map((entry, index) =>
      parseOpportunity(entry, `opportunities[${index}]`),
    ),
    ...('judgeApprovedPlanVersion' in object
      ? {
          judgeApprovedPlanVersion: integerValue(
            object.judgeApprovedPlanVersion,
            'judgeApprovedPlanVersion',
          ),
        }
      : {}),
    ...('judgeEvaluatedPlanVersion' in object
      ? {
          judgeEvaluatedPlanVersion: integerValue(
            object.judgeEvaluatedPlanVersion,
            'judgeEvaluatedPlanVersion',
          ),
        }
      : {}),
    ...('judgeReady' in object
      ? { judgeReady: booleanValue(object.judgeReady, 'judgeReady') }
      : {}),
    criticCoverageGapIds: stringArrayValue(object.criticCoverageGapIds, 'criticCoverageGapIds'),
    criticScopeCoverageGapIds: stringArrayValue(
      object.criticScopeCoverageGapIds,
      'criticScopeCoverageGapIds',
    ),
    criticContextGapIds: stringArrayValue(object.criticContextGapIds, 'criticContextGapIds'),
    materialRevisionProofGapIds: stringArrayValue(
      object.materialRevisionProofGapIds,
      'materialRevisionProofGapIds',
    ),
    otherUnresolvedProofIds: stringArrayValue(
      object.otherUnresolvedProofIds,
      'otherUnresolvedProofIds',
    ),
    hasCanonicalBindingMismatch: booleanValue(
      object.hasCanonicalBindingMismatch,
      'hasCanonicalBindingMismatch',
    ),
    hasFreshReviewMismatch: booleanValue(object.hasFreshReviewMismatch, 'hasFreshReviewMismatch'),
    hasFinalArtifactMismatch: booleanValue(
      object.hasFinalArtifactMismatch,
      'hasFinalArtifactMismatch',
    ),
    hasJudgeInconsistency: booleanValue(object.hasJudgeInconsistency, 'hasJudgeInconsistency'),
    catalog,
    sources,
  };
}

function parseBinding(
  value: JsonValue | undefined,
  label: string,
  allowUnbound = false,
): OccurrenceSourceBinding {
  const object = objectValue(value, label);
  const candidate = objectValue(object.candidate, `${label}.candidate`);
  const lineage = objectValue(object.lineage, `${label}.lineage`);
  const kind = stringValue(candidate.kind, `${label}.candidate.kind`);
  const evaluationStage = stringValue(lineage.evaluationStage, `${label}.lineage.evaluationStage`);
  if (!isOccurrenceCandidateKind(kind)) {
    return invalidState(`${label}.candidate.kind is invalid`);
  }
  if (!isOccurrenceEvaluationStage(evaluationStage)) {
    return invalidState(`${label}.lineage.evaluationStage is invalid`);
  }
  const contentDigest = occurrenceBindingDigestValue(
    candidate.contentDigest,
    `${label}.candidate.contentDigest`,
    allowUnbound,
  );
  const lineageDigest = occurrenceBindingDigestValue(
    lineage.lineageDigest,
    `${label}.lineage.lineageDigest`,
    allowUnbound,
  );
  if (contentDigest.unbound !== lineageDigest.unbound) {
    return invalidState(`${label} must not mix bound and unbound digests`);
  }
  return copyBinding(
    {
      candidate: {
        kind,
        planVersion: integerValue(candidate.planVersion, `${label}.candidate.planVersion`),
        contentDigest: contentDigest.value,
      },
      lineage: {
        evaluationStage,
        lineageDigest: lineageDigest.value,
      },
    },
    allowUnbound,
  );
}

function parseRequirement(
  value: JsonValue | undefined,
  label: string,
  source: OccurrenceSource,
  allowUnbound: boolean,
): OccurrenceSourceRequirement {
  const object = objectValue(value, label);
  if (object.required === true) {
    return copyRequirement(source, {
      required: true,
      reason: stringValue(object.reason, `${label}.reason`),
      expectedBinding: parseBinding(
        object.expectedBinding,
        `${label}.expectedBinding`,
        allowUnbound,
      ),
    });
  }
  if (object.required === false) {
    return copyRequirement(source, {
      required: false,
      reason: stringValue(object.reason, `${label}.reason`),
    });
  }
  return invalidState(`${label}.required must be boolean`);
}

function parseSnapshot(value: JsonValue | undefined, label: string): OccurrenceCoverageSnapshot {
  const object = objectValue(value, label);
  const occurrences = arrayValue(object.occurrences, `${label}.occurrences`).map((entry, index) => {
    const occurrence = objectValue(entry, `${label}.occurrences[${index}]`);
    return {
      invariantId: stringValue(
        occurrence.invariantId,
        `${label}.occurrences[${index}].invariantId`,
      ),
      occurrenceId: stringValue(
        occurrence.occurrenceId,
        `${label}.occurrences[${index}].occurrenceId`,
      ),
      disposition: enumStringValue(
        occurrence.disposition,
        RAW_DISPOSITIONS,
        `${label}.occurrences[${index}].disposition`,
      ),
      evidenceGrounded: occurrence.evidenceGrounded,
    } as AdmittedOccurrenceDisposition;
  });
  return copySnapshot({
    source: enumStringValue(object.source, OCCURRENCE_SOURCES, `${label}.source`),
    catalogDigest: sha256Value(object.catalogDigest, `${label}.catalogDigest`),
    binding: parseBinding(object.binding, `${label}.binding`),
    occurrences,
  });
}

function parseCatalog(value: JsonValue | undefined): ReadinessProofCatalog {
  const object = objectValue(value, 'catalog');
  sha256Value(object.digest, 'catalog.digest');
  const invariants = arrayValue(object.invariants, 'catalog.invariants').map((entry, index) => {
    const invariant = objectValue(entry, `catalog.invariants[${index}]`);
    return {
      invariantId: stringValue(invariant.invariantId, `catalog.invariants[${index}].invariantId`),
      occurrenceIds: arrayValue(
        invariant.occurrenceIds,
        `catalog.invariants[${index}].occurrenceIds`,
      ).map((occurrenceId, occurrenceIndex) =>
        stringValue(occurrenceId, `catalog.invariants[${index}].occurrenceIds[${occurrenceIndex}]`),
      ),
    };
  });
  const materialIssueIds = arrayValue(object.materialIssueIds, 'catalog.materialIssueIds').map(
    (issueId, index) => stringValue(issueId, `catalog.materialIssueIds[${index}]`),
  );
  const catalog = createReadinessProofCatalog({
    expectedPlanVersion: integerValue(object.expectedPlanVersion, 'catalog.expectedPlanVersion'),
    invariants,
    materialIssueIds,
  });
  if (canonicalJson(catalog) !== canonicalJson(object)) {
    return invalidState('catalog is not canonical or its digest is invalid');
  }
  return catalog;
}

export function parseReadinessProofState(value: JsonValue): ReadinessProofState {
  try {
    const object = objectValue(value, 'root');
    if (object.schemaVersion !== READINESS_PROOF_SCHEMA_VERSION) {
      return invalidState(`schemaVersion must be ${READINESS_PROOF_SCHEMA_VERSION}`);
    }
    const catalog = parseCatalog(object.catalog);
    const sourceValues = arrayValue(object.sources, 'sources');
    if (sourceValues.length !== OCCURRENCE_SOURCES.length) {
      return invalidState('sources must contain every source exactly once');
    }
    const parsedSlots = sourceValues.map((entry, index) => {
      const slot = objectValue(entry, `sources[${index}]`);
      const source = enumStringValue(slot.source, OCCURRENCE_SOURCES, `sources[${index}].source`);
      const hasSnapshot = 'snapshot' in slot;
      return {
        source,
        requirement: parseRequirement(
          slot.requirement,
          `sources[${index}].requirement`,
          source,
          !hasSnapshot,
        ),
        ...(hasSnapshot
          ? { snapshot: parseSnapshot(slot.snapshot, `sources[${index}].snapshot`) }
          : {}),
      };
    });
    if (new Set(parsedSlots.map((slot) => slot.source)).size !== OCCURRENCE_SOURCES.length) {
      return invalidState('sources must contain every source exactly once');
    }
    const requirements = Object.fromEntries(
      parsedSlots.map((slot) => [slot.source, slot.requirement]),
    ) as Partial<Record<OccurrenceSource, OccurrenceSourceRequirement>>;
    if (requirements.critic?.required !== true) {
      return invalidState('critic occurrence source must be required');
    }
    const parsedSeed = parseLifecycleSeed(
      object,
      catalog,
      parsedSlots.map((slot) => ({ source: slot.source, requirement: slot.requirement })),
    );
    const sourceMaterialIssueIds = {
      criticMaterialIssueIds: parsedSeed.criticMaterialIssueIds,
      fixReviewerMaterialIssueIds: parsedSeed.fixReviewerMaterialIssueIds,
      intermediateJudgeMaterialIssueIds: parsedSeed.intermediateJudgeMaterialIssueIds,
      finalJudgeMaterialIssueIds: parsedSeed.finalJudgeMaterialIssueIds,
    };
    let parsed = buildState({
      ...parsedSeed,
      admittedCriticIssueRefs: parsedSeed.admittedCriticIssueRefs.filter(
        (issueRef) => !issueRef.startsWith(`v${parsedSeed.planVersion}.`),
      ),
      criticMaterialIssueIds: [],
      fixReviewerMaterialIssueIds: [],
      intermediateJudgeMaterialIssueIds: [],
      finalJudgeMaterialIssueIds: [],
    });
    for (const slot of parsedSlots) {
      if (slot.snapshot !== undefined) {
        if (slot.snapshot.source !== slot.source) {
          return invalidState(`sources[${slot.source}] snapshot source does not match slot`);
        }
        parsed = replaceOccurrenceCoverageSnapshot(parsed, slot.snapshot);
      }
    }
    parsed = buildState(
      stateSeed(parsed, {
        ...sourceMaterialIssueIds,
        admittedCriticIssueRefs: parsedSeed.admittedCriticIssueRefs,
      }),
    );
    if (canonicalJson(parsed) !== canonicalJson(object)) {
      return invalidState('stored readiness proof state does not match canonical recomputation');
    }
    return parsed;
  } catch (error) {
    if (error instanceof ReadinessProofValidationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return invalidState(message);
  }
}
