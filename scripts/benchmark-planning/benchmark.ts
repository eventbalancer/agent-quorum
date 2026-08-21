import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ajvModule from 'ajv/dist/2020.js';
import type { AnySchemaObject, ErrorObject, ValidateFunction } from 'ajv';
import type {
  BenchmarkApprovalStatus,
  BenchmarkCheck,
  BenchmarkDecision,
  BenchmarkRunResults,
  BenchmarkScoreReport,
  BenchmarkTask,
  BenchmarkTaskRunResult,
  BenchmarkTaskScore,
  BlindAnswerKey,
  BlindAssignment,
  BlindBundleIndex,
  BlindBundleTask,
  BlindLabel,
  BlindReview,
  PlanningBenchmarkManifest,
} from './model.js';

export const BENCHMARK_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'benchmarks',
  'planning',
);

export const DEFAULT_MANIFEST_FILE = path.join(BENCHMARK_ROOT, 'manifest.json');
export const RUN_RESULTS_FILE = 'run-results.json';
export const BLIND_BUNDLE_FILE = 'bundle.json';
export const BLIND_REVIEW_TEMPLATE_FILE = 'review.template.json';

const REFERENCE_MARKER_PREFIX = '<!-- benchmark-reference-approval: ';
const REQUIRED_CATEGORIES = new Set([
  'local-cli-api-change',
  'config-artifact-projection',
  'internal-refactor',
  'schema-storage-migration',
  'resume-hash-binding',
  'cross-repository-delivery',
  'authorization-data-integrity',
  'concurrency-process-lifecycle',
]);
const EXPECTED_TASKS_PER_RISK = 5;
const EXPECTED_TASK_COUNT = EXPECTED_TASKS_PER_RISK * 2;
const EXPECTED_STANDARD_READY = 4;
const EXPECTED_STANDARD_MAX_ITERATIONS = 2;
const EXPECTED_HIGH_READY = 4;
const EXPECTED_HIGH_MAX_ITERATIONS = 3;
const EXPECTED_MINIMUM_PREFERRED = 6;
const EXPECTED_MAXIMUM_WORSE = 0;
const EXPECTED_MAXIMUM_MISSED = 0;
const EXPECTED_MINIMUM_REVIEWS = 2;
const Ajv2020 = ajvModule.default;

interface RunPlanningBenchmarkOptions {
  readonly manifestFile?: string;
  readonly outputDir: string;
  readonly repositoryRoot: string;
  readonly taskIds?: readonly string[];
}

interface CreateBlindBundleOptions {
  readonly manifestFile?: string;
  readonly resultsFile: string;
  readonly outputDir: string;
  readonly keyFile: string;
  readonly seed: string;
}

interface ScorePlanningBenchmarkOptions {
  readonly manifestFile?: string;
  readonly resultsFile: string;
  readonly keyFile: string;
  readonly reviewFiles: readonly string[];
}

interface LoadedBenchmark {
  readonly manifest: PlanningBenchmarkManifest;
  readonly root: string;
}

