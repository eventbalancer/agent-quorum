export type BenchmarkRisk = 'standard' | 'high';

export type BenchmarkApprovalStatus = 'operator-approval-required' | 'operator-approved';

export type BenchmarkDecision =
  | 'ready'
  | 'revision-required'
  | 'unable-to-decide'
  | 'limits-exhausted'
  | 'run-failed';

export type BlindLabel = 'A' | 'B';

export type BlindPreference = BlindLabel | 'tie';

export type MaterialSeverity = 'blocker' | 'major';

export interface BenchmarkKnownConcern {
  readonly id: string;
  readonly severity: MaterialSeverity;
  readonly claim: string;
}

export interface BenchmarkTask {
  readonly id: string;
  readonly risk: BenchmarkRisk;
  readonly category: string;
  readonly prompt: string;
  readonly reference: string;
  readonly referenceApproval: BenchmarkApprovalStatus;
  readonly workspaceRevision: string;
  readonly providerConfig: string;
  readonly knownConcerns: readonly BenchmarkKnownConcern[];
}

export interface ReadinessThreshold {
  readonly minimumReady: number;
  readonly total: number;
  readonly maximumCritiqueIterations: number;
}

export interface ComparisonThreshold {
  readonly minimumMajorityPreferred: number;
  readonly maximumMajorityWorse: number;
  readonly maximumMissedMaterialConcerns: number;
  readonly minimumIndependentReviewsPerTask: number;
}

export interface PlanningBenchmarkThresholds {
  readonly standard: ReadinessThreshold;
  readonly high: ReadinessThreshold;
  readonly comparison: ComparisonThreshold;
}

export interface PlanningBenchmarkManifest {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly corpusApproval: BenchmarkApprovalStatus;
  readonly thresholds: PlanningBenchmarkThresholds;
  readonly tasks: readonly BenchmarkTask[];
}

export interface BenchmarkTaskRunResult {
  readonly taskId: string;
  readonly decision: BenchmarkDecision;
  readonly critiqueIterations: number;
  readonly exitCode: number;
  readonly candidatePlan?: string;
  readonly candidateSha256?: string;
}

export interface BenchmarkRunResults {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly workspaceRevision: string;
  readonly providerConfigSha256: string;
  readonly tasks: readonly BenchmarkTaskRunResult[];
}

export interface BlindAssignment {
  readonly taskId: string;
  readonly candidateLabel: BlindLabel;
  readonly comparisonLabel: BlindLabel;
}

export interface BlindAnswerKey {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly seed: string;
  readonly assignments: readonly BlindAssignment[];
}

export interface BlindBundleTask {
  readonly taskId: string;
  readonly prompt: string;
  readonly planA: string;
  readonly planB: string;
}

export interface BlindBundleIndex {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly rubric: string;
  readonly tasks: readonly BlindBundleTask[];
}

export interface BlindMaterialFinding {
  readonly plan: BlindLabel;
  readonly severity: MaterialSeverity;
  readonly claim: string;
  readonly knownConcernId?: string;
}

export type KnownConcernDisposition = 'addressed' | 'missed' | 'unreviewed';

export interface BlindKnownConcernAssessment {
  readonly plan: BlindLabel;
  readonly knownConcernId: string;
  readonly disposition: KnownConcernDisposition;
  readonly evidence: string;
}

export interface BlindTaskReview {
  readonly taskId: string;
  readonly preference: BlindPreference;
  readonly findings: readonly BlindMaterialFinding[];
  readonly knownConcernAssessments: readonly BlindKnownConcernAssessment[];
}

export interface BlindReview {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly reviewerId: string;
  readonly tasks: readonly BlindTaskReview[];
}

export type ComparisonOutcome = 'preferred' | 'tie' | 'worse';

export interface BenchmarkTaskScore {
  readonly taskId: string;
  readonly risk: BenchmarkRisk;
  readonly decision: BenchmarkDecision;
  readonly critiqueIterations: number;
  readonly readinessPassed: boolean;
  readonly comparison: ComparisonOutcome;
  readonly candidateVotes: number;
  readonly comparisonVotes: number;
  readonly tieVotes: number;
  readonly missedKnownConcernIds: readonly string[];
  readonly additionalMaterialConcernCount: number;
}

export interface BenchmarkCheck {
  readonly passed: boolean;
  readonly actual: number;
  readonly required: number;
}

export interface BenchmarkScoreChecks {
  readonly standardReady: BenchmarkCheck;
  readonly highRiskReady: BenchmarkCheck;
  readonly missedMaterialConcerns: BenchmarkCheck;
  readonly majorityWorse: BenchmarkCheck;
  readonly majorityPreferred: BenchmarkCheck;
}

export interface BenchmarkScoreReport {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly reviewerCount: number;
  readonly thresholdsPassed: boolean;
  readonly operatorApprovalSatisfied: boolean;
  readonly accepted: boolean;
  readonly checks: BenchmarkScoreChecks;
  readonly tasks: readonly BenchmarkTaskScore[];
}
