import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import ajvModule from 'ajv/dist/2020.js';
import type { AnySchemaObject, ErrorObject, ValidateFunction } from 'ajv';
import { readRunRecords, type RunRecord } from '../../src/core/run-store.js';
import {
  readReadinessContract,
  type ReadinessContract,
} from '../../src/core/readiness-contract.js';
import {
  OCCURRENCE_SOURCES,
  projectOccurrenceCoverage,
  type OccurrenceCoverageProjection,
  type OccurrenceSourceProjection,
  type ReadinessProofState,
} from '../../src/core/readiness-proof.js';
import { readReadinessProofState } from '../../src/core/readiness-store.js';
import { planDocumentShapeOk } from '../../src/stages/plan/plan-shape.js';
import type { FinalProjection } from '../../src/types.js';
import {
  BENCHMARK_ROOT,
  benchmarkChildEnvironment,
  declaredFile,
  verifyBenchmarkOutputLocation,
  verifyBenchmarkWorkspace,
} from './benchmark.js';
import type {
  BenchmarkDecision,
  PlanningSmokeManifest,
  PlanningSmokeResults,
  PlanningSmokeSentinel,
  PlanningSmokeSentinelResult,
} from './model.js';

export const DEFAULT_SMOKE_MANIFEST_FILE = path.join(BENCHMARK_ROOT, 'smoke-manifest.json');
export const SMOKE_RESULTS_FILE = 'smoke-results.json';

const EXPECTED_STANDARD_ID = 'standard-create-ready';
const EXPECTED_HIGH_ID = 'high-revise-judge-ready';
const SEEDED_HIGH_RISK_FAULT =
  'complete payload directly to the final record path with writeFileSync';
const Ajv2020 = ajvModule.default;

interface LoadedPlanningSmoke {
  readonly manifest: PlanningSmokeManifest;
  readonly root: string;
}

interface RunPlanningSmokeOptions {
  readonly manifestFile?: string;
  readonly outputDir: string;
  readonly repositoryRoot: string;
}

interface EvaluatePlanningSmokeSentinelOptions {
  readonly sentinel: PlanningSmokeSentinel;
  readonly outputDir: string;
  readonly workDir: string;
  readonly exitCode: number;
}

