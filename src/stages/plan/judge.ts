import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { admitJudge, type AdmittedJudge } from '../../core/readiness-admission.js';
import { sha256 } from '../../core/digest.js';
import type { JsonValue } from '../../core/json.js';
import {
  createOccurrenceSourceBinding,
  type OccurrenceSourceBinding,
  type ReadinessProofState,
} from '../../core/readiness-proof.js';
import { readStripped, type RunContext } from '../../core/run-context.js';
import { validateSchema } from '../../core/schema.js';
import { providerRun } from '../../providers/provider.js';
import { log } from '../../runtime/log.js';
import { retainedRolePrompt, synchronizeRetainedInterventions } from './retained-context.js';

const FINAL_PLAN_ARTIFACT = 'plan.final.md';
const FINAL_JUDGE_RAW = 'judge.final.raw';
const FINAL_JUDGE_VERDICT = 'judge.final.json';
export const FINAL_JUDGE_METADATA = 'judge.final.meta.json';
export const FINAL_JUDGE_METADATA_SCHEMA_VERSION = 2;

export type JudgeStage = 'intermediate' | 'final';

export type IntermediateJudgeOperationalRationale =
  | 'intermediate-judge-ready'
  | 'intermediate-judge-not-ready'
  | 'intermediate-judge-proof-unavailable'
  | 'intermediate-judge-candidate-mutated';

export type FinalJudgeOperationalRationale =
  | 'final-judge-ready'
  | 'final-judge-not-ready'
  | 'final-judge-proof-unavailable'
  | 'final-judge-candidate-mutated';

export type JudgeOperationalRationale =
  | IntermediateJudgeOperationalRationale
  | FinalJudgeOperationalRationale;

export interface JudgeUnavailableResult<Stage extends JudgeStage = JudgeStage> {
  readonly available: false;
  readonly stage: Stage;
  readonly binding: OccurrenceSourceBinding;
  readonly candidateUnchanged: boolean;
  readonly rationale: string;
}

export interface JudgeAvailableResult<Stage extends JudgeStage = JudgeStage> {
  readonly available: true;
  readonly stage: Stage;
  readonly binding: OccurrenceSourceBinding;
  readonly candidateUnchanged: boolean;
  readonly rationale: string;
  readonly admitted: AdmittedJudge;
}

export type JudgeEvaluationResult<Stage extends JudgeStage = JudgeStage> =
  | JudgeUnavailableResult<Stage>
  | JudgeAvailableResult<Stage>;

export type IntermediateJudgeResult = JudgeEvaluationResult<'intermediate'>;

interface FinalJudgeArtifacts {
  readonly raw: string;
  readonly verdict: string;
  readonly metadata: string;
}

interface FinalJudgeOccurrenceProof {
  readonly coverageComplete: true;
  readonly satisfied: boolean;
  readonly unresolvedOccurrenceIds: readonly string[];
  readonly violatedOccurrenceIds: readonly string[];
  readonly occurrences: AdmittedJudge['snapshot']['occurrences'];
  readonly materialIssueIds: readonly string[];
}

interface FinalJudgeMetadata {
  readonly schemaVersion: typeof FINAL_JUDGE_METADATA_SCHEMA_VERSION;
  readonly canonicalPlan: typeof FINAL_PLAN_ARTIFACT;
  readonly planVersion: number;
  readonly planSha256: string;
  readonly observedPlanSha256: string | null;
  readonly readinessContractDigest: string | null;
  readonly catalogDigest: string;
  readonly source: 'final-judge';
  readonly binding: OccurrenceSourceBinding;
  readonly evaluated: boolean;
  readonly available: boolean;
  readonly candidateUnchanged: boolean;
  readonly ready: boolean | null;
  readonly rationale: FinalJudgeOperationalRationale;
  readonly occurrenceProof: FinalJudgeOccurrenceProof | null;
  readonly verdictArtifact: typeof FINAL_JUDGE_VERDICT | null;
}

interface FinalJudgeResultFields {
  readonly metadataPath: string;
}

export type FinalJudgeResult = JudgeEvaluationResult<'final'> & FinalJudgeResultFields;

interface JudgePromptOptions {
  readonly scope?: JudgeStage;
  readonly planSha256?: string;
  readonly planContent?: string;
}