export interface BenchmarkChildEnvironmentOptions {
  readonly ambientEnv: NodeJS.ProcessEnv;
  readonly providerConfigText: string;
  readonly homeDir: string;
  readonly stateDir: string;
  readonly workDir: string;
  readonly runName: string;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${file}: ${detail}`, { cause: error });
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

function readValidatedJson<T>(
  file: string,
  schemaFile: string,
  requiredProperty: Extract<keyof T, string>,
): T {
  const value = parseJson(file);
  if (!isJsonObject(value) || !(requiredProperty in value)) {
    throw new Error(`required property ${requiredProperty} is missing from ${file}`);
  }
  const schemaValue = parseJson(schemaFile);
  if (!isJsonObject(schemaValue)) {
    throw new Error(`schema must be a JSON object: ${schemaFile}`);
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate: ValidateFunction<T> = ajv.compile<T>(schemaValue as AnySchemaObject);
  if (!validate(value)) {
    throw new Error(`schema validation failed for ${file}: ${validationDetails(validate.errors)}`);
  }
  return value;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function benchmarkConfigOverride(providerConfigText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(providerConfigText) as unknown;
  } catch (error) {
    throw new Error('benchmark provider config is not valid JSON', { cause: error });
  }
  if (!isJsonObject(parsed)) {
    throw new Error('benchmark provider config must be a JSON object');
  }
  const telegram = isJsonObject(parsed.telegram) ? parsed.telegram : {};
  return JSON.stringify({
    ...parsed,
    telegram: { ...telegram, clarify: '0' },
  });
}

export function benchmarkChildEnvironment(
  options: BenchmarkChildEnvironmentOptions,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(options.ambientEnv)) {
    if (!key.startsWith('AGENT_QUORUM_') && value !== undefined) {
      environment[key] = value;
    }
  }
  return {
    ...environment,
    AGENT_QUORUM_CONFIG_OVERRIDE_JSON: benchmarkConfigOverride(options.providerConfigText),
    AGENT_QUORUM_HOME: options.homeDir,
    AGENT_QUORUM_STATE_DIR: options.stateDir,
    AGENT_QUORUM_WORK_DIR: options.workDir,
    AGENT_QUORUM_RUN_NAME: options.runName,
    AGENT_QUORUM_CLARIFY: '0',
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function uniqueValues(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function assertExactSet(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const actualUnique = [...new Set(actual)].sort();
  const expectedUnique = [...new Set(expected)].sort();
  if (
    actual.length !== expected.length ||
    JSON.stringify(actualUnique) !== JSON.stringify(expectedUnique)
  ) {
    throw new Error(`${label} must contain each benchmark task exactly once`);
  }
}

function declaredFile(root: string, relativeFile: string): string {
  if (path.isAbsolute(relativeFile)) {
    throw new Error(`benchmark paths must be relative: ${relativeFile}`);
  }
  const resolvedRoot = realpathSync(root);
  const candidate = path.resolve(resolvedRoot, relativeFile);
  const relative = path.relative(resolvedRoot, candidate);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`benchmark path escapes its root: ${relativeFile}`);
  }
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    throw new Error(`benchmark file not found: ${relativeFile}`);
  }
  const resolvedCandidate = realpathSync(candidate);
  const resolvedRelative = path.relative(resolvedRoot, resolvedCandidate);
  if (resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative)) {
    throw new Error(`benchmark symlink escapes its root: ${relativeFile}`);
  }
  return resolvedCandidate;
}

function expectedReferenceMarker(status: BenchmarkApprovalStatus): string {
  return `${REFERENCE_MARKER_PREFIX}${status} -->`;
}

function assertProviderSnapshot(file: string): void {
  const value = parseJson(file);
  if (
    !isJsonObject(value) ||
    !isJsonObject(value.settings) ||
    value.settings.quality !== 'balanced'
  ) {
    throw new Error(`provider config must pin balanced quality: ${file}`);
  }
  if (!isJsonObject(value.roles)) {
    throw new Error(`provider config must pin role providers: ${file}`);
  }
  const requiredRoles = ['creator', 'critic', 'fixer', 'reviewer', 'translator', 'judge'];
  for (const role of requiredRoles) {
    const config = value.roles[role];
    if (
      !isJsonObject(config) ||
      typeof config.runner !== 'string' ||
      config.runner === '' ||
      typeof config.model !== 'string' ||
      config.model === ''
    ) {
      throw new Error(`provider config must pin runner and model for ${role}: ${file}`);
    }
  }
}

function assertThresholdContract(manifest: PlanningBenchmarkManifest): void {
  const { standard, high, comparison } = manifest.thresholds;
  const matches =
    standard.minimumReady === EXPECTED_STANDARD_READY &&
    standard.total === EXPECTED_TASKS_PER_RISK &&
    standard.maximumCritiqueIterations === EXPECTED_STANDARD_MAX_ITERATIONS &&
    high.minimumReady === EXPECTED_HIGH_READY &&
    high.total === EXPECTED_TASKS_PER_RISK &&
    high.maximumCritiqueIterations === EXPECTED_HIGH_MAX_ITERATIONS &&
    comparison.minimumMajorityPreferred === EXPECTED_MINIMUM_PREFERRED &&
    comparison.maximumMajorityWorse === EXPECTED_MAXIMUM_WORSE &&
    comparison.maximumMissedMaterialConcerns === EXPECTED_MAXIMUM_MISSED &&
    comparison.minimumIndependentReviewsPerTask === EXPECTED_MINIMUM_REVIEWS;
  if (!matches) {
    throw new Error('benchmark thresholds must match the bounded-readiness release contract');
  }
}

export function validatePlanningBenchmark(manifest: PlanningBenchmarkManifest, root: string): void {
  assertThresholdContract(manifest);
  if (manifest.tasks.length !== EXPECTED_TASK_COUNT) {
    throw new Error(`benchmark must contain exactly ${EXPECTED_TASK_COUNT} tasks`);
  }
  const ids = manifest.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('benchmark task IDs must be unique');
  }
  const concernIds = manifest.tasks.flatMap((task) =>
    task.knownConcerns.map((concern) => concern.id),
  );
  if (new Set(concernIds).size !== concernIds.length) {
    throw new Error('known material concern IDs must be globally unique');
  }
  const standardCount = manifest.tasks.filter((task) => task.risk === 'standard').length;
  const highCount = manifest.tasks.filter((task) => task.risk === 'high').length;
  if (standardCount !== EXPECTED_TASKS_PER_RISK || highCount !== EXPECTED_TASKS_PER_RISK) {
    throw new Error('benchmark must contain exactly five standard and five high-risk tasks');
  }
  const categories = new Set(manifest.tasks.map((task) => task.category));
  for (const category of REQUIRED_CATEGORIES) {
    if (!categories.has(category)) {
      throw new Error(`benchmark is missing required category: ${category}`);
    }
  }
  const revisions = uniqueValues(manifest.tasks.map((task) => task.workspaceRevision));
  if (revisions.length !== 1) {
    throw new Error('all benchmark tasks must pin the same workspace revision');
  }
  const providerConfigs = uniqueValues(manifest.tasks.map((task) => task.providerConfig));
  if (providerConfigs.length !== 1) {
    throw new Error('all benchmark tasks must pin the same provider config snapshot');
  }
  for (const task of manifest.tasks) {
    declaredFile(root, task.prompt);
    const referenceFile = declaredFile(root, task.reference);
    const firstLine = readFileSync(referenceFile, 'utf8').split(/\r?\n/, 1)[0] ?? '';
    if (firstLine !== expectedReferenceMarker(task.referenceApproval)) {
      throw new Error(`comparison plan approval marker does not match manifest: ${task.id}`);
    }
    declaredFile(root, task.providerConfig);
  }
  const providerConfig = providerConfigs[0];
  if (providerConfig === undefined) {
    throw new Error('provider config snapshot is missing');
  }
  assertProviderSnapshot(declaredFile(root, providerConfig));
}

export function loadPlanningBenchmark(
  manifestFile: string = DEFAULT_MANIFEST_FILE,
): LoadedBenchmark {
  const resolvedManifest = path.resolve(manifestFile);
  const root = path.dirname(resolvedManifest);
  const schemaFile = path.join(root, 'manifest.schema.json');
  const manifest = readValidatedJson<PlanningBenchmarkManifest>(
    resolvedManifest,
    schemaFile,
    'schemaVersion',
  );
  validatePlanningBenchmark(manifest, root);
  return { manifest, root };
}

function loadRunResults(
  file: string,
  benchmark: LoadedBenchmark,
  requireComplete: boolean,
): BenchmarkRunResults {
  const schemaFile = path.join(benchmark.root, 'run-results.schema.json');
  const results = readValidatedJson<BenchmarkRunResults>(
    path.resolve(file),
    schemaFile,
    'schemaVersion',
  );
  if (results.suiteId !== benchmark.manifest.suiteId) {
    throw new Error('run results suite does not match the benchmark manifest');
  }
  const expectedRevision = benchmark.manifest.tasks[0]?.workspaceRevision;
  if (results.workspaceRevision !== expectedRevision) {
    throw new Error('run results workspace revision does not match the benchmark manifest');
  }
  const providerConfig = benchmark.manifest.tasks[0]?.providerConfig;
  if (providerConfig === undefined) {
    throw new Error('benchmark provider config is missing');
  }
  const expectedConfigSha256 = sha256(
    readFileSync(declaredFile(benchmark.root, providerConfig), 'utf8'),
  );
  if (results.providerConfigSha256 !== expectedConfigSha256) {
    throw new Error('run results provider config digest does not match the benchmark manifest');
  }
  const expectedIds = benchmark.manifest.tasks.map((task) => task.id);
  if (requireComplete) {
    assertExactSet(
      results.tasks.map((task) => task.taskId),
      expectedIds,
      'run results',
    );
    const resultsRoot = path.dirname(path.resolve(file));
    for (const result of results.tasks) {
      if (result.candidatePlan === undefined || result.candidateSha256 === undefined) {
        throw new Error(`run results are missing candidate evidence for ${result.taskId}`);
      }
      const candidateFile = declaredFile(resultsRoot, result.candidatePlan);
      if (sha256(readFileSync(candidateFile)) !== result.candidateSha256) {
        throw new Error(`candidate digest does not match run results for ${result.taskId}`);
      }
    }
  }
  return results;
}

function loadAnswerKey(file: string, benchmark: LoadedBenchmark): BlindAnswerKey {
  const schemaFile = path.join(benchmark.root, 'blind-key.schema.json');
  const key = readValidatedJson<BlindAnswerKey>(path.resolve(file), schemaFile, 'schemaVersion');
  if (key.suiteId !== benchmark.manifest.suiteId) {
    throw new Error('blind answer key suite does not match the benchmark manifest');
  }
  assertExactSet(
    key.assignments.map((assignment) => assignment.taskId),
    benchmark.manifest.tasks.map((task) => task.id),
    'blind answer key',
  );
  for (const assignment of key.assignments) {
    if (assignment.candidateLabel === assignment.comparisonLabel) {
      throw new Error(`blind labels must differ for ${assignment.taskId}`);
    }
    const expected = assignmentFor(key.seed, assignment.taskId);
    if (
      assignment.candidateLabel !== expected.candidateLabel ||
      assignment.comparisonLabel !== expected.comparisonLabel
    ) {
      throw new Error(`blind assignment does not match its seed for ${assignment.taskId}`);
    }
  }
  return key;
}

function loadReview(file: string, benchmark: LoadedBenchmark): BlindReview {
  const schemaFile = path.join(benchmark.root, 'review.schema.json');
  const review = readValidatedJson<BlindReview>(path.resolve(file), schemaFile, 'schemaVersion');
  if (review.suiteId !== benchmark.manifest.suiteId) {
    throw new Error(`review suite does not match the benchmark manifest: ${file}`);
  }
  assertExactSet(
    review.tasks.map((task) => task.taskId),
    benchmark.manifest.tasks.map((task) => task.id),
    `review ${review.reviewerId}`,
  );
  const taskById = new Map(benchmark.manifest.tasks.map((task) => [task.id, task]));
  for (const taskReview of review.tasks) {
    const task = taskById.get(taskReview.taskId);
    if (task === undefined) {
      throw new Error(`unknown reviewed task: ${taskReview.taskId}`);
    }
    const knownIds = new Set(task.knownConcerns.map((concern) => concern.id));
    const expectedAssessments = task.knownConcerns.flatMap((concern) => [
      `A:${concern.id}`,
      `B:${concern.id}`,
    ]);
    const actualAssessments = taskReview.knownConcernAssessments.map(
      (assessment) => `${assessment.plan}:${assessment.knownConcernId}`,
    );
    if (
      actualAssessments.length !== expectedAssessments.length ||
      JSON.stringify([...new Set(actualAssessments)].sort()) !==
        JSON.stringify([...expectedAssessments].sort())
    ) {
      throw new Error(
        `review ${review.reviewerId} must assess every known concern for both plans in ${task.id}`,
      );
    }
    if (
      taskReview.knownConcernAssessments.some(
        (assessment) => assessment.disposition === 'unreviewed',
      )
    ) {
      throw new Error(`review ${review.reviewerId} has unreviewed known concerns in ${task.id}`);
    }
    for (const finding of taskReview.findings) {
      if (finding.knownConcernId !== undefined && !knownIds.has(finding.knownConcernId)) {
        throw new Error(`unknown concern ${finding.knownConcernId} in review ${review.reviewerId}`);
      }
    }
  }
  return review;
}

function gitRevision(repositoryRoot: string): string {
  const revisionResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (revisionResult.status !== 0) {
    throw new Error('unable to resolve benchmark workspace revision');
  }
  const revision = revisionResult.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(`unexpected git revision: ${revision}`);
  }
  return revision;
}

export function verifyBenchmarkWorkspace(
  repositoryRoot: string,
  expectedRevision: string,
  manifestFile: string,
): string {
  const statusResult = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (statusResult.status !== 0) {
    throw new Error('unable to inspect benchmark workspace cleanliness');
  }
  if (statusResult.stdout.trim() !== '') {
    throw new Error('benchmark workspace must be clean, including untracked files');
  }

  const revision = gitRevision(repositoryRoot);
  const expectedObject = spawnSync('git', ['cat-file', '-e', `${expectedRevision}^{commit}`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (expectedObject.status !== 0) {
    throw new Error(`benchmark workspace revision is unavailable: ${expectedRevision}`);
  }
  if (revision === expectedRevision) {
    return revision;
  }

  const relativeManifest = path.relative(repositoryRoot, path.resolve(manifestFile));
  if (
    relativeManifest === '' ||
    relativeManifest === '..' ||
    relativeManifest.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeManifest)
  ) {
    throw new Error('benchmark manifest must be inside the benchmark repository');
  }
  const sourceDiff = spawnSync(
    'git',
    [
      'diff',
      '--quiet',
      expectedRevision,
      revision,
      '--',
      '.',
      `:(exclude)${relativeManifest.split(path.sep).join('/')}`,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  if (sourceDiff.status === 1) {
    throw new Error(
      `benchmark source differs from pinned workspace revision ${expectedRevision}; update the pin from a clean implementation commit`,
    );
  }
  if (sourceDiff.status !== 0) {
    throw new Error('unable to compare benchmark source with its pinned revision');
  }
  return revision;
}

export function verifyBenchmarkOutputLocation(repositoryRoot: string, outputDir: string): void {
  const relative = path.relative(repositoryRoot, outputDir);
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  ) {
    throw new Error('benchmark output must be outside the benchmark repository');
  }
}

function critiqueIterationCount(workDir: string): number {
  try {
    return readdirSync(workDir).filter((entry) => /^critique\.v[0-9]+\.json$/.test(entry)).length;
  } catch {
    return 0;
  }
}

function convergenceDecision(workDir: string): BenchmarkDecision {
  const convergenceFile = path.join(workDir, 'convergence.final.json');
  if (!existsSync(convergenceFile)) {
    return 'run-failed';
  }
  const value = parseJson(convergenceFile);
  if (!isJsonObject(value)) {
    return 'run-failed';
  }
  const decision = value.decision;
  if (
    decision === 'ready' ||
    decision === 'revision-required' ||
    decision === 'unable-to-decide' ||
    decision === 'limits-exhausted'
  ) {
    return decision;
  }
  return 'run-failed';
}

function makeTaskRunResult(
  task: BenchmarkTask,
  outputDir: string,
  workDir: string,
  exitCode: number,
): BenchmarkTaskRunResult {
  const candidateFile = path.join(workDir, 'plan.final.md');
  const candidateExists = existsSync(candidateFile) && statSync(candidateFile).isFile();
  const decision = exitCode === 0 ? convergenceDecision(workDir) : 'run-failed';
  return {
    taskId: task.id,
    decision,
    critiqueIterations: critiqueIterationCount(workDir),
    exitCode,
    ...(candidateExists
      ? {
          candidatePlan: path.relative(outputDir, candidateFile),
          candidateSha256: sha256(readFileSync(candidateFile)),
        }
      : {}),
  };
}

function ensureNewPath(target: string, label: string): void {
  if (existsSync(target)) {
    throw new Error(`${label} already exists: ${target}`);
  }
}

export function selectBenchmarkTasks(
  tasks: readonly BenchmarkTask[],
  taskIds: readonly string[] = [],
): readonly BenchmarkTask[] {
  if (taskIds.length === 0) {
    return tasks;
  }
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const selected = taskIds.map((taskId) => {
    const task = taskById.get(taskId);
    if (task === undefined) {
      throw new Error(`unknown benchmark task: ${taskId}`);
    }
    return task;
  });
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error('benchmark task IDs must be unique');
  }
  return selected;
}

export function runPlanningBenchmark(options: RunPlanningBenchmarkOptions): BenchmarkRunResults {
  const benchmark = loadPlanningBenchmark(options.manifestFile);
  const selectedTasks = selectBenchmarkTasks(benchmark.manifest.tasks, options.taskIds);
  const outputDir = path.resolve(options.outputDir);
  const repositoryRoot = realpathSync(options.repositoryRoot);
  verifyBenchmarkOutputLocation(repositoryRoot, outputDir);
  ensureNewPath(outputDir, 'benchmark output');
  const expectedRevision = benchmark.manifest.tasks[0]?.workspaceRevision;
  if (expectedRevision === undefined) {
    throw new Error('benchmark workspace revision is missing');
  }
  verifyBenchmarkWorkspace(
    repositoryRoot,
    expectedRevision,
    options.manifestFile ?? DEFAULT_MANIFEST_FILE,
  );
  const providerConfigRelative = benchmark.manifest.tasks[0]?.providerConfig;
  if (providerConfigRelative === undefined) {
    throw new Error('benchmark provider config is missing');
  }
  const providerConfigFile = declaredFile(benchmark.root, providerConfigRelative);
  const providerConfigText = readFileSync(providerConfigFile, 'utf8');
  mkdirSync(outputDir, { recursive: true });
  const taskResults: BenchmarkTaskRunResult[] = [];
  for (const task of selectedTasks) {
    const taskRoot = path.join(outputDir, task.id);
    const workDir = path.join(taskRoot, 'run');
    const stateDir = path.join(taskRoot, 'state');
    const homeDir = path.join(taskRoot, 'home');
    mkdirSync(taskRoot, { recursive: true });
    const promptFile = declaredFile(benchmark.root, task.prompt);
    const environment = benchmarkChildEnvironment({
      ambientEnv: process.env,
      providerConfigText,
      homeDir,
      stateDir,
      workDir,
      runName: `benchmark-${task.id}`,
    });
    const runResult = spawnSync(
      'pnpm',
      [
        'run',
        'run:cli',
        '--',
        'plan',
        '--quality',
        'balanced',
        '--iters',
        '5',
        '--no-translate',
        '--prompt',
        promptFile,
      ],
      {
        cwd: repositoryRoot,
        env: environment,
        stdio: 'inherit',
      },
    );
    const exitCode = runResult.status ?? 1;
    taskResults.push(makeTaskRunResult(task, outputDir, workDir, exitCode));
    const partialResults: BenchmarkRunResults = {
      schemaVersion: 1,
      suiteId: benchmark.manifest.suiteId,
      workspaceRevision: expectedRevision,
      providerConfigSha256: sha256(providerConfigText),
      tasks: taskResults,
    };
    writeJson(path.join(outputDir, RUN_RESULTS_FILE), partialResults);
  }
  return {
    schemaVersion: 1,
    suiteId: benchmark.manifest.suiteId,
    workspaceRevision: expectedRevision,
    providerConfigSha256: sha256(providerConfigText),
    tasks: taskResults,
  };
}

export function assignmentFor(seed: string, taskId: string): BlindAssignment {
  if (seed.trim() === '') {
    throw new Error('blind seed must not be empty');
  }
  const digest = createHash('sha256').update(`${seed}\0${taskId}`).digest();
  const candidateLabel: BlindLabel = (digest[0] ?? 0) % 2 === 0 ? 'A' : 'B';
  const comparisonLabel: BlindLabel = candidateLabel === 'A' ? 'B' : 'A';
  return { taskId, candidateLabel, comparisonLabel };
}

function stripReferenceMarker(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const first = lines[0] ?? '';
  if (!first.startsWith(REFERENCE_MARKER_PREFIX) || !first.endsWith(' -->')) {
    throw new Error('comparison plan is missing its approval marker');
  }
  return lines.slice(1).join('\n').replace(/^\n+/, '');
}

function stripPlanFrontmatter(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return markdown;
  }
  const closing = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (closing < 0) {
    throw new Error('blind plan has unterminated frontmatter');
  }
  return lines.slice(closing + 2).join('\n');
}

function normalizedBlindPlan(markdown: string): string {
  return `${stripPlanFrontmatter(markdown).trim()}\n`;
}

function keyIsOutsideBundle(outputDir: string, keyFile: string): boolean {
  const relative = path.relative(outputDir, keyFile);
  return relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function reviewTemplate(manifest: PlanningBenchmarkManifest): BlindReview {
  return {
    schemaVersion: 1,
    suiteId: manifest.suiteId,
    reviewerId: 'replace-with-stable-reviewer-id',
    tasks: manifest.tasks.map((task) => ({
      taskId: task.id,
      preference: 'tie',
      findings: [],
      knownConcernAssessments: task.knownConcerns.flatMap((concern) =>
        (['A', 'B'] as const).map((plan) => ({
          plan,
          knownConcernId: concern.id,
          disposition: 'unreviewed' as const,
          evidence: 'replace-with-plan-evidence',
        })),
      ),
    })),
  };
}

export function createBlindBundle(options: CreateBlindBundleOptions): BlindAnswerKey {
  const benchmark = loadPlanningBenchmark(options.manifestFile);
  const resultsFile = path.resolve(options.resultsFile);
  const results = loadRunResults(resultsFile, benchmark, true);
  const resultsRoot = path.dirname(resultsFile);
  const outputDir = path.resolve(options.outputDir);
  const keyFile = path.resolve(options.keyFile);
  ensureNewPath(outputDir, 'blind bundle');
  ensureNewPath(keyFile, 'blind answer key');
  if (!keyIsOutsideBundle(outputDir, keyFile)) {
    throw new Error('blind answer key must be outside the distributed bundle directory');
  }
  const resultById = new Map(results.tasks.map((result) => [result.taskId, result]));
  const assignments = benchmark.manifest.tasks.map((task) => assignmentFor(options.seed, task.id));
  const assignmentById = new Map(assignments.map((assignment) => [assignment.taskId, assignment]));
  mkdirSync(outputDir, { recursive: true });
  copyFileSync(path.join(benchmark.root, 'rubric.md'), path.join(outputDir, 'rubric.md'));
  const bundleTasks: BlindBundleTask[] = [];
  for (const task of benchmark.manifest.tasks) {
    const result = resultById.get(task.id);
    const assignment = assignmentById.get(task.id);
    if (result?.candidatePlan === undefined || assignment === undefined) {
      throw new Error(`candidate plan is missing for ${task.id}`);
    }
    const candidateFile = declaredFile(resultsRoot, result.candidatePlan);
    const taskDir = path.join(outputDir, task.id);
    mkdirSync(taskDir, { recursive: true });
    const promptName = 'task.md';
    const planAName = 'plan-a.md';
    const planBName = 'plan-b.md';
    copyFileSync(declaredFile(benchmark.root, task.prompt), path.join(taskDir, promptName));
    const candidate = normalizedBlindPlan(readFileSync(candidateFile, 'utf8'));
    const comparison = normalizedBlindPlan(
      stripReferenceMarker(readFileSync(declaredFile(benchmark.root, task.reference), 'utf8')),
    );
    const planA = assignment.candidateLabel === 'A' ? candidate : comparison;
    const planB = assignment.candidateLabel === 'B' ? candidate : comparison;
    writeFileSync(path.join(taskDir, planAName), planA);
    writeFileSync(path.join(taskDir, planBName), planB);
    bundleTasks.push({
      taskId: task.id,
      prompt: path.posix.join(task.id, promptName),
      planA: path.posix.join(task.id, planAName),
      planB: path.posix.join(task.id, planBName),
    });
  }
  const bundle: BlindBundleIndex = {
    schemaVersion: 1,
    suiteId: benchmark.manifest.suiteId,
    rubric: 'rubric.md',
    tasks: bundleTasks,
  };
  writeJson(path.join(outputDir, BLIND_BUNDLE_FILE), bundle);
  writeJson(path.join(outputDir, BLIND_REVIEW_TEMPLATE_FILE), reviewTemplate(benchmark.manifest));
  const key: BlindAnswerKey = {
    schemaVersion: 1,
    suiteId: benchmark.manifest.suiteId,
    seed: options.seed,
    assignments,
  };
  writeJson(keyFile, key);
  return key;
}

function checkAtLeast(actual: number, required: number): BenchmarkCheck {
  return { passed: actual >= required, actual, required };
}

function checkAtMost(actual: number, required: number): BenchmarkCheck {
  return { passed: actual <= required, actual, required };
}

function taskScore(
  task: BenchmarkTask,
  result: BenchmarkTaskRunResult,
  assignment: BlindAssignment,
  reviews: readonly BlindReview[],
  manifest: PlanningBenchmarkManifest,
): BenchmarkTaskScore {
  const taskReviews = reviews.map((review) => {
    const taskReview = review.tasks.find((entry) => entry.taskId === task.id);
    if (taskReview === undefined) {
      throw new Error(`review ${review.reviewerId} is missing ${task.id}`);
    }
    return taskReview;
  });
  const candidateVotes = taskReviews.filter(
    (review) => review.preference === assignment.candidateLabel,
  ).length;
  const comparisonVotes = taskReviews.filter(
    (review) => review.preference === assignment.comparisonLabel,
  ).length;
  const tieVotes = taskReviews.filter((review) => review.preference === 'tie').length;
  const requiredMajority = Math.floor(taskReviews.length / 2) + 1;
  const comparison =
    candidateVotes >= requiredMajority
      ? 'preferred'
      : comparisonVotes >= requiredMajority
        ? 'worse'
        : 'tie';
  const candidateFindings = taskReviews.flatMap((review) =>
    review.findings.filter((finding) => finding.plan === assignment.candidateLabel),
  );
  const missedKnownConcernIds = [
    ...uniqueValues([
      ...taskReviews.flatMap((review) =>
        review.knownConcernAssessments
          .filter(
            (assessment) =>
              assessment.plan === assignment.candidateLabel && assessment.disposition === 'missed',
          )
          .map((assessment) => assessment.knownConcernId),
      ),
      ...candidateFindings.flatMap((finding) =>
        finding.knownConcernId === undefined ? [] : [finding.knownConcernId],
      ),
    ]),
  ].sort();
  const additionalClaims = uniqueValues(
    candidateFindings.flatMap((finding) =>
      finding.knownConcernId === undefined
        ? [`${finding.severity}:${finding.claim.trim().toLowerCase()}`]
        : [],
    ),
  );
  const threshold =
    task.risk === 'standard' ? manifest.thresholds.standard : manifest.thresholds.high;
  const readinessPassed =
    result.decision === 'ready' &&
    result.critiqueIterations > 0 &&
    result.critiqueIterations <= threshold.maximumCritiqueIterations;
  return {
    taskId: task.id,
    risk: task.risk,
    decision: result.decision,
    critiqueIterations: result.critiqueIterations,
    readinessPassed,
    comparison,
    candidateVotes,
    comparisonVotes,
    tieVotes,
    missedKnownConcernIds,
    additionalMaterialConcernCount: additionalClaims.length,
  };
}

function approvalsSatisfied(manifest: PlanningBenchmarkManifest): boolean {
  return (
    manifest.corpusApproval === 'operator-approved' &&
    manifest.tasks.every((task) => task.referenceApproval === 'operator-approved')
  );
}

export function scorePlanningBenchmark(
  options: ScorePlanningBenchmarkOptions,
): BenchmarkScoreReport {
  const benchmark = loadPlanningBenchmark(options.manifestFile);
  const results = loadRunResults(options.resultsFile, benchmark, true);
  const key = loadAnswerKey(options.keyFile, benchmark);
  const reviews = options.reviewFiles.map((file) => loadReview(file, benchmark));
  const reviewerIds = reviews.map((review) => review.reviewerId);
  if (new Set(reviewerIds).size !== reviewerIds.length) {
    throw new Error('reviewer IDs must be distinct');
  }
  const requiredReviews = benchmark.manifest.thresholds.comparison.minimumIndependentReviewsPerTask;
  if (reviews.length < requiredReviews) {
    throw new Error(`at least ${requiredReviews} independent reviews are required`);
  }
  const resultById = new Map(results.tasks.map((result) => [result.taskId, result]));
  const assignmentById = new Map(
    key.assignments.map((assignment) => [assignment.taskId, assignment]),
  );
  const taskScores = benchmark.manifest.tasks.map((task) => {
    const result = resultById.get(task.id);
    const assignment = assignmentById.get(task.id);
    if (result === undefined || assignment === undefined) {
      throw new Error(`score inputs are incomplete for ${task.id}`);
    }
    return taskScore(task, result, assignment, reviews, benchmark.manifest);
  });
  const standardReady = taskScores.filter(
    (task) => task.risk === 'standard' && task.readinessPassed,
  ).length;
  const highRiskReady = taskScores.filter(
    (task) => task.risk === 'high' && task.readinessPassed,
  ).length;
  const missedMaterialConcerns = taskScores.reduce(
    (total, task) =>
      total + task.missedKnownConcernIds.length + task.additionalMaterialConcernCount,
    0,
  );
  const majorityWorse = taskScores.filter((task) => task.comparison === 'worse').length;
  const majorityPreferred = taskScores.filter((task) => task.comparison === 'preferred').length;
  const checks = {
    standardReady: checkAtLeast(standardReady, benchmark.manifest.thresholds.standard.minimumReady),
    highRiskReady: checkAtLeast(highRiskReady, benchmark.manifest.thresholds.high.minimumReady),
    missedMaterialConcerns: checkAtMost(
      missedMaterialConcerns,
      benchmark.manifest.thresholds.comparison.maximumMissedMaterialConcerns,
    ),
    majorityWorse: checkAtMost(
      majorityWorse,
      benchmark.manifest.thresholds.comparison.maximumMajorityWorse,
    ),
    majorityPreferred: checkAtLeast(
      majorityPreferred,
      benchmark.manifest.thresholds.comparison.minimumMajorityPreferred,
    ),
  };
  const thresholdsPassed = Object.values(checks).every((check) => check.passed);
  const operatorApprovalSatisfied = approvalsSatisfied(benchmark.manifest);
  return {
    schemaVersion: 1,
    suiteId: benchmark.manifest.suiteId,
    reviewerCount: reviews.length,
    thresholdsPassed,
    operatorApprovalSatisfied,
    accepted: thresholdsPassed && operatorApprovalSatisfied,
    checks,
    tasks: taskScores,
  };
}
