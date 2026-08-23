import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileSha256 } from '../../core/digest.js';
import {
  bindCanonicalPlan,
  createOccurrenceSourceBinding,
  invalidateDeterministicProof,
  invalidateOccurrenceCoverageSource,
  markFinalArtifactReview,
  projectOccurrenceCoverage,
  recordAdmittedFixReviewerProof,
  recordAdmittedJudgeProof,
  recordSystemProof,
  reduceReadinessProofState,
  type OccurrenceSourceBinding,
  type ReadinessProofState,
} from '../../core/readiness-proof.js';
import { writeReadinessProofState } from '../../core/readiness-store.js';
import type { RunContext } from '../../core/run-context.js';
import {
  validateSystemCoverage,
  writeSystemCheck,
  type SystemCheck,
} from '../../core/system-context.js';
import type { FinalProjection, RunFinalStatus } from '../../types.js';
import {
  carrySystemCoverageIntoPackage,
  emitPlanPackage,
  evaluateSplitDecision,
  PACKAGE_DIR_NAME,
  SPLIT_DECISION_FILE,
  parsePlanStructure,
  validatePlanPackage,
  type PackageHealth,
  type SplitDecision,
} from './plan-package.js';
import {
  planDocumentShapeHealth,
  planFrontmatterStatus,
  planHasTitleHeading,
  setPlanFrontmatterStatus,
  type PlanShapeHealth,
} from './plan-shape.js';
import { fixReviewCandidateDigest, type FixPassOutcome } from './fix-pass.js';
import {
  finalJudgeOperationalRationale,
  runFinalJudge,
  type FinalJudgeOperationalRationale,
  type FinalJudgeResult,
} from './judge.js';
import { runTranslatePass } from './translate-pass.js';
import {
  EMPTY_FINDINGS_COUNTS,
  readFindingsCounts,
  validateFinalPlan,
  type FindingsCounts,
} from './validate-plan.js';

const FINAL_PROOF_ARTIFACT = 'convergence.final.json';
const FINAL_SYSTEM_CHECK_ARTIFACT = 'system-check.final.json';
const FIX_REVIEW_STALE_REASON = 'fix-pass-replacement-proof-stale';
const MONOTONIC_DOWNGRADE_REASON = 'finalization:monotonic-downgrade';

export interface FinalizationStructuralFacts {
  readonly status: RunFinalStatus;
  readonly reason: string;
  readonly title: 0 | 1;
  readonly shape: PlanShapeHealth;
  readonly declaredStatus?: RunFinalStatus;
  readonly findings: FindingsCounts;
}

export interface FinalizationPackageFacts {
  readonly splitDecision: SplitDecision;
  readonly phaseCount: number;
  readonly directory?: string;
  readonly health?: PackageHealth;
}

export interface FinalizationJudgeFacts {
  readonly required: boolean;
  readonly allowed: boolean;
  readonly evaluated: boolean;
  readonly available: boolean;
  readonly candidateUnchanged: boolean;
  readonly verdict: boolean | null;
  readonly rationale:
    | FinalJudgeOperationalRationale
    | 'final-candidate-mutated-during-system-check'
    | 'standard-risk-judge-exempt'
    | 'structural-blocked'
    | 'assurance-appetite-judge-unavailable'
    | 'final-candidate-mutated-during-localization';
  readonly binding?: OccurrenceSourceBinding;
  readonly metadataPath?: string;
}

export interface FinalizationArtifacts {
  readonly finalPlan: string;
  readonly convergence: string;
  readonly systemCheck: string;
  readonly judgeMetadata?: string;
  readonly localizedPlan?: string;
}

export interface FinalizationResult {
  readonly proof: ReadinessProofState;
  readonly status: RunFinalStatus;
  readonly reasons: readonly string[];
  readonly structural: FinalizationStructuralFacts;
  readonly judge: FinalizationJudgeFacts;
  readonly artifacts: FinalizationArtifacts;
  readonly package: FinalizationPackageFacts;
  readonly exitCode: 0 | 6;
  readonly projection: FinalProjection;
}

export interface FinalizePlanDependencies {
  readonly systemCheck: (
    ctx: RunContext,
    state: ReadinessProofState,
    finalPlan: string,
  ) => SystemCheck | Promise<SystemCheck>;
  readonly judge: (
    ctx: RunContext,
    state: ReadinessProofState,
    finalPlan: string,
  ) => Promise<FinalJudgeResult>;
  readonly package: (
    ctx: RunContext,
    finalPlan: string,
  ) => FinalizationPackageFacts | Promise<FinalizationPackageFacts>;
  readonly localize: (ctx: RunContext, finalPlan: string, outFile: string) => void | Promise<void>;
}

function judgeRequired(state: ReadinessProofState): boolean {
  return state.riskDomains.some(
    (assessment) => assessment.applicability === 'applicable' && assessment.risk === 'high',
  );
}

