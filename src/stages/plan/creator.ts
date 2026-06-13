import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { nonEmptyFile } from '../../runtime/files.js';
import path from 'node:path';
import { HaltError } from '../../runtime/halt.js';
import { err, log } from '../../runtime/log.js';
import { providerRun } from '../../providers/provider.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../core/json.js';
import { operatorInterventionsContext } from './interventions.js';
import {
  normalizePlanDocument,
  planDocumentShapeOk,
  requirePlanDocumentShape,
  validatePlanDocumentShape,
} from './plan-shape.js';
import {
  combineUpdateJson,
  sanitizeUpdateJson,
  sanitizeUpdateMetaJson,
  validateSchema,
} from '../../core/schema.js';
import { readStripped, type RunContext } from '../../core/run-context.js';

const ONE_SHOT_OUTPUT_MODE =
  'Return ONLY JSON conforming to the schema. No prose, no markdown fences.\n' +
  '\n' +
  'Return the full revised plan in plan_markdown plus issue verdict metadata in the same object.\n' +
  'Apply every critique issue you judge valid with final severity blocker or major. Apply minor and nit issues only when they add clear value. Preserve the plan as a readable implementation document; keep revision bookkeeping out of the markdown. Normalize the revised plan to the Plan Document Contract from the plan-creator skill, and keep the final ## Impact Graph section accurate.';

const SPLIT_PLAN_OUTPUT_MODE =
  'Return the full revised plan as clean Markdown only. Do not return JSON. Do not wrap the whole answer in a markdown fence.\n' +
  '\n' +
  'Apply every critique issue you judge valid with final severity blocker or major. Apply minor and nit issues only when they add clear value. Preserve the plan as a readable implementation document; keep revision bookkeeping out of the markdown. Normalize the revised plan to the Plan Document Contract from the plan-creator skill, and keep the final ## Impact Graph section accurate.';

const SPLIT_META_OUTPUT_MODE =
  'Return ONLY JSON conforming to the schema. No prose, no markdown fences.\n' +
  '\n' +
  'The revised plan has already been written as markdown. Your job here is only bookkeeping:\n' +
  '- give each original critique issue a verdict;\n' +
  '- mark accepted or downgraded issues as applied only when the revised plan actually addresses them;\n' +
  '- put only self-rejected minor/nit accepted items in rejected_append;\n' +
  '- do not include plan_markdown or any other markdown content in this JSON.';

function jqRawRender(value: JsonValue | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value ?? null, null, 2);
}

function creatorUpdatePrompt(
  ctx: RunContext,
  planBlock: string,
  critiqueFile: string,
  outputMode: string,
): string {
  const interventions = operatorInterventionsContext(ctx.work, 'creator');
  const interventionsBlock = interventions !== '' ? `\n${interventions}` : '';
  const rejected = readStripped(path.join(ctx.work, 'rejected-log.jsonl'));
  return (
    `${planBlock}\n` +
    `${interventionsBlock}\n` +
    '\n' +
    `## Critique\n${readStripped(critiqueFile)}\n` +
    '\n' +
    `## Rejected log\n${rejected}\n` +
    '\n' +
    `## Output mode\n${outputMode}`
  );
}

export async function runCreatorCreate(
  ctx: RunContext,
  promptFile: string,
  outFile: string,
): Promise<void> {
  const interventions = operatorInterventionsContext(ctx.work, 'creator');
  const interventionsBlock = interventions !== '' ? `\n${interventions}` : '';
  const prompt =
    `## Prompt\n${readStripped(promptFile)}\n` +
    `${interventionsBlock}\n` +
    '\n' +
    '## Output mode\n' +
    'Return the full implementation plan as clean Markdown only.\n' +
    'Follow the Plan Document Contract from the plan-creator skill.\n' +
    'This is the definitive plan, not a draft for later review to expand: fully specify the in-scope work on this first pass — concrete file lists, the complete importer/consumer set, exact per-phase edits and gates. When the work changes file/directory layout or component topology, render the target as a diagram in ## Target State (a before→after directory tree for file moves), not prose alone.\n' +
    'Include the final required ## Impact Graph section with a Mermaid flowchart.';

  const status = await providerRun(
    ctx.provider,
    'creator',
    'markdown',
    outFile,
    ctx.skills.creatorSkill,
    '',
    ctx.permissions.creator.createTools,
    ctx.permissions.creator.createDisallowedTools,
    prompt,
  );
  if (status !== 0) {
    throw new HaltError(`creator provider call failed (${status})`, status, true);
  }

  if (!nonEmptyFile(outFile)) {
    err('creator produced empty plan from prompt');
    throw new HaltError('creator produced empty plan from prompt', 4, true);
  }
  normalizePlanDocument(outFile);
  validatePlanDocumentShape(outFile);
  requirePlanDocumentShape(outFile);
}

