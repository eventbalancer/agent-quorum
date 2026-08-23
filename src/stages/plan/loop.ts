import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { structuredPatch } from 'diff';
import { fileSha256 } from '../../core/digest.js';
import { fileLineCount } from '../../runtime/files.js';
import { HaltError } from '../../runtime/halt.js';
import { err, log } from '../../runtime/log.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../core/json.js';
import { convergenceHealth, critiqueHealth } from '../../core/metrics.js';
import {
  type AdmittedJudgeRevisionIssue,
  type ExpectedCreatorIssue,
} from '../../core/readiness-admission.js';
import {
  addReadinessLimit,
  bindVersionedPlan,
  createOccurrenceSourceBinding,
  recordAdmittedCreatorUpdate,
  recordAdmittedCritique,
  recordAdmittedJudgeProof,
  recordSystemProof,
  reduceReadinessProofState,
  type OccurrenceSourceBinding,
  type ReadinessProofState,
} from '../../core/readiness-proof.js';
import { writeReadinessProofState } from '../../core/readiness-store.js';
import { markOperatorInterventionsMigrated } from './interventions.js';
import { runAdmittedCritic } from './critic.js';
import { runCreatorUpdate } from './creator.js';
import { runJudge } from './judge.js';
import { synchronizeRetainedInterventions } from './retained-context.js';
import { validateSchema } from '../../core/schema.js';
import type { RunContext } from '../../core/run-context.js';
import { validateSystemCoverage, writeSystemCheck } from '../../core/system-context.js';

function readJson(file: string): JsonValue {
  return JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
}

function issueCount(update: JsonValue, predicate: (issue: JsonObject) => boolean): number {
  const issues = isJsonObject(update) && Array.isArray(update.issues) ? update.issues : [];
  return issues.filter((issue) => isJsonObject(issue) && predicate(issue)).length;
}

function jqLength(value: JsonValue | undefined): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  return 0;
}

// `diff -u old new | grep -c '^[+-][^+-]'`: counts changed lines whose second
// character is not another +/- (so `---`/`+++` headers and bullet-line changes
// like `-- item` are excluded, faithfully to the reference).
function changedLineCount(oldFile: string, newFile: string): number {
  const patch = structuredPatch(
    oldFile,
    newFile,
    readFileSync(oldFile, 'utf8'),
    readFileSync(newFile, 'utf8'),
    '',
    '',
    { context: 3 },
  );
  let count = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (/^[+-][^+-]/.test(line)) {
        count += 1;
      }
    }
  }
  return count;
}

interface MaterialIssueCounts {
  readonly blockers: number;
  readonly majors: number;
}

function openBlockerMajor(critiqueJson: JsonValue): MaterialIssueCounts {
  const issues =
    isJsonObject(critiqueJson) && Array.isArray(critiqueJson.issues) ? critiqueJson.issues : [];
  let blockers = 0;
  let majors = 0;
  for (const issue of issues) {
    if (!isJsonObject(issue)) {
      continue;
    }
    if (issue.severity === 'blocker') {
      blockers += 1;
    }
    if (issue.severity === 'major') {
      majors += 1;
    }
  }
  return { blockers, majors };
}

