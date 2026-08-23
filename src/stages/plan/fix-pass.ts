import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  admitFixReviewer,
  ReadinessAdmissionError,
  type AdmittedFixReviewer,
} from '../../core/readiness-admission.js';
import { sha256 } from '../../core/digest.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../core/json.js';
import {
  createOccurrenceSourceBinding,
  type OccurrenceSourceBinding,
  type ReadinessProofState,
  type RequiredOccurrenceSourceRequirement,
} from '../../core/readiness-proof.js';
import { validateSchema } from '../../core/schema.js';
import { providerRun } from '../../providers/provider.js';
import type { ProviderRuntime } from '../../providers/runtime.js';
import { fileLineCount, nonEmptyFile } from '../../runtime/files.js';
import { HaltError } from '../../runtime/halt.js';
import { err, log } from '../../runtime/log.js';
import { markOperatorInterventionsMigrated } from './interventions.js';
import {
  normalizePlanDocument,
  normalizeRepositoryFileLineReferences,
  requirePlanDocumentShape,
  validatePlanDocumentShape,
} from './plan-shape.js';
import { readStripped, type RunContext } from '../../core/run-context.js';
import { retainedRolePrompt, synchronizeRetainedInterventions } from './retained-context.js';
import { validateFinalPlan, type FindingsCounts } from './validate-plan.js';
import {
  admissionFailureLogLabel,
  candidateEvidenceAnchorPrompt,
  readinessAdmissionRepairPrompt,
  structuredOutputRepairPrompt,
} from './evidence-anchors.js';

const FIX_REVIEW_REQUIRED_REASON = 'fix-pass-replacement-retained';

export type FixPassExemptionReason =
  | 'disabled'
  | 'no-findings'
  | 'proposal-failed'
  | 'review-failed'
  | 'replacement-rejected'
  | 'pre-fix-restored';

export interface RetainedFixPassCandidate {
  readonly kind: 'fix-proposal' | 'fix-applied';
  readonly planVersion: number;
  readonly path: string;
  readonly contentDigest: string;
}

export type FixPassOutcome =
  | {
      readonly retainedReplacement: false;
      readonly requirement: {
        readonly required: false;
        readonly reason: FixPassExemptionReason;
      };
    }
  | {
      readonly retainedReplacement: true;
      readonly candidate: RetainedFixPassCandidate;
      readonly requirement: RequiredOccurrenceSourceRequirement;
      readonly review: AdmittedFixReviewer;
    };

interface CandidateReviewInput {
  readonly ctx: RunContext;
  readonly runtime: ProviderRuntime;
  readonly candidateFile: string;
  readonly candidateKind: RetainedFixPassCandidate['kind'];
  readonly outputFile: string;
  readonly basePrompt: string;
}

interface AdmittedCandidateReview {
  readonly binding: OccurrenceSourceBinding;
  readonly contentDigest: string;
  readonly review: AdmittedFixReviewer;
}

export function exemptFixPass(reason: FixPassExemptionReason): FixPassOutcome {
  return { retainedReplacement: false, requirement: { required: false, reason } };
}

export function fixReviewCandidateContent(file: string): string {
  return readFileSync(file, 'utf8').replace(
    /^status:[ \t]+(?:clean|needs-review|blocked)[ \t]*\r?$/m,
    'status: <orchestration-projection>',
  );
}

export function fixReviewCandidateDigest(file: string): string {
  return sha256(fixReviewCandidateContent(file));
}

