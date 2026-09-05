import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { FinalProjection } from '../types.js';
import { fileSha256 } from './digest.js';
import { readReadinessContract, type ReadinessContract } from './readiness-contract.js';
import {
  OCCURRENCE_SOURCES,
  projectOccurrenceCoverage,
  type OccurrenceCoverageProjection,
  type OccurrenceSourceProjection,
  type ReadinessProofState,
} from './readiness-proof.js';
import { readReadinessProofState } from './readiness-store.js';
import type { RunRecord } from './run-store.js';

export interface FinalPlanAdmissionOptions {
  readonly workDir: string;
  readonly record: RunRecord;
  readonly expectedSourceDigest?: string;
  readonly expectedAuthoritativeDigest?: string;
}

export type FinalPlanAdmissionResult =
  | {
      readonly admitted: true;
      readonly proof: ReadinessProofState;
      readonly contract: ReadinessContract;
      readonly canonicalPlanSha256: string;
    }
  | { readonly admitted: false; readonly failures: readonly string[] };

function samePhysicalPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return sameJson(Object.keys(value).sort(), [...expected].sort());
}

function parseJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

function matchingFiles(workDir: string, pattern: RegExp): readonly string[] {
  return readdirSync(workDir).filter((file) => pattern.test(file));
}

function source(
  coverage: OccurrenceCoverageProjection,
  name: (typeof OCCURRENCE_SOURCES)[number],
): OccurrenceSourceProjection | undefined {
  return coverage.sources.find((candidate) => candidate.source === name);
}

const FIX_REVIEW_EXEMPTIONS = new Set([
  'disabled',
  'no-findings',
  'proposal-failed',
  'review-failed',
  'replacement-rejected',
  'pre-fix-restored',
]);

function validateFixReviewerSource(
  coverage: OccurrenceCoverageProjection,
  failures: string[],
): void {
  const fixReviewer = source(coverage, 'fix-reviewer');
  if (fixReviewer === undefined) {
    failures.push('fix-reviewer source projection is missing');
    return;
  }
  if (fixReviewer.required) {
    if (
      fixReviewer.reason !== 'fix-pass-replacement-retained' ||
      !fixReviewer.available ||
      !fixReviewer.catalogExact ||
      !fixReviewer.current ||
      !fixReviewer.consistent ||
      !fixReviewer.conclusive ||
      fixReviewer.expectedBinding === undefined ||
      fixReviewer.snapshot === undefined ||
      !sameJson(fixReviewer.snapshot.binding, fixReviewer.expectedBinding)
    ) {
      failures.push('required fix-reviewer proof is missing, stale, or inconclusive');
    }
    return;
  }
  if (
    fixReviewer.available ||
    !fixReviewer.catalogExact ||
    !fixReviewer.current ||
    !fixReviewer.consistent ||
    !fixReviewer.conclusive ||
    !FIX_REVIEW_EXEMPTIONS.has(fixReviewer.reason)
  ) {
    failures.push('fix-reviewer exemption is unsupported or carries stale proof');
  }
}

export function validatePlanOccurrenceCoverage(
  proof: ReadinessProofState,
  final: FinalProjection,
  failures: string[],
): void {
  const projected = projectOccurrenceCoverage(proof);
  if (!sameJson(final.readiness.occurrenceCoverage, projected)) {
    failures.push('durable occurrence coverage disagrees with the schema-3 proof');
  }
  const coverage = projected;
  const catalogOccurrenceIds = proof.catalog.invariants.flatMap(
    (invariant) => invariant.occurrenceIds,
  );
  if (
    coverage.catalogDigest !== proof.catalog.digest ||
    coverage.expectedPlanVersion !== proof.planVersion ||
    !sameJson(coverage.expectedOccurrenceIds, catalogOccurrenceIds) ||
    !sameJson(
      coverage.outcomes.map((outcome) => outcome.occurrenceId),
      catalogOccurrenceIds,
    )
  ) {
    failures.push('occurrence catalog identity or outcome accounting is not exact');
  }
  if (
    !coverage.catalogExact ||
    !coverage.sourcesCurrent ||
    !coverage.sourcesConclusive ||
    !coverage.sourceConsistent ||
    !coverage.proofSatisfied ||
    coverage.outcomes.some((outcome) => outcome.outcome !== 'resolved') ||
    coverage.violatedOccurrenceIds.length > 0 ||
    coverage.unresolvedOccurrenceIds.length > 0 ||
    coverage.disagreementOccurrenceIds.length > 0
  ) {
    failures.push('final occurrence proof is not catalog-exact and all-resolved');
  }
  validateFixReviewerSource(coverage, failures);
}