async function runCreatorUpdateOneShot(
  ctx: RunContext,
  iter: number,
  planFile: string,
  critiqueFile: string,
  updateFile: string,
  nextFile: string,
  revisionFile: string,
  metaFile: string,
): Promise<number> {
  const planVersion = iter + 1;
  const planBlock = `## Plan\n${readStripped(planFile)}`;
  const prompt = creatorUpdatePrompt(ctx, planBlock, critiqueFile, ONE_SHOT_OUTPUT_MODE);

  const status = await providerRun(
    ctx.provider,
    'creator',
    'json',
    updateFile,
    ctx.skills.creatorSkill,
    ctx.skills.creatorSchema,
    ctx.permissions.creator.updateTools,
    ctx.permissions.creator.updateDisallowedTools,
    prompt,
  );
  if (status !== 0) {
    return status;
  }

  sanitizeUpdateJson(updateFile, planVersion);
  if (!validateSchema(updateFile, ctx.skills.creatorSchema)) {
    return 3;
  }
  const update = JSON.parse(readFileSync(updateFile, 'utf8')) as JsonValue;
  const planMarkdown = isJsonObject(update) ? update.plan_markdown : null;
  writeFileSync(revisionFile, `${jqRawRender(planMarkdown)}\n`);
  if (!nonEmptyFile(revisionFile)) {
    return 4;
  }
  normalizePlanDocument(revisionFile);
  validatePlanDocumentShape(revisionFile);
  if (!planDocumentShapeOk(revisionFile)) {
    return 4;
  }
  copyFileSync(revisionFile, nextFile);
  const updateObj: JsonObject = isJsonObject(update) ? update : {};
  const meta = {
    plan_version: updateObj.plan_version ?? null,
    issues: updateObj.issues ?? null,
    applied: updateObj.applied ?? null,
    rejected_append: updateObj.rejected_append ?? null,
  };
  writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  sanitizeUpdateMetaJson(metaFile, planVersion);
  if (!validateSchema(metaFile, ctx.skills.creatorMetaSchema)) {
    return 3;
  }
  return 0;
}

async function runCreatorUpdatePlan(
  ctx: RunContext,
  planFile: string,
  critiqueFile: string,
  outFile: string,
): Promise<void> {
  const planBlock = `## Plan\n${readStripped(planFile)}`;
  const prompt = creatorUpdatePrompt(ctx, planBlock, critiqueFile, SPLIT_PLAN_OUTPUT_MODE);
  const status = await providerRun(
    ctx.provider,
    'creator',
    'markdown',
    outFile,
    ctx.skills.creatorSkill,
    '',
    ctx.permissions.creator.updateTools,
    ctx.permissions.creator.updateDisallowedTools,
    prompt,
  );
  if (status !== 0) {
    throw new HaltError(`creator provider call failed (${status})`, status, true);
  }
}

async function runCreatorUpdateMeta(
  ctx: RunContext,
  originalPlan: string,
  revisedPlan: string,
  critiqueFile: string,
  outFile: string,
): Promise<void> {
  const planBlock = `## Original plan\n${readStripped(originalPlan)}\n\n## Revised plan\n${readStripped(revisedPlan)}`;
  const prompt = creatorUpdatePrompt(ctx, planBlock, critiqueFile, SPLIT_META_OUTPUT_MODE);
  const status = await providerRun(
    ctx.provider,
    'creator',
    'json',
    outFile,
    ctx.skills.creatorSkill,
    ctx.skills.creatorMetaSchema,
    ctx.permissions.creator.updateTools,
    ctx.permissions.creator.updateDisallowedTools,
    prompt,
  );
  if (status !== 0) {
    throw new HaltError(`creator provider call failed (${status})`, status, true);
  }
}

