import type { DeepPartial, OperatorConfig } from './core/config.js';
import type {
  OccurrenceCoverageProjection as CanonicalOccurrenceCoverageProjection,
  OccurrenceSourceBinding,
  OccurrenceSourceProjection as CanonicalOccurrenceSourceProjection,
} from './core/readiness-proof.js';

export type { Runner } from './providers/registry.js';

export type Role = 'creator' | 'critic' | 'fixer' | 'reviewer' | 'translator' | 'judge';

export type Quality = 'quick' | 'balanced' | 'thorough';

export type RunMode = 'plan' | 'prompt';

export type RunFinalStatus = 'clean' | 'needs-review' | 'blocked';

export type CompletenessPromise = 'best-effort' | 'cumulative' | 'exhaustive';

export type ReadinessDecision =
  | 'ready'
  | 'revision-required'
  | 'unable-to-decide'
  | 'limits-exhausted';

export type ReadinessLimit = 'issue-budget' | 'iteration-cap' | 'assurance-appetite';

export type RiskApplicability = 'applicable' | 'not-applicable' | 'unknown';

export type RiskLevel = 'standard' | 'high';

export type RiskDomain =
  | 'correctness'
  | 'public-compatibility'
  | 'data-migrations'
  | 'security-privacy-authorization'
  | 'concurrency-distributed-ordering'
  | 'cross-repository-delivery'
  | 'production-operability'
  | 'performance-cost';

export type OccurrenceSourceProjection = CanonicalOccurrenceSourceProjection;

export type OccurrenceCoverageProjection = CanonicalOccurrenceCoverageProjection;

export interface ReadinessProofProjection {
  readonly proofArtifactPath: string;
  readonly planVersion: number;
  readonly canonicalPlanSha256: string;
  readonly decision: ReadinessDecision;
  readonly reasonCodes: readonly string[];
  readonly satisfied: boolean;
  readonly exhaustedLimits: readonly ReadinessLimit[];
  readonly unresolvedProofIds: readonly string[];
  readonly applicableRiskDomains: readonly RiskDomain[];
  readonly highRiskDomains: readonly RiskDomain[];
  readonly opportunityCount: number;
  readonly occurrenceCoverage: OccurrenceCoverageProjection;
}

export interface JudgeProofProjection {
  readonly required: boolean;
  readonly allowed: boolean;
  readonly evaluated: boolean;
  readonly available: boolean;
  readonly candidateUnchanged: boolean;
  readonly verdict: boolean | null;
  readonly rationale: string;
  readonly binding?: OccurrenceSourceBinding;
  readonly metadataPath?: string;
}

export interface FinalProjection {
  readonly status: RunFinalStatus;
  readonly reasons: readonly string[];
  readonly structuralStatus: RunFinalStatus;
  readonly structuralReason: string;
  readonly artifactPath: string;
  readonly readiness: ReadinessProofProjection;
  readonly judge: JudgeProofProjection;
}

interface RunSecrets {
  readonly telegramBotToken?: string;
}

export interface RunOverrides {
  readonly workDir?: string;
  readonly home?: string;
  readonly config?: DeepPartial<OperatorConfig>;
  readonly secrets?: RunSecrets;
}