function appendJudgeRevisionIssue(
  critiqueFile: string,
  critiqueJson: JsonValue,
  issue: AdmittedJudgeRevisionIssue,
  criticSchema: string,
): { readonly expectedIssue: ExpectedCreatorIssue } {
  const critique = isJsonObject(critiqueJson) ? critiqueJson : {};
  const issues = Array.isArray(critique.issues) ? critique.issues.filter(isJsonObject) : [];
  const nextNumber =
    issues.reduce((max, candidate) => {
      const match = /^C([0-9]+)$/.exec(typeof candidate.id === 'string' ? candidate.id : '');
      return match === null ? max : Math.max(max, Number(match[1]));
    }, 0) + 1;
  const review = isJsonObject(critique.review) ? critique.review : {};
  const budget = isJsonObject(review.issue_budget) ? review.issue_budget : {};
  const used = issues.length + 1;
  const limit = typeof budget.limit === 'number' ? budget.limit : used;
  const summary =
    `${typeof critique.summary === 'string' ? critique.summary : ''} Intermediate Judge requested one material revision.`
      .trim()
      .slice(0, 700);
  const augmented: JsonObject = {
    ...critique,
    summary,
    issues: [
      ...issues,
      {
        id: `C${nextNumber}`,
        addresses: null,
        severity: issue.severity,
        category: issue.category,
        claim: issue.claim,
        evidence: issue.evidence,
        evidence_refs: [...issue.evidenceRefs],
        invariant_id: null,
        introduced_by_revision: null,
        suggested_fix: issue.suggestedFix,
        confidence: 1,
        duplicate_of: null,
      },
    ],
    review: {
      ...review,
      issue_budget: {
        ...budget,
        limit,
        used,
        exhausted: budget.exhausted === true || used > limit,
      },
    },
  };
  writeFileSync(critiqueFile, `${JSON.stringify(augmented, null, 2)}\n`);
  if (!validateSchema(critiqueFile, criticSchema)) {
    throw new HaltError('Judge revision issue failed critique schema validation', 3, true);
  }
  return {
    expectedIssue: {
      id: `C${nextNumber}`,
      severity: issue.severity,
      claim: issue.claim,
      evidence: issue.evidence,
      suggestedFix: issue.suggestedFix,
      provenance: 'intermediate-judge',
    },
  };
}

function hasApplicableHighRisk(state: ReadinessProofState): boolean {
  return state.riskDomains.some(
    (domain) => domain.applicability === 'applicable' && domain.risk === 'high',
  );
}

function requiresSystemCoverage(state: ReadinessProofState): boolean {
  return state.riskDomains.some(
    (domain) =>
      domain.domain === 'cross-repository-delivery' && domain.applicability === 'applicable',
  );
}

function persistReadinessProof(ctx: RunContext): void {
  ctx.readinessProof = reduceReadinessProofState(ctx.readinessProof);
  writeReadinessProofState(
    path.join(ctx.work, `convergence.v${ctx.readinessProof.planVersion}.json`),
    ctx.readinessProof,
  );
}

interface BoundVersionedPlan {
  readonly planSha256: string;
  readonly critic: OccurrenceSourceBinding;
  readonly intermediateJudge?: OccurrenceSourceBinding;
}

function bindPlanForReview(
  ctx: RunContext,
  planFile: string,
  planVersion: number,
): BoundVersionedPlan {
  if (ctx.readinessProof.planVersion !== planVersion) {
    throw new TypeError(
      `readiness proof plan version ${ctx.readinessProof.planVersion} does not match v${planVersion}`,
    );
  }
  ctx.readinessProof = synchronizeRetainedInterventions(ctx);
  const planSha256 = fileSha256(planFile);
  const critic = createOccurrenceSourceBinding(ctx.readinessProof, {
    source: 'critic',
    candidateKind: 'versioned-plan',
    contentDigest: planSha256,
  });
  const intermediateJudge = hasApplicableHighRisk(ctx.readinessProof)
    ? createOccurrenceSourceBinding(ctx.readinessProof, {
        source: 'intermediate-judge',
        candidateKind: 'versioned-plan',
        contentDigest: planSha256,
      })
    : undefined;
  ctx.readinessProof = bindVersionedPlan(ctx.readinessProof, {
    planVersion,
    planSha256,
    criticLineageDigest: critic.lineage.lineageDigest,
    ...(intermediateJudge === undefined
      ? {}
      : { intermediateJudgeLineageDigest: intermediateJudge.lineage.lineageDigest }),
  });
  persistReadinessProof(ctx);
  return {
    planSha256,
    critic,
    ...(intermediateJudge === undefined ? {} : { intermediateJudge }),
  };
}

const UNANCHORED_WARN_RATIO = 0.5;