export async function runCreatorUpdate(
  ctx: RunContext,
  iter: number,
  planFile: string,
  critiqueFile: string,
  updateFile: string,
  nextFile: string,
): Promise<void> {
  const revisionFile = path.join(ctx.work, `plan.revision.v${iter}.md`);
  const metaFile = path.join(ctx.work, `update-meta.v${iter}.json`);
  const planVersion = iter + 1;

  if (ctx.effort.creatorOneShot === 1) {
    const status = await runCreatorUpdateOneShot(
      ctx,
      iter,
      planFile,
      critiqueFile,
      updateFile,
      nextFile,
      revisionFile,
      metaFile,
    );
    if (status === 0) {
      validatePlanDocumentShape(nextFile);
      requirePlanDocumentShape(nextFile);
      return;
    }
    log('WARNING: one-shot creator update failed; falling back to split update');
    rmSync(revisionFile, { force: true });
    rmSync(metaFile, { force: true });
    rmSync(updateFile, { force: true });
    rmSync(nextFile, { force: true });
  }

  await runCreatorUpdatePlan(ctx, planFile, critiqueFile, revisionFile);
  if (!nonEmptyFile(revisionFile)) {
    err('creator produced empty revised plan');
    throw new HaltError('creator produced empty revised plan', 4, true);
  }
  normalizePlanDocument(revisionFile);

  await runCreatorUpdateMeta(ctx, planFile, revisionFile, critiqueFile, metaFile);
  sanitizeUpdateMetaJson(metaFile, planVersion);
  if (!validateSchema(metaFile, ctx.skills.creatorMetaSchema)) {
    throw new HaltError('update metadata failed schema validation', 3, true);
  }

  combineUpdateJson(metaFile, revisionFile, updateFile);
  sanitizeUpdateJson(updateFile, planVersion);
  if (!validateSchema(updateFile, ctx.skills.creatorSchema)) {
    throw new HaltError('update failed schema validation', 3, true);
  }

  copyFileSync(revisionFile, nextFile);
  validatePlanDocumentShape(nextFile);
  requirePlanDocumentShape(nextFile);
}

export interface ClarifyQuestion {
  id: string;
  question: string;
  why: string;
  options: string[];
}

export async function runCreatorClarify(
  ctx: RunContext,
  promptFile: string,
  outFile: string,
): Promise<number> {
  const localeInstruction = `Write all operator-facing strings in the requested locale: ${ctx.settings.locale}.`;
  const prompt =
    `## Prompt\n${readStripped(promptFile)}\n` +
    '\n' +
    '## Output mode: clarification questions\n' +
    'Return ONLY JSON conforming to the schema. No prose, no markdown fences.\n' +
    `${localeInstruction}\n` +
    'Surface only the blocking questions whose answers would materially change the plan, following the Clarify Mode rules in the plan-creator skill. Resolve everything you can from the repo yourself; return {"questions": []} when nothing is genuinely blocking.';

  const status = await providerRun(
    ctx.provider,
    'creator',
    'json',
    outFile,
    ctx.skills.creatorSkill,
    ctx.skills.clarifySchema,
    ctx.permissions.creator.createTools,
    ctx.permissions.creator.createDisallowedTools,
    prompt,
  );
  if (status !== 0) {
    return status;
  }

  if (!nonEmptyFile(outFile)) {
    err('creator produced no clarification output');
    return 4;
  }
  const parsed = JSON.parse(readFileSync(outFile, 'utf8')) as JsonValue;
  const rawQuestions =
    isJsonObject(parsed) && Array.isArray(parsed.questions) ? parsed.questions : [];
  const questions = rawQuestions.map((value, index) => {
    const obj = isJsonObject(value) ? value : {};
    const why = obj.why;
    const options = Array.isArray(obj.options) ? obj.options : [];
    return {
      id: `Q${index + 1}`,
      question: obj.question ?? null,
      why: why === null || why === undefined || why === false ? '' : why,
      options: options.filter((option) => option !== null && option !== ''),
    };
  });
  writeFileSync(outFile, `${JSON.stringify({ questions }, null, 2)}\n`);
  if (!validateSchema(outFile, ctx.skills.clarifySchema)) {
    return 3;
  }
  return 0;
}
