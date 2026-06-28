import { providerRun } from '../../providers/provider.js';
import { log } from '../../runtime/log.js';
import { isJsonObject, type JsonValue } from '../../core/json.js';
import { validateSchema } from '../../core/schema.js';
import { readStripped, type RunContext } from '../../core/run-context.js';

const NOT_READY: { ready: false; rationale: '' } = { ready: false, rationale: '' };

export function judgePrompt(planFile: string, critiqueFile: string): string {
  return (
    `## Plan\n${readStripped(planFile)}\n\n` +
    `## Critique\n${readStripped(critiqueFile)}\n\n` +
    'Return ONLY JSON conforming to the schema. No prose, no markdown fences.'
  );
}

export async function runJudge(
  ctx: RunContext,
  _iter: number,
  planFile: string,
  critiqueFile: string,
  outFile: string,
): Promise<{ ready: boolean; rationale: string }> {
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
  if (!validateSchema(outFile, ctx.skills.judgeSchema)) {
    log('WARNING: judge output failed schema validation — treating as not ready');
    return NOT_READY;
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(readStripped(outFile)) as JsonValue;
  } catch {
    log('WARNING: judge output is not valid JSON — treating as not ready');
    return NOT_READY;
  }
  if (!isJsonObject(parsed) || typeof parsed.ready !== 'boolean') {
    log('WARNING: judge output missing ready field — treating as not ready');
    return NOT_READY;
  }
  return {
    ready: parsed.ready,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
  };
}