function fixPassAcceptPlanCandidate(
  candidate: string,
  label: string,
  projectRoot: string,
): boolean {
  normalizePlanDocument(candidate);
  normalizeRepositoryFileLineReferences(candidate, projectRoot);
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

async function reviewCandidate(
  input: CandidateReviewInput,
): Promise<AdmittedCandidateReview | undefined> {
  const readinessProof = synchronizeRetainedInterventions(input.ctx);
  const candidateContent = fixReviewCandidateContent(input.candidateFile);
  const contentDigest = sha256(candidateContent);
  const binding = createOccurrenceSourceBinding(readinessProof, {
    source: 'fix-reviewer',
    candidateKind: input.candidateKind,
    contentDigest,
  });
  const evidenceAnchors = candidateEvidenceAnchorPrompt(input.candidateFile, candidateContent);
  const prompt = retainedRolePrompt({
    ctx: input.ctx,
    role: 'reviewer',
    stage: binding.lineage.evaluationStage,
    planVersion: readinessProof.planVersion,
    skillFile: input.ctx.skills.reviewerSkill,
    schemaFile: input.ctx.skills.reviewerSchema,
    basePrompt:
      `## Trusted review binding\n` +
      `candidate_kind: ${input.candidateKind}\n` +
      `candidate_content_digest: ${contentDigest}\n\n` +
      `${evidenceAnchors}\n\n` +
      input.basePrompt,
    lineageDigest: binding.lineage.lineageDigest,
    persistVersionedState: false,
  });
  let admitted: AdmittedFixReviewer | undefined;
  const status = await providerRun(
    input.runtime,
    'reviewer',
    'json',
    input.outputFile,
    input.ctx.skills.reviewerSkill,
    input.ctx.skills.reviewerSchema,
    input.ctx.permissions.reviewer.tools,
    input.ctx.permissions.reviewer.disallowedTools,
    prompt,
    {
      validateOutput: (outputFile) => {
        if (
          !nonEmptyFile(outputFile) ||
          !validateSchema(outputFile, input.ctx.skills.reviewerSchema)
        ) {
          admitted = undefined;
          return {
            valid: false,
            retryPrompt: structuredOutputRepairPrompt('fix-reviewer'),
          };
        }
        try {
          const parsed = JSON.parse(readFileSync(outputFile, 'utf8')) as JsonValue;
          admitted = admitFixReviewer({
            value: parsed,
            catalog: readinessProof.catalog,
            binding,
            evidenceContext: {
              work: input.ctx.work,
              projectRoot: input.ctx.provider.projectRoot,
              planVersion: readinessProof.planVersion,
              candidateContent,
              candidatePath: input.candidateFile,
            },
            requirementReason: FIX_REVIEW_REQUIRED_REASON,
          });
          return true;
        } catch (error) {
          admitted = undefined;
          if (error instanceof ReadinessAdmissionError) {
            log(`WARNING: ${admissionFailureLogLabel('fix-reviewer', error)}`);
            return { valid: false, retryPrompt: readinessAdmissionRepairPrompt(error) };
          }
          return {
            valid: false,
            retryPrompt: structuredOutputRepairPrompt('fix-reviewer'),
          };
        }
      },
    },
  );
  if (status !== 0 || admitted === undefined) {
    return undefined;
  }
  return { binding, contentDigest, review: admitted };
}

function reviewApprovesCandidate(review: AdmittedFixReviewer): boolean {
  return review.approval !== 'reject' && review.satisfied;
}

function retainedFixPassOutcome(
  finalPlan: string,
  candidateKind: RetainedFixPassCandidate['kind'],
  admitted: AdmittedCandidateReview,
  planVersion: number,
): FixPassOutcome {
  if (fixReviewCandidateDigest(finalPlan) !== admitted.contentDigest) {
    throw new TypeError('retained fix-pass candidate does not match its admitted review binding');
  }
  return {
    retainedReplacement: true,
    candidate: {
      kind: candidateKind,
      planVersion,
      path: path.resolve(finalPlan),
      contentDigest: admitted.contentDigest,
    },
    requirement: {
      required: true,
      reason: admitted.review.reason,
      expectedBinding: admitted.binding,
    },
    review: admitted.review,
  };
}

function findingsCounts(findings: JsonObject): FindingsCounts {
  const lengthOf = (value: JsonValue | undefined) => (Array.isArray(value) ? value.length : 0);
  return {
    stale: lengthOf(findings.stale_lines),
    ambiguous: lengthOf(findings.ambiguous),
    unresolved: lengthOf(findings.unresolved),
  };
}

export async function runFixPass(
  ctx: RunContext,
  finalPlan: string,
  readinessProof: ReadinessProofState,
): Promise<FixPassOutcome> {
  if (ctx.readinessProof !== readinessProof) {
    throw new TypeError('fix-pass readiness proof must be the current RunContext proof state');
  }
  const findingsFile = path.join(ctx.work, 'findings.json');
  const runtime = fixPassRuntime(ctx);

  if (!existsSync(findingsFile)) {
    log('fix-pass: no findings.json — skipping');
    return exemptFixPass('no-findings');
  }

  let findings: JsonObject = {};
  try {
    const parsed = JSON.parse(readFileSync(findingsFile, 'utf8')) as JsonValue;
    if (isJsonObject(parsed)) {
      findings = parsed;
    }
  } catch {
    findings = {};
  }
  const counts = findingsCounts(findings);
  const count = counts.stale + counts.ambiguous + counts.unresolved;
  if (count === 0) {
    log('fix-pass: 0 findings — skipping');
    return exemptFixPass('no-findings');
  }
  log(
    `fix-pass: ${count} findings (stale_lines=${counts.stale}, ambiguous=${counts.ambiguous}, unresolved=${counts.unresolved})`,
  );

  const beforeFix = path.join(ctx.work, 'plan.final.before-fix.md');
  copyFileSync(finalPlan, beforeFix);
  const restore = (reason: FixPassExemptionReason): FixPassOutcome => {
    copyFileSync(beforeFix, finalPlan);
    return exemptFixPass(reason);
  };

  const proposalFile = path.join(ctx.work, 'fix-proposal.md');
  log(`fix-pass: step 1 — ${runtime.matrix.fixer.runner} propose (${runtime.matrix.fixer.model})`);
  const proposePrompt = retainedRolePrompt({
    ctx,
    role: 'fixer',
    stage: 'fix-proposal',
    planVersion: readinessProof.planVersion,
    skillFile: ctx.skills.fixerSkill,
    schemaFile: '',
    basePrompt:
      `## Plan\n${readStripped(finalPlan)}\n\n` +
      `## Findings\n${readStripped(findingsFile)}\n\n` +
      '(Propose mode: output the full revised plan as plain markdown. No JSON, no fences.)',
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
    return restore('proposal-failed');
  }
  log(`fix-pass:   → proposal_lines=${fileLineCount(proposalFile)}`);
  if (!fixPassAcceptPlanCandidate(proposalFile, 'proposal output', ctx.provider.projectRoot)) {
    err('fix-pass: keeping pre-fix canonical plan, fix-pass skipped');
    return restore('proposal-failed');
  }

  const proposalReviewFile = path.join(ctx.work, 'fix-review.json');
  log(
    `fix-pass: step 2 — ${runtime.matrix.reviewer.runner} review (${runtime.matrix.reviewer.model} reasoning=${runtime.matrix.reviewer.reasoning})`,
  );
  const proposalReview = await reviewCandidate({
    ctx,
    runtime,
    candidateFile: proposalFile,
    candidateKind: 'fix-proposal',
    outputFile: proposalReviewFile,
    basePrompt:
      `## Original plan\n${readStripped(beforeFix)}\n\n` +
      `## Proposed fix\n${readStripped(proposalFile)}\n\n` +
      `## Findings\n${readStripped(findingsFile)}\n\n` +
      'Return ONLY JSON conforming to the schema. No prose, no markdown fences.',
  });
  if (proposalReview === undefined) {
    err('fix-pass: review failed — keeping pre-fix canonical plan, fix-pass skipped');
    return restore('review-failed');
  }
  log(
    `fix-pass:   → approval=${proposalReview.review.approval} concerns=${proposalReview.review.concerns.length}`,
  );

  if (proposalReview.review.approval === 'accept') {
    if (!reviewApprovesCandidate(proposalReview.review)) {
      err(
        'fix-pass: proposal review did not resolve every active occurrence — replacement rejected',
      );
      return restore('replacement-rejected');
    }
    log('fix-pass: clean accept, using proposal as final plan');
    copyFileSync(proposalFile, finalPlan);
    markOperatorInterventionsMigrated(ctx.work, 'fixer', 'plan.final.md');
    log('fix-pass: re-validation');
    validateFinalPlan(ctx.provider.projectRoot, finalPlan);
    log('fix-pass: done (backup at plan.final.before-fix.md)');
    return retainedFixPassOutcome(
      finalPlan,
      'fix-proposal',
      proposalReview,
      proposalReview.binding.candidate.planVersion,
    );
  }

  log(`fix-pass: step 3 — ${runtime.matrix.fixer.runner} apply (${runtime.matrix.fixer.model})`);
  const applyOut = path.join(ctx.work, 'fix-applied.md');
  const applyPrompt = retainedRolePrompt({
    ctx,
    role: 'fixer',
    stage: 'fix-apply',
    planVersion: readinessProof.planVersion,
    skillFile: ctx.skills.fixerSkill,
    schemaFile: '',
    basePrompt:
      `## Plan\n${readStripped(beforeFix)}\n\n` +
      `## Findings\n${readStripped(findingsFile)}\n\n` +
      `## Proposal\n${readStripped(proposalFile)}\n\n` +
      `## Review\n${readStripped(proposalReviewFile)}\n\n` +
      '(Apply mode: output the full final plan as plain markdown. Incorporate every blocker/major concern from Review; minor/nit only if you agree.)',
    persistVersionedState: false,
  });
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
  if (applyStatus !== 0 || !nonEmptyFile(applyOut)) {
    err(
      `fix-pass: apply failed/timed out (status=${applyStatus}) — keeping pre-fix canonical plan`,
    );
    return restore('replacement-rejected');
  }
  log(`fix-pass:   → applied_lines=${fileLineCount(applyOut)}`);
  if (!fixPassAcceptPlanCandidate(applyOut, 'apply output', ctx.provider.projectRoot)) {
    err('fix-pass: apply output rejected — keeping pre-fix canonical plan');
    return restore('replacement-rejected');
  }

  const appliedReviewFile = path.join(ctx.work, 'fix-applied-review.json');
  log(`fix-pass: step 4 — ${runtime.matrix.reviewer.runner} review exact applied candidate`);
  const appliedReview = await reviewCandidate({
    ctx,
    runtime,
    candidateFile: applyOut,
    candidateKind: 'fix-applied',
    outputFile: appliedReviewFile,
    basePrompt:
      `## Original plan\n${readStripped(beforeFix)}\n\n` +
      `## Applied fix\n${readStripped(applyOut)}\n\n` +
      `## Findings\n${readStripped(findingsFile)}\n\n` +
      `## Proposal review\n${readStripped(proposalReviewFile)}\n\n` +
      'Review the exact applied candidate. Assess every active invariant and occurrence. Return ONLY JSON conforming to the schema.',
  });
  if (appliedReview === undefined) {
    err('fix-pass: exact applied candidate review failed — restoring backup');
    return restore('review-failed');
  }
  if (!reviewApprovesCandidate(appliedReview.review)) {
    err('fix-pass: exact applied candidate was not independently approved — restoring backup');
    return restore('pre-fix-restored');
  }

  copyFileSync(applyOut, finalPlan);
  markOperatorInterventionsMigrated(ctx.work, 'fixer', 'plan.final.md');
  log('fix-pass: re-validation');
  validateFinalPlan(ctx.provider.projectRoot, finalPlan);
  log('fix-pass: done (backup at plan.final.before-fix.md)');
  return retainedFixPassOutcome(
    finalPlan,
    'fix-applied',
    appliedReview,
    appliedReview.binding.candidate.planVersion,
  );
}
