import type { DeepPartial, OperatorConfig } from './core/config.js';

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

export type ConvergenceLimit =
  | 'issue-budget'
  | 'iteration-cap'
  | 'provider-context'
  | 'unknown-provider-context'
  | 'authoritative-scope'
  | 'assurance-appetite';

export interface ConvergenceReport {
  readonly promise: CompletenessPromise;
  readonly satisfied: boolean;
  readonly artifactPath: string;
  readonly exhaustedLimits: readonly ConvergenceLimit[];
  readonly unresolvedCoverage: readonly string[];
  readonly decision: ReadinessDecision;
  readonly reasonCodes: readonly string[];
  readonly applicableRiskDomains: readonly RiskDomain[];
  readonly highRiskDomains: readonly RiskDomain[];
  readonly opportunityCount: number;
}

export type ReadinessLabel = 'ready' | 'not-ready' | 'unknown';

export interface FinalReadiness {
  readonly evaluated: boolean;
  readonly ready: boolean | null;
  readonly rationale: string;
  readonly planSha256: string;
}

export function readinessLabel(ready: FinalReadiness['ready']): ReadinessLabel {
  if (ready === null) {
    return 'unknown';
  }
  return ready ? 'ready' : 'not-ready';
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
