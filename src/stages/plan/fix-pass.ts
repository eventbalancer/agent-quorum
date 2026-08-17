import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { fileLineCount, nonEmptyFile } from '../../runtime/files.js';
import path from 'node:path';
import { HaltError } from '../../runtime/halt.js';
import { err, log } from '../../runtime/log.js';
import { providerRun } from '../../providers/provider.js';
import type { ProviderRuntime } from '../../providers/runtime.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../core/json.js';
import { markOperatorInterventionsMigrated } from './interventions.js';
import {
  normalizePlanDocument,
  requirePlanDocumentShape,
  validatePlanDocumentShape,
} from './plan-shape.js';
import { validateSchema } from '../../core/schema.js';
import { validateFinalPlan } from './validate-plan.js';
import { readStripped, type RunContext } from '../../core/run-context.js';
import { retainedRolePrompt } from './retained-context.js';

function fixPassAcceptPlanCandidate(candidate: string, label: string): boolean {
  normalizePlanDocument(candidate);
  validatePlanDocumentShape(candidate);
  try {
    requirePlanDocumentShape(candidate);
    return true;
  } catch (error) {
    if (!(error instanceof HaltError)) {
      throw error;
    }
  }
  err(`fix-pass: ${label} failed the plan-shape gate`);
  return false;
}

function reviewCoversActiveInvariants(ctx: RunContext, review: JsonObject): boolean {
  if (review.coverage_complete !== true) {
    return false;
  }
  if (
    !Array.isArray(review.unresolved_occurrence_ids) ||
    review.unresolved_occurrence_ids.length > 0
  ) {
    return false;
  }
  const assessments = Array.isArray(review.invariant_assessments)
    ? review.invariant_assessments.filter(isJsonObject)
    : [];
  return ctx.convergence.invariants.every((invariant) => {
    const assessment = assessments.find((entry) => entry.invariant_id === invariant.id);
    return (
      assessment?.satisfied === true &&
      Array.isArray(assessment.unresolved_occurrence_ids) &&
      assessment.unresolved_occurrence_ids.length === 0
    );
  });
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
    streamKnobs: {
      ...ctx.provider.streamKnobs,
      claude: {
        ...ctx.provider.streamKnobs.claude,
        wallTimeoutSeconds: ctx.passes.fixPass.timeoutSeconds,
        semanticTimeoutSeconds: ctx.passes.fixPass.semanticIdleTimeoutSeconds,
      },
    },
  };
}

interface AppliedCandidateReviewInput {
  readonly ctx: RunContext;
  readonly runtime: ProviderRuntime;
  readonly beforeFix: string;
  readonly finalPlan: string;
  readonly findingsFile: string;
  readonly proposalReviewFile: string;
}

async function appliedCandidateIsApproved(input: AppliedCandidateReviewInput): Promise<boolean> {
  const appliedReviewFile = path.join(input.ctx.work, 'fix-applied-review.json');
  const appliedReviewBase =
    `## Original plan\n${readStripped(input.beforeFix)}\n\n` +
    `## Applied fix\n${readStripped(input.finalPlan)}\n\n` +
    `## Findings\n${readStripped(input.findingsFile)}\n\n` +
    `## Proposal review\n${readStripped(input.proposalReviewFile)}\n\n` +
    'Review the exact applied candidate. Assess every active invariant and occurrence. Return ONLY JSON conforming to the schema.';
  const appliedReviewPrompt = retainedRolePrompt({
    ctx: input.ctx,
    role: 'reviewer',
    stage: 'fix-applied-review',
    planVersion: input.ctx.convergence.planVersion,
    skillFile: input.ctx.skills.reviewerSkill,
    schemaFile: input.ctx.skills.reviewerSchema,
    basePrompt: appliedReviewBase,
    persistVersionedState: false,
  });
  log(`fix-pass: step 4 — ${input.runtime.matrix.reviewer.runner} review exact applied candidate`);
  const appliedReviewStatus = await providerRun(
    input.runtime,
    'reviewer',
    'json',
    appliedReviewFile,
    input.ctx.skills.reviewerSkill,
    input.ctx.skills.reviewerSchema,
    input.ctx.permissions.reviewer.tools,
    input.ctx.permissions.reviewer.disallowedTools,
    appliedReviewPrompt,
  );
  if (appliedReviewStatus !== 0 || !nonEmptyFile(appliedReviewFile)) {
    return false;
  }
  if (!validateSchema(appliedReviewFile, input.ctx.skills.reviewerSchema)) {
    return false;
  }
  const parsed = JSON.parse(readFileSync(appliedReviewFile, 'utf8')) as JsonValue;
  const review = isJsonObject(parsed) ? parsed : {};
  const concerns = Array.isArray(review.concerns) ? review.concerns.filter(isJsonObject) : [];
  const hasMaterialConcern = concerns.some(
    (concern) => concern.severity === 'blocker' || concern.severity === 'major',
  );
  return (
    review.approval !== 'reject' &&
    !hasMaterialConcern &&
    reviewCoversActiveInvariants(input.ctx, review)
  );
}