interface CandidateIdentity {
  readonly unchanged: boolean;
  readonly observedSha256?: string;
}

function synchronizeJudgeState(
  ctx: RunContext,
  state: ReadinessProofState,
  stage: JudgeStage,
): ReadinessProofState {
  if (ctx.readinessProof !== state) {
    throw new TypeError(`${stage} Judge requires the current run-context proof state`);
  }
  const synchronized = synchronizeRetainedInterventions(ctx);
  if (
    synchronized.planVersion !== state.planVersion ||
    synchronized.catalog.digest !== state.catalog.digest
  ) {
    throw new TypeError(`${stage} Judge proof state does not match the run context`);
  }
  return synchronized;
}

function intermediateJudgeOperationalRationale(
  candidateUnchanged: boolean,
  verdict: boolean | null,
): IntermediateJudgeOperationalRationale {
  if (!candidateUnchanged) {
    return 'intermediate-judge-candidate-mutated';
  }
  if (verdict === null) {
    return 'intermediate-judge-proof-unavailable';
  }
  return verdict ? 'intermediate-judge-ready' : 'intermediate-judge-not-ready';
}

export function finalJudgeOperationalRationale(
  candidateUnchanged: boolean,
  verdict: boolean | null,
): FinalJudgeOperationalRationale {
  if (!candidateUnchanged) {
    return 'final-judge-candidate-mutated';
  }
  if (verdict === null) {
    return 'final-judge-proof-unavailable';
  }
  return verdict ? 'final-judge-ready' : 'final-judge-not-ready';
}

function resolveFinalCritiqueFile(ctx: RunContext): string | undefined {
  if (ctx.lastCritiqueIter < 0) {
    return undefined;
  }
  const critiqueFile = path.join(ctx.work, `critique.v${ctx.lastCritiqueIter}.json`);
  return existsSync(critiqueFile) ? critiqueFile : undefined;
}

function buildJudgeEvaluationSection(options: JudgePromptOptions): string {
  const scope = options.scope ?? 'intermediate';
  const isFinal = scope === 'final';
  const lines = [
    '## Evaluation',
    `scope: ${scope}`,
    `canonical_plan: ${isFinal ? FINAL_PLAN_ARTIFACT : 'no'}`,
  ];
  if (options.planSha256 !== undefined) {
    lines.push(`plan_sha256: ${options.planSha256}`);
  }
  lines.push(
    `critique_context: ${isFinal ? 'advisory; it may predate the canonical final plan' : 'current critique for this plan revision'}`,
    'frontmatter_status: orchestration projection only; do not change the semantic verdict solely because status is clean, needs-review, or blocked',
  );
  return lines.join('\n');
}

export function judgePrompt(
  planFile: string,
  critiqueFile: string | undefined,
  options: JudgePromptOptions = {},
): string {
  const plan =
    options.planContent ??
    (options.scope === 'final' ? readFileSync(planFile, 'utf8') : readStripped(planFile));
  const critiqueContext =
    critiqueFile === undefined
      ? 'No critique context is available. Evaluate the plan independently.'
      : readStripped(critiqueFile);
  return [
    buildJudgeEvaluationSection(options),
    `## Plan\n${plan}`,
    `## Critique Context\n${critiqueContext}`,
    'Return ONLY JSON conforming to the schema. No prose, no markdown fences.',
  ].join('\n\n');
}

function candidateIdentity(file: string, expectedSha256: string): CandidateIdentity {
  try {
    const observedSha256 = sha256(readFileSync(file));
    return { unchanged: observedSha256 === expectedSha256, observedSha256 };
  } catch {
    return { unchanged: false };
  }
}

function parseJsonFile(file: string): JsonValue | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  } catch {
    return undefined;
  }
}

interface RequestJudgeInput<Stage extends JudgeStage> {
  readonly ctx: RunContext;
  readonly state: ReadinessProofState;
  readonly stage: Stage;
  readonly candidateFile: string;
  readonly candidateContent: string;
  readonly binding: OccurrenceSourceBinding;
  readonly outputFile: string;
  readonly prompt: string;
}

