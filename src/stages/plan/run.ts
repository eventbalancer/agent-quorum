import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { packageRoot, projectRoot } from '../../runtime/env.js';
import { fileLineCount } from '../../runtime/files.js';
import { installSignalTeardown, ownPgid } from '../../runtime/exec.js';
import { HaltError } from '../../runtime/halt.js';
import { disableRunLogSink, enableRunLogSink, err, log } from '../../runtime/log.js';
import { resolveArtifactRoots } from '../../runtime/paths.js';
import { procStartToken } from '../../runtime/proc.js';
import { Scratch } from '../../runtime/scratch.js';
import {
  cleanupRunRegistry,
  nowUtcStamp,
  writeRunMetadata,
  type RunMetadata,
} from '../../core/artifacts.js';
import {
  deriveRunName,
  finalizeRunRecord,
  pruneRuns,
  readRunRecords,
  runNameFromWorkdir,
  writeRunRecord,
  type RunState,
} from '../../core/run-store.js';
import { clarifyDoneFile, runClarificationGate } from './clarify.js';
import { ExitCode } from '../../exit-codes.js';
import {
  resolveConfig,
  resolveRoleConfig,
  resolveRolePermissions,
  resolveRunSettings,
  runnersInUse,
  type CliSettings,
  type ResolveOverrides,
  type Secrets,
} from '../../core/config.js';
import { isJsonObject, type JsonValue } from '../../core/json.js';
import { handoffDir } from '../../core/store.js';
import { runCreatorCreate, runCreatorReadinessAssessment } from './creator.js';
import { qualityMatrix } from '../../core/quality.js';
import { runFixPass } from './fix-pass.js';
import { markOperatorInterventionsMigrated } from './interventions.js';
import { resolveWatchdogKnobs } from '../../core/knobs.js';
import { resolveRunnerBinaries } from '../../providers/registry.js';
import { runIterationLoop } from './loop.js';
import { runFinalJudge } from './judge.js';
import { preflightRunners } from './preflight.js';
import {
  emitPlanPackage,
  carrySystemCoverageIntoPackage,
  evaluateSplitDecision,
  PACKAGE_DIR_NAME,
  parsePlanStructure,
  SPLIT_DECISION_FILE,
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
import { prepareResume } from './resume.js';
import { skillPaths, type RunContext } from '../../core/run-context.js';
import {
  CANONICAL_PROOF_HASH_MISMATCH,
  DELIVERED_PLAN_FRESH_REVIEW_REQUIRED,
  FINAL_ARTIFACT_REVIEW_REQUIRED,
  applyReadinessPolicy,
  classifyTerminal,
  convergenceReport,
  CRITIC_ISSUE_BUDGET,
  createConvergenceState,
  fileSha256,
  recordSystemCheck,
  requiresReadinessJudge,
  requiresSystemCoverage,
  writeConvergenceState,
} from '../../core/convergence.js';
import {
  RISK_DOMAINS as READINESS_RISK_DOMAINS,
  buildReadinessContract,
  readReadinessContract,
  writeFrozenReadinessContract,
  type ReadinessAssessment,
  type ReadinessContract,
} from '../../core/readiness-contract.js';
import {
  buildSystemContext,
  validateSystemCoverage,
  writeSystemCheck,
  writeSystemContext,
} from '../../core/system-context.js';
import {
  buildRunReport,
  writeSummary,
  type RunReport,
  type RunReportFinalFacts,
} from './summary.js';
import {
  telegramNotifyCompletion,
  type TelegramCompletionNotification,
  type TelegramRuntime,
} from '../../channels/telegram/index.js';
import { runTranslatePass } from './translate-pass.js';
import {
  EMPTY_FINDINGS_COUNTS,
  readFindingsCounts,
  validateFinalPlan,
  type FindingsCounts,
} from './validate-plan.js';
import type { FinalReadiness, RunFinalStatus, RunMode, RunOverrides } from '../../types.js';

export const RUN_USAGE =
  'usage: agent-quorum plan [--iters N] [--quality {quick,balanced,thorough}] [--no-fix] [--locale LOCALE] [--no-translate] <plan.md>\n' +
  '       agent-quorum plan [--iters N] [--quality {quick,balanced,thorough}] [--no-fix] [--locale LOCALE] [--no-translate] --prompt <prompt.md>\n';

function usage(): never {
  process.stderr.write(RUN_USAGE);
  throw new HaltError('usage', 1, true);
}

export interface ParsedRunArgs {
  mode: RunMode;
  inputPath: string;
  cli: CliSettings;
}

export function parseRunArgs(args: readonly string[]): ParsedRunArgs {
  let mode: RunMode = 'plan';
  let inputPath = '';
  const cli: CliSettings = {};

  let i = 0;
  const usageError = (message: string): never => {
    process.stderr.write(`${message}\n`);
    throw new HaltError(message, 1, true);
  };
  parse: while (i < args.length) {
    const arg = args[i] ?? '';
    switch (true) {
      case arg === '--prompt': {
        mode = 'prompt';
        const value = args[i + 1] ?? '';
        if (value === '') {
          usage();
        }
        inputPath = value;
        i += 2;
        break;
      }
      case arg === '--iters' || arg === '--max-iters': {
        const value = args[i + 1] ?? '';
        if (!/^[0-9]+$/.test(value)) {
          usageError('--iters expects a positive integer');
        }
        cli.maxIters = value;
        i += 2;
        break;
      }
      case arg.startsWith('--iters=') || arg.startsWith('--max-iters='): {
        const value = arg.slice(arg.indexOf('=') + 1);
        if (!/^[0-9]+$/.test(value)) {
          usageError('--iters expects a positive integer');
        }
        cli.maxIters = value;
        i += 1;
        break;
      }
      case arg === '--fix':
        cli.fix = '1';
        i += 1;
        break;
      case arg === '--no-fix':
        cli.fix = '0';
        i += 1;
        break;
      case arg === '--translate':
        cli.translate = '1';
        i += 1;
        break;
      case arg === '--no-translate':
        cli.translate = '0';
        i += 1;
        break;
      case arg === '--locale': {
        const value = args[i + 1] ?? '';
        if (value === '') {
          usageError('--locale expects a locale tag');
        }
        cli.locale = value;
        i += 2;
        break;
      }
      case arg.startsWith('--locale='):
        cli.locale = arg.slice('--locale='.length);
        if (cli.locale === '') {
          usageError('--locale expects a locale tag');
        }
        i += 1;
        break;
      case arg === '--quality': {
        const value = args[i + 1] ?? '';
        if (value === '') {
          usageError('--quality expects quick, balanced, or thorough');
        }
        cli.quality = value;
        i += 2;
        break;
      }
      case arg.startsWith('--quality='):
        cli.quality = arg.slice('--quality='.length);
        i += 1;
        break;
      case arg === '-h' || arg === '--help':
        process.stdout.write(RUN_USAGE);
        throw new HaltError('help', 0, true);
      case arg === '--':
        break parse;
      case arg.startsWith('-'):
        process.stderr.write(`unknown flag: ${arg}\n`);
        usage();
        break;
      default:
        if (inputPath !== '') {
          process.stderr.write(`unexpected arg: ${arg}\n`);
          usage();
        }
        inputPath = arg;
        i += 1;
        break;
    }
  }

  if (inputPath === '') {
    usage();
  }
  if (!existsSync(inputPath) || !statSync(inputPath).isFile()) {
    process.stderr.write(`file not found: ${inputPath}\n`);
    throw new HaltError(`file not found: ${inputPath}`, 1, true);
  }
  return { mode, inputPath, cli };
}

function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function absolutePath(file: string): string {
  return path.join(canonicalDir(path.dirname(path.resolve(file))), path.basename(file));
}

function filesEqual(a: string, b: string): boolean {
  if (!existsSync(a) || !existsSync(b)) {
    return false;
  }
  return readFileSync(a).equals(readFileSync(b));
}

const READINESS_CONTRACT_FILE = 'readiness-contract.json';

type ReadinessPreparation =
  | { readonly ok: true; readonly contract: ReadinessContract }
  | { readonly ok: false; readonly exitCode: number; readonly reason: string };

function writeAssessmentQuestions(work: string, assessment: ReadinessAssessment): void {
  const questions = assessment.unresolvedMaterialQuestions.map((question, index) => ({
    id: `Q${index + 1}`,
    question: question.question,
    why: question.rationale,
    options: question.options,
  }));
  writeFileSync(
    path.join(work, 'clarify-questions.json'),
    `${JSON.stringify({ questions }, null, 2)}\n`,
  );
}

function legacyReadinessAssessment(ctx: RunContext): JsonValue {
  return {
    boundary: {
      goal: 'Preserve the existing resumed plan as a useful artifact pending a fresh assessment.',
      in_scope: [`Existing plan boundary from ${path.basename(ctx.inputPath)}`],
      out_of_scope: ['Automatic expansion or reinterpretation of the legacy plan boundary'],
      constraints: ['A fresh planning run is required before this legacy state can be ready.'],
    },
    domain_assessments: READINESS_RISK_DOMAINS.map((domain) => ({
      domain,
      applicability: 'unknown',
      risk: 'standard',
      rationale: 'The legacy run did not persist an applicability assessment for this domain.',
      evidence_refs: [`source-digest:${ctx.convergence.sourceDigest}`],
    })),
    material_questions: [
      {
        id: 'legacy-fresh-assessment',
        question: 'How should the legacy run be continued?',
        rationale: 'Its implementation boundary and risk applicability were not frozen.',
        options: [
          'Start a new planning run with a fresh assessment',
          'Keep this plan as needs-review without claiming readiness',
        ],
      },
    ],
  };
}

function buildContract(ctx: RunContext, assessment: string | JsonValue): ReadinessContract {
  return buildReadinessContract({
    assessment,
    sourceDigest: ctx.convergence.sourceDigest,
    systemDigest: ctx.systemContext.digest,
    quality: ctx.settings.quality,
    iterationLimit: ctx.settings.maxIters,
    issueBudget: ctx.convergence.issueBudget.limit,
    operatorDecisionIds: ctx.convergence.operatorDecisionIds,
  });
}

async function createReadinessContract(ctx: RunContext): Promise<ReadinessPreparation> {
  const initialFile = path.join(ctx.work, 'readiness-assessment.initial.json');
  log(
    `readiness assessment (${ctx.provider.matrix.creator.runner} ${ctx.provider.matrix.creator.model})`,
  );
  const assessment = await runCreatorReadinessAssessment(ctx, initialFile);
  let selectedFile = initialFile;
  writeAssessmentQuestions(ctx.work, assessment);
  if (assessment.unresolvedMaterialQuestions.length > 0) {
    const gate = await runClarificationGate(ctx, ctx.inputPath);
    if (!gate.ok && gate.exitCode !== ExitCode.ClarifyTransportFailure) {
      return gate;
    }
    if (!gate.ok) {
      log(
        `readiness assessment: clarification unavailable (${gate.reason}); freezing unresolved material questions`,
      );
    }
    if (existsSync(clarifyDoneFile(ctx.work))) {
      const finalFile = path.join(ctx.work, 'readiness-assessment.final.json');
      log('readiness assessment: re-evaluating after operator clarification');
      await runCreatorReadinessAssessment(ctx, finalFile);
      selectedFile = finalFile;
    }
  }
  const contract = buildContract(ctx, readFileSync(selectedFile, 'utf8'));
  writeFrozenReadinessContract(path.join(ctx.work, READINESS_CONTRACT_FILE), contract);
  return { ok: true, contract };
}

async function prepareReadinessContract(
  ctx: RunContext,
  resuming: boolean,
): Promise<ReadinessPreparation> {
  const contractFile = path.join(ctx.work, READINESS_CONTRACT_FILE);
  let contract: ReadinessContract;
  if (existsSync(contractFile)) {
    contract = readReadinessContract(contractFile);
  } else if (resuming) {
    contract = buildContract(ctx, legacyReadinessAssessment(ctx));
    writeFrozenReadinessContract(contractFile, contract);
  } else {
    const created = await createReadinessContract(ctx);
    if (!created.ok) {
      return created;
    }
    contract = created.contract;
  }

  ctx.readinessBoundary = contract.boundary;

  const priorContractDigest = ctx.convergence.readinessContractDigest;
  applyReadinessPolicy(ctx.convergence, {
    contractDigest: contract.contractDigest,
    judgeAllowed: contract.appetite.judgeAllowed,
    exhaustiveApplicableDomains: contract.appetite.exhaustiveApplicableDomains,
    unresolvedMaterialQuestionIds: contract.unresolvedMaterialQuestions.map(
      (question) => question.id,
    ),
    riskDomains: contract.domainAssessments,
  });
  ctx.convergence.operatorDecisionIds = [...contract.operatorDecisionIds];

  const challenges: {
    readonly id: string;
    readonly kind: 'scope-expansion' | 'assurance-appetite';
    readonly claim: string;
    readonly evidenceRefs: readonly JsonValue[];
  }[] = [];
  if (contract.sourceDigest !== ctx.convergence.sourceDigest) {
    challenges.push({
      id: 'frozen-source-digest-changed',
      kind: 'scope-expansion',
      claim: 'The source input changed after the readiness boundary was frozen.',
      evidenceRefs: [contract.sourceDigest, ctx.convergence.sourceDigest],
    });
  }
  if (contract.systemDigest !== ctx.systemContext.digest) {
    challenges.push({
      id: 'frozen-system-digest-changed',
      kind: 'scope-expansion',
      claim: 'Authoritative system facts changed after the readiness boundary was frozen.',
      evidenceRefs: [contract.systemDigest, ctx.systemContext.digest],
    });
  }
  if (
    contract.appetite.quality !== ctx.settings.quality ||
    contract.appetite.iterationLimit !== ctx.settings.maxIters ||
    contract.appetite.issueBudget !== ctx.convergence.issueBudget.limit
  ) {
    challenges.push({
      id: 'frozen-assurance-appetite-changed',
      kind: 'assurance-appetite',
      claim: 'The requested assurance appetite differs from the frozen readiness contract.',
      evidenceRefs: [contract.contractDigest],
    });
  }
  if (
    priorContractDigest !== undefined &&
    !priorContractDigest.startsWith('legacy-derived:') &&
    priorContractDigest !== contract.contractDigest
  ) {
    challenges.push({
      id: 'frozen-contract-digest-changed',
      kind: 'scope-expansion',
      claim: 'The resumed convergence state is bound to a different readiness contract.',
      evidenceRefs: [priorContractDigest, contract.contractDigest],
    });
  }
  ctx.convergence.boundaryChallenges.push(
    ...challenges.map((challenge) => ({
      ...challenge,
      rationale: 'A new run is required to establish a coherent immutable boundary and appetite.',
      planVersion: ctx.convergence.planVersion,
    })),
  );
  classifyTerminal(ctx.convergence);
  return { ok: true, contract };
}

export interface RunOutcome {
  exitCode: number;
  report?: RunReport;
}

type CompletionNotificationDetails = Omit<TelegramCompletionNotification, 'inputPath' | 'workDir'>;
type CompletionNotifier = (details: CompletionNotificationDetails) => Promise<void>;

function createCompletionNotifier(
  inputPath: string,
  workDir: string,
  runtime: TelegramRuntime,
): CompletionNotifier {
  let didNotifyCompletion = false;
  return async (details) => {
    if (didNotifyCompletion) {
      return;
    }
    didNotifyCompletion = true;
    await telegramNotifyCompletion(runtime, { inputPath, workDir, ...details });
  };
}

function errorExitCode(error: unknown): number {
  if (error instanceof HaltError) {
    return error.exitCode;
  }
  return 1;
}

function errorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

interface SplitPackageResult {
  readonly splitDecision: SplitDecision;
  readonly packagePhaseCount: number;
  readonly packageDir?: string;
  readonly packageHealth?: PackageHealth;
}

interface ResolveFinalStatusParams {
  readonly finalTitle: 0 | 1;
  readonly shape: PlanShapeHealth;
  readonly declaredStatus?: RunFinalStatus;
  readonly findings: FindingsCounts;
  readonly packageHealth?: PackageHealth;
}

interface FinalStatusResult {
  readonly status: RunFinalStatus;
  readonly reason: string;
}

function writeSplitDecisionFile(work: string, splitDecision: SplitDecision): void {
  writeFileSync(
    path.join(work, SPLIT_DECISION_FILE),
    `${JSON.stringify(
      {
        decision: splitDecision.split ? 'split' : 'no-split',
        rationale: splitDecision.rationale,
        signals: splitDecision.signals,
      },
      null,
      2,
    )}\n`,
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

function emitAndValidateSplitPackage(ctx: RunContext, finalPlan: string): SplitPackageResult {
  const structure = parsePlanStructure(finalPlan);
  const splitDecision = evaluateSplitDecision(structure, {
    mode: ctx.split.mode,
    minPhases: ctx.split.minPhases,
    maxPlanLines: ctx.maxPlanLines,
  });
  writeSplitDecisionFile(ctx.work, splitDecision);

  if (!splitDecision.split) {
    log(`split: no package (${splitDecision.rationale})`);
    return { splitDecision, packagePhaseCount: 0 };
  }

  const emitted = emitPlanPackage(ctx.work, finalPlan, structure, splitDecision);
  if (emitted.kind === 'empty-work-plan') {
    err('split: forced split over an empty/absent Work Plan — no package written');
    return {
      splitDecision,
      packagePhaseCount: 0,
      packageHealth: emptyPackageHealth(),
    };
  }

  const packagePhaseCount = emitted.paths.phases.length;
  carrySystemCoverageIntoPackage(emitted.paths, ctx.convergence.relationshipIds);
  const packageHealth = validatePlanPackage(ctx.provider.projectRoot, emitted.paths.dir, {
    relationshipIds: ctx.convergence.relationshipIds,
  });
  log(`split: emitted plan.package/ with ${packagePhaseCount} phase doc(s)`);
  return {
    splitDecision,
    packagePhaseCount,
    packageDir: emitted.paths.dir,
    packageHealth,
  };
}

function isPackageBroken(packageHealth: PackageHealth): boolean {
  return (
    packageHealth.emptyWorkPlan ||
    packageHealth.missingFiles > 0 ||
    packageHealth.missingHeadings > 0 ||
    packageHealth.brokenCrossRefs > 0 ||
    packageHealth.forbiddenShell > 0 ||
    (packageHealth.systemCoverageMissing ?? 0) > 0
  );
}

function hasPackageReferencesNeedingReview(packageHealth: PackageHealth): boolean {
  return (
    packageHealth.references.stale > 0 ||
    packageHealth.references.ambiguous > 0 ||
    packageHealth.references.unresolved > 0
  );
}

function resolveStructuralStatus({
  finalTitle,
  shape,
  declaredStatus,
  findings,
  packageHealth,
}: ResolveFinalStatusParams): FinalStatusResult {
  if (finalTitle !== 1 || shape.missing !== 0 || shape.graph !== 1 || shape.frontmatter !== 1) {
    return {
      status: 'blocked',
      reason: `plan shape broken (title=${finalTitle} missing_sections=${shape.missing} impact_graph_mermaid=${shape.graph} frontmatter=${shape.frontmatter})`,
    };
  }

  if (packageHealth !== undefined && isPackageBroken(packageHealth)) {
    return {
      status: 'blocked',
      reason: packageHealth.emptyWorkPlan
        ? 'plan.package not emitted: forced split over an empty/absent Work Plan'
        : `plan.package broken (missing_files=${packageHealth.missingFiles} missing_headings=${packageHealth.missingHeadings} broken_cross_refs=${packageHealth.brokenCrossRefs} forbidden_shell=${packageHealth.forbiddenShell} system_coverage_missing=${packageHealth.systemCoverageMissing ?? 0})`,
    };
  }

  if (declaredStatus === 'blocked') {
    return {
      status: 'needs-review',
      reason: 'plan frontmatter declares a blocking STOP condition that requires review',
    };
  }

  if (declaredStatus === 'needs-review') {
    return {
      status: 'needs-review',
      reason: 'plan frontmatter declares unresolved review work',
    };
  }

  if (findings.stale > 0) {
    return {
      status: 'needs-review',
      reason: `${findings.stale} stale line reference(s) remain after fix-pass`,
    };
  }

  if (findings.ambiguous > 0 || findings.unresolved > 0) {
    return {
      status: 'needs-review',
      reason: `${findings.ambiguous} ambiguous + ${findings.unresolved} unresolved reference(s) (may be generic names or future files)`,
    };
  }

  if (packageHealth !== undefined && hasPackageReferencesNeedingReview(packageHealth)) {
    return {
      status: 'needs-review',
      reason: `plan.package references need review (stale=${packageHealth.references.stale} ambiguous=${packageHealth.references.ambiguous} unresolved=${packageHealth.references.unresolved})`,
    };
  }

  return { status: 'clean', reason: '' };
}

function resolveCompletionStatus(
  structural: FinalStatusResult,
  readiness: FinalReadiness | undefined,
  convergenceSatisfied: boolean,
  convergenceReason: string,
): FinalStatusResult {
  if (structural.status === 'blocked') {
    return structural;
  }
  const reasons: string[] = [];
  if (structural.status === 'needs-review') {
    reasons.push(structural.reason);
  }
  if (readiness !== undefined && (!readiness.evaluated || readiness.ready === false)) {
    reasons.push(`Final Judge: ${readiness.evaluated ? 'not-ready' : 'unavailable'}`);
  }
  if (!convergenceSatisfied) {
    reasons.push(`Convergence proof: ${convergenceReason}`);
  }
  if (reasons.length === 0) {
    return { status: 'clean', reason: '' };
  }
  return { status: 'needs-review', reason: reasons.join('; ') };
}

const FINAL_JUDGE_PROOF_MARKERS = new Set([
  'final-judge:unavailable',
  'final-judge:not-ready',
  'final-judge:coverage-unproved',
]);

function recordFinalJudgeProof(
  ctx: RunContext,
  readiness: FinalReadiness | undefined,
  coverageProved: boolean,
): void {
  ctx.convergence.unresolvedCoverage = ctx.convergence.unresolvedCoverage.filter(
    (id) => !FINAL_JUDGE_PROOF_MARKERS.has(id),
  );
  const unresolved =
    readiness?.evaluated !== true
      ? 'final-judge:unavailable'
      : readiness.ready !== true
        ? 'final-judge:not-ready'
        : !coverageProved
          ? 'final-judge:coverage-unproved'
          : undefined;
  if (unresolved !== undefined) {
    ctx.convergence.unresolvedCoverage.push(unresolved);
  }
}

function refreshFinalSystemCheck(ctx: RunContext, finalPlan: string) {
  const check = validateSystemCoverage(ctx.systemContext, finalPlan, ctx.convergence.planVersion, {
    required: requiresSystemCoverage(ctx.convergence),
    inScope: ctx.readinessBoundary?.inScope ?? ctx.systemContext.declaredScope,
    outOfScope: ctx.readinessBoundary?.outOfScope ?? [],
  });
  writeSystemCheck(ctx.work, check, 'system-check.final.json');
  recordSystemCheck(ctx.convergence, check);
  return check;
}

function recordCanonicalProofHashBinding(
  ctx: RunContext,
  finalPlan: string,
  systemCheck: { readonly planSha256: string },
  readiness: FinalReadiness | undefined,
  candidateUnchanged = true,
): boolean {
  const canonicalPlanSha256 = fileSha256(finalPlan);
  const mismatch =
    !candidateUnchanged ||
    systemCheck.planSha256 !== canonicalPlanSha256 ||
    (readiness !== undefined && readiness.planSha256 !== canonicalPlanSha256);
  if (mismatch && !ctx.convergence.unresolvedCoverage.includes(CANONICAL_PROOF_HASH_MISMATCH)) {
    ctx.convergence.unresolvedCoverage.push(CANONICAL_PROOF_HASH_MISMATCH);
  }
  ctx.convergence.canonicalPlanSha256 = canonicalPlanSha256;
  return mismatch;
}

function statusInvariantPlan(file: string): string {
  return readFileSync(file, 'utf8').replace(
    /^status:\s+(?:clean|needs-review|blocked)\s*$/m,
    'status: <orchestration-projection>',
  );
}

function recordFinalArtifactProof(
  ctx: RunContext,
  finalPlan: string,
  structural: FinalStatusResult,
): void {
  const markers = new Set([DELIVERED_PLAN_FRESH_REVIEW_REQUIRED, FINAL_ARTIFACT_REVIEW_REQUIRED]);
  ctx.convergence.unresolvedCoverage = ctx.convergence.unresolvedCoverage.filter(
    (entry) => !markers.has(entry),
  );
  if (structural.status !== 'clean') {
    ctx.convergence.unresolvedCoverage.push(FINAL_ARTIFACT_REVIEW_REQUIRED);
  }
  const reviewedVersion = ctx.convergence.lastCritiquedPlanVersion;
  const reviewedPlan =
    reviewedVersion === undefined ? undefined : path.join(ctx.work, `plan.v${reviewedVersion}.md`);
  const exactReviewedCandidate =
    reviewedVersion === ctx.convergence.planVersion &&
    reviewedPlan !== undefined &&
    existsSync(reviewedPlan) &&
    statusInvariantPlan(reviewedPlan) === statusInvariantPlan(finalPlan);
  if (reviewedVersion === ctx.convergence.planVersion && !exactReviewedCandidate) {
    ctx.convergence.unresolvedCoverage.push(DELIVERED_PLAN_FRESH_REVIEW_REQUIRED);
  }
  classifyTerminal(ctx.convergence);
}

function finalStatusLogDetails(facts: RunReportFinalFacts): string {
  const readiness =
    facts.readiness === undefined
      ? 'not-required'
      : !facts.readiness.evaluated
        ? 'unknown'
        : facts.readiness.ready
          ? 'ready'
          : 'not-ready';
  return [
    `structural=${facts.structuralStatus}`,
    `readiness=${readiness}`,
    `convergence_satisfied=${String(facts.convergence?.satisfied ?? false)}`,
    `exhausted_limits=${facts.convergence?.exhaustedLimits.length ?? 0}`,
    `unresolved_coverage=${facts.convergence?.unresolvedCoverage.length ?? 0}`,
  ].join(' ');
}

function resolveFinalFacts(
  structural: FinalStatusResult,
  readiness: FinalReadiness | undefined,
  readinessPath: string | undefined,
  convergenceSatisfied: boolean,
  convergenceReason: string,
  convergence: ReturnType<typeof convergenceReport>,
): RunReportFinalFacts {
  const final = resolveCompletionStatus(
    structural,
    readiness,
    convergenceSatisfied,
    convergenceReason,
  );
  return {
    status: final.status,
    reason: final.reason,
    structuralStatus: structural.status,
    structuralReason: structural.reason,
    ...(readiness !== undefined ? { readiness } : {}),
    ...(readinessPath !== undefined ? { readinessPath } : {}),
    convergence,
  };
}

// A malformed forwarded value fails the run before any provider work rather than being dropped.
function readForwardedOverrides(env: NodeJS.ProcessEnv, home: string): ResolveOverrides {
  const overrides: ResolveOverrides = {};
  const configJson = env.AGENT_QUORUM_CONFIG_OVERRIDE_JSON;
  if (configJson !== undefined && configJson !== '') {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(configJson) as JsonValue;
    } catch {
      throw new HaltError('AGENT_QUORUM_CONFIG_OVERRIDE_JSON is not valid JSON', 1);
    }
    if (!isJsonObject(parsed)) {
      throw new HaltError('AGENT_QUORUM_CONFIG_OVERRIDE_JSON must be a JSON object', 1);
    }
    overrides.config = parsed;
  }
  const secretFile = env.AGENT_QUORUM_SECRETS_OVERRIDE_FILE;
  if (secretFile !== undefined && secretFile !== '') {
    overrides.secrets = readSecretHandoff(secretFile, home);
  }
  return overrides;
}

// Confirm the path resolves to a regular file strictly inside <home>/handoff/ before any
// unlink, so a hostile env var cannot turn the reader into an arbitrary-file delete.
function readSecretHandoff(filePath: string, home: string): Secrets {
  let dir: string;
  try {
    dir = realpathSync(handoffDir(home));
  } catch {
    throw new HaltError(
      'AGENT_QUORUM_SECRETS_OVERRIDE_FILE set but the store handoff directory does not exist',
      1,
    );
  }
  let resolved: string;
  try {
    resolved = realpathSync(filePath);
  } catch {
    throw new HaltError(
      'AGENT_QUORUM_SECRETS_OVERRIDE_FILE does not resolve to a readable file',
      1,
    );
  }
  if (!resolved.startsWith(dir + path.sep)) {
    throw new HaltError(
      'AGENT_QUORUM_SECRETS_OVERRIDE_FILE must resolve inside the store handoff directory',
      1,
    );
  }
  if (!statSync(resolved).isFile()) {
    throw new HaltError('AGENT_QUORUM_SECRETS_OVERRIDE_FILE must resolve to a regular file', 1);
  }
  const raw = readFileSync(resolved, 'utf8');
  unlinkSync(resolved);
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    throw new HaltError('AGENT_QUORUM_SECRETS_OVERRIDE_FILE is not valid JSON', 1);
  }
  if (!isJsonObject(parsed)) {
    throw new HaltError('AGENT_QUORUM_SECRETS_OVERRIDE_FILE must contain a JSON object', 1);
  }
  const token = parsed.telegramBotToken;
  if (token !== undefined && typeof token !== 'string') {
    throw new HaltError('AGENT_QUORUM_SECRETS_OVERRIDE_FILE telegramBotToken must be a string', 1);
  }
  return token === undefined ? {} : { telegramBotToken: token };
}

export async function runPlanLoopCli(
  args: readonly string[],
  overrides: RunOverrides = {},
): Promise<RunOutcome> {
  const parsed = parseRunArgs(args);

  const { home, runsDir, stateDir } = resolveArtifactRoots(overrides);
  // Typed RunOverrides and the detached child's forwarded env are exclusive in practice;
  // typed input wins if both appear.
  const forwarded = readForwardedOverrides(process.env, home);
  const configOverrides: ResolveOverrides = {
    cli: parsed.cli,
    ...(forwarded.config !== undefined ? { config: forwarded.config } : {}),
    ...(forwarded.secrets !== undefined ? { secrets: forwarded.secrets } : {}),
    ...(overrides.config !== undefined ? { config: overrides.config } : {}),
    ...(overrides.secrets !== undefined ? { secrets: overrides.secrets } : {}),
  };
  const { config: resolved } = resolveConfig({
    overrides: configOverrides,
    env: process.env,
    home,
  });
  const settings = resolveRunSettings(resolved);
  const knobs = resolveWatchdogKnobs(resolved);
  const qualityKnobs = qualityMatrix(settings.quality);

  const plansDir = runsDir;
  const inputPath = absolutePath(parsed.inputPath);
  const base = path.basename(inputPath, '.md');

  let runStateDir = stateDir;
  if (!path.isAbsolute(runStateDir)) {
    runStateDir = path.join(process.cwd(), runStateDir);
  }
  mkdirSync(runStateDir, { recursive: true });
  runStateDir = canonicalDir(runStateDir);

  const explicitWork = overrides.workDir ?? process.env.AGENT_QUORUM_WORK_DIR;
  const forwardedName = process.env.AGENT_QUORUM_RUN_NAME;
  const explicitName =
    forwardedName !== undefined && forwardedName !== '' ? forwardedName : undefined;
  let work: string;
  let name: string;
  if (explicitWork !== undefined && explicitWork !== '') {
    work = path.isAbsolute(explicitWork) ? explicitWork : path.join(process.cwd(), explicitWork);
    name = explicitName ?? runNameFromWorkdir(work);
  } else {
    name = explicitName ?? deriveRunName(readRunRecords(runStateDir), base);
    work = path.join(plansDir, `loop-${name}`);
  }
  mkdirSync(work, { recursive: true });
  work = canonicalDir(work);

  const logPath = path.join(work, 'run.log');
  const runMetaFile = path.join(work, 'run.meta.tsv');
  const runRegistryFile = path.join(runStateDir, `${process.pid}.tsv`);
  const notifyCompletion = createCompletionNotifier(inputPath, work, resolved.telegram);

  const pgid = ownPgid();
  const startToken = procStartToken(process.pid) ?? '';
  const forwardedRunId = process.env.AGENT_QUORUM_RUN_ID;
  const startedAt = nowUtcStamp();
  let runId = '';
  const finalizeRun = (state: RunState, exitCode: number, facts?: RunReportFinalFacts): void => {
    if (runId === '') {
      return;
    }
    finalizeRunRecord(runStateDir, runId, {
      state,
      exitCode,
      endedAt: nowUtcStamp(),
      ...(facts !== undefined
        ? {
            finalStatus: facts.status,
            finalReason: facts.reason,
            structuralStatus: facts.structuralStatus,
            structuralReason: facts.structuralReason,
            ...(facts.readiness !== undefined ? { finalReadiness: facts.readiness } : {}),
            ...(facts.convergence !== undefined ? { finalConvergence: facts.convergence } : {}),
          }
        : {}),
    });
  };

  try {
    if (process.env.AGENT_QUORUM_STDIO_IS_RUNLOG !== '1') {
      enableRunLogSink(logPath);
    }
    runId = writeRunRecord(
      runStateDir,
      {
        name,
        pid: process.pid,
        pgid,
        procStartToken: startToken,
        mode: parsed.mode,
        inputPath,
        workDir: work,
        logPath,
        plansDir,
        startedAt,
        quality: settings.quality,
        state: 'running',
      },
      forwardedRunId !== undefined && forwardedRunId !== '' ? { fixedRunId: forwardedRunId } : {},
    ).runId;
    log(`run ${runId} (${name})`);
    try {
      pruneRuns(runStateDir, {}, resolved.retention);
    } catch {
      /* best-effort retention; never block a run on prune */
    }

    const matrix = resolveRoleConfig(resolved);
    const permissions = resolveRolePermissions(resolved);

    const metadata: RunMetadata = {
      pid: process.pid,
      pgid,
      mode: parsed.mode,
      inputPath,
      workDir: work,
      plansDir,
      startedAt,
      quality: settings.quality,
      sessionMode: String(qualityKnobs.sessionMode),
      creatorOneShot: String(qualityKnobs.creatorOneShot),
      previousCritiques: qualityKnobs.previousCritiques,
      topology: qualityKnobs.topology,
      completenessPromise: qualityKnobs.completenessPromise,
      issueCap: CRITIC_ISSUE_BUDGET,
      inputLimits: resolved.inputLimits,
      maxIters: settings.maxIters,
      fixPass: String(settings.fixPass),
      diffThreshold: settings.diffThreshold,
      creator: {
        runner: matrix.creator.runner,
        model: matrix.creator.model,
        reasoning: matrix.creator.reasoning,
        createTools: permissions.creator.createTools,
        createDisallowedTools: permissions.creator.createDisallowedTools,
        updateTools: permissions.creator.updateTools,
        updateDisallowedTools: permissions.creator.updateDisallowedTools,
      },
      critic: {
        runner: matrix.critic.runner,
        model: matrix.critic.model,
        reasoning: matrix.critic.reasoning,
        tools: permissions.critic.tools,
        disallowedTools: permissions.critic.disallowedTools,
      },
      fixer: {
        runner: matrix.fixer.runner,
        model: matrix.fixer.model,
        reasoning: matrix.fixer.reasoning,
        tools: permissions.fixer.tools,
        disallowedTools: permissions.fixer.disallowedTools,
      },
      reviewer: {
        runner: matrix.reviewer.runner,
        model: matrix.reviewer.model,
        reasoning: matrix.reviewer.reasoning,
        tools: permissions.reviewer.tools,
        disallowedTools: permissions.reviewer.disallowedTools,
      },
      judge: {
        runner: matrix.judge.runner,
        model: matrix.judge.model,
        reasoning: matrix.judge.reasoning,
        tools: permissions.judge.tools,
        disallowedTools: permissions.judge.disallowedTools,
      },
      runId,
      name,
    };
    writeRunMetadata(runMetaFile, runRegistryFile, metadata);

    const skills = skillPaths(packageRoot());
    for (const skillFile of [
      skills.creatorSkill,
      skills.creatorSchema,
      skills.creatorMetaSchema,
      skills.readinessContractSchema,
      skills.clarifySchema,
      skills.criticSkill,
      skills.criticSchema,
      skills.fixerSkill,
      skills.reviewerSkill,
      skills.reviewerSchema,
      skills.translatorSkill,
      skills.markdownSchema,
      skills.judgeSkill,
      skills.judgeSchema,
    ]) {
      if (!existsSync(skillFile)) {
        process.stderr.write(`missing: ${skillFile}\n`);
        cleanupRunRegistry(runRegistryFile);
        finalizeRun('failed', 1);
        await notifyCompletion({ exitCode: 1, reason: `missing: ${skillFile}` });
        return { exitCode: 1, report: { workDir: work, runId, name } };
      }
    }

    const binaries = { ...resolveRunnerBinaries(), cursor: resolved.providers.cursorBin };
    const required = runnersInUse(matrix, settings.fixPass, settings.translatePass, 0);
    const preflightFailure = preflightRunners(required, binaries);
    if (preflightFailure !== undefined) {
      process.stderr.write(`${preflightFailure.message}\n`);
      cleanupRunRegistry(runRegistryFile);
      finalizeRun('failed', 1);
      await notifyCompletion({ exitCode: 1, reason: preflightFailure.message });
      return { exitCode: 1, report: { workDir: work, runId, name } };
    }

    const scratch = Scratch.create(base);
    const creatorSessionFile = path.join(work, 'creator.session-id');

    const systemContext = buildSystemContext({
      projectRoot: projectRoot(),
      mode: parsed.mode,
      inputFile: inputPath,
    });
    const convergence = createConvergenceState({
      quality: settings.quality,
      matrix: qualityKnobs,
      mode: parsed.mode,
      sourceDigest: fileSha256(inputPath),
      authoritativeDigest: systemContext.digest,
      relationshipIds: systemContext.crossRepository
        ? systemContext.relationships.map((relationship) => relationship.id)
        : [],
      maxIters: settings.maxIters,
    });
    const resuming = process.env.AGENT_QUORUM_RESUME === '1';

    const ctx: RunContext = {
      work,
      mode: parsed.mode,
      inputPath,
      plansDir,
      config: resolved,
      settings,
      quality: qualityKnobs,
      permissions,
      skills,
      provider: {
        scratch,
        projectRoot: projectRoot(),
        retry: { retryCount: settings.retryCount, retryDelaySeconds: settings.retryDelaySeconds },
        streamKnobs: knobs.stream,
        matrix,
        sessionMode: qualityKnobs.sessionMode,
        creatorSessionFile,
        markdownSchemaPath: skills.markdownSchema,
        binaries,
        claudePermissionMode: resolved.providers.claudePermissionMode,
        livenessHeartbeatSeconds: resolved.providers.livenessHeartbeatSeconds,
        claudeThinkingEvery: resolved.providers.claudeThinkingEvery,
        ...(resolved.providers.providerDiagnostics
          ? { diagnosticsDir: path.join(work, 'diagnostics') }
          : {}),
      },
      passes: { fixPass: knobs.fixPass, translatePass: knobs.translatePass },
      maxPlanLines: resolved.status.maxPlanLines,
      split: {
        mode: resolved.split.mode,
        minPhases: resolved.split.minPhases,
      },
      lastCritiqueIter: -1,
      resume: { startIter: 0, archivedCount: 0, archiveDir: '' },
      convergence,
      systemContext,
    };

    const cleanup = () => {
      cleanupRunRegistry(runRegistryFile);
      scratch.sweep();
    };
    installSignalTeardown(cleanup);

    try {
      let startIter = 0;
      if (resuming) {
        startIter = prepareResume(ctx);
      }
      writeSystemContext(work, systemContext);
      if (qualityKnobs.sessionMode === 1) {
        rmSync(creatorSessionFile, { force: true });
      }
      const rejectedLog = path.join(work, 'rejected-log.jsonl');
      if (!existsSync(rejectedLog)) {
        writeFileSync(rejectedLog, '');
      }
      const readinessPreparation = await prepareReadinessContract(ctx, resuming);
      if (!readinessPreparation.ok) {
        finalizeRun('failed', readinessPreparation.exitCode);
        await notifyCompletion({
          exitCode: readinessPreparation.exitCode,
          reason: readinessPreparation.reason,
        });
        return {
          exitCode: readinessPreparation.exitCode,
          report: { workDir: work, runId, name },
        };
      }
      writeConvergenceState(work, ctx.convergence);

      if (requiresReadinessJudge(ctx.convergence) && ctx.convergence.judgeAllowed) {
        const judgePreflightFailure = preflightRunners([matrix.judge.runner], binaries);
        if (judgePreflightFailure !== undefined) {
          process.stderr.write(`${judgePreflightFailure.message}\n`);
          finalizeRun('failed', 1);
          await notifyCompletion({ exitCode: 1, reason: judgePreflightFailure.message });
          return { exitCode: 1, report: { workDir: work, runId, name } };
        }
      }

      if (parsed.mode === 'prompt') {
        const promptCopy = path.join(work, 'prompt.md');
        if (!filesEqual(inputPath, promptCopy)) {
          copyFileSync(inputPath, promptCopy);
        }
        const v0 = path.join(work, 'plan.v0.md');
        if (!existsSync(v0) || statSync(v0).size === 0) {
          log(`creating plan v0 from prompt (${matrix.creator.runner} ${matrix.creator.model})`);
          await runCreatorCreate(ctx, inputPath, v0);
          markOperatorInterventionsMigrated(work, 'creator', 'plan.v0.md');
          log(`  → plan.v0.md created (${fileLineCount(v0)} lines)`);
        }
      } else {
        const v0 = path.join(work, 'plan.v0.md');
        if (!existsSync(v0)) {
          copyFileSync(inputPath, v0);
        }
      }

      if (startIter > 0) {
        log(`resuming from v${startIter}`);
      }

      const { iter } = await runIterationLoop(ctx, startIter);

      const finalPlan = path.join(work, 'plan.final.md');
      validateFinalPlan(ctx.provider.projectRoot, finalPlan);

      if (settings.fixPass === 1) {
        await runFixPass(ctx, finalPlan);
      } else {
        log('fix-pass: disabled via --no-fix');
      }

      const translateFile = path.join(work, `plan.final.${settings.locale}.md`);

      const findings = readFindingsCounts(path.join(work, 'findings.json'));
      let splitPackage = emitAndValidateSplitPackage(ctx, finalPlan);
      let packageHealth = splitPackage.packageHealth;
      const currentStructuralStatus = (): FinalStatusResult => {
        return resolveStructuralStatus({
          finalTitle: planHasTitleHeading(finalPlan) ? 1 : 0,
          shape: planDocumentShapeHealth(finalPlan),
          findings,
          ...(packageHealth !== undefined ? { packageHealth } : {}),
        });
      };
      let structural = currentStructuralStatus();
      const rebuildCanonicalPackage = (): void => {
        rmSync(path.join(work, PACKAGE_DIR_NAME), { recursive: true, force: true });
        splitPackage = emitAndValidateSplitPackage(ctx, finalPlan);
        packageHealth = splitPackage.packageHealth;
        structural = currentStructuralStatus();
      };
      if (structural.status === 'clean') {
        log('STRUCTURAL: clean — plan.final.md is complete with no stale references');
      } else {
        err(`STRUCTURAL: ${structural.status} — ${structural.reason}`);
      }

      recordFinalArtifactProof(ctx, finalPlan, structural);
      const projectedStatus: RunFinalStatus =
        structural.status === 'blocked'
          ? 'blocked'
          : ctx.convergence.decision === 'ready'
            ? 'clean'
            : 'needs-review';
      const beforeInitialStatusProjection = readFileSync(finalPlan, 'utf8');
      setPlanFrontmatterStatus(finalPlan, projectedStatus);
      if (readFileSync(finalPlan, 'utf8') !== beforeInitialStatusProjection) {
        rebuildCanonicalPackage();
      }
      recordFinalArtifactProof(ctx, finalPlan, structural);
      let finalSystemCheck = refreshFinalSystemCheck(ctx, finalPlan);

      let readiness: FinalReadiness | undefined;
      let readinessPath: string | undefined;
      let judgeCoverageProved = false;
      let judgeCandidateUnchanged = true;
      const finalJudgeRequired =
        requiresReadinessJudge(ctx.convergence) && ctx.convergence.judgeAllowed;
      if (structural.status !== 'blocked' && finalJudgeRequired) {
        const priorJudgeVersion = ctx.convergence.judgeEvaluatedPlanVersion;
        const priorJudgeReady = ctx.convergence.judgeReady;
        const reviewedPlan = path.join(work, `plan.v${ctx.convergence.planVersion}.md`);
        const sameSemanticPlan =
          existsSync(reviewedPlan) &&
          statusInvariantPlan(reviewedPlan) === statusInvariantPlan(finalPlan);
        log(
          `final Judge (${matrix.judge.runner} ${matrix.judge.model} reasoning=${matrix.judge.reasoning})`,
        );
        const judged = await runFinalJudge(ctx, finalPlan);
        readiness = judged.readiness;
        readinessPath = judged.metadataPath;
        judgeCoverageProved = judged.coverageProved;
        judgeCandidateUnchanged = judged.candidateUnchanged;
        if (
          priorJudgeVersion === ctx.convergence.planVersion &&
          priorJudgeReady !== undefined &&
          readiness.evaluated &&
          sameSemanticPlan &&
          priorJudgeReady !== readiness.ready &&
          !ctx.convergence.unresolvedCoverage.includes('final-judge:inconsistent-verdict')
        ) {
          ctx.convergence.unresolvedCoverage.push('final-judge:inconsistent-verdict');
          delete ctx.convergence.judgeApprovedPlanVersion;
        }
        if (!readiness.evaluated) {
          err(`FINAL JUDGE: unknown (plan_sha256=${readiness.planSha256})`);
        } else if (readiness.ready) {
          log(
            `FINAL JUDGE: ready (coverage_proved=${String(judgeCoverageProved)}, plan_sha256=${readiness.planSha256})`,
          );
        } else {
          err(`FINAL JUDGE: not-ready (plan_sha256=${readiness.planSha256})`);
        }
      } else if (structural.status === 'blocked' && finalJudgeRequired) {
        log('final Judge skipped — structural status is blocked');
      }

      if (finalJudgeRequired) {
        recordFinalJudgeProof(ctx, readiness, judgeCoverageProved);
      }
      const initialProofHashMismatch = recordCanonicalProofHashBinding(
        ctx,
        finalPlan,
        finalSystemCheck,
        readiness,
        judgeCandidateUnchanged,
      );
      judgeCandidateUnchanged = true;
      if (initialProofHashMismatch) {
        finalSystemCheck = refreshFinalSystemCheck(ctx, finalPlan);
        rebuildCanonicalPackage();
      }
      classifyTerminal(ctx.convergence);
      writeConvergenceState(work, ctx.convergence, 'convergence.final.json');

      let finalFacts = resolveFinalFacts(
        structural,
        readiness,
        readinessPath,
        ctx.convergence.satisfied,
        ctx.convergence.stopReason,
        convergenceReport(work, ctx.convergence),
      );
      if (finalFacts.status === 'needs-review') {
        const beforeStatusProjection = readFileSync(finalPlan, 'utf8');
        setPlanFrontmatterStatus(finalPlan, 'needs-review');
        const statusChanged = readFileSync(finalPlan, 'utf8') !== beforeStatusProjection;
        if (statusChanged) {
          finalSystemCheck = refreshFinalSystemCheck(ctx, finalPlan);
        }
        if (statusChanged && structural.status !== 'blocked' && finalJudgeRequired) {
          log('final Judge re-evaluation after canonical needs-review status projection');
          const previousReady = readiness?.ready;
          const previousCoverageProved = judgeCoverageProved;
          const judged = await runFinalJudge(ctx, finalPlan);
          readiness = judged.readiness;
          readinessPath = judged.metadataPath;
          judgeCoverageProved = judged.coverageProved;
          judgeCandidateUnchanged = judged.candidateUnchanged;
          if (previousReady !== readiness.ready || previousCoverageProved !== judgeCoverageProved) {
            if (!ctx.convergence.unresolvedCoverage.includes('final-judge:inconsistent-verdict')) {
              ctx.convergence.unresolvedCoverage.push('final-judge:inconsistent-verdict');
            }
          }
          if (ctx.convergence.unresolvedCoverage.includes('final-judge:inconsistent-verdict')) {
            delete ctx.convergence.judgeApprovedPlanVersion;
          }
          recordFinalJudgeProof(ctx, readiness, judgeCoverageProved);
          const projectedProofHashMismatch = recordCanonicalProofHashBinding(
            ctx,
            finalPlan,
            finalSystemCheck,
            readiness,
            judgeCandidateUnchanged,
          );
          judgeCandidateUnchanged = true;
          if (projectedProofHashMismatch) {
            setPlanFrontmatterStatus(finalPlan, 'needs-review');
            finalSystemCheck = refreshFinalSystemCheck(ctx, finalPlan);
            rebuildCanonicalPackage();
          }
        }
        recordCanonicalProofHashBinding(ctx, finalPlan, finalSystemCheck, readiness);
        classifyTerminal(ctx.convergence);
        writeConvergenceState(work, ctx.convergence, 'convergence.final.json');
        finalFacts = resolveFinalFacts(
          structural,
          readiness,
          readinessPath,
          ctx.convergence.satisfied,
          ctx.convergence.stopReason,
          convergenceReport(work, ctx.convergence),
        );
        if (splitPackage.packageDir !== undefined) {
          copyFileSync(finalPlan, path.join(splitPackage.packageDir, 'plan.md'));
        }
      }

      writeConvergenceState(work, ctx.convergence, 'convergence.final.json');

      if (settings.translatePass === 1) {
        await runTranslatePass(ctx, finalPlan, translateFile);
      } else {
        log('translate-pass: disabled (locale=en)');
      }
      const lateProofHashMismatch = recordCanonicalProofHashBinding(
        ctx,
        finalPlan,
        finalSystemCheck,
        readiness,
      );
      if (
        lateProofHashMismatch ||
        ctx.convergence.unresolvedCoverage.includes(CANONICAL_PROOF_HASH_MISMATCH)
      ) {
        const beforeStatusProjection = readFileSync(finalPlan, 'utf8');
        setPlanFrontmatterStatus(finalPlan, 'needs-review');
        const statusChanged = readFileSync(finalPlan, 'utf8') !== beforeStatusProjection;
        if (lateProofHashMismatch || statusChanged) {
          finalSystemCheck = refreshFinalSystemCheck(ctx, finalPlan);
        }
        if (lateProofHashMismatch) {
          rebuildCanonicalPackage();
        }
        recordCanonicalProofHashBinding(ctx, finalPlan, finalSystemCheck, readiness);
        classifyTerminal(ctx.convergence);
        if (splitPackage.packageDir !== undefined) {
          copyFileSync(finalPlan, path.join(splitPackage.packageDir, 'plan.md'));
        }
      }
      writeConvergenceState(work, ctx.convergence, 'convergence.final.json');

      const persistedProofHashMismatch = recordCanonicalProofHashBinding(
        ctx,
        finalPlan,
        finalSystemCheck,
        readiness,
      );
      if (
        persistedProofHashMismatch ||
        (ctx.convergence.unresolvedCoverage.includes(CANONICAL_PROOF_HASH_MISMATCH) &&
          planFrontmatterStatus(finalPlan) !== 'needs-review')
      ) {
        setPlanFrontmatterStatus(finalPlan, 'needs-review');
        finalSystemCheck = refreshFinalSystemCheck(ctx, finalPlan);
        rebuildCanonicalPackage();
        recordCanonicalProofHashBinding(ctx, finalPlan, finalSystemCheck, readiness);
        classifyTerminal(ctx.convergence);
        if (splitPackage.packageDir !== undefined) {
          copyFileSync(finalPlan, path.join(splitPackage.packageDir, 'plan.md'));
        }
        writeConvergenceState(work, ctx.convergence, 'convergence.final.json');
      }
      finalFacts = resolveFinalFacts(
        structural,
        readiness,
        readinessPath,
        ctx.convergence.satisfied,
        ctx.convergence.stopReason,
        convergenceReport(work, ctx.convergence),
      );

      if (finalFacts.status === 'clean') {
        log(
          readiness === undefined
            ? 'FINAL: clean — plan.final.md is structurally complete with no stale references'
            : 'FINAL: clean — canonical plan is structurally clean and Judge-approved',
        );
      } else {
        err(`FINAL: ${finalFacts.status} — ${finalStatusLogDetails(finalFacts)}`);
      }

      writeSummary(ctx, {
        iter,
        localizedFinalFile: translateFile,
        finalStale: findings.stale,
        finalAmbiguous: findings.ambiguous,
        finalUnresolved: findings.unresolved,
        finalFacts,
        splitDecision: splitPackage.splitDecision.split ? 'split' : 'no-split',
        splitRationale: splitPackage.splitDecision.rationale,
        packagePhaseCount: splitPackage.packagePhaseCount,
        ...(splitPackage.packageDir !== undefined ? { packageDir: splitPackage.packageDir } : {}),
        ...(packageHealth !== undefined ? { packageHealth } : {}),
      });

      log(`done. summary: ${path.join(work, 'summary.md')}`);
      const report = {
        ...buildRunReport(ctx, iter, finalFacts),
        convergence: convergenceReport(work, ctx.convergence),
        runId,
        name,
      };
      const exitCode = finalFacts.status === 'blocked' ? 6 : 0;
      finalizeRun(finalFacts.status === 'blocked' ? 'blocked' : 'finished', exitCode, finalFacts);
      await notifyCompletion({
        ...finalFacts,
        exitCode,
        iterations: iter,
        ...(report.summaryPath !== undefined ? { summaryPath: report.summaryPath } : {}),
      });
      return { exitCode, report };
    } finally {
      cleanup();
    }
  } catch (error) {
    finalizeRun('failed', errorExitCode(error));
    await notifyCompletion({ exitCode: errorExitCode(error), reason: errorReason(error) });
    throw error;
  } finally {
    disableRunLogSink();
  }
}
