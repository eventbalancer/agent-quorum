import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import ajvModule from 'ajv/dist/2020.js';
import type { AnySchemaObject, ErrorObject, ValidateFunction } from 'ajv';
import {
  admitFinalPlan,
  validatePlanOccurrenceCoverage,
  validatePlanJudgeProof,
} from '../../src/core/plan-admission.js';
import { readRunRecords, type RunRecord } from '../../src/core/run-store.js';
import {
  readReadinessContract,
  type ReadinessContract,
} from '../../src/core/readiness-contract.js';
import { type ReadinessProofState } from '../../src/core/readiness-proof.js';
import { readReadinessProofState } from '../../src/core/readiness-store.js';
import { planDocumentShapeOk } from '../../src/stages/plan/plan-shape.js';
import type { FinalProjection } from '../../src/types.js';
import { BENCHMARK_ROOT, declaredFile } from './benchmark.js';
import type {
  BenchmarkDecision,
  PlanningSmokeManifest,
  PlanningSmokeSentinel,
  PlanningSmokeSentinelResult,
} from './model.js';

export const DEFAULT_SMOKE_MANIFEST_FILE = path.join(BENCHMARK_ROOT, 'smoke-manifest.json');
export const SMOKE_RESULTS_FILE = 'smoke-results.json';

const EXPECTED_STANDARD_ID = 'standard-create-ready';
const EXPECTED_HIGH_ID = 'high-revise-judge-ready';
const SEEDED_HIGH_RISK_FAULT = 'without checking their target paths or relative order';
const Ajv2020 = ajvModule.default;

interface LoadedPlanningSmoke {
  readonly manifest: PlanningSmokeManifest;
  readonly root: string;
}

interface EvaluatePlanningSmokeSentinelOptions {
  readonly sentinel: PlanningSmokeSentinel;
  readonly outputDir: string;
  readonly workDir: string;
  readonly exitCode: number;
  readonly inputFile?: string;
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
      sentinel.maxIterations !== 2 ||
      expected.minimumCritiqueIterations !== 1 ||
      expected.maximumCritiqueIterations !== 2 ||
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
      sentinel.maxIterations !== 3 ||
      expected.maximumCritiqueIterations !== 3 ||
      expected.judge !== 'required' ||
      expected.minimumCritiqueIterations !== 2 ||
      expected.minimumPlanVersion !== 1
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
    validatePlanOccurrenceCoverage(proof, final, failures);
    validatePlanJudgeProof(
      sentinel.expected.judge === 'required',
      workDir,
      proof,
      contract,
      final,
      failures,
    );
    if (record !== undefined) {
      const admission = admitFinalPlan({
        workDir,
        record,
        ...(options.inputFile === undefined
          ? {}
          : { expectedSourceDigest: sha256(readFileSync(options.inputFile)) }),
      });
      if (!admission.admitted) {
        failures.push(...admission.failures);
      }
    }
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