async function requestJudge<Stage extends JudgeStage>(
  input: RequestJudgeInput<Stage>,
): Promise<AdmittedJudge | undefined> {
  let admitted: AdmittedJudge | undefined;
  const validateOutput = (outputFile: string): boolean => {
    if (!validateSchema(outputFile, input.ctx.skills.judgeSchema)) {
      log(`WARNING: ${input.stage} Judge output failed schema validation`);
      return false;
    }
    const value = parseJsonFile(outputFile);
    if (value === undefined) {
      log(`WARNING: ${input.stage} Judge output is not valid JSON`);
      return false;
    }
    try {
      admitted = admitJudge({
        value,
        stage: input.stage,
        catalog: input.state.catalog,
        binding: input.binding,
        evidenceContext: {
          work: input.ctx.work,
          projectRoot: input.ctx.provider.projectRoot,
          planVersion: input.state.planVersion,
          candidateContent: input.candidateContent,
          candidatePath: input.candidateFile,
        },
      });
      return true;
    } catch {
      admitted = undefined;
      log(`WARNING: ${input.stage} Judge output failed semantic admission`);
      return false;
    }
  };
  const status = await providerRun(
    input.ctx.provider,
    'judge',
    'json',
    input.outputFile,
    input.ctx.skills.judgeSkill,
    input.ctx.skills.judgeSchema,
    input.ctx.permissions.judge.tools,
    input.ctx.permissions.judge.disallowedTools,
    input.prompt,
    { validateOutput },
  );
  if (status !== 0) {
    log(`WARNING: ${input.stage} Judge provider call failed (${status}) — proof unavailable`);
    return undefined;
  }
  if (admitted !== undefined) {
    return admitted;
  }
  return validateOutput(input.outputFile) ? admitted : undefined;
}

function unavailableResult<Stage extends JudgeStage>(
  stage: Stage,
  binding: OccurrenceSourceBinding,
  candidateUnchanged: boolean,
): JudgeUnavailableResult<Stage> {
  const rationale =
    stage === 'final'
      ? finalJudgeOperationalRationale(candidateUnchanged, null)
      : intermediateJudgeOperationalRationale(candidateUnchanged, null);
  return { available: false, stage, binding, candidateUnchanged, rationale };
}

function availableResult<Stage extends JudgeStage>(
  stage: Stage,
  binding: OccurrenceSourceBinding,
  admitted: AdmittedJudge,
  candidateUnchanged: boolean,
): JudgeAvailableResult<Stage> {
  const rationale =
    stage === 'final'
      ? finalJudgeOperationalRationale(candidateUnchanged, admitted.verdict)
      : intermediateJudgeOperationalRationale(candidateUnchanged, admitted.verdict);
  return { available: true, stage, binding, admitted, candidateUnchanged, rationale };
}

export async function runJudge(
  ctx: RunContext,
  state: ReadinessProofState,
  iter: number,
  planFile: string,
  critiqueFile: string,
  outFile: string,
): Promise<IntermediateJudgeResult> {
  if (iter !== state.planVersion) {
    throw new TypeError('intermediate Judge iteration must match readiness proof plan version');
  }
  const synchronizedState = synchronizeJudgeState(ctx, state, 'intermediate');
  const planBytes = readFileSync(planFile);
  const planContent = planBytes.toString('utf8');
  const planSha256 = sha256(planBytes);
  const binding = createOccurrenceSourceBinding(synchronizedState, {
    source: 'intermediate-judge',
    candidateKind: 'versioned-plan',
    contentDigest: planSha256,
  });
  const prompt = retainedRolePrompt({
    ctx,
    role: 'judge',
    stage: 'intermediate-readiness',
    planVersion: iter,
    skillFile: ctx.skills.judgeSkill,
    schemaFile: ctx.skills.judgeSchema,
    basePrompt: judgePrompt(planFile, critiqueFile, {
      scope: 'intermediate',
      planSha256,
      planContent,
    }),
    lineageDigest: binding.lineage.lineageDigest,
    persistVersionedState: false,
  });
  const admitted = await requestJudge({
    ctx,
    state: synchronizedState,
    stage: 'intermediate',
    candidateFile: planFile,
    candidateContent: planContent,
    binding,
    outputFile: outFile,
    prompt,
  });
  const candidateUnchanged = candidateIdentity(planFile, planSha256).unchanged;
  if (admitted === undefined) {
    return unavailableResult('intermediate', binding, candidateUnchanged);
  }
  return availableResult('intermediate', binding, admitted, candidateUnchanged);
}

