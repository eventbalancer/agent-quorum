import { appendFileSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { structuredPatch } from 'diff';
import { fileLineCount } from '../../runtime/files.js';
import { HaltError } from '../../runtime/halt.js';
import { err, log } from '../../runtime/log.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../core/json.js';
import { critiqueHealth } from '../../core/metrics.js';
import { markOperatorInterventionsMigrated } from './interventions.js';
import { runCritic } from './critic.js';
import { runCreatorUpdate } from './creator.js';
import { sanitizeCritiqueJson, validateSchema } from '../../core/schema.js';
import type { RunContext } from '../../core/run-context.js';

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

export interface LoopResult {
  iter: number;
}

export async function runIterationLoop(ctx: RunContext, startIter: number): Promise<LoopResult> {
  const matrix = ctx.provider.matrix;
  let iter = startIter;

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
    const issuesCount = jqLength(isJsonObject(critiqueJson) ? critiqueJson.issues : null);
    log(`  → ${issuesCount} raw issues`);

    const health = critiqueHealth(ctx.work, ctx.skills.criticSchema, iter, critique);
    if (health.total > 0) {
      log(
        `  → addressed=${health.addressed} new=${health.newIssues} invalid=${health.invalid} (${health.pct}% valid-addressed)`,
      );
      if (health.invalid > 0) {
        log(`WARNING: critic returned ${health.invalid} invalid address reference(s)`);
      }
      if (health.pct < 30 && iter >= 2) {
        log('WARNING: critic is mostly finding new issues, not refining — possible drift');
      }
    }

    if (issuesCount === 0) {
      log(`converged at v${iter} (critic returned no issues)`);
      copyFileSync(plan, path.join(ctx.work, 'plan.final.md'));
      break;
    }

    log(`iter=${iter} — creator update (${matrix.creator.runner} ${matrix.creator.model})`);
    await runCreatorUpdate(ctx, iter, plan, critique, update, next);
    markOperatorInterventionsMigrated(ctx.work, 'creator', `plan.v${iter + 1}.md`);

    const updateJson = readJson(update);
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

    const rejectedEntries =
      isJsonObject(updateJson) && Array.isArray(updateJson.rejected_append)
        ? updateJson.rejected_append
        : [];
    let rejectedAppend = '';
    for (const entry of rejectedEntries) {
      const obj = isJsonObject(entry) ? entry : {};
      rejectedAppend += `${JSON.stringify({
        iter,
        id: obj.id ?? null,
        claim: obj.claim ?? null,
        reason: obj.reason ?? null,
      })}\n`;
    }
    if (rejectedAppend !== '') {
      appendFileSync(path.join(ctx.work, 'rejected-log.jsonl'), rejectedAppend);
    }

    if (blockers === 0 && majors === 0) {
      log(`converged at v${iter + 1} (no accepted blockers/majors)`);
      copyFileSync(next, path.join(ctx.work, 'plan.final.md'));
      iter += 1;
      break;
    }

    const changed = changedLineCount(plan, next);
    log(`  → diff_lines=${changed}`);
    if (changed < ctx.settings.diffThreshold) {
      log(`stable-diff at v${iter + 1} (revision <${ctx.settings.diffThreshold} lines)`);
      copyFileSync(next, path.join(ctx.work, 'plan.final.md'));
      iter += 1;
      break;
    }

    iter += 1;
  }

  if (!existsSync(path.join(ctx.work, 'plan.final.md'))) {
    log(`hit MAX_ITERS=${ctx.settings.maxIters} without convergence — using last revision`);
    copyFileSync(path.join(ctx.work, `plan.v${iter}.md`), path.join(ctx.work, 'plan.final.md'));
  }

  return { iter };
}