function deterministicProofRequired(state: ReadinessProofState): boolean {
  return state.riskDomains.some(
    (assessment) =>
      assessment.applicability === 'applicable' &&
      assessment.domain === 'cross-repository-delivery',
  );
}

function emptyPackageHealth(): PackageHealth {
  return {
    ok: false,
    emptyWorkPlan: true,
    missingFiles: 0,
    missingHeadings: 0,
    brokenCrossRefs: 0,
    forbiddenShell: 0,
    references: EMPTY_FINDINGS_COUNTS,
  };
}

function writeSplitDecision(work: string, decision: SplitDecision): void {
  writeFileSync(
    path.join(work, SPLIT_DECISION_FILE),
    `${JSON.stringify(
      {
        decision: decision.split ? 'split' : 'no-split',
        rationale: decision.rationale,
        signals: decision.signals,
      },
      null,
      2,
    )}\n`,
  );
}

function defaultPackage(ctx: RunContext, finalPlan: string): FinalizationPackageFacts {
  rmSync(path.join(ctx.work, PACKAGE_DIR_NAME), { recursive: true, force: true });
  const structure = parsePlanStructure(finalPlan);
  const splitDecision = evaluateSplitDecision(structure, {
    mode: ctx.split.mode,
    minPhases: ctx.split.minPhases,
    maxPlanLines: ctx.maxPlanLines,
  });
  writeSplitDecision(ctx.work, splitDecision);
  if (!splitDecision.split) {
    return { splitDecision, phaseCount: 0 };
  }
  const emitted = emitPlanPackage(ctx.work, finalPlan, structure, splitDecision);
  if (emitted.kind === 'empty-work-plan') {
    return { splitDecision, phaseCount: 0, health: emptyPackageHealth() };
  }
  carrySystemCoverageIntoPackage(emitted.paths, ctx.readinessProof.relationshipIds);
  const health = validatePlanPackage(ctx.provider.projectRoot, emitted.paths.dir, {
    relationshipIds: ctx.readinessProof.relationshipIds,
  });
  return {
    splitDecision,
    phaseCount: emitted.paths.phases.length,
    directory: emitted.paths.dir,
    health,
  };
}

function defaultSystemCheck(
  ctx: RunContext,
  state: ReadinessProofState,
  finalPlan: string,
): SystemCheck {
  return validateSystemCoverage(ctx.systemContext, finalPlan, state.planVersion, {
    required: deterministicProofRequired(state),
    inScope: ctx.readinessBoundary?.inScope ?? ctx.systemContext.declaredScope,
    outOfScope: ctx.readinessBoundary?.outOfScope ?? [],
  });
}

export const DEFAULT_FINALIZE_PLAN_DEPENDENCIES: FinalizePlanDependencies = {
  systemCheck: defaultSystemCheck,
  judge: runFinalJudge,
  package: defaultPackage,
  localize: runTranslatePass,
};

function isPackageBroken(health: PackageHealth): boolean {
  return (
    health.emptyWorkPlan ||
    health.missingFiles > 0 ||
    health.missingHeadings > 0 ||
    health.brokenCrossRefs > 0 ||
    health.forbiddenShell > 0 ||
    (health.systemCoverageMissing ?? 0) > 0
  );
}

function packageReferencesNeedReview(health: PackageHealth): boolean {
  return (
    health.references.stale > 0 ||
    health.references.ambiguous > 0 ||
    health.references.unresolved > 0
  );
}

function structuralFacts(
  finalPlan: string,
  declaredStatus: RunFinalStatus | undefined,
  findings: FindingsCounts,
  packageFacts: FinalizationPackageFacts,
): FinalizationStructuralFacts {
  const title = planHasTitleHeading(finalPlan) ? 1 : 0;
  const shape = planDocumentShapeHealth(finalPlan);
  let status: RunFinalStatus = 'clean';
  let reason = '';
  if (title !== 1 || shape.missing !== 0 || shape.graph !== 1 || shape.frontmatter !== 1) {
    status = 'blocked';
    reason = `plan shape broken (title=${title} missing_sections=${shape.missing} impact_graph_mermaid=${shape.graph} frontmatter=${shape.frontmatter})`;
  } else if (packageFacts.health !== undefined && isPackageBroken(packageFacts.health)) {
    status = 'blocked';
    reason = packageFacts.health.emptyWorkPlan
      ? 'plan.package not emitted: forced split over an empty/absent Work Plan'
      : `plan.package broken (missing_files=${packageFacts.health.missingFiles} missing_headings=${packageFacts.health.missingHeadings} broken_cross_refs=${packageFacts.health.brokenCrossRefs} forbidden_shell=${packageFacts.health.forbiddenShell} system_coverage_missing=${packageFacts.health.systemCoverageMissing ?? 0})`;
  } else if (findings.stale > 0) {
    status = 'needs-review';
    reason = `${findings.stale} stale line reference(s) remain after fix-pass`;
  } else if (findings.ambiguous > 0 || findings.unresolved > 0) {
    status = 'needs-review';
    reason = `${findings.ambiguous} ambiguous + ${findings.unresolved} unresolved reference(s) (may be generic names or future files)`;
  } else if (
    packageFacts.health !== undefined &&
    packageReferencesNeedReview(packageFacts.health)
  ) {
    status = 'needs-review';
    reason = `plan.package references need review (stale=${packageFacts.health.references.stale} ambiguous=${packageFacts.health.references.ambiguous} unresolved=${packageFacts.health.references.unresolved})`;
  }
  return {
    status,
    reason,
    title,
    shape,
    ...(declaredStatus === undefined ? {} : { declaredStatus }),
    findings,
  };
}