export async function runFixPass(ctx: RunContext, finalPlan: string): Promise<void> {
  const findingsFile = path.join(ctx.work, 'findings.json');
  const runtime = fixPassRuntime(ctx);

  if (!existsSync(findingsFile)) {
    log('fix-pass: no findings.json — skipping');
    return;
  }

  let findings: JsonObject = {};
  try {
    const parsed = JSON.parse(readFileSync(findingsFile, 'utf8')) as JsonValue;
    if (isJsonObject(parsed)) {
      findings = parsed;
    }
  } catch {
    /* unreadable findings behave as zero */
  }
  const lengthOf = (value: JsonValue | undefined) => (Array.isArray(value) ? value.length : 0);
  const staleCount = lengthOf(findings.stale_lines);
  const ambiguousCount = lengthOf(findings.ambiguous);
  const unresolvedCount = lengthOf(findings.unresolved);
  const findingsCount = staleCount + ambiguousCount + unresolvedCount;
  if (findingsCount === 0) {
    log('fix-pass: 0 findings — skipping');
    return;
  }
  log(
    `fix-pass: ${findingsCount} findings (stale_lines=${staleCount}, ambiguous=${ambiguousCount}, unresolved=${unresolvedCount})`,
  );

  const beforeFix = path.join(ctx.work, 'plan.final.before-fix.md');
  copyFileSync(finalPlan, beforeFix);

  const proposalFile = path.join(ctx.work, 'fix-proposal.md');
  log(`fix-pass: step 1 — ${runtime.matrix.fixer.runner} propose (${runtime.matrix.fixer.model})`);
  const proposeBasePrompt =
    `## Plan\n${readStripped(finalPlan)}\n` +
    '\n' +
    `## Findings\n${readStripped(findingsFile)}\n` +
    '\n' +
    '(Propose mode: output the full revised plan as plain markdown. No JSON, no fences.)';
  const proposePrompt = retainedRolePrompt({
    ctx,
    role: 'fixer',
    stage: 'fix-proposal',
    planVersion: ctx.convergence.planVersion,
    skillFile: ctx.skills.fixerSkill,
    schemaFile: '',
    basePrompt: proposeBasePrompt,
    persistVersionedState: false,
  });

  const proposeStatus = await providerRun(
    runtime,
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
      `fix-pass: propose failed/timed out (status=${proposeStatus}) — keeping pre-fix canonical plan, fix-pass skipped`,
    );
    copyFileSync(beforeFix, finalPlan);
    return;
  }
  log(`fix-pass:   → proposal_lines=${fileLineCount(proposalFile)}`);
  if (!fixPassAcceptPlanCandidate(proposalFile, 'proposal output')) {
    err('fix-pass: keeping pre-fix canonical plan, fix-pass skipped');
    copyFileSync(beforeFix, finalPlan);
    return;
  }

  const reviewFile = path.join(ctx.work, 'fix-review.json');
  log(
    `fix-pass: step 2 — ${runtime.matrix.reviewer.runner} review (${runtime.matrix.reviewer.model} reasoning=${runtime.matrix.reviewer.reasoning})`,
  );
  const reviewBasePrompt =
    `## Original plan\n${readStripped(beforeFix)}\n` +
    '\n' +
    `## Proposed fix\n${readStripped(proposalFile)}\n` +
    '\n' +
    `## Findings\n${readStripped(findingsFile)}\n` +
    '\n' +
    'Return ONLY JSON conforming to the schema. No prose, no markdown fences.';
  const reviewPrompt = retainedRolePrompt({
    ctx,
    role: 'reviewer',
    stage: 'fix-proposal-review',
    planVersion: ctx.convergence.planVersion,
    skillFile: ctx.skills.reviewerSkill,
    schemaFile: ctx.skills.reviewerSchema,
    basePrompt: reviewBasePrompt,
    persistVersionedState: false,
  });

  const reviewStatus = await providerRun(
    runtime,
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
      `fix-pass: review failed/timed out (status=${reviewStatus}) — keeping pre-fix canonical plan, fix-pass skipped`,
    );
    copyFileSync(beforeFix, finalPlan);
    return;
  }
  if (!validateSchema(reviewFile, ctx.skills.reviewerSchema)) {
    err(
      'fix-pass: review schema validation failed — keeping pre-fix canonical plan, fix-pass skipped',
    );
    copyFileSync(beforeFix, finalPlan);
    return;
  }

  const review = JSON.parse(readFileSync(reviewFile, 'utf8')) as JsonValue;
  const reviewObj: JsonObject = isJsonObject(review) ? review : {};
  const approvalValue = reviewObj.approval;
  const approval =
    typeof approvalValue === 'string' ? approvalValue : JSON.stringify(approvalValue ?? null);
  const concerns = Array.isArray(reviewObj.concerns) ? reviewObj.concerns : [];
  const concernCount = concerns.length;
  const severityCount = (severity: string) =>
    concerns.filter((concern) => isJsonObject(concern) && concern.severity === severity).length;
  const blockerCount = severityCount('blocker');
  const majorCount = severityCount('major');
  log(
    `fix-pass:   → approval=${approval} concerns=${concernCount} (blocker=${blockerCount} major=${majorCount})`,
  );

  let fixPassReplaced = false;
  let appliedCandidateNeedsReview = false;
  if (approval === 'accept' && concernCount === 0) {
    const invariantCoverageComplete = reviewCoversActiveInvariants(ctx, reviewObj);
    log(
      invariantCoverageComplete
        ? 'fix-pass: clean accept, using proposal as final plan'
        : 'fix-pass: proposal accepted without complete invariant coverage — reviewing exact candidate',
    );
    copyFileSync(proposalFile, finalPlan);
    fixPassReplaced = true;
    appliedCandidateNeedsReview = !invariantCoverageComplete;
  } else {
    log(`fix-pass: step 3 — ${runtime.matrix.fixer.runner} apply (${runtime.matrix.fixer.model})`);
    const applyBasePrompt =
      `## Plan\n${readStripped(beforeFix)}\n` +
      '\n' +
      `## Findings\n${readStripped(findingsFile)}\n` +
      '\n' +
      `## Proposal\n${readStripped(proposalFile)}\n` +
      '\n' +
      `## Review\n${readStripped(reviewFile)}\n` +
      '\n' +
      '(Apply mode: output the full final plan as plain markdown. Incorporate every blocker/major concern from Review; minor/nit only if you agree.)';
    const applyPrompt = retainedRolePrompt({
      ctx,
      role: 'fixer',
      stage: 'fix-apply',
      planVersion: ctx.convergence.planVersion,
      skillFile: ctx.skills.fixerSkill,
      schemaFile: '',
      basePrompt: applyBasePrompt,
      persistVersionedState: false,
    });

    const applyOut = path.join(ctx.work, 'fix-applied.md');
    const applyStatus = await providerRun(
      runtime,
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
      err(
        `fix-pass: apply failed/timed out (status=${applyStatus}) — keeping pre-fix canonical plan`,
      );
      copyFileSync(beforeFix, finalPlan);
      return;
    }
    if (!nonEmptyFile(applyOut)) {
      if (blockerCount === 0 && majorCount === 0) {
        err('fix-pass: empty apply output — using validated proposal as final');
        copyFileSync(proposalFile, finalPlan);
        fixPassReplaced = true;
        appliedCandidateNeedsReview = !reviewCoversActiveInvariants(ctx, reviewObj);
      } else {
        err(
          'fix-pass: empty apply output after blocker/major review — keeping pre-fix canonical plan',
        );
        copyFileSync(beforeFix, finalPlan);
      }
    } else {
      log(`fix-pass:   → applied_lines=${fileLineCount(applyOut)}`);
      if (fixPassAcceptPlanCandidate(applyOut, 'apply output')) {
        copyFileSync(applyOut, finalPlan);
        fixPassReplaced = true;
        appliedCandidateNeedsReview = true;
      } else if (blockerCount === 0 && majorCount === 0) {
        err('fix-pass: apply output rejected — using validated proposal as final');
        copyFileSync(proposalFile, finalPlan);
        fixPassReplaced = true;
        appliedCandidateNeedsReview = !reviewCoversActiveInvariants(ctx, reviewObj);
      } else {
        err(
          'fix-pass: apply output rejected after blocker/major review — keeping pre-fix canonical plan',
        );
        copyFileSync(beforeFix, finalPlan);
      }
    }
  }
  if (fixPassReplaced && appliedCandidateNeedsReview) {
    const accepted = await appliedCandidateIsApproved({
      ctx,
      runtime,
      beforeFix,
      finalPlan,
      findingsFile,
      proposalReviewFile: reviewFile,
    });
    if (!accepted) {
      err('fix-pass: exact applied candidate was not independently approved — restoring backup');
      copyFileSync(beforeFix, finalPlan);
      fixPassReplaced = false;
    }
  }
  if (fixPassReplaced) {
    markOperatorInterventionsMigrated(ctx.work, 'fixer', 'plan.final.md');
  }

  log('fix-pass: re-validation');
  validateFinalPlan(ctx.provider.projectRoot, finalPlan);
  log('fix-pass: done (backup at plan.final.before-fix.md)');
}