function logCritiqueHealth(ctx: RunContext, iteration: number, critiqueFile: string): void {
  const health = critiqueHealth(ctx.work, ctx.skills.criticSchema, iteration, critiqueFile);
  const convergence = convergenceHealth(
    ctx.work,
    ctx.skills.criticSchema,
    iteration,
    critiqueFile,
    ctx.provider.projectRoot,
  );
  log(
    `  → lineage=${JSON.stringify(convergence.lineage)} grounding=${JSON.stringify(convergence.grounding)}`,
  );
  if (health.total === 0) {
    return;
  }
  log(
    `  → addressed=${health.addressed} new=${health.newIssues} invalid=${health.invalid} unanchored=${health.unanchored} (${health.pct}% valid-addressed)`,
  );
  if (health.invalid > 0) {
    log(`WARNING: critic returned ${health.invalid} invalid address reference(s)`);
  }
  if (health.pct < 30 && iteration >= 2) {
    log('WARNING: critic is mostly finding new issues, not refining — possible drift');
  }
  if (health.unanchored > 0 && health.unanchored / health.total >= UNANCHORED_WARN_RATIO) {
    log(
      `WARNING: ${health.unanchored}/${health.total} issues lack file:line or section-anchor evidence — possible evidence drift`,
    );
  }
}

function appendRejectedEntries(work: string, iteration: number, updateJson: JsonValue): void {
  const entries =
    isJsonObject(updateJson) && Array.isArray(updateJson.rejected_append)
      ? updateJson.rejected_append
      : [];
  const content = entries
    .map((entry) => {
      const object = isJsonObject(entry) ? entry : {};
      return `${JSON.stringify({
        iter: iteration,
        id: object.id ?? null,
        claim: object.claim ?? null,
        reason: object.reason ?? null,
      })}\n`;
    })
    .join('');
  if (content !== '') {
    appendFileSync(path.join(work, 'rejected-log.jsonl'), content);
  }
}

export interface LoopResult {
  readonly iter: number;
  readonly converged: boolean;
}

