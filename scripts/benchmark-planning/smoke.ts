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
import { planDocumentShapeOk } from '../../src/stages/plan/plan-shape.js';
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

function convergenceDecision(value: unknown): BenchmarkDecision {
  if (!isJsonObject(value)) {
    return 'run-failed';
  }
  const decision = value.decision;
  return decision === 'ready' ||
    decision === 'revision-required' ||
    decision === 'unable-to-decide' ||
    decision === 'limits-exhausted'
    ? decision
    : 'run-failed';
}

function integerField(
  value: Record<string, unknown> | undefined,
  field: string,
): number | undefined {
  const selected = value?.[field];
  return typeof selected === 'number' && Number.isInteger(selected) ? selected : undefined;
}

function isEmptyStringArrayField(
  value: Record<string, unknown> | undefined,
  field: string,
): boolean {
  const selected = value?.[field];
  return (
    Array.isArray(selected) &&
    selected.length === 0 &&
    selected.every((entry) => typeof entry === 'string')
  );
}

function highRiskDomainCount(convergence: Record<string, unknown> | undefined): number {
  const domains = convergence?.riskDomains;
  if (!Array.isArray(domains)) {
    return 0;
  }
  return domains.filter(
    (domain) =>
      isJsonObject(domain) && domain.applicability === 'applicable' && domain.risk === 'high',
  ).length;
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
  const convergenceFile = path.join(workDir, 'convergence.final.json');
  const convergenceValue = existsSync(convergenceFile) ? parseJson(convergenceFile) : undefined;
  const convergence = isJsonObject(convergenceValue) ? convergenceValue : undefined;
  const decision = convergenceDecision(convergenceValue);
  const critiqueFiles = matchingFiles(workDir, /^critique\.v[0-9]+\.json$/);
  const critiqueIterations = critiqueFiles.length;
  const planVersion = integerField(convergence, 'planVersion');
  const finalPlanFile = path.join(workDir, 'plan.final.md');
  const finalPlanExists = existsSync(finalPlanFile) && statSync(finalPlanFile).isFile();
  const finalPlanText = finalPlanExists ? readFileSync(finalPlanFile, 'utf8') : undefined;
  const finalPlanSha256 = finalPlanText === undefined ? undefined : sha256(finalPlanText);

  if (exitCode !== 0) {
    failures.push(`run exited with code ${exitCode}`);
  }
  if (!existsSync(path.join(workDir, 'readiness-assessment.initial.json'))) {
    failures.push('readiness assessment artifact is missing');
  }
  if (!existsSync(path.join(workDir, 'readiness-contract.json'))) {
    failures.push('frozen readiness contract is missing');
  }
  if (!existsSync(path.join(workDir, 'plan.v0.md'))) {
    failures.push('initial plan artifact is missing');
  }
  if (convergence === undefined) {
    failures.push('final convergence artifact is missing');
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
  } else if (!/^status: clean$/m.test(finalPlanText)) {
    failures.push('final plan status is not clean');
  }
  if (convergence?.satisfied !== true) {
    failures.push('compatibility satisfied projection is not true');
  }
  if (!isEmptyStringArrayField(convergence, 'reasonCodes')) {
    failures.push('final convergence reason codes are missing or non-empty');
  }
  if (!isEmptyStringArrayField(convergence, 'unresolvedCoverage')) {
    failures.push('final convergence coverage is missing or unresolved');
  }
  if (
    planVersion === undefined ||
    integerField(convergence, 'lastCritiquedPlanVersion') !== planVersion
  ) {
    failures.push('final plan version lacks exact critic proof');
  }
  if (
    finalPlanSha256 === undefined ||
    convergence?.planSha256 !== finalPlanSha256 ||
    convergence.canonicalPlanSha256 !== finalPlanSha256
  ) {
    failures.push('final plan SHA-256 binding is incomplete');
  }

  const intermediateJudgeFiles = matchingFiles(workDir, /^judge\.v[0-9]+\.json$/);
  const finalJudgeFile = path.join(workDir, 'judge.final.json');
  const finalJudgeMetaFile = path.join(workDir, 'judge.final.meta.json');
  if (sentinel.expected.judge === 'forbidden') {
    if (
      intermediateJudgeFiles.length > 0 ||
      existsSync(finalJudgeFile) ||
      existsSync(finalJudgeMetaFile)
    ) {
      failures.push('standard-risk sentinel invoked Judge');
    }
    if (highRiskDomainCount(convergence) > 0) {
      failures.push('standard-risk sentinel was classified as high risk');
    }
  } else {
    if (highRiskDomainCount(convergence) === 0) {
      failures.push('high-risk sentinel has no applicable high-risk domain');
    }
    if (!existsSync(path.join(workDir, 'update.v0.json'))) {
      failures.push('creator revision artifact is missing');
    }
    if (!existsSync(path.join(workDir, 'update-meta.v0.json'))) {
      failures.push('creator revision metadata is missing');
    }
    const initialCritique = path.join(workDir, 'critique.v0.json');
    if (!existsSync(initialCritique) || !critiqueHasMaterialIssue(initialCritique)) {
      failures.push('initial critic did not report the seeded material issue');
    }
    if (intermediateJudgeFiles.length === 0) {
      failures.push('intermediate Judge artifact is missing');
    }
    if (!existsSync(finalJudgeFile) || !existsSync(finalJudgeMetaFile)) {
      failures.push('final Judge proof is missing');
    }
    if (convergence?.judgeReady !== true) {
      failures.push('final Judge did not approve readiness');
    }
    if (
      planVersion === undefined ||
      integerField(convergence, 'judgeApprovedPlanVersion') !== planVersion
    ) {
      failures.push('Judge approval is not bound to the final plan version');
    }
    if (existsSync(finalJudgeMetaFile) && finalPlanSha256 !== undefined) {
      const meta = parseJson(finalJudgeMetaFile);
      if (!isJsonObject(meta) || meta.planSha256 !== finalPlanSha256) {
        failures.push('final Judge metadata is not bound to the final plan SHA-256');
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
    const inputArgs = sentinel.inputMode === 'prompt' ? ['--prompt', inputFile] : [inputFile];
    const runResult = spawnSync(
      'pnpm',
      [
        'run',
        'run:cli',
        '--',
        'plan',
        '--quality',
        sentinel.quality,
        '--iters',
        String(sentinel.maxIterations),
        '--no-translate',
        ...inputArgs,
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
