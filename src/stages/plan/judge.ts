import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { providerRun } from '../../providers/provider.js';
import { log } from '../../runtime/log.js';
import { isJsonObject, type JsonValue } from '../../core/json.js';
import { validateSchema } from '../../core/schema.js';
import { readStripped, type RunContext } from '../../core/run-context.js';
import type { FinalReadiness } from '../../types.js';

const FINAL_PLAN_ARTIFACT = 'plan.final.md';
const FINAL_JUDGE_RAW = 'judge.final.raw';
const FINAL_JUDGE_VERDICT = 'judge.final.json';
export const FINAL_JUDGE_METADATA = 'judge.final.meta.json';
const MAX_REPORTED_RATIONALE_LENGTH = 180;
const UNKNOWN_RATIONALE = 'Final Judge did not produce a valid verdict after provider retries.';

interface JudgeVerdict {
  readonly ready: boolean;
  readonly rationale: string;
}

const NOT_READY: JudgeVerdict = { ready: false, rationale: '' };

export interface FinalJudgeResult {
  readonly readiness: FinalReadiness;
  readonly metadataPath: string;
}

interface JudgePromptOptions {
  readonly scope?: 'intermediate' | 'final';
  readonly planSha256?: string;
}

interface FinalJudgeFiles {
  readonly raw: string;
  readonly verdict: string;
  readonly metadata: string;
}

interface FinalJudgeMetadata {
  readonly canonical_plan: string;
  readonly plan_sha256: string;
  readonly evaluated: boolean;
  readonly ready: boolean | null;
  readonly rationale: string;
  readonly verdict_artifact: string | null;
}

function compactRationale(rationale: string): string {
  const compacted = rationale.replace(/\s+/g, ' ').trim();
  if (compacted.length <= MAX_REPORTED_RATIONALE_LENGTH) {
    return compacted;
  }
  return `${compacted.slice(0, MAX_REPORTED_RATIONALE_LENGTH - 3).trimEnd()}...`;
}

function readJudgeVerdict(outputFile: string, schemaFile: string): JudgeVerdict | undefined {
  if (!validateSchema(outputFile, schemaFile)) {
    return undefined;
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(readFileSync(outputFile, 'utf8')) as JsonValue;
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed) || typeof parsed.ready !== 'boolean') {
    return undefined;
  }
  return {
    ready: parsed.ready,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
  };
}

function finalJudgeRationale(verdict: JudgeVerdict): string {
  const compact = compactRationale(verdict.rationale);
  if (compact !== '') {
    return compact;
  }
  return `Final Judge returned ready=${String(verdict.ready)} without a rationale.`;
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
  );
  return lines.join('\n');
}

export function judgePrompt(
  planFile: string,
  critiqueFile: string | undefined,
  options: JudgePromptOptions = {},
): string {
  const plan = options.scope === 'final' ? readFileSync(planFile, 'utf8') : readStripped(planFile);
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

export async function runJudge(
  ctx: RunContext,
  _iter: number,
  planFile: string,
  critiqueFile: string,
  outFile: string,
): Promise<JudgeVerdict> {
  const prompt = judgePrompt(planFile, critiqueFile);
  const status = await providerRun(
    ctx.provider,
    'judge',
    'json',
    outFile,
    ctx.skills.judgeSkill,
    ctx.skills.judgeSchema,
    ctx.permissions.judge.tools,
    ctx.permissions.judge.disallowedTools,
    prompt,
  );
  if (status !== 0) {
    log(`WARNING: judge provider call failed (${status}) — treating as not ready`);
    return NOT_READY;
  }
  const verdict = readJudgeVerdict(outFile, ctx.skills.judgeSchema);
  if (verdict === undefined) {
    log('WARNING: judge output failed schema validation — treating as not ready');
    return NOT_READY;
  }
  return {
    ready: verdict.ready,
    rationale: compactRationale(verdict.rationale),
  };
}

function resolveFinalJudgeFiles(work: string): FinalJudgeFiles {
  return {
    raw: path.join(work, FINAL_JUDGE_RAW),
    verdict: path.join(work, FINAL_JUDGE_VERDICT),
    metadata: path.join(work, FINAL_JUDGE_METADATA),
  };
}

async function requestFinalJudge(
  ctx: RunContext,
  rawFile: string,
  prompt: string,
): Promise<JudgeVerdict | undefined> {
  let verdict: JudgeVerdict | undefined;
  const validateOutput = (outputFile: string): boolean => {
    verdict = readJudgeVerdict(outputFile, ctx.skills.judgeSchema);
    if (verdict === undefined) {
      log('WARNING: final Judge output is invalid — retrying under provider policy');
    }
    return verdict !== undefined;
  };
  const status = await providerRun(
    ctx.provider,
    'judge',
    'json',
    rawFile,
    ctx.skills.judgeSkill,
    ctx.skills.judgeSchema,
    ctx.permissions.judge.tools,
    ctx.permissions.judge.disallowedTools,
    prompt,
    { validateOutput },
  );
  return status === 0 ? verdict : undefined;
}

function finalReadiness(verdict: JudgeVerdict | undefined, planSha256: string): FinalReadiness {
  if (verdict === undefined) {
    return {
      evaluated: false,
      ready: null,
      rationale: UNKNOWN_RATIONALE,
      planSha256,
    };
  }
  return {
    evaluated: true,
    ready: verdict.ready,
    rationale: finalJudgeRationale(verdict),
    planSha256,
  };
}

function persistFinalJudgeResult(files: FinalJudgeFiles, readiness: FinalReadiness): void {
  if (readiness.evaluated) {
    copyFileSync(files.raw, files.verdict);
  }
  const metadata: FinalJudgeMetadata = {
    canonical_plan: FINAL_PLAN_ARTIFACT,
    plan_sha256: readiness.planSha256,
    evaluated: readiness.evaluated,
    ready: readiness.ready,
    rationale: readiness.rationale,
    verdict_artifact: readiness.evaluated ? FINAL_JUDGE_VERDICT : null,
  };
  writeFileSync(files.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function runFinalJudge(ctx: RunContext, finalPlan: string): Promise<FinalJudgeResult> {
  const files = resolveFinalJudgeFiles(ctx.work);
  const planSha256 = createHash('sha256').update(readFileSync(finalPlan)).digest('hex');
  rmSync(files.raw, { force: true });
  rmSync(files.verdict, { force: true });
  rmSync(files.metadata, { force: true });

  const prompt = judgePrompt(finalPlan, resolveFinalCritiqueFile(ctx), {
    scope: 'final',
    planSha256,
  });
  const verdict = await requestFinalJudge(ctx, files.raw, prompt);
  const readiness = finalReadiness(verdict, planSha256);
  persistFinalJudgeResult(files, readiness);
  return { readiness, metadataPath: files.metadata };
}
