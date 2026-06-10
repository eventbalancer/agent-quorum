import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { fileLineCount, nonEmptyFile } from '../runtime/files.js';
import path from 'node:path';
import { HaltError } from '../runtime/halt.js';
import { err, log } from '../runtime/log.js';
import { providerRun } from '../providers/provider.js';
import type { ProviderRuntime } from '../providers/runtime.js';
import { isJsonObject, type JsonObject, type JsonValue } from './json.js';
import {
  markOperatorInterventionsMigrated,
  operatorInterventionsContext,
} from './interventions.js';
import {
  normalizePlanDocument,
  requirePlanDocumentShape,
  validatePlanDocumentShape,
} from './plan-shape.js';
import { validateSchema } from './schema.js';
import { validateFinalPlan } from './validate-plan.js';
import { readStripped, type RunContext } from './run-context.js';

function fixPassAcceptPlanCandidate(candidate: string, label: string): boolean {
  normalizePlanDocument(candidate);
  validatePlanDocumentShape(candidate);
  try {
    requirePlanDocumentShape(candidate);
    return true;
  } catch (error) {
    if (!(error instanceof HaltError)) throw error;
  }
  err(`fix-pass: ${label} failed the plan-shape gate`);
  return false;
}

// The fix pass overrides the claude wall/semantic timeouts and the retry count
// locally, exactly like the reference's scoped variable overrides.
function fixPassRuntime(ctx: RunContext): ProviderRuntime {
  return {
    ...ctx.provider,
    retry: {
      retryCount: ctx.passes.fixPass.retryCount,
      retryDelaySeconds: ctx.provider.retry.retryDelaySeconds,
    },
    claudeKnobs: {
      ...ctx.provider.claudeKnobs,
      wallTimeoutSeconds: ctx.passes.fixPass.timeoutSeconds,
      semanticTimeoutSeconds: ctx.passes.fixPass.semanticIdleTimeoutSeconds,
    },
  };
}