interface FinalJudgeMetadata {
  readonly schemaVersion: 2;
  readonly canonicalPlan: 'plan.final.md';
  readonly planVersion: number;
  readonly planSha256: string;
  readonly observedPlanSha256: string | null;
  readonly readinessContractDigest: string | null;
  readonly catalogDigest: string;
  readonly source: 'final-judge';
  readonly binding: unknown;
  readonly evaluated: boolean;
  readonly available: boolean;
  readonly candidateUnchanged: boolean;
  readonly ready: boolean | null;
  readonly rationale: string;
  readonly occurrenceProof: Record<string, unknown> | null;
  readonly verdictArtifact: 'judge.final.json' | null;
}

const FINAL_JUDGE_METADATA_KEYS = [
  'schemaVersion',
  'canonicalPlan',
  'planVersion',
  'planSha256',
  'observedPlanSha256',
  'readinessContractDigest',
  'catalogDigest',
  'source',
  'binding',
  'evaluated',
  'available',
  'candidateUnchanged',
  'ready',
  'rationale',
  'occurrenceProof',
  'verdictArtifact',
] as const;

const FINAL_JUDGE_OCCURRENCE_KEYS = [
  'coverageComplete',
  'satisfied',
  'unresolvedOccurrenceIds',
  'violatedOccurrenceIds',
  'occurrences',
  'materialIssueIds',
] as const;

function parseFinalJudgeMetadata(file: string): FinalJudgeMetadata | undefined {
  let value: unknown;
  try {
    value = parseJson(file);
  } catch {
    return undefined;
  }
  if (
    !isJsonObject(value) ||
    !hasExactKeys(value, FINAL_JUDGE_METADATA_KEYS) ||
    value.schemaVersion !== 2 ||
    value.canonicalPlan !== 'plan.final.md' ||
    value.source !== 'final-judge' ||
    typeof value.planVersion !== 'number' ||
    !Number.isSafeInteger(value.planVersion) ||
    typeof value.planSha256 !== 'string' ||
    (value.observedPlanSha256 !== null && typeof value.observedPlanSha256 !== 'string') ||
    (value.readinessContractDigest !== null && typeof value.readinessContractDigest !== 'string') ||
    typeof value.catalogDigest !== 'string' ||
    typeof value.evaluated !== 'boolean' ||
    typeof value.available !== 'boolean' ||
    typeof value.candidateUnchanged !== 'boolean' ||
    (value.ready !== null && typeof value.ready !== 'boolean') ||
    typeof value.rationale !== 'string' ||
    (value.occurrenceProof !== null &&
      (!isJsonObject(value.occurrenceProof) ||
        !hasExactKeys(value.occurrenceProof, FINAL_JUDGE_OCCURRENCE_KEYS))) ||
    (value.verdictArtifact !== null && value.verdictArtifact !== 'judge.final.json')
  ) {
    return undefined;
  }
  return value as unknown as FinalJudgeMetadata;
}

