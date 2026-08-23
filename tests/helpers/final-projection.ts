import path from 'node:path';
import { canonicalJsonSha256 } from '../../src/core/digest.js';
import type {
  FinalProjection,
  JudgeProofProjection,
  ReadinessDecision,
  RunFinalStatus,
} from '../../src/types.js';

interface FinalProjectionOptions {
  readonly status?: RunFinalStatus;
  readonly structuralStatus?: RunFinalStatus;
  readonly structuralReason?: string;
  readonly decision?: ReadinessDecision;
  readonly reasonCodes?: readonly string[];
  readonly reasons?: readonly string[];
  readonly judge?: Partial<JudgeProofProjection>;
}

export function finalProjection(
  workDir: string,
  options: FinalProjectionOptions = {},
): FinalProjection {
  const canonicalPlanSha256 = 'a'.repeat(64);
  const riskDomainIds = [
    'correctness',
    'public-compatibility',
    'data-migrations',
    'security-privacy-authorization',
    'concurrency-distributed-ordering',
    'cross-repository-delivery',
    'production-operability',
    'performance-cost',
  ] as const;
  const retainedContextCategories = [
    'original-scope',
    'authoritative-system-facts',
    'operator-decisions',
    'material-findings',
    'active-invariants',
    'quality-and-limits',
  ] as const;
  const catalogDigest = canonicalJsonSha256({
    expectedPlanVersion: 0,
    riskDomainIds,
    invariants: [],
    materialIssueIds: [],
    retainedContextCategories,
  });
  const criticBinding = {
    candidate: {
      kind: 'versioned-plan' as const,
      planVersion: 0,
      contentDigest: canonicalPlanSha256,
    },
    lineage: {
      evaluationStage: 'review' as const,
      lineageDigest: 'c'.repeat(64),
    },
  };
  const finalJudgeBinding = {
    candidate: {
      kind: 'canonical-plan' as const,
      planVersion: 0,
      contentDigest: canonicalPlanSha256,
    },
    lineage: {
      evaluationStage: 'final-readiness' as const,
      lineageDigest: 'd'.repeat(64),
    },
  };
  const intermediateJudgeBinding = {
    candidate: {
      kind: 'versioned-plan' as const,
      planVersion: 0,
      contentDigest: canonicalPlanSha256,
    },
    lineage: {
      evaluationStage: 'intermediate-readiness' as const,
      lineageDigest: 'e'.repeat(64),
    },
  };
  const proofArtifactPath = path.join(workDir, 'convergence.final.json');
  const decision = options.decision ?? 'ready';
  const reasonCodes = options.reasonCodes ?? [];
  const status = options.status ?? 'clean';
  const structuralStatus = options.structuralStatus ?? 'clean';
  const structuralReason = options.structuralReason ?? '';
  const derivedReasons = [
    ...(structuralStatus === 'clean' ? [] : [structuralReason]),
    ...(decision === 'ready'
      ? status === 'clean'
        ? []
        : ['finalization:monotonic-downgrade']
      : [`Readiness proof: ${decision}:${reasonCodes.join(',')}`]),
  ];
  const judge: JudgeProofProjection = {
    required: false,
    allowed: true,
    evaluated: false,
    available: false,
    candidateUnchanged: true,
    verdict: null,
    rationale: 'standard-risk-judge-exempt',
    ...options.judge,
  };
  const judgeBinding = judge.available ? finalJudgeBinding : undefined;
  const intermediateJudgeSource = judge.required
    ? {
        source: 'intermediate-judge' as const,
        required: true,
        available: true,
        catalogExact: true,
        current: true,
        consistent: true,
        conclusive: true,
        reason: 'applicable-high-risk-judge-required',
        expectedBinding: intermediateJudgeBinding,
        snapshot: {
          source: 'intermediate-judge' as const,
          catalogDigest,
          binding: intermediateJudgeBinding,
          occurrences: [],
        },
      }
    : {
        source: 'intermediate-judge' as const,
        required: false,
        available: false,
        catalogExact: true,
        current: true,
        consistent: true,
        conclusive: true,
        reason: 'standard-risk-judge-exempt',
      };
  const finalJudgeSource = judge.required
    ? {
        source: 'final-judge' as const,
        required: true,
        available: judge.available,
        catalogExact: judge.available,
        current: judge.available,
        consistent: true,
        conclusive: judge.available,
        reason: 'applicable-high-risk-judge-required',
        expectedBinding: finalJudgeBinding,
        ...(judge.available
          ? {
              snapshot: {
                source: 'final-judge' as const,
                catalogDigest,
                binding: finalJudgeBinding,
                occurrences: [],
              },
            }
          : {}),
      }
    : {
        source: 'final-judge' as const,
        required: false,
        available: false,
        catalogExact: true,
        current: true,
        consistent: true,
        conclusive: true,
        reason: 'standard-risk-judge-exempt',
      };
  const coverageReasonCodes =
    judge.required && !judge.available
      ? ['occurrence-source:final-judge:missing', 'occurrence-source:final-judge:inconclusive']
      : [];
  return {
    status,
    reasons: options.reasons ?? derivedReasons,
    structuralStatus,
    structuralReason,
    artifactPath: proofArtifactPath,
    readiness: {
      proofArtifactPath,
      planVersion: 0,
      canonicalPlanSha256,
      decision,
      reasonCodes,
      satisfied: decision === 'ready',
      exhaustedLimits: [],
      unresolvedProofIds: [],
      applicableRiskDomains: judge.required ? ['correctness'] : [],
      highRiskDomains: judge.required ? ['correctness'] : [],
      opportunityCount: 0,
      occurrenceCoverage: {
        catalogDigest,
        expectedPlanVersion: 0,
        riskDomainIds,
        invariants: [],
        materialIssueIds: [],
        retainedContextCategories,
        expectedOccurrenceIds: [],
        sources: [
          {
            source: 'critic',
            required: true,
            available: true,
            catalogExact: true,
            current: true,
            consistent: true,
            conclusive: true,
            reason: 'independent-critic-required',
            expectedBinding: criticBinding,
            snapshot: {
              source: 'critic',
              catalogDigest,
              binding: criticBinding,
              occurrences: [],
            },
          },
          {
            source: 'fix-reviewer',
            required: false,
            available: false,
            catalogExact: true,
            current: true,
            consistent: true,
            conclusive: true,
            reason: 'not-required',
          },
          intermediateJudgeSource,
          finalJudgeSource,
        ],
        outcomes: [],
        resolvedOccurrenceIds: [],
        violatedOccurrenceIds: [],
        unresolvedOccurrenceIds: [],
        disagreementOccurrenceIds: [],
        catalogExact: coverageReasonCodes.length === 0,
        sourcesCurrent: coverageReasonCodes.length === 0,
        sourcesConclusive: coverageReasonCodes.length === 0,
        sourceConsistent: true,
        proofSatisfied: coverageReasonCodes.length === 0,
        reasonCodes: coverageReasonCodes,
      },
    },
    judge: {
      ...judge,
      ...(judgeBinding === undefined ? {} : { binding: judgeBinding }),
    },
  };
}