export async function runFixPass(ctx: RunContext, finalPlan: string): Promise<void> {
  const findingsFile = path.join(ctx.work, 'findings.json');
  const rt = fixPassRuntime(ctx);

  if (!existsSync(findingsFile)) {
    log('fix-pass: no findings.json — skipping');
    return;
  }

  let findings: JsonObject = {};
  try {
    const parsed = JSON.parse(readFileSync(findingsFile, 'utf8')) as JsonValue;
    if (isJsonObject(parsed)) findings = parsed;
  } catch {
    /* unreadable findings behave as zero */
  }
  const lengthOf = (value: JsonValue | undefined) => (Array.isArray(value) ? value.length : 0);
  const nStale = lengthOf(findings.stale_lines);
  const nAmb = lengthOf(findings.ambiguous);
  const nUnres = lengthOf(findings.unresolved);
  const total = nStale + nAmb + nUnres;
  if (total === 0) {
    log('fix-pass: 0 findings — skipping');
    return;
  }
  log(
    `fix-pass: ${total} findings (stale_lines=${nStale}, ambiguous=${nAmb}, unresolved=${nUnres})`,
  );

  const beforeFix = path.join(ctx.work, 'plan.final.before-fix.md');
  copyFileSync(finalPlan, beforeFix);

  const proposalFile = path.join(ctx.work, 'fix-proposal.md');
  log(`fix-pass: step 1 — ${rt.matrix.fixer.runner} propose (${rt.matrix.fixer.model})`);
  const fixerInterventions = operatorInterventionsContext(ctx.work, 'fixer');
  const fixerIvBlock = fixerInterventions !== '' ? `\n${fixerInterventions}` : '';
  const proposePrompt =
    `## Plan\n${readStripped(finalPlan)}\n` +
    `${fixerIvBlock}\n` +
    '\n' +
    `## Findings\n${readStripped(findingsFile)}\n` +
    '\n' +
    '(Propose mode: output the full revised plan as plain markdown. No JSON, no fences.)';

  const proposeStatus = await providerRun(
    rt,
    'fixer',
    'markdown',
    proposalFile,
    ctx.skills.fixerSkill,
    '',
    ctx.permissions.fixer.tools,
    ctx.permissions.fixer.disallowedTools,
    proposePrompt,
  );
  if (proposeStatus !== 0 || !nonEmptyFile(proposalFile)) {
    err(
      `fix-pass: propose failed/timed out (status=${proposeStatus}) — keeping converged plan, fix-pass skipped`,
    );
    copyFileSync(beforeFix, finalPlan);
    return;
  }
  log(`fix-pass:   → proposal_lines=${fileLineCount(proposalFile)}`);
  if (!fixPassAcceptPlanCandidate(proposalFile, 'proposal output')) {
    err('fix-pass: keeping converged plan, fix-pass skipped');
    copyFileSync(beforeFix, finalPlan);
    return;
  }

  const reviewFile = path.join(ctx.work, 'fix-review.json');
  log(
    `fix-pass: step 2 — ${rt.matrix.reviewer.runner} review (${rt.matrix.reviewer.model} reasoning=${rt.matrix.reviewer.reasoning})`,
  );
  const reviewerInterventions = operatorInterventionsContext(ctx.work, 'reviewer');
  const reviewerIvBlock = reviewerInterventions !== '' ? `\n${reviewerInterventions}` : '';
  const reviewPrompt =
    `## Original plan\n${readStripped(beforeFix)}\n` +
    '\n' +
    `## Proposed fix\n${readStripped(proposalFile)}\n` +
    `${reviewerIvBlock}\n` +
    '\n' +
    `## Findings\n${readStripped(findingsFile)}\n` +
    '\n' +
    'Return ONLY JSON conforming to the schema. No prose, no markdown fences.';

  const reviewStatus = await providerRun(
    rt,
    'reviewer',
    'json',
    reviewFile,
    ctx.skills.reviewerSkill,
    ctx.skills.reviewerSchema,
    ctx.permissions.reviewer.tools,
    ctx.permissions.reviewer.disallowedTools,
    reviewPrompt,
  );
  if (reviewStatus !== 0 || !nonEmptyFile(reviewFile)) {
    err(
      `fix-pass: review failed/timed out (status=${reviewStatus}) — keeping converged plan, fix-pass skipped`,
    );
    copyFileSync(beforeFix, finalPlan);
    return;
  }
  if (!validateSchema(reviewFile, ctx.skills.reviewerSchema)) {
    err('fix-pass: review schema validation failed — keeping converged plan, fix-pass skipped');
    copyFileSync(beforeFix, finalPlan);
    return;
  }

  const review = JSON.parse(readFileSync(reviewFile, 'utf8')) as JsonValue;
  const reviewObj: JsonObject = isJsonObject(review) ? review : {};
  const approvalValue = reviewObj.approval;
  const approval =
    typeof approvalValue === 'string' ? approvalValue : JSON.stringify(approvalValue ?? null);
  const concerns = Array.isArray(reviewObj.concerns) ? reviewObj.concerns : [];
  const nConcerns = concerns.length;
  const severityCount = (severity: string) =>
    concerns.filter((concern) => isJsonObject(concern) && concern.severity === severity).length;
  const nBlockers = severityCount('blocker');
  const nMajors = severityCount('major');
  log(
    `fix-pass:   → approval=${approval} concerns=${nConcerns} (blocker=${nBlockers} major=${nMajors})`,
  );

  let fixPassReplaced = false;
  if (approval === 'accept' && nConcerns === 0) {
    log('fix-pass: clean accept, using proposal as final plan');
    copyFileSync(proposalFile, finalPlan);
    fixPassReplaced = true;
  } else {
    log(`fix-pass: step 3 — ${rt.matrix.fixer.runner} apply (${rt.matrix.fixer.model})`);
    const applyPrompt =
      `## Plan\n${readStripped(beforeFix)}\n` +
      `${fixerIvBlock}\n` +
      '\n' +
      `## Findings\n${readStripped(findingsFile)}\n` +
      '\n' +
      `## Proposal\n${readStripped(proposalFile)}\n` +
      '\n' +
      `## Review\n${readStripped(reviewFile)}\n` +
      '\n' +
      '(Apply mode: output the full final plan as plain markdown. Incorporate every blocker/major concern from Review; minor/nit only if you agree.)';

    const applyOut = path.join(ctx.work, 'fix-applied.md');
    const applyStatus = await providerRun(
      rt,
      'fixer',
      'markdown',
      applyOut,
      ctx.skills.fixerSkill,
      '',
      ctx.permissions.fixer.tools,
      ctx.permissions.fixer.disallowedTools,
      applyPrompt,
    );
    if (applyStatus !== 0) {
      err(`fix-pass: apply failed/timed out (status=${applyStatus}) — keeping converged plan`);
      copyFileSync(beforeFix, finalPlan);
      return;
    }
    if (!nonEmptyFile(applyOut)) {
      if (nBlockers === 0 && nMajors === 0) {
        err('fix-pass: empty apply output — using validated proposal as final');
        copyFileSync(proposalFile, finalPlan);
        fixPassReplaced = true;
      } else {
        err('fix-pass: empty apply output after blocker/major review — keeping converged plan');
        copyFileSync(beforeFix, finalPlan);
      }
    } else {
      log(`fix-pass:   → applied_lines=${fileLineCount(applyOut)}`);
      if (fixPassAcceptPlanCandidate(applyOut, 'apply output')) {
        copyFileSync(applyOut, finalPlan);
        fixPassReplaced = true;
      } else if (nBlockers === 0 && nMajors === 0) {
        err('fix-pass: apply output rejected — using validated proposal as final');
        copyFileSync(proposalFile, finalPlan);
        fixPassReplaced = true;
      } else {
        err('fix-pass: apply output rejected after blocker/major review — keeping converged plan');
        copyFileSync(beforeFix, finalPlan);
      }
    }
  }
  if (fixPassReplaced) {
    markOperatorInterventionsMigrated(ctx.work, 'fixer', 'plan.final.md');
  }

  log('fix-pass: re-validation');
  validateFinalPlan(ctx.provider.projectRoot, finalPlan);
  log('fix-pass: done (backup at plan.final.before-fix.md)');
}
