import { appendFileSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { structuredPatch } from 'diff';
import { fileLineCount } from '../../runtime/files.js';
import { HaltError } from '../../runtime/halt.js';
import { err, log } from '../../runtime/log.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../core/json.js';
import { convergenceHealth, critiqueDuplicateIsValid, critiqueHealth } from '../../core/metrics.js';
import { markOperatorInterventionsMigrated } from './interventions.js';
import { runCritic } from './critic.js';
import { runCreatorUpdate } from './creator.js';
import { runJudge } from './judge.js';
import { sanitizeCritiqueJson, validateSchema } from '../../core/schema.js';
import type { RunContext } from '../../core/run-context.js';
import {
  addConvergenceLimit,
  classifyTerminal,
  recordCreatorUpdate,
  recordCritique,
  recordSystemCheck,
  requiresReadinessJudge,
  requiresSystemCoverage,
  writeConvergenceState,
} from '../../core/convergence.js';
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

  classifyTerminal(ctx.convergence);
  if (
    ctx.convergence.readinessContractDigest !== undefined &&
    (ctx.convergence.decision === 'limits-exhausted' ||
      (ctx.convergence.decision === 'unable-to-decide' &&
        ctx.convergence.reasonCodes.some((reason) =>
          [
            'boundary-challenge',
            'material-question-unresolved',
            'risk-applicability-unresolved',
            'required-evidence-unavailable',
            'legacy-state-requires-review',
          ].includes(reason),
        )))
  ) {
    copyFileSync(path.join(ctx.work, `plan.v${iter}.md`), path.join(ctx.work, 'plan.final.md'));
    writeConvergenceState(ctx.work, ctx.convergence);
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
    await runCritic(ctx, iter, plan, critique);
    sanitizeCritiqueJson(critique, iter);
    if (!validateSchema(critique, ctx.skills.criticSchema)) {
      throw new HaltError('critique failed schema validation', 3, true);
    }
    ctx.lastCritiqueIter = iter;
    const critiqueJson = readJson(critique);
    recordCritique(ctx.convergence, critiqueJson, iter, {
      work: ctx.work,
      projectRoot: ctx.provider.projectRoot,
    });
    const systemCheck = validateSystemCoverage(ctx.systemContext, plan, iter, {
      required: requiresSystemCoverage(ctx.convergence),
      inScope: ctx.readinessBoundary?.inScope ?? ctx.systemContext.declaredScope,
      outOfScope: ctx.readinessBoundary?.outOfScope ?? [],
    });
    recordSystemCheck(ctx.convergence, systemCheck);
    writeSystemCheck(ctx.work, systemCheck);
    const rawIssues =
      isJsonObject(critiqueJson) && Array.isArray(critiqueJson.issues) ? critiqueJson.issues : [];
    const duplicateCount = rawIssues.filter((issue) =>
      critiqueDuplicateIsValid(issue, ctx.work),
    ).length;
    const issuesCount = rawIssues.length - duplicateCount;
    if (duplicateCount > 0) {
      log(`  → ${issuesCount} actionable issues (${duplicateCount} duplicate)`);
    } else {
      log(`  → ${issuesCount} issues`);
    }

    logCritiqueHealth(ctx, iter, critique);

    if (requiresReadinessJudge(ctx.convergence) && ctx.convergence.judgeAllowed) {
      const { blockers, majors } = openBlockerMajor(critiqueJson);
      if (blockers === 0 && majors === 0) {
        log(
          `iter=${iter} — intermediate judge (${matrix.judge.runner} ${matrix.judge.model} reasoning=${matrix.judge.reasoning})`,
        );
        const judgeFile = path.join(ctx.work, `judge.v${iter}.json`);
        const verdict = await runJudge(ctx, iter, plan, critique, judgeFile);
        log(`  → intermediate judge ready=${verdict.ready}`);
      } else {
        log(
          `iter=${iter} — intermediate judge skipped (${blockers} blocker / ${majors} major open)`,
        );
      }
    }

    classifyTerminal(ctx.convergence);
    writeConvergenceState(ctx.work, ctx.convergence);
    const decision = ctx.convergence.decision;
    if (decision === 'ready') {
      log(`ready at v${iter}`);
      copyFileSync(plan, path.join(ctx.work, 'plan.final.md'));
      break;
    }
    if (decision === 'unable-to-decide' || decision === 'limits-exhausted') {
      log(
        `v${iter} retained with decision=${ctx.convergence.decision} reasons=${ctx.convergence.reasonCodes.join(',')}`,
      );
      copyFileSync(plan, path.join(ctx.work, 'plan.final.md'));
      break;
    }

    log(`iter=${iter} — creator update (${matrix.creator.runner} ${matrix.creator.model})`);
    await runCreatorUpdate(ctx, iter, plan, critique, update, next);
    markOperatorInterventionsMigrated(ctx.work, 'creator', `plan.v${iter + 1}.md`);

    const updateJson = readJson(update);
    recordCreatorUpdate(ctx.convergence, critiqueJson, updateJson, iter, {
      work: ctx.work,
      projectRoot: ctx.provider.projectRoot,
    });
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

    if (!existsSync(next) || statSync(next).size === 0) {
      err('creator produced empty plan');
      throw new HaltError('creator produced empty plan', 4, true);
    }
    const planLines = fileLineCount(next);
    log(`  → plan_lines=${planLines}`);
    const maxPlanLines = ctx.maxPlanLines;
    if (planLines > maxPlanLines) {
      log(`WARNING: plan exceeds ${maxPlanLines} lines (${planLines})`);
    }

    appendRejectedEntries(ctx.work, iter, updateJson);
    writeConvergenceState(ctx.work, ctx.convergence);

    const changed = changedLineCount(plan, next);
    log(`  → diff_lines=${changed}`);
    if (changed < ctx.settings.diffThreshold) {
      log(`stable-diff telemetry at v${iter + 1} (revision <${ctx.settings.diffThreshold} lines)`);
    }

    iter += 1;
  }

  if (!existsSync(path.join(ctx.work, 'plan.final.md'))) {
    log(`hit MAX_ITERS=${ctx.settings.maxIters} without proof — using last revision`);
    addConvergenceLimit(
      ctx.convergence,
      'iteration-cap',
      `plan.v${iter}:not-independently-reviewed`,
    );
    ctx.convergence.stopReason = 'iteration-cap';
    copyFileSync(path.join(ctx.work, `plan.v${iter}.md`), path.join(ctx.work, 'plan.final.md'));
  }

  classifyTerminal(ctx.convergence);
  writeConvergenceState(ctx.work, ctx.convergence);

  return { iter, converged: ctx.convergence.satisfied };
}
