import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HaltError } from '../../runtime/halt.js';
import { providerRun } from '../../providers/provider.js';
import { readStripped, type RunContext } from '../../core/run-context.js';
import { retainedRolePrompt } from './retained-context.js';
import {
  admitCritique,
  ReadinessAdmissionError,
  type AdmitCritiqueInput,
  type AdmittedCritique,
} from '../../core/readiness-admission.js';
import { type JsonValue } from '../../core/json.js';
import { sanitizeCritiqueJson, validateSchema } from '../../core/schema.js';
import { log } from '../../runtime/log.js';
import {
  admissionFailureLogLabel,
  candidateEvidenceAnchorPrompt,
  readinessAdmissionRepairPrompt,
  structuredOutputRepairPrompt,
} from './evidence-anchors.js';

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
  const plan = readStripped(planFile);
  return [
    candidateEvidenceAnchorPrompt(planFile, plan),
    `## Plan\n${plan}`,
    'Return ONLY JSON conforming to the schema. No prose, no markdown fences.',
  ].join('\n\n');
}

interface CriticRequestOptions {
  readonly validateOutput?: (outFile: string) => boolean | { valid: false; retryPrompt: string };
}

async function requestCritic(
  ctx: RunContext,
  iter: number,
  planFile: string,
  outFile: string,
  lineageDigest: string,
  options: CriticRequestOptions = {},
): Promise<number> {
  const prompt = retainedRolePrompt({
    ctx,
    role: 'critic',
    stage: 'review',
    planVersion: iter,
    skillFile: ctx.skills.criticSkill,
    schemaFile: ctx.skills.criticSchema,
    basePrompt: criticPrompt(planFile),
    lineageDigest,
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
    options,
  );
  return status;
}

export async function runCritic(
  ctx: RunContext,
  iter: number,
  planFile: string,
  outFile: string,
  lineageDigest: string,
): Promise<void> {
  const status = await requestCritic(ctx, iter, planFile, outFile, lineageDigest);
  if (status !== 0) {
    throw new HaltError(`critic provider call failed (${status})`, status, true);
  }
}

export type CriticAdmissionInput = Omit<AdmitCritiqueInput, 'value'>;

export async function runAdmittedCritic(
  ctx: RunContext,
  iter: number,
  planFile: string,
  outFile: string,
  lineageDigest: string,
  admissionInput: CriticAdmissionInput,
): Promise<AdmittedCritique> {
  let admitted: AdmittedCritique | undefined;
  const validationState: {
    failure:
      | { readonly kind: 'admission'; readonly error: ReadinessAdmissionError }
      | { readonly kind: 'structural' }
      | undefined;
  } = { failure: undefined };
  const status = await requestCritic(ctx, iter, planFile, outFile, lineageDigest, {
    validateOutput: (candidateFile) => {
      try {
        sanitizeCritiqueJson(candidateFile, iter);
        if (!validateSchema(candidateFile, ctx.skills.criticSchema)) {
          validationState.failure = { kind: 'structural' };
          return {
            valid: false,
            retryPrompt: structuredOutputRepairPrompt('critic'),
          };
        }
        const value = JSON.parse(readFileSync(candidateFile, 'utf8')) as JsonValue;
        admitted = admitCritique({ value, ...admissionInput });
        validationState.failure = undefined;
        return true;
      } catch (error) {
        admitted = undefined;
        if (error instanceof ReadinessAdmissionError) {
          validationState.failure = { kind: 'admission', error };
          log(`WARNING: ${admissionFailureLogLabel('critic', error)}`);
          return { valid: false, retryPrompt: readinessAdmissionRepairPrompt(error) };
        }
        validationState.failure = { kind: 'structural' };
        return {
          valid: false,
          retryPrompt: structuredOutputRepairPrompt('critic'),
        };
      }
    },
  });
  if (status !== 0) {
    const failure = validationState.failure;
    if (failure?.kind === 'admission') {
      throw new HaltError(
        `critic output failed deterministic admission (code=${failure.error.code} path=${failure.error.path})`,
        3,
        true,
      );
    }
    if (failure?.kind === 'structural') {
      throw new HaltError('critique failed schema validation', 3, true);
    }
    throw new HaltError(`critic provider call failed (${status})`, status, true);
  }
  if (admitted === undefined) {
    throw new HaltError('critic output failed deterministic admission', 3, true);
  }
  return admitted;
}