interface SmokeApiResult {
  readonly schemaVersion: 1;
  readonly exitCode: number;
  readonly workDir: string;
  readonly final: FinalProjection | null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON in ${file}`, { cause: error });
  }
}

function validationDetails(errors: readonly ErrorObject[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) {
    return 'unknown schema error';
  }
  return errors
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}

function readValidatedManifest(file: string, schemaFile: string): PlanningSmokeManifest {
  const value = parseJson(file);
  const schema = parseJson(schemaFile);
  if (!isJsonObject(schema)) {
    throw new Error(`schema must be a JSON object: ${schemaFile}`);
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate: ValidateFunction<PlanningSmokeManifest> = ajv.compile<PlanningSmokeManifest>(
    schema as AnySchemaObject,
  );
  if (!validate(value)) {
    throw new Error(`schema validation failed for ${file}: ${validationDetails(validate.errors)}`);
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureNewPath(target: string, label: string): void {
  if (existsSync(target)) {
    throw new Error(`${label} already exists: ${target}`);
  }
}

function samePhysicalPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function assertAllCodexProviderSnapshot(file: string): void {
  const value = parseJson(file);
  if (!isJsonObject(value) || !isJsonObject(value.roles)) {
    throw new Error(`smoke provider config must pin role providers: ${file}`);
  }
  for (const role of ['creator', 'critic', 'fixer', 'reviewer', 'translator', 'judge']) {
    const config = value.roles[role];
    if (
      !isJsonObject(config) ||
      config.runner !== 'codex' ||
      typeof config.model !== 'string' ||
      config.model === ''
    ) {
      throw new Error(`smoke provider config must pin ${role} to a Codex model`);
    }
  }
}

function assertSentinelContract(sentinel: PlanningSmokeSentinel): void {
  const { expected } = sentinel;
  if (
    expected.minimumCritiqueIterations > expected.maximumCritiqueIterations ||
    expected.maximumCritiqueIterations > sentinel.maxIterations
  ) {
    throw new Error(`invalid critique bounds for smoke sentinel ${sentinel.id}`);
  }
  if (sentinel.id === EXPECTED_STANDARD_ID) {
    if (
      sentinel.risk !== 'standard' ||
      sentinel.inputMode !== 'prompt' ||
      sentinel.quality !== 'quick' ||
      expected.judge !== 'forbidden' ||
      expected.minimumPlanVersion !== 0
    ) {
      throw new Error('standard smoke sentinel must cover quick prompt creation without Judge');
    }
    return;
  }
  if (sentinel.id === EXPECTED_HIGH_ID) {
    if (
      sentinel.risk !== 'high' ||
      sentinel.inputMode !== 'plan' ||
      sentinel.quality !== 'balanced' ||
      expected.judge !== 'required' ||
      expected.minimumCritiqueIterations < 2 ||
      expected.minimumPlanVersion < 1
    ) {
      throw new Error('high-risk smoke sentinel must cover revision and targeted Judge assurance');
    }
    return;
  }
  throw new Error(`unknown planning smoke sentinel: ${sentinel.id}`);
}

export function validatePlanningSmoke(manifest: PlanningSmokeManifest, root: string): void {
  if (manifest.sentinels.length !== 2) {
    throw new Error('planning smoke must contain exactly two sentinels');
  }
  const ids = manifest.sentinels.map((sentinel) => sentinel.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('planning smoke sentinel IDs must be unique');
  }
  if (!ids.includes(EXPECTED_STANDARD_ID) || !ids.includes(EXPECTED_HIGH_ID)) {
    throw new Error('planning smoke must contain the standard and high-risk flow sentinels');
  }
  for (const sentinel of manifest.sentinels) {
    assertSentinelContract(sentinel);
    const inputFile = declaredFile(root, sentinel.input);
    if (sentinel.inputMode === 'plan' && !planDocumentShapeOk(inputFile)) {
      throw new Error(`direct-plan smoke sentinel is not structurally valid: ${sentinel.id}`);
    }
    if (
      sentinel.id === EXPECTED_HIGH_ID &&
      !readFileSync(inputFile, 'utf8').includes(SEEDED_HIGH_RISK_FAULT)
    ) {
      throw new Error('high-risk smoke sentinel is missing its seeded material fault');
    }
  }
  assertAllCodexProviderSnapshot(declaredFile(root, manifest.providerConfig));
}

export function loadPlanningSmoke(
  manifestFile: string = DEFAULT_SMOKE_MANIFEST_FILE,
): LoadedPlanningSmoke {
  const resolvedManifest = path.resolve(manifestFile);
  const root = path.dirname(resolvedManifest);
  const manifest = readValidatedManifest(
    resolvedManifest,
    path.join(root, 'smoke-manifest.schema.json'),
  );
  validatePlanningSmoke(manifest, root);
  return { manifest, root };
}

function matchingFiles(workDir: string, pattern: RegExp): readonly string[] {
  try {
    return readdirSync(workDir).filter((entry) => pattern.test(entry));
  } catch {
    return [];
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return sameJson(actual, [...expected].sort());
}

function indexedFiles(workDir: string, pattern: RegExp): readonly number[] {
  return matchingFiles(workDir, pattern)
    .flatMap((file) => {
      const match = pattern.exec(file);
      pattern.lastIndex = 0;
      return match?.[1] === undefined ? [] : [Number(match[1])];
    })
    .filter((version) => Number.isSafeInteger(version) && version >= 0)
    .sort((left, right) => left - right);
}

function expectedVersions(last: number, inclusive: boolean): readonly number[] {
  const count = inclusive ? last + 1 : last;
  return Array.from({ length: count }, (_, index) => index);
}

function readStrictProof(
  file: string,
  failures: string[],
  label: string,
): ReadinessProofState | undefined {
  try {
    return readReadinessProofState(file);
  } catch {
    failures.push(`${label} is missing, corrupt, or not schema 3`);
    return undefined;
  }
}

function readStrictContract(file: string, failures: string[]): ReadinessContract | undefined {
  try {
    return readReadinessContract(file);
  } catch {
    failures.push('frozen readiness contract is missing, corrupt, or not schema 2');
    return undefined;
  }
}

function readSmokeRunRecord(workDir: string, failures: string[]): RunRecord | undefined {
  const stateDir = path.join(path.dirname(workDir), 'state');
  const records = readRunRecords(stateDir).filter((record) =>
    samePhysicalPath(record.workDir, workDir),
  );
  if (records.length !== 1 || records[0]?.final === undefined) {
    failures.push('current schema-1 run record with FinalProjection is missing');
    return undefined;
  }
  return records[0];
}

function readSmokeApiResult(workDir: string, failures: string[]): SmokeApiResult | undefined {
  const file = path.join(path.dirname(workDir), 'api-result.json');
  let value: unknown;
  try {
    value = parseJson(file);
  } catch {
    failures.push('in-process API result is missing or invalid');
    return undefined;
  }
  if (
    !isJsonObject(value) ||
    !hasExactKeys(value, ['schemaVersion', 'exitCode', 'workDir', 'final']) ||
    value.schemaVersion !== 1 ||
    typeof value.exitCode !== 'number' ||
    !Number.isSafeInteger(value.exitCode) ||
    typeof value.workDir !== 'string' ||
    (value.final !== null && !isJsonObject(value.final))
  ) {
    failures.push('in-process API result is missing or invalid');
    return undefined;
  }
  return value as unknown as SmokeApiResult;
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

function validateOccurrenceCoverage(
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

function validateJudgeProof(
  sentinel: PlanningSmokeSentinel,
  workDir: string,
  proof: ReadinessProofState,
  contract: ReadinessContract,
  final: FinalProjection,
  failures: string[],
): void {
  const coverage = final.readiness.occurrenceCoverage;
  const intermediate = source(coverage, 'intermediate-judge');
  const finalSource = source(coverage, 'final-judge');
  const intermediateJudgeFiles = matchingFiles(workDir, /^judge\.v[0-9]+\.json$/);
  const finalJudgeFile = path.join(workDir, 'judge.final.json');
  const finalJudgeMetaFile = path.join(workDir, 'judge.final.meta.json');
  if (sentinel.expected.judge === 'forbidden') {
    if (
      final.judge.required ||
      final.judge.evaluated ||
      final.judge.available ||
      final.judge.verdict !== null ||
      final.judge.rationale !== 'standard-risk-judge-exempt' ||
      final.judge.allowed ||
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
      failures.push('standard-risk sentinel invoked Judge');
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

function critiqueHasMaterialIssue(file: string): boolean {
  try {
    const value = parseJson(file);
    return isJsonObject(value) && Array.isArray(value.issues) && value.issues.length > 0;
  } catch {
    return false;
  }
}

export function evaluatePlanningSmokeSentinel(
  options: EvaluatePlanningSmokeSentinelOptions,
): PlanningSmokeSentinelResult {
  const { sentinel, outputDir, workDir, exitCode } = options;
  const failures: string[] = [];
  const proofFile = path.join(workDir, 'convergence.final.json');
  const contractFile = path.join(workDir, 'readiness-contract.json');
  const proof = readStrictProof(proofFile, failures, 'final readiness proof');
  const contract = readStrictContract(contractFile, failures);
  const record = readSmokeRunRecord(workDir, failures);
  const api = readSmokeApiResult(workDir, failures);
  const final = record?.final;
  const decision: BenchmarkDecision = final?.readiness.decision ?? 'run-failed';
  const planVersion = final?.readiness.planVersion;
  const critiqueVersions = indexedFiles(workDir, /^critique\.v([0-9]+)\.json$/);
  const critiqueIterations = critiqueVersions.length;
  const finalPlanFile = path.join(workDir, 'plan.final.md');
  const finalPlanExists = existsSync(finalPlanFile) && statSync(finalPlanFile).isFile();
  const finalPlanText = finalPlanExists ? readFileSync(finalPlanFile, 'utf8') : undefined;
  const finalPlanSha256 = finalPlanText === undefined ? undefined : sha256(finalPlanText);

  if (exitCode !== 0) {
    failures.push(`run exited with code ${exitCode}`);
  }
  if (
    api !== undefined &&
    (api.exitCode !== exitCode ||
      !samePhysicalPath(api.workDir, workDir) ||
      api.final === null ||
      final === undefined ||
      !sameJson(api.final, final))
  ) {
    failures.push('in-process API and durable final projections disagree');
  }
  if (!existsSync(path.join(workDir, 'readiness-assessment.initial.json'))) {
    failures.push('readiness assessment artifact is missing');
  }
  if (!existsSync(path.join(workDir, 'plan.v0.md'))) {
    failures.push('initial plan artifact is missing');
  }
  if (decision !== sentinel.expected.decision) {
    failures.push(`decision is ${decision}, expected ${sentinel.expected.decision}`);
  }
  if (critiqueIterations < sentinel.expected.minimumCritiqueIterations) {
    failures.push('too few exact-version critic passes');
  }
  if (critiqueIterations > sentinel.expected.maximumCritiqueIterations) {
    failures.push('critic iteration budget was exceeded');
  }
  if (planVersion === undefined || planVersion < sentinel.expected.minimumPlanVersion) {
    failures.push('required plan revision was not produced');
  }
  if (!finalPlanExists || finalPlanText === undefined || finalPlanSha256 === undefined) {
    failures.push('final plan artifact is missing');
  } else if (!/^status: clean$/m.test(finalPlanText) || final?.status !== 'clean') {
    failures.push('final plan status is not clean');
  }

  if (planVersion !== undefined) {
    const expectedCritiques = expectedVersions(planVersion, true);
    const planVersions = indexedFiles(workDir, /^plan\.v([0-9]+)\.md$/);
    const proofVersions = indexedFiles(workDir, /^convergence\.v([0-9]+)\.json$/);
    const updateVersions = indexedFiles(workDir, /^update\.v([0-9]+)\.json$/);
    const updateMetaVersions = indexedFiles(workDir, /^update-meta\.v([0-9]+)\.json$/);
    if (
      !sameJson(critiqueVersions, expectedCritiques) ||
      !sameJson(planVersions, expectedCritiques) ||
      !sameJson(updateVersions, expectedVersions(planVersion, false)) ||
      !sameJson(updateMetaVersions, expectedVersions(planVersion, false))
    ) {
      failures.push('versioned plan, critique, and revision artifacts are not contiguous');
    }
    if (!sameJson(proofVersions, expectedCritiques)) {
      failures.push('versioned schema-3 readiness proofs are not contiguous');
    } else {
      for (const version of proofVersions) {
        const versioned = readStrictProof(
          path.join(workDir, `convergence.v${String(version)}.json`),
          failures,
          `versioned readiness proof v${String(version)}`,
        );
        const versionedPlanFile = path.join(workDir, `plan.v${String(version)}.md`);
        const versionedPlanSha256 = existsSync(versionedPlanFile)
          ? sha256(readFileSync(versionedPlanFile))
          : undefined;
        if (
          versioned !== undefined &&
          (versioned.planVersion !== version || versioned.planSha256 !== versionedPlanSha256)
        ) {
          failures.push(
            `versioned readiness proof v${String(version)} has the wrong plan identity`,
          );
        }
      }
    }
  }

  if (sentinel.expected.judge === 'required') {
    const initialCritique = path.join(workDir, 'critique.v0.json');
    if (!existsSync(initialCritique) || !critiqueHasMaterialIssue(initialCritique)) {
      failures.push('initial critic did not report the seeded material issue');
    }
  }

  if (proof !== undefined && contract !== undefined && final !== undefined) {
    const projection = final.readiness;
    if (
      !samePhysicalPath(projection.proofArtifactPath, proofFile) ||
      !samePhysicalPath(final.artifactPath, proofFile) ||
      projection.planVersion !== proof.planVersion ||
      projection.canonicalPlanSha256 !== proof.canonicalPlanSha256 ||
      projection.decision !== proof.reduction.decision ||
      !sameJson(projection.reasonCodes, proof.reduction.reasonCodes) ||
      projection.satisfied !== proof.reduction.satisfied ||
      !sameJson(projection.exhaustedLimits, proof.reduction.exhaustedLimits) ||
      !sameJson(projection.unresolvedProofIds, proof.reduction.unresolvedProofIds) ||
      proof.readinessContractDigest !== contract.contractDigest ||
      proof.sourceDigest !== contract.sourceDigest ||
      proof.authoritativeDigest !== contract.systemDigest ||
      record?.state !== 'finished' ||
      record.mode !== sentinel.inputMode ||
      record.quality !== sentinel.quality ||
      record.exitCode !== exitCode
    ) {
      failures.push('run record, contract, and final proof projections disagree');
    }
    if (
      finalPlanSha256 === undefined ||
      projection.canonicalPlanSha256 !== finalPlanSha256 ||
      proof.canonicalPlanSha256 !== finalPlanSha256
    ) {
      failures.push('final plan SHA-256 binding is incomplete');
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
      projection.opportunityCount !== proof.opportunities.length ||
      final.reasons.length > 0 ||
      final.structuralStatus !== 'clean'
    ) {
      failures.push('final status or risk-domain projection disagrees with proof');
    }
    if (sentinel.expected.judge === 'forbidden' && highRisk.length > 0) {
      failures.push('standard-risk sentinel was classified as high risk');
    }
    if (sentinel.expected.judge === 'required' && highRisk.length === 0) {
      failures.push('high-risk sentinel has no applicable high-risk domain');
    }
    validateOccurrenceCoverage(proof, final, failures);
    validateJudgeProof(sentinel, workDir, proof, contract, final, failures);
  }

  return {
    taskId: sentinel.id,
    passed: failures.length === 0,
    decision,
    critiqueIterations,
    ...(planVersion === undefined ? {} : { planVersion }),
    exitCode,
    failures,
    ...(finalPlanExists && finalPlanSha256 !== undefined
      ? {
          finalPlan: path.relative(outputDir, finalPlanFile),
          finalPlanSha256,
        }
      : {}),
  };
}

export function runPlanningSmoke(options: RunPlanningSmokeOptions): PlanningSmokeResults {
  const smoke = loadPlanningSmoke(options.manifestFile);
  const outputDir = path.resolve(options.outputDir);
  const repositoryRoot = realpathSync(options.repositoryRoot);
  verifyBenchmarkOutputLocation(repositoryRoot, outputDir);
  ensureNewPath(outputDir, 'planning smoke output');
  verifyBenchmarkWorkspace(
    repositoryRoot,
    smoke.manifest.workspaceRevision,
    options.manifestFile ?? DEFAULT_SMOKE_MANIFEST_FILE,
  );
  const providerConfigFile = declaredFile(smoke.root, smoke.manifest.providerConfig);
  const providerConfigText = readFileSync(providerConfigFile, 'utf8');
  mkdirSync(outputDir, { recursive: true });
  const taskResults: PlanningSmokeSentinelResult[] = [];

  for (const sentinel of smoke.manifest.sentinels) {
    const taskRoot = path.join(outputDir, sentinel.id);
    const workDir = path.join(taskRoot, 'run');
    const stateDir = path.join(taskRoot, 'state');
    const homeDir = path.join(taskRoot, 'home');
    mkdirSync(taskRoot, { recursive: true });
    const inputFile = declaredFile(smoke.root, sentinel.input);
    const environment = benchmarkChildEnvironment({
      ambientEnv: process.env,
      providerConfigText,
      homeDir,
      stateDir,
      workDir,
      runName: `smoke-${sentinel.id}`,
    });
    const apiResultFile = path.join(taskRoot, 'api-result.json');
    const runResult = spawnSync(
      'pnpm',
      [
        'exec',
        'tsx',
        path.join(repositoryRoot, 'scripts', 'benchmark-planning', 'smoke-api-runner.ts'),
        sentinel.inputMode,
        inputFile,
        sentinel.quality,
        String(sentinel.maxIterations),
        workDir,
        apiResultFile,
      ],
      {
        cwd: repositoryRoot,
        env: environment,
        stdio: 'inherit',
      },
    );
    const exitCode = runResult.status ?? (runResult.signal === null ? 1 : 143);
    taskResults.push(evaluatePlanningSmokeSentinel({ sentinel, outputDir, workDir, exitCode }));
    const partial: PlanningSmokeResults = {
      schemaVersion: 1,
      suiteId: smoke.manifest.suiteId,
      workspaceRevision: smoke.manifest.workspaceRevision,
      providerConfigSha256: sha256(providerConfigText),
      passed:
        taskResults.length === smoke.manifest.sentinels.length &&
        taskResults.every((task) => task.passed),
      tasks: taskResults,
    };
    writeJson(path.join(outputDir, SMOKE_RESULTS_FILE), partial);
  }

  return {
    schemaVersion: 1,
    suiteId: smoke.manifest.suiteId,
    workspaceRevision: smoke.manifest.workspaceRevision,
    providerConfigSha256: sha256(providerConfigText),
    passed: taskResults.every((task) => task.passed),
    tasks: taskResults,
  };
}
