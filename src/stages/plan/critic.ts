import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { HaltError } from '../../runtime/halt.js';
import { log } from '../../runtime/log.js';
import { providerRun } from '../../providers/provider.js';
import { isJsonObject, type JsonValue } from '../../core/json.js';
import { schemaValidQuiet } from '../../core/schema.js';
import { operatorInterventionsContext } from './interventions.js';
import { readStripped, type RunContext } from '../../core/run-context.js';

export function artifactVersion(file: string, prefix: string, suffix: string): number | undefined {
  let base = path.basename(file);
  if (!base.startsWith(prefix) || !base.endsWith(suffix)) {
    return undefined;
  }
  base = base.slice(prefix.length, base.length - suffix.length);
  if (!/^[0-9]+$/.test(base)) {
    return undefined;
  }
  return Number(base);
}

function jqAlt(value: JsonValue | undefined, fallback: string): string {
  if (value === null || value === undefined || value === false) {
    return fallback;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function compactCritiqueFile(file: string): string {
  const name = path.basename(file);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  const issues = isJsonObject(parsed) && Array.isArray(parsed.issues) ? parsed.issues : [];
  if (issues.length === 0) {
    return `- ${name}: no issues`;
  }
  return issues
    .map((issue) => {
      const obj = isJsonObject(issue) ? issue : {};
      return `- ${name}.${jqAlt(obj.id, 'null')} [${jqAlt(obj.severity, 'null')}, ${jqAlt(obj.category, 'null')}, addresses=${jqAlt(obj.addresses, 'new')}]: ${jqAlt(obj.claim, 'null')}`;
    })
    .join('\n');
}

export function topologyContext(projectRoot: string, topologyMode: string): string {
  const ecosystem = path.join(projectRoot, 'ecosystem.yaml');
  if (!existsSync(ecosystem)) {
    return '';
  }
  if (topologyMode === 'compact') {
    return (
      '## Repo topology summary\n' +
      `Source of truth: ${ecosystem}\n` +
      'Read ecosystem.yaml and affected per-repo CLAUDE.md files before making repo-path, dependency-order, layer, or region-specific claims.'
    );
  }
  return `## Repo topology (ecosystem.yaml)\n${readStripped(ecosystem)}`;
}

function previousCritiquesBlock(ctx: RunContext, iter: number): string {
  let block = '';
  const files = readdirSync(ctx.work)
    .filter((name) => name.startsWith('critique.v') && name.endsWith('.json'))
    .sort()
    .map((name) => path.join(ctx.work, name));
  for (const file of files) {
    const n = artifactVersion(file, 'critique.v', '.json');
    if (n === undefined || n >= iter) {
      continue;
    }
    if (!schemaValidQuiet(file, ctx.skills.criticSchema)) {
      log(`WARNING: skipping invalid previous critique: ${path.basename(file)}`);
      continue;
    }
    if (ctx.effort.previousCritiques === 'compact') {
      block += `### ${path.basename(file)} compact\n${compactCritiqueFile(file)}\n\n`;
    } else {
      block += `### ${path.basename(file)}\n${readStripped(file)}\n\n`;
    }
  }
  return block;
}

export function criticPrompt(ctx: RunContext, iter: number, planFile: string): string {
  const prevCritiques = previousCritiquesBlock(ctx, iter);
  const topology = topologyContext(ctx.provider.projectRoot, ctx.effort.topology);
  const interventions = operatorInterventionsContext(ctx.work, 'critic');

  const interventionsBlock = interventions !== '' ? `\n${interventions}` : '';
  const topologyBlock = topology !== '' ? `\n${topology}` : '';
  const prevBlock =
    prevCritiques !== '' ? `\n## Previous critiques\n${prevCritiques.replace(/\n+$/, '')}` : '';
  const rejected = readStripped(path.join(ctx.work, 'rejected-log.jsonl'));

  return (
    `## Plan\n${readStripped(planFile)}\n` +
    `${interventionsBlock}\n` +
    `${topologyBlock}\n` +
    `${prevBlock}\n` +
    `## Rejected log\n${rejected}\n` +
    '\n' +
    'Return ONLY JSON conforming to the schema. No prose, no markdown fences.'
  );
}

export async function runCritic(
  ctx: RunContext,
  iter: number,
  planFile: string,
  outFile: string,
): Promise<void> {
  const prompt = criticPrompt(ctx, iter, planFile);
  const status = await providerRun(
    ctx.provider,
    'critic',
    'json',
    outFile,
    ctx.skills.criticSkill,
    ctx.skills.criticSchema,
    ctx.permissions.critic.tools,
    ctx.permissions.critic.disallowedTools,
    prompt,
  );
  if (status !== 0) {
    throw new HaltError(`critic provider call failed (${status})`, status, true);
  }
}