function bindingsEqual(left: OccurrenceSourceBinding, right: OccurrenceSourceBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface FixProofResult {
  readonly state: ReadinessProofState;
  readonly retainedCurrent: boolean;
}

function consumeFixPassOutcome(
  state: ReadinessProofState,
  finalPlan: string,
  outcome: FixPassOutcome,
): FixProofResult {
  if (!outcome.retainedReplacement) {
    return {
      state: recordAdmittedFixReviewerProof(state, outcome.requirement),
      retainedCurrent: false,
    };
  }
  const expectedBinding = createOccurrenceSourceBinding(state, {
    source: 'fix-reviewer',
    candidateKind: outcome.candidate.kind,
    contentDigest: outcome.candidate.contentDigest,
  });
  const retainedCurrent =
    outcome.candidate.planVersion === state.planVersion &&
    path.resolve(outcome.candidate.path) === path.resolve(finalPlan) &&
    outcome.candidate.contentDigest === fixReviewCandidateDigest(finalPlan) &&
    bindingsEqual(outcome.requirement.expectedBinding, expectedBinding) &&
    bindingsEqual(outcome.requirement.expectedBinding, outcome.review.expectedBinding) &&
    bindingsEqual(outcome.requirement.expectedBinding, outcome.review.snapshot.binding) &&
    outcome.review.snapshot.catalogDigest === state.catalog.digest;
  return {
    state: recordAdmittedFixReviewerProof(
      state,
      retainedCurrent
        ? {
            required: true,
            reason: outcome.requirement.reason,
            expectedBinding,
            snapshot: outcome.review.snapshot,
            materialIssueIds: outcome.review.materialIssueIds,
          }
        : {
            required: true,
            reason: FIX_REVIEW_STALE_REASON,
            expectedBinding,
            materialIssueIds: [],
          },
    ),
    retainedCurrent,
  };
}

function proofComparableContent(file: string): string {
  return readFileSync(file, 'utf8').replace(
    /^status:[ \t]+(?:clean|needs-review|blocked)[ \t]*\r?$/m,
    'status: <orchestration-projection>',
  );
}

function projectFrontmatterStatus(file: string, status: RunFinalStatus): void {
  setPlanFrontmatterStatus(file, status);
  if (planFrontmatterStatus(file) === undefined) {
    writeFileSync(file, `---\nstatus: ${status}\n---\n\n${readFileSync(file, 'utf8')}`);
  }
}

function compatibleWithIndependentReview(
  ctx: RunContext,
  state: ReadinessProofState,
  finalPlan: string,
  retainedFixCurrent: boolean,
): boolean {
  if (retainedFixCurrent) {
    return true;
  }
  const reviewedPlan = path.join(ctx.work, `plan.v${state.planVersion}.md`);
  return (
    existsSync(reviewedPlan) &&
    state.planSha256 !== undefined &&
    fileSha256(reviewedPlan) === state.planSha256 &&
    proofComparableContent(reviewedPlan) === proofComparableContent(finalPlan)
  );
}

function invalidateRetainedFixProof(
  state: ReadinessProofState,
  outcome: FixPassOutcome,
): ReadinessProofState {
  if (!outcome.retainedReplacement) {
    return state;
  }
  const expectedBinding = createOccurrenceSourceBinding(state, {
    source: 'fix-reviewer',
    candidateKind: outcome.candidate.kind,
    contentDigest: outcome.candidate.contentDigest,
  });
  return recordAdmittedFixReviewerProof(state, {
    required: true,
    reason: FIX_REVIEW_STALE_REASON,
    expectedBinding,
    materialIssueIds: [],
  });
}

interface CanonicalBindingResult {
  readonly state: ReadinessProofState;
  readonly sha256: string;
}

function bindFinalCandidate(
  state: ReadinessProofState,
  finalPlan: string,
  compatible: boolean,
  fresh: boolean,
  judgeConsistent: boolean,
): CanonicalBindingResult {
  const sha256 = fileSha256(finalPlan);
  const finalJudgeBinding = judgeRequired(state)
    ? createOccurrenceSourceBinding(state, {
        source: 'final-judge',
        candidateKind: 'canonical-plan',
        contentDigest: sha256,
      })
    : undefined;
  let next = bindCanonicalPlan(state, {
    planVersion: state.planVersion,
    canonicalPlanSha256: sha256,
    ...(finalJudgeBinding === undefined
      ? {}
      : { finalJudgeLineageDigest: finalJudgeBinding.lineage.lineageDigest }),
    compatibleWithVersionedProof: compatible,
  });
  next = markFinalArtifactReview(next, {
    planVersion: next.planVersion,
    canonicalPlanSha256: sha256,
    fresh,
    judgeConsistent,
  });
  return { state: next, sha256 };
}

interface SystemProofResult {
  readonly state: ReadinessProofState;
  readonly check: SystemCheck;
  readonly candidateUnchanged: boolean;
}

async function refreshSystemProof(
  ctx: RunContext,
  state: ReadinessProofState,
  finalPlan: string,
  dependency: FinalizePlanDependencies['systemCheck'],
): Promise<SystemProofResult> {
  const expectedSha256 = fileSha256(finalPlan);
  const trustedCheck = defaultSystemCheck(ctx, state, finalPlan);
  let check: SystemCheck;
  try {
    check = await dependency(ctx, state, finalPlan);
  } catch {
    const required = deterministicProofRequired(state);
    check = {
      schemaVersion: 1,
      planVersion: state.planVersion,
      planSha256: expectedSha256,
      systemDigest: state.authoritativeDigest,
      required,
      boundaryRepositories: [
        ...(ctx.readinessBoundary?.inScope ?? ctx.systemContext.declaredScope),
      ],
      passed: !required,
      crossRepository: ctx.systemContext.crossRepository,
      relationships: [],
      mismatches: [],
      requiredEvidenceUnavailable: required ? ['system-check:unavailable'] : [],
      limitations: ctx.systemContext.limitations,
    };
  }
  const candidateUnchanged = fileSha256(finalPlan) === expectedSha256;
  const bindingCurrent =
    check.planVersion === state.planVersion &&
    check.planSha256 === expectedSha256 &&
    check.systemDigest === state.authoritativeDigest;
  const requirementCurrent = check.required === trustedCheck.required;
  const semanticsCurrent =
    check.passed === trustedCheck.passed &&
    JSON.stringify(check.boundaryRepositories) ===
      JSON.stringify(trustedCheck.boundaryRepositories) &&
    check.crossRepository === trustedCheck.crossRepository &&
    JSON.stringify(check.relationships) === JSON.stringify(trustedCheck.relationships) &&
    JSON.stringify(check.mismatches) === JSON.stringify(trustedCheck.mismatches) &&
    JSON.stringify(check.requiredEvidenceUnavailable) ===
      JSON.stringify(trustedCheck.requiredEvidenceUnavailable) &&
    JSON.stringify(check.limitations) === JSON.stringify(trustedCheck.limitations);
  if (!candidateUnchanged) {
    return { state: invalidateDeterministicProof(state), check, candidateUnchanged: false };
  }
  const mismatchIds = [
    ...trustedCheck.mismatches,
    ...(bindingCurrent ? [] : ['system-check:binding-mismatch']),
    ...(requirementCurrent ? [] : ['system-check:requirement-mismatch']),
    ...(semanticsCurrent ? [] : ['system-check:semantic-mismatch']),
  ].sort();
  const unavailableEvidenceIds = [...trustedCheck.requiredEvidenceUnavailable].sort();
  const passed =
    bindingCurrent &&
    requirementCurrent &&
    semanticsCurrent &&
    trustedCheck.passed &&
    mismatchIds.length === 0 &&
    unavailableEvidenceIds.length === 0;
  const admittedCheck: SystemCheck = {
    ...trustedCheck,
    planVersion: state.planVersion,
    planSha256: expectedSha256,
    systemDigest: state.authoritativeDigest,
    passed,
    mismatches: [...new Set(mismatchIds)],
    requiredEvidenceUnavailable: unavailableEvidenceIds,
  };
  const next = recordSystemProof(state, {
    binding: {
      planVersion: state.planVersion,
      planSha256: expectedSha256,
      authoritativeDigest: state.authoritativeDigest,
    },
    passed,
    mismatchIds: admittedCheck.mismatches,
    unavailableEvidenceIds: admittedCheck.requiredEvidenceUnavailable,
  });
  writeSystemCheck(ctx.work, admittedCheck, FINAL_SYSTEM_CHECK_ARTIFACT);
  return { state: next, check: admittedCheck, candidateUnchanged: true };
}

function exemptJudgeFacts(
  state: ReadinessProofState,
  rationale: FinalizationJudgeFacts['rationale'],
  candidateUnchanged = true,
): FinalizationJudgeFacts {
  return {
    required: judgeRequired(state),
    allowed: state.judgeAllowed,
    evaluated: false,
    available: false,
    candidateUnchanged,
    verdict: null,
    rationale,
  };
}

interface JudgeProofResult {
  readonly state: ReadinessProofState;
  readonly facts: FinalizationJudgeFacts;
  readonly candidateUnchanged: boolean;
}

async function evaluateFinalJudge(
  ctx: RunContext,
  state: ReadinessProofState,
  finalPlan: string,
  dependency: FinalizePlanDependencies['judge'],
): Promise<JudgeProofResult> {
  ctx.readinessProof = state;
  const expectedSha256 = fileSha256(finalPlan);
  const result = await dependency(ctx, state, finalPlan);
  const currentState = ctx.readinessProof;
  const candidateUnchanged = result.candidateUnchanged && fileSha256(finalPlan) === expectedSha256;
  let next: ReadinessProofState;
  let admitted = false;
  let admittedVerdict: boolean | null = null;
  let admittedBinding: OccurrenceSourceBinding | undefined;
  if (result.available) {
    if (
      candidateUnchanged &&
      result.binding.candidate.planVersion === state.planVersion &&
      result.binding.candidate.contentDigest === expectedSha256 &&
      bindingsEqual(result.binding, result.admitted.snapshot.binding)
    ) {
      try {
        next = recordAdmittedJudgeProof(currentState, {
          stage: 'final',
          snapshot: result.admitted.snapshot,
          verdict: result.admitted.verdict,
          ...(result.admitted.approvedPlanVersion === undefined
            ? {}
            : { approvedPlanVersion: result.admitted.approvedPlanVersion }),
          materialIssueIds: result.admitted.materialIssueIds,
        });
        admitted = true;
        admittedVerdict = result.admitted.verdict;
        admittedBinding = result.admitted.snapshot.binding;
      } catch {
        next = invalidateOccurrenceCoverageSource(currentState, 'final-judge');
      }
    } else {
      next = invalidateOccurrenceCoverageSource(currentState, 'final-judge');
    }
  } else {
    next = invalidateOccurrenceCoverageSource(currentState, 'final-judge');
  }
  return {
    state: next,
    facts: {
      required: true,
      allowed: state.judgeAllowed,
      evaluated: result.available,
      available: admitted,
      candidateUnchanged,
      verdict: admittedVerdict,
      rationale: finalJudgeOperationalRationale(candidateUnchanged, admittedVerdict),
      ...(admittedBinding === undefined ? {} : { binding: admittedBinding }),
      metadataPath: result.metadataPath,
    },
    candidateUnchanged,
  };
}

function judgeVerdictsConsistent(
  priorVerdict: boolean | undefined,
  current: FinalizationJudgeFacts,
): boolean {
  return priorVerdict === undefined || current.verdict === null || priorVerdict === current.verdict;
}

function finalReasons(
  structural: FinalizationStructuralFacts,
  proof: ReadinessProofState,
  monotonicDowngrade: boolean,
): string[] {
  const reasons: string[] = [];
  if (structural.status !== 'clean' && structural.reason !== '') {
    reasons.push(structural.reason);
  }
  if (!proof.reduction.satisfied) {
    reasons.push(`Readiness proof: ${proof.reduction.stopReason}`);
  }
  if (monotonicDowngrade && proof.reduction.satisfied) {
    reasons.push(MONOTONIC_DOWNGRADE_REASON);
  }
  return [...new Set(reasons)];
}

function statusFor(
  structural: FinalizationStructuralFacts,
  proof: ReadinessProofState,
  nonCleanLocked: boolean,
): RunFinalStatus {
  if (structural.status === 'blocked') {
    return 'blocked';
  }
  return !nonCleanLocked && structural.status === 'clean' && proof.reduction.satisfied
    ? 'clean'
    : 'needs-review';
}

interface CandidatePassResult {
  readonly state: ReadinessProofState;
  readonly judge: FinalizationJudgeFacts;
  readonly judgeConsistent: boolean;
  readonly mutated: boolean;
}

async function evaluateCandidateProof(
  ctx: RunContext,
  state: ReadinessProofState,
  finalPlan: string,
  structural: FinalizationStructuralFacts,
  priorJudgeVerdict: boolean | undefined,
  dependencies: FinalizePlanDependencies,
): Promise<CandidatePassResult> {
  const system = await refreshSystemProof(ctx, state, finalPlan, dependencies.systemCheck);
  if (!system.candidateUnchanged) {
    return {
      state: system.state,
      judge: exemptJudgeFacts(state, 'final-candidate-mutated-during-system-check', false),
      judgeConsistent: false,
      mutated: true,
    };
  }
  if (!judgeRequired(system.state)) {
    return {
      state: reduceReadinessProofState(system.state),
      judge: exemptJudgeFacts(system.state, 'standard-risk-judge-exempt'),
      judgeConsistent: true,
      mutated: false,
    };
  }
  if (structural.status === 'blocked') {
    return {
      state: reduceReadinessProofState(system.state),
      judge: exemptJudgeFacts(system.state, 'structural-blocked'),
      judgeConsistent: true,
      mutated: false,
    };
  }
  if (!system.state.judgeAllowed) {
    return {
      state: reduceReadinessProofState(system.state),
      judge: exemptJudgeFacts(system.state, 'assurance-appetite-judge-unavailable'),
      judgeConsistent: true,
      mutated: false,
    };
  }
  let judged: JudgeProofResult;
  try {
    judged = await evaluateFinalJudge(ctx, system.state, finalPlan, dependencies.judge);
  } catch {
    const unavailable = invalidateOccurrenceCoverageSource(ctx.readinessProof, 'final-judge');
    return {
      state: reduceReadinessProofState(unavailable),
      judge: exemptJudgeFacts(unavailable, 'final-judge-proof-unavailable'),
      judgeConsistent: !unavailable.hasJudgeInconsistency,
      mutated: false,
    };
  }
  const judgeConsistent =
    !system.state.hasJudgeInconsistency && judgeVerdictsConsistent(priorJudgeVerdict, judged.facts);
  const reviewed = markFinalArtifactReview(judged.state, {
    planVersion: judged.state.planVersion,
    canonicalPlanSha256: judged.state.canonicalPlanSha256 ?? fileSha256(finalPlan),
    fresh: !judged.state.hasFreshReviewMismatch && structural.status === 'clean',
    judgeConsistent,
  });
  return {
    state: reduceReadinessProofState(reviewed),
    judge: judged.facts,
    judgeConsistent,
    mutated: !judged.candidateUnchanged,
  };
}

interface PackageAndStructureResult {
  readonly packageFacts: FinalizationPackageFacts;
  readonly structural: FinalizationStructuralFacts;
  readonly candidateUnchanged: boolean;
}

async function refreshPackageAndStructure(
  ctx: RunContext,
  finalPlan: string,
  declaredStatus: RunFinalStatus | undefined,
  dependency: FinalizePlanDependencies['package'],
): Promise<PackageAndStructureResult> {
  validateFinalPlan(ctx.provider.projectRoot, finalPlan);
  const findings = readFindingsCounts(path.join(ctx.work, 'findings.json'));
  const before = fileSha256(finalPlan);
  const packageFacts = await dependency(ctx, finalPlan);
  const candidateUnchanged = fileSha256(finalPlan) === before;
  return {
    packageFacts,
    structural: structuralFacts(finalPlan, declaredStatus, findings, packageFacts),
    candidateUnchanged,
  };
}

function localizedPath(ctx: RunContext): string {
  return path.join(ctx.work, `plan.final.${ctx.settings.locale}.md`);
}

export async function finalizePlan(
  ctx: RunContext,
  finalPlan: string,
  fixPassOutcome: FixPassOutcome,
  dependencyOverrides: Partial<FinalizePlanDependencies> = {},
): Promise<FinalizationResult> {
  const dependencies: FinalizePlanDependencies = {
    ...DEFAULT_FINALIZE_PLAN_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const absoluteFinalPlan = path.resolve(finalPlan);
  if (absoluteFinalPlan !== path.resolve(ctx.work, 'plan.final.md')) {
    throw new TypeError('final plan must be the canonical work-directory plan');
  }
  const declaredStatus = planFrontmatterStatus(absoluteFinalPlan);
  const fixProof = consumeFixPassOutcome(ctx.readinessProof, absoluteFinalPlan, fixPassOutcome);
  let state = fixProof.state;
  ctx.readinessProof = state;

  let evaluated = await refreshPackageAndStructure(
    ctx,
    absoluteFinalPlan,
    declaredStatus,
    dependencies.package,
  );
  let structural = evaluated.structural;
  let nonCleanLocked = structural.status !== 'clean' || !evaluated.candidateUnchanged;
  const initialStatus: RunFinalStatus =
    structural.status === 'blocked'
      ? 'blocked'
      : structural.status === 'clean' && evaluated.candidateUnchanged
        ? 'clean'
        : 'needs-review';
  projectFrontmatterStatus(absoluteFinalPlan, initialStatus);
  evaluated = await refreshPackageAndStructure(
    ctx,
    absoluteFinalPlan,
    declaredStatus,
    dependencies.package,
  );
  let packageFacts = evaluated.packageFacts;
  structural = evaluated.structural;
  if (!evaluated.candidateUnchanged) {
    nonCleanLocked = true;
  }

  let retainedFixCurrent =
    fixProof.retainedCurrent &&
    (!fixPassOutcome.retainedReplacement ||
      fixPassOutcome.candidate.contentDigest === fixReviewCandidateDigest(absoluteFinalPlan));
  if (!retainedFixCurrent && fixPassOutcome.retainedReplacement) {
    state = invalidateRetainedFixProof(state, fixPassOutcome);
  }
  let compatible = compatibleWithIndependentReview(
    ctx,
    state,
    absoluteFinalPlan,
    retainedFixCurrent,
  );
  let canonical = bindFinalCandidate(
    state,
    absoluteFinalPlan,
    compatible,
    compatible && structural.status === 'clean',
    true,
  );
  state = canonical.state;
  ctx.readinessProof = state;
  const intermediateJudgeVerdict =
    !fixPassOutcome.retainedReplacement && state.judgeEvaluatedPlanVersion === state.planVersion
      ? state.judgeReady
      : undefined;
  let pass = await evaluateCandidateProof(
    ctx,
    state,
    absoluteFinalPlan,
    structural,
    intermediateJudgeVerdict,
    dependencies,
  );
  state = pass.state;
  let judgeFacts = pass.judge;
  let needsSecondPass = pass.mutated;
  if (pass.mutated) {
    nonCleanLocked = true;
  }
  state = reduceReadinessProofState(state);
  if (initialStatus === 'clean' && !state.reduction.satisfied) {
    nonCleanLocked = true;
    needsSecondPass = true;
  }

  if (needsSecondPass) {
    projectFrontmatterStatus(absoluteFinalPlan, 'needs-review');
    evaluated = await refreshPackageAndStructure(
      ctx,
      absoluteFinalPlan,
      declaredStatus,
      dependencies.package,
    );
    packageFacts = evaluated.packageFacts;
    structural = evaluated.structural;
    retainedFixCurrent =
      retainedFixCurrent &&
      (!fixPassOutcome.retainedReplacement ||
        fixPassOutcome.candidate.contentDigest === fixReviewCandidateDigest(absoluteFinalPlan));
    if (!retainedFixCurrent && fixPassOutcome.retainedReplacement) {
      state = invalidateRetainedFixProof(state, fixPassOutcome);
    }
    compatible =
      !pass.mutated &&
      compatibleWithIndependentReview(ctx, state, absoluteFinalPlan, retainedFixCurrent);
    canonical = bindFinalCandidate(
      state,
      absoluteFinalPlan,
      compatible,
      compatible && structural.status === 'clean',
      pass.judgeConsistent,
    );
    state = canonical.state;
    ctx.readinessProof = state;
    const previousFinalVerdict = judgeFacts.verdict ?? undefined;
    pass = await evaluateCandidateProof(
      ctx,
      state,
      absoluteFinalPlan,
      structural,
      previousFinalVerdict,
      dependencies,
    );
    state = pass.state;
    judgeFacts = pass.judge;
    if (pass.mutated) {
      nonCleanLocked = true;
      projectFrontmatterStatus(absoluteFinalPlan, 'needs-review');
      evaluated = await refreshPackageAndStructure(
        ctx,
        absoluteFinalPlan,
        declaredStatus,
        dependencies.package,
      );
      packageFacts = evaluated.packageFacts;
      structural = evaluated.structural;
      state = invalidateRetainedFixProof(state, fixPassOutcome);
      canonical = bindFinalCandidate(state, absoluteFinalPlan, false, false, false);
      const system = await refreshSystemProof(
        ctx,
        canonical.state,
        absoluteFinalPlan,
        dependencies.systemCheck,
      );
      state = system.state;
    }
  }

  state = reduceReadinessProofState(state);
  let status = statusFor(structural, state, nonCleanLocked);
  projectFrontmatterStatus(absoluteFinalPlan, status);
  if (fileSha256(absoluteFinalPlan) !== (state.canonicalPlanSha256 ?? '')) {
    nonCleanLocked = true;
    retainedFixCurrent =
      retainedFixCurrent &&
      (!fixPassOutcome.retainedReplacement ||
        fixPassOutcome.candidate.contentDigest === fixReviewCandidateDigest(absoluteFinalPlan));
    if (!retainedFixCurrent) {
      state = invalidateRetainedFixProof(state, fixPassOutcome);
    }
    compatible =
      status !== 'blocked' &&
      compatibleWithIndependentReview(ctx, state, absoluteFinalPlan, retainedFixCurrent);
    canonical = bindFinalCandidate(
      state,
      absoluteFinalPlan,
      compatible,
      compatible && structural.status === 'clean',
      pass.judgeConsistent,
    );
    const system = await refreshSystemProof(
      ctx,
      canonical.state,
      absoluteFinalPlan,
      dependencies.systemCheck,
    );
    state = system.state;
    evaluated = await refreshPackageAndStructure(
      ctx,
      absoluteFinalPlan,
      declaredStatus,
      dependencies.package,
    );
    packageFacts = evaluated.packageFacts;
    structural = evaluated.structural;
  }

  const translateFile = localizedPath(ctx);
  rmSync(translateFile, { force: true });
  const beforeLocalization = fileSha256(absoluteFinalPlan);
  if (ctx.settings.translatePass === 1) {
    ctx.readinessProof = state;
    await dependencies.localize(ctx, absoluteFinalPlan, translateFile);
    state = ctx.readinessProof;
  }
  const localizationMutatedCanonical = fileSha256(absoluteFinalPlan) !== beforeLocalization;
  if (localizationMutatedCanonical) {
    nonCleanLocked = true;
    projectFrontmatterStatus(absoluteFinalPlan, 'needs-review');
    state = invalidateRetainedFixProof(state, fixPassOutcome);
    state = invalidateOccurrenceCoverageSource(state, 'final-judge');
    canonical = bindFinalCandidate(state, absoluteFinalPlan, false, false, false);
    const system = await refreshSystemProof(
      ctx,
      canonical.state,
      absoluteFinalPlan,
      dependencies.systemCheck,
    );
    state = system.state;
    evaluated = await refreshPackageAndStructure(
      ctx,
      absoluteFinalPlan,
      declaredStatus,
      dependencies.package,
    );
    packageFacts = evaluated.packageFacts;
    structural = evaluated.structural;
    judgeFacts = {
      required: judgeFacts.required,
      allowed: judgeFacts.allowed,
      evaluated: judgeFacts.evaluated,
      available: false,
      candidateUnchanged: false,
      verdict: null,
      rationale: 'final-candidate-mutated-during-localization',
      ...(judgeFacts.metadataPath === undefined ? {} : { metadataPath: judgeFacts.metadataPath }),
    };
  }

  state = reduceReadinessProofState(state);
  status = statusFor(structural, state, nonCleanLocked);
  projectFrontmatterStatus(absoluteFinalPlan, status);
  if (fileSha256(absoluteFinalPlan) !== state.canonicalPlanSha256) {
    canonical = bindFinalCandidate(state, absoluteFinalPlan, false, false, false);
    const system = await refreshSystemProof(
      ctx,
      canonical.state,
      absoluteFinalPlan,
      dependencies.systemCheck,
    );
    state = reduceReadinessProofState(system.state);
    evaluated = await refreshPackageAndStructure(
      ctx,
      absoluteFinalPlan,
      declaredStatus,
      dependencies.package,
    );
    packageFacts = evaluated.packageFacts;
    structural = evaluated.structural;
  }
  let finalStatus = statusFor(structural, state, nonCleanLocked);
  if (planFrontmatterStatus(absoluteFinalPlan) !== finalStatus) {
    projectFrontmatterStatus(absoluteFinalPlan, finalStatus);
    canonical = bindFinalCandidate(state, absoluteFinalPlan, false, false, false);
    const system = await refreshSystemProof(
      ctx,
      canonical.state,
      absoluteFinalPlan,
      dependencies.systemCheck,
    );
    state = reduceReadinessProofState(system.state);
    evaluated = await refreshPackageAndStructure(
      ctx,
      absoluteFinalPlan,
      declaredStatus,
      dependencies.package,
    );
    packageFacts = evaluated.packageFacts;
    structural = evaluated.structural;
    finalStatus = statusFor(structural, state, nonCleanLocked);
  }
  if (
    planFrontmatterStatus(absoluteFinalPlan) !== finalStatus ||
    fileSha256(absoluteFinalPlan) !== state.canonicalPlanSha256
  ) {
    throw new TypeError('finalization did not settle one exact canonical candidate');
  }
  ctx.readinessProof = state;
  const convergencePath = writeReadinessProofState(
    path.join(ctx.work, FINAL_PROOF_ARTIFACT),
    state,
  );
  const systemCheckPath = path.join(ctx.work, FINAL_SYSTEM_CHECK_ARTIFACT);
  const reasons = finalReasons(structural, state, nonCleanLocked);
  const canonicalPlanSha256 = state.canonicalPlanSha256;
  const judgeMetadata = judgeFacts.metadataPath;
  const localizedPlan = existsSync(translateFile) ? translateFile : undefined;
  const projection: FinalProjection = {
    status: finalStatus,
    reasons,
    structuralStatus: structural.status,
    structuralReason: structural.reason,
    artifactPath: convergencePath,
    readiness: {
      proofArtifactPath: convergencePath,
      planVersion: state.planVersion,
      canonicalPlanSha256,
      decision: state.reduction.decision,
      reasonCodes: state.reduction.reasonCodes,
      satisfied: state.reduction.satisfied,
      exhaustedLimits: state.reduction.exhaustedLimits,
      unresolvedProofIds: state.reduction.unresolvedProofIds,
      applicableRiskDomains: state.riskDomains
        .filter((assessment) => assessment.applicability === 'applicable')
        .map((assessment) => assessment.domain),
      highRiskDomains: state.riskDomains
        .filter(
          (assessment) => assessment.applicability === 'applicable' && assessment.risk === 'high',
        )
        .map((assessment) => assessment.domain),
      opportunityCount: state.opportunities.length,
      occurrenceCoverage: projectOccurrenceCoverage(state),
    },
    judge: judgeFacts,
  };
  return {
    proof: state,
    status: finalStatus,
    reasons,
    structural,
    judge: judgeFacts,
    artifacts: {
      finalPlan: absoluteFinalPlan,
      convergence: convergencePath,
      systemCheck: systemCheckPath,
      ...(judgeMetadata === undefined ? {} : { judgeMetadata }),
      ...(localizedPlan === undefined ? {} : { localizedPlan }),
    },
    package: packageFacts,
    exitCode: finalStatus === 'blocked' ? 6 : 0,
    projection,
  };
}