export async function runIterationLoop(ctx: RunContext, startIter: number): Promise<LoopResult> {
  const matrix = ctx.provider.matrix;
  let iter = startIter;

  ctx.readinessProof = reduceReadinessProofState(ctx.readinessProof);
  const initialDecision = ctx.readinessProof.reduction;
  if (
    ctx.readinessProof.readinessContractDigest !== undefined &&
    (initialDecision.decision === 'limits-exhausted' ||
      (initialDecision.decision === 'unable-to-decide' &&
        initialDecision.reasonCodes.some((reason) =>
          [
            'boundary-challenge',
            'material-question-unresolved',
            'risk-applicability-unresolved',
            'required-evidence-unavailable',
          ].includes(reason),
        )))
  ) {
    const plan = path.join(ctx.work, `plan.v${iter}.md`);
    bindPlanForReview(ctx, plan, iter);
    copyFileSync(plan, path.join(ctx.work, 'plan.final.md'));
    persistReadinessProof(ctx);
    return { iter, converged: false };
  }

  while (iter < ctx.settings.maxIters) {
    const plan = path.join(ctx.work, `plan.v${iter}.md`);
    const critique = path.join(ctx.work, `critique.v${iter}.json`);
    const update = path.join(ctx.work, `update.v${iter}.json`);
    const next = path.join(ctx.work, `plan.v${iter + 1}.md`);

    log(
      `iter=${iter} — critic (${matrix.critic.runner} ${matrix.critic.model} reasoning=${matrix.critic.reasoning})`,
    );
    const bindings = bindPlanForReview(ctx, plan, iter);
    const admittedCritique = await runAdmittedCritic(
      ctx,
      iter,
      plan,
      critique,
      bindings.critic.lineage.lineageDigest,
      {
        catalog: ctx.readinessProof.catalog,
        binding: bindings.critic,
        evidenceContext: {
          work: ctx.work,
          projectRoot: ctx.provider.projectRoot,
          planVersion: iter,
          candidateContent: readFileSync(plan, 'utf8'),
          candidatePath: plan,
        },
        expectedScopeToken: ctx.mode === 'prompt' ? 'original-scope' : 'direct-plan-scope',
        issueBudgetLimit: ctx.readinessProof.issueBudget.limit,
        currentRiskDomains: ctx.readinessProof.riskDomains,
        admittedPriorIssueRefs: ctx.readinessProof.admittedCriticIssueRefs.filter(
          (issueRef) => !issueRef.startsWith(`v${iter}.`),
        ),
      },
    );
    ctx.lastCritiqueIter = iter;
    const critiqueJson = readJson(critique);
    ctx.readinessProof = recordAdmittedCritique(ctx.readinessProof, admittedCritique);
    const expectedIssues: ExpectedCreatorIssue[] = admittedCritique.materialIssues.map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      claim: issue.claim,
      evidence: issue.evidence,
      suggestedFix: issue.suggestedFix,
      provenance: 'critic',
    }));

    if (bindings.intermediateJudge === undefined && hasApplicableHighRisk(ctx.readinessProof)) {
      bindPlanForReview(ctx, plan, iter);
    }

    const systemCheck = validateSystemCoverage(ctx.systemContext, plan, iter, {
      required: requiresSystemCoverage(ctx.readinessProof),
      inScope: ctx.readinessBoundary?.inScope ?? ctx.systemContext.declaredScope,
      outOfScope: ctx.readinessBoundary?.outOfScope ?? [],
    });
    ctx.readinessProof = recordSystemProof(ctx.readinessProof, {
      binding: {
        planVersion: iter,
        planSha256: systemCheck.planSha256,
        authoritativeDigest: systemCheck.systemDigest,
      },
      passed: systemCheck.passed,
      mismatchIds: systemCheck.mismatches,
      unavailableEvidenceIds: systemCheck.requiredEvidenceUnavailable,
    });
    writeSystemCheck(ctx.work, systemCheck);
    log(`  → ${admittedCritique.materialIssues.length} issues`);

    logCritiqueHealth(ctx, iter, critique);

    if (hasApplicableHighRisk(ctx.readinessProof) && ctx.readinessProof.judgeAllowed) {
      const { blockers, majors } = openBlockerMajor(critiqueJson);
      if (blockers === 0 && majors === 0) {
        log(
          `iter=${iter} — intermediate judge (${matrix.judge.runner} ${matrix.judge.model} reasoning=${matrix.judge.reasoning})`,
        );
        bindPlanForReview(ctx, plan, iter);
        const judgeFile = path.join(ctx.work, `judge.v${iter}.json`);
        const judged = await runJudge(ctx, ctx.readinessProof, iter, plan, critique, judgeFile);
        const judgeReady = judged.available && judged.candidateUnchanged && judged.admitted.verdict;
        log(`  → intermediate judge ready=${String(judgeReady)}`);
        if (judged.available && judged.candidateUnchanged) {
          ctx.readinessProof = recordAdmittedJudgeProof(ctx.readinessProof, judged.admitted);
          const revisionIssue = judged.admitted.revisionIssue;
          if (revisionIssue !== undefined) {
            const augmented = appendJudgeRevisionIssue(
              critique,
              critiqueJson,
              revisionIssue,
              ctx.skills.criticSchema,
            );
            expectedIssues.push(augmented.expectedIssue);
            log(`  → intermediate judge requested ${revisionIssue.severity} in-boundary revision`);
          }
        }
      } else {
        log(
          `iter=${iter} — intermediate judge skipped (${blockers} blocker / ${majors} major open)`,
        );
      }
    }

    persistReadinessProof(ctx);
    const decision = ctx.readinessProof.reduction.decision;
    if (decision === 'ready') {
      log(`ready at v${iter}`);
      copyFileSync(plan, path.join(ctx.work, 'plan.final.md'));
      break;
    }
    if (decision === 'unable-to-decide' || decision === 'limits-exhausted') {
      log(
        `v${iter} retained with decision=${decision} reasons=${ctx.readinessProof.reduction.reasonCodes.join(',')}`,
      );
      copyFileSync(plan, path.join(ctx.work, 'plan.final.md'));
      break;
    }

    ctx.readinessProof = synchronizeRetainedInterventions(ctx);
    persistReadinessProof(ctx);
    log(`iter=${iter} — creator update (${matrix.creator.runner} ${matrix.creator.model})`);
    const admittedUpdate = await runCreatorUpdate(ctx, iter, plan, critique, update, next, {
      currentCatalog: ctx.readinessProof.catalog,
      fromPlanVersion: iter,
      expectedPlanVersion: iter + 1,
      expectedIssues,
      retainedFindings: ctx.readinessProof.findings,
      retainedInvariants: ctx.readinessProof.invariants,
      operatorInterventionIds: ctx.readinessProof.interventionIds,
      admittedCriticIssueRefs: ctx.readinessProof.admittedCriticIssueRefs,
      admittedJudgeRevisionIssueIds: ctx.readinessProof.intermediateJudgeMaterialIssueIds,
    });
    markOperatorInterventionsMigrated(ctx.work, 'creator', `plan.v${iter + 1}.md`);

    if (!existsSync(next) || statSync(next).size === 0) {
      err('creator produced empty plan');
      throw new HaltError('creator produced empty plan', 4, true);
    }

    const updateJson = readJson(update);
    if (admittedUpdate === undefined) {
      throw new HaltError('creator update bypassed deterministic admission', 3, true);
    }
    ctx.readinessProof = recordAdmittedCreatorUpdate(ctx.readinessProof, admittedUpdate);
    const blockers = issueCount(
      updateJson,
      (issue) =>
        (issue.verdict === 'accept' || issue.verdict === 'downgrade') &&
        issue.final_severity === 'blocker',
    );
    const majors = issueCount(
      updateJson,
      (issue) =>
        (issue.verdict === 'accept' || issue.verdict === 'downgrade') &&
        issue.final_severity === 'major',
    );
    const acceptedTotal = issueCount(
      updateJson,
      (issue) => issue.verdict === 'accept' || issue.verdict === 'downgrade',
    );
    const applied = jqLength(isJsonObject(updateJson) ? updateJson.applied : null);
    const rejectedNow = jqLength(isJsonObject(updateJson) ? updateJson.rejected_append : null);
    log(
      `  → accepted=${acceptedTotal} (blockers=${blockers}, majors=${majors}), applied=${applied}, rejected=${rejectedNow}`,
    );

    const planLines = fileLineCount(next);
    log(`  → plan_lines=${planLines}`);
    const maxPlanLines = ctx.maxPlanLines;
    if (planLines > maxPlanLines) {
      log(`WARNING: plan exceeds ${maxPlanLines} lines (${planLines})`);
    }

    appendRejectedEntries(ctx.work, iter, updateJson);
    bindPlanForReview(ctx, next, iter + 1);

    const changed = changedLineCount(plan, next);
    log(`  → diff_lines=${changed}`);
    if (changed < ctx.settings.diffThreshold) {
      log(`stable-diff telemetry at v${iter + 1} (revision <${ctx.settings.diffThreshold} lines)`);
    }

    iter += 1;
  }

  if (!existsSync(path.join(ctx.work, 'plan.final.md'))) {
    log(`hit MAX_ITERS=${ctx.settings.maxIters} without proof — using last revision`);
    ctx.readinessProof = addReadinessLimit(ctx.readinessProof, {
      limit: 'iteration-cap',
      unresolvedProofId: `plan.v${iter}:not-independently-reviewed`,
    });
    copyFileSync(path.join(ctx.work, `plan.v${iter}.md`), path.join(ctx.work, 'plan.final.md'));
  }

  persistReadinessProof(ctx);

  return { iter, converged: ctx.readinessProof.reduction.satisfied };
}