export function validatePlanJudgeProof(
  judgeRequired: boolean,
  workDir: string,
  proof: ReadinessProofState,
  contract: ReadinessContract,
  final: FinalProjection,
  failures: string[],
): void {
  const notRequired = !judgeRequired;
  const coverage = final.readiness.occurrenceCoverage;
  const intermediate = source(coverage, 'intermediate-judge');
  const finalSource = source(coverage, 'final-judge');
  const intermediateJudgeFiles = matchingFiles(workDir, /^judge\.v[0-9]+\.json$/);
  const finalJudgeFile = path.join(workDir, 'judge.final.json');
  const finalJudgeMetaFile = path.join(workDir, 'judge.final.meta.json');
  if (notRequired) {
    if (
      final.judge.required ||
      final.judge.evaluated ||
      final.judge.available ||
      final.judge.verdict !== null ||
      final.judge.rationale !== 'standard-risk-judge-exempt' ||
      final.judge.binding !== undefined ||
      final.judge.metadataPath !== undefined ||
      intermediate?.required !== false ||
      intermediate.reason !== 'standard-risk-judge-exempt' ||
      intermediate.available ||
      !intermediate.catalogExact ||
      !intermediate.current ||
      !intermediate.consistent ||
      !intermediate.conclusive ||
      finalSource?.required !== false ||
      finalSource.reason !== 'standard-risk-judge-exempt' ||
      finalSource.available ||
      !finalSource.catalogExact ||
      !finalSource.current ||
      !finalSource.consistent ||
      !finalSource.conclusive
    ) {
      failures.push('standard-risk Judge projection is not explicitly exempt');
    }
    if (
      intermediateJudgeFiles.length > 0 ||
      existsSync(finalJudgeFile) ||
      existsSync(finalJudgeMetaFile)
    ) {
      failures.push('Judge-exempt plan carries Judge artifacts');
    }
    return;
  }

  if (
    !final.judge.required ||
    !final.judge.allowed ||
    !final.judge.evaluated ||
    !final.judge.available ||
    !final.judge.candidateUnchanged ||
    final.judge.verdict !== true ||
    final.judge.metadataPath === undefined ||
    !samePhysicalPath(final.judge.metadataPath, finalJudgeMetaFile) ||
    intermediate?.required !== true ||
    !intermediate.available ||
    !intermediate.catalogExact ||
    !intermediate.current ||
    !intermediate.consistent ||
    !intermediate.conclusive ||
    intermediate.expectedBinding === undefined ||
    intermediate.snapshot === undefined ||
    !sameJson(intermediate.expectedBinding, intermediate.snapshot.binding) ||
    finalSource?.required !== true ||
    !finalSource.available ||
    !finalSource.catalogExact ||
    !finalSource.current ||
    !finalSource.consistent ||
    !finalSource.conclusive ||
    finalSource.expectedBinding === undefined ||
    finalSource.snapshot === undefined ||
    !sameJson(finalSource.expectedBinding, finalSource.snapshot.binding)
  ) {
    failures.push('required intermediate/final Judge proof is incomplete');
  }
  if (!intermediateJudgeFiles.includes(`judge.v${String(proof.planVersion)}.json`)) {
    failures.push('intermediate Judge artifact is missing');
  }
  if (!existsSync(finalJudgeFile) || !existsSync(finalJudgeMetaFile)) {
    failures.push('final Judge proof is missing');
    return;
  }
  const metadata = parseFinalJudgeMetadata(finalJudgeMetaFile);
  if (metadata === undefined) {
    failures.push('schema-2 final Judge metadata disagrees with canonical proof');
    return;
  }
  const occurrenceProof = metadata.occurrenceProof;
  if (occurrenceProof === null) {
    failures.push('schema-2 final Judge metadata disagrees with canonical proof');
    return;
  }
  if (
    metadata.planVersion !== proof.planVersion ||
    metadata.planSha256 !== proof.canonicalPlanSha256 ||
    metadata.observedPlanSha256 !== proof.canonicalPlanSha256 ||
    metadata.readinessContractDigest !== contract.contractDigest ||
    metadata.catalogDigest !== proof.catalog.digest ||
    !metadata.evaluated ||
    !metadata.available ||
    !metadata.candidateUnchanged ||
    metadata.ready !== true ||
    metadata.rationale !== final.judge.rationale ||
    metadata.verdictArtifact !== 'judge.final.json' ||
    !sameJson(metadata.binding, final.judge.binding) ||
    !sameJson(metadata.binding, finalSource?.snapshot?.binding) ||
    occurrenceProof.coverageComplete !== true ||
    occurrenceProof.satisfied !== true ||
    !sameJson(occurrenceProof.unresolvedOccurrenceIds, []) ||
    !sameJson(occurrenceProof.violatedOccurrenceIds, []) ||
    !sameJson(occurrenceProof.occurrences, finalSource?.snapshot?.occurrences) ||
    !sameJson(occurrenceProof.materialIssueIds, [])
  ) {
    failures.push('schema-2 final Judge metadata disagrees with canonical proof');
  }
}

function isCurrentRunSchema(version: number): boolean {
  return version === 1;
}