function resolveFinalJudgeArtifacts(work: string): FinalJudgeArtifacts {
  return {
    raw: path.join(work, FINAL_JUDGE_RAW),
    verdict: path.join(work, FINAL_JUDGE_VERDICT),
    metadata: path.join(work, FINAL_JUDGE_METADATA),
  };
}

function finalMetadata(
  state: ReadinessProofState,
  binding: OccurrenceSourceBinding,
  candidate: CandidateIdentity,
  result: JudgeEvaluationResult<'final'>,
): FinalJudgeMetadata {
  const usable = result.available && result.candidateUnchanged;
  return {
    schemaVersion: FINAL_JUDGE_METADATA_SCHEMA_VERSION,
    canonicalPlan: FINAL_PLAN_ARTIFACT,
    planVersion: state.planVersion,
    planSha256: binding.candidate.contentDigest,
    observedPlanSha256: candidate.observedSha256 ?? null,
    readinessContractDigest: state.readinessContractDigest ?? null,
    catalogDigest: state.catalog.digest,
    source: 'final-judge',
    binding,
    evaluated: result.available,
    available: usable,
    candidateUnchanged: result.candidateUnchanged,
    ready: result.available ? result.admitted.verdict : null,
    rationale: finalJudgeOperationalRationale(
      result.candidateUnchanged,
      result.available ? result.admitted.verdict : null,
    ),
    occurrenceProof: result.available
      ? {
          coverageComplete: result.admitted.coverageComplete,
          satisfied: result.admitted.satisfied,
          unresolvedOccurrenceIds: result.admitted.unresolvedOccurrenceIds,
          violatedOccurrenceIds: result.admitted.violatedOccurrenceIds,
          occurrences: result.admitted.snapshot.occurrences,
          materialIssueIds: result.admitted.materialIssueIds,
        }
      : null,
    verdictArtifact: usable ? FINAL_JUDGE_VERDICT : null,
  };
}

function persistFinalJudgeResult(files: FinalJudgeArtifacts, metadata: FinalJudgeMetadata): void {
  if (metadata.verdictArtifact !== null) {
    copyFileSync(files.raw, files.verdict);
  }
  writeFileSync(files.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function runFinalJudge(
  ctx: RunContext,
  state: ReadinessProofState,
  finalPlan: string,
): Promise<FinalJudgeResult> {
  const synchronizedState = synchronizeJudgeState(ctx, state, 'final');
  const files = resolveFinalJudgeArtifacts(ctx.work);
  const planBytes = readFileSync(finalPlan);
  const planContent = planBytes.toString('utf8');
  const planSha256 = sha256(planBytes);
  const binding = createOccurrenceSourceBinding(synchronizedState, {
    source: 'final-judge',
    candidateKind: 'canonical-plan',
    contentDigest: planSha256,
  });
  rmSync(files.raw, { force: true });
  rmSync(files.verdict, { force: true });
  rmSync(files.metadata, { force: true });

  const prompt = retainedRolePrompt({
    ctx,
    role: 'judge',
    stage: 'final-readiness',
    planVersion: synchronizedState.planVersion,
    skillFile: ctx.skills.judgeSkill,
    schemaFile: ctx.skills.judgeSchema,
    basePrompt: judgePrompt(finalPlan, resolveFinalCritiqueFile(ctx), {
      scope: 'final',
      planSha256,
      planContent,
    }),
    lineageDigest: binding.lineage.lineageDigest,
    persistVersionedState: false,
  });
  const admitted = await requestJudge({
    ctx,
    state: synchronizedState,
    stage: 'final',
    candidateFile: finalPlan,
    candidateContent: planContent,
    binding,
    outputFile: files.raw,
    prompt,
  });
  const candidate = candidateIdentity(finalPlan, planSha256);
  const result: JudgeEvaluationResult<'final'> =
    admitted === undefined
      ? unavailableResult('final', binding, candidate.unchanged)
      : availableResult('final', binding, admitted, candidate.unchanged);
  const metadata = finalMetadata(synchronizedState, binding, candidate, result);
  persistFinalJudgeResult(files, metadata);
  return { ...result, metadataPath: files.metadata };
}
