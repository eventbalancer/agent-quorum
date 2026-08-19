import path from 'node:path';
import { HaltError } from '../../runtime/halt.js';
import { providerRun } from '../../providers/provider.js';
import { readStripped, type RunContext } from '../../core/run-context.js';
import { retainedRolePrompt } from './retained-context.js';

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

export function criticPrompt(planFile: string): string {
  return [
    `## Plan\n${readStripped(planFile)}`,
    'Return ONLY JSON conforming to the schema. No prose, no markdown fences.',
  ].join('\n\n');
}

export async function runCritic(
  ctx: RunContext,
  iter: number,
  planFile: string,
  outFile: string,
): Promise<void> {
  const prompt = retainedRolePrompt({
    ctx,
    role: 'critic',
    stage: 'review',
    planVersion: iter,
    skillFile: ctx.skills.criticSkill,
    schemaFile: ctx.skills.criticSchema,
    basePrompt: criticPrompt(planFile),
  });
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