export function admitFinalPlan(options: FinalPlanAdmissionOptions): FinalPlanAdmissionResult {
  const { record, workDir } = options;
  const failures: string[] = [];
  try {
    const proofFile = path.join(workDir, 'convergence.final.json');
    const proof = readReadinessProofState(proofFile);
    const contract = readReadinessContract(path.join(workDir, 'readiness-contract.json'));
    const canonicalPlanFile = path.join(workDir, 'plan.final.md');
    const canonicalPlanSha256 = fileSha256(canonicalPlanFile);
    const final = record.final;
    if (
      !isCurrentRunSchema(record.schemaVersion) ||
      record.state !== 'finished' ||
      record.exitCode !== 0 ||
      !samePhysicalPath(record.workDir, workDir) ||
      final === undefined
    ) {
      return {
        admitted: false,
        failures: ['finished current-schema run record is unavailable or mismatched'],
      };
    }
    const projection = final.readiness;
    if (
      !/^status: clean$/m.test(readFileSync(canonicalPlanFile, 'utf8')) ||
      final.status !== 'clean' ||
      final.structuralStatus !== 'clean' ||
      final.reasons.length > 0 ||
      proof.reduction.decision !== 'ready' ||
      !proof.reduction.satisfied
    ) {
      failures.push('final plan is not structurally clean and ready');
    }
    if (
      !samePhysicalPath(projection.proofArtifactPath, proofFile) ||
      !samePhysicalPath(final.artifactPath, proofFile) ||
      projection.planVersion !== proof.planVersion ||
      projection.canonicalPlanSha256 !== canonicalPlanSha256 ||
      proof.canonicalPlanSha256 !== canonicalPlanSha256 ||
      projection.decision !== proof.reduction.decision ||
      !sameJson(projection.reasonCodes, proof.reduction.reasonCodes) ||
      projection.satisfied !== proof.reduction.satisfied ||
      !sameJson(projection.exhaustedLimits, proof.reduction.exhaustedLimits) ||
      !sameJson(projection.unresolvedProofIds, proof.reduction.unresolvedProofIds) ||
      proof.readinessContractDigest !== contract.contractDigest ||
      proof.sourceDigest !== contract.sourceDigest ||
      proof.authoritativeDigest !== contract.systemDigest ||
      record.quality !== contract.appetite.quality ||
      proof.quality !== record.quality ||
      proof.sourceDigest !== fileSha256(record.inputPath) ||
      record.mode !== (proof.scopeSource === 'prompt' ? 'prompt' : 'plan') ||
      proof.iterationLimit !== contract.appetite.iterationLimit ||
      proof.issueBudget.limit !== contract.appetite.issueBudget ||
      proof.judgeAllowed !== contract.appetite.judgeAllowed ||
      final.judge.allowed !== proof.judgeAllowed ||
      proof.exhaustiveApplicableDomains !== contract.appetite.exhaustiveApplicableDomains
    ) {
      failures.push('run record, contract, and final proof identities disagree');
    }
    if (
      (options.expectedSourceDigest !== undefined &&
        proof.sourceDigest !== options.expectedSourceDigest) ||
      (options.expectedAuthoritativeDigest !== undefined &&
        proof.authoritativeDigest !== options.expectedAuthoritativeDigest)
    ) {
      failures.push('final proof does not assess the current source or authoritative context');
    }
    const applicable = contract.domainAssessments
      .filter((assessment) => assessment.applicability === 'applicable')
      .map((assessment) => assessment.domain);
    const highRisk = contract.domainAssessments
      .filter(
        (assessment) => assessment.applicability === 'applicable' && assessment.risk === 'high',
      )
      .map((assessment) => assessment.domain);
    if (
      !sameJson(projection.applicableRiskDomains, applicable) ||
      !sameJson(projection.highRiskDomains, highRisk) ||
      projection.opportunityCount !== proof.opportunities.length
    ) {
      failures.push('final risk-domain projection disagrees with proof');
    }
    validatePlanOccurrenceCoverage(proof, final, failures);
    validatePlanJudgeProof(highRisk.length > 0, workDir, proof, contract, final, failures);
    if (failures.length > 0) {
      return { admitted: false, failures };
    }
    return { admitted: true, proof, contract, canonicalPlanSha256 };
  } catch {
    return {
      admitted: false,
      failures: ['final readiness artifacts are missing, corrupt, or incompatible'],
    };
  }
}
