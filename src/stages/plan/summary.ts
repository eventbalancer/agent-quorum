import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { countNewlines } from '../../runtime/files.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../core/json.js';
import { critiqueHealth, type CritiqueHealth } from '../../core/metrics.js';
import { operatorInterventionsState } from './interventions.js';
import { PACKAGE_DIR_NAME, SPLIT_DECISION_FILE, type PackageHealth } from './plan-package.js';
import { planDocumentShapeHealth } from './plan-shape.js';
import type { RunContext } from '../../core/run-context.js';

function jsonArrayLength(file: string, key: string): number {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
    const value = isJsonObject(parsed) ? parsed[key] : null;
    return Array.isArray(value) ? value.length : 0;
  } catch {
    return 0;
  }
}

function updateIssueCount(file: string, predicate: (issue: JsonObject) => boolean): number {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
    const issues = isJsonObject(parsed) && Array.isArray(parsed.issues) ? parsed.issues : [];
    return issues.filter((issue) => isJsonObject(issue) && predicate(issue)).length;
  } catch {
    return 0;
  }
}

export interface SummaryInput {
  readonly iter: number;
  readonly localizedFinalFile: string;
  readonly finalStale: number;
  readonly finalAmbiguous: number;
  readonly finalUnresolved: number;
  readonly finalStatus: string;
  readonly finalReason: string;
  readonly splitDecision: string;
  readonly splitRationale: string;
  readonly packagePhaseCount: number;
  readonly packageDir?: string;
  readonly packageHealth?: PackageHealth;
}

// Shared by writeSummary and buildRunReport so the structured result can
// never drift from the `final_health` line in summary.md.
function finalHealth(ctx: RunContext): CritiqueHealth | undefined {
  const lastCritique = path.join(ctx.work, `critique.v${ctx.lastCritiqueIter}.json`);
  if (ctx.lastCritiqueIter < 0 || !existsSync(lastCritique)) {
    return undefined;
  }
  return critiqueHealth(ctx.work, ctx.skills.criticSchema, ctx.lastCritiqueIter, lastCritique);
}

export interface RunReport {
  readonly workDir: string;
  readonly runId?: string;
  readonly name?: string;
  readonly iterations?: number;
  readonly finalPlanPath?: string;
  readonly summaryPath?: string;
  readonly health?: CritiqueHealth;
  readonly splitDecision?: string;
  readonly packageDir?: string;
}

function readSplitDecision(work: string): string | undefined {
  const file = path.join(work, SPLIT_DECISION_FILE);
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
    const decision = isJsonObject(parsed) ? parsed.decision : undefined;
    return typeof decision === 'string' ? decision : undefined;
  } catch {
    return undefined;
  }
}

export function buildRunReport(ctx: RunContext, iter: number): RunReport {
  const finalPlan = path.join(ctx.work, 'plan.final.md');
  const summaryFile = path.join(ctx.work, 'summary.md');
  const packageDir = path.join(ctx.work, PACKAGE_DIR_NAME);
  const splitDecision = readSplitDecision(ctx.work);
  const health = finalHealth(ctx);
  return {
    workDir: ctx.work,
    iterations: iter,
    ...(existsSync(finalPlan) ? { finalPlanPath: finalPlan } : {}),
    ...(existsSync(summaryFile) ? { summaryPath: summaryFile } : {}),
    ...(health !== undefined ? { health } : {}),
    ...(splitDecision !== undefined ? { splitDecision } : {}),
    ...(existsSync(packageDir) ? { packageDir } : {}),
  };
}

export function writeSummary(ctx: RunContext, input: SummaryInput): void {
  const lines: string[] = [];
  const rejectedLog = path.join(ctx.work, 'rejected-log.jsonl');
  const finalPlan = path.join(ctx.work, 'plan.final.md');

  lines.push('# agent-quorum summary');
  lines.push('');
  lines.push(`- input: \`${ctx.inputPath}\``);
  lines.push(`- mode: ${ctx.mode}`);
  lines.push(`- workdir: \`${ctx.work}\``);
  lines.push(`- iterations: ${input.iter}`);
  lines.push(`- final: \`${finalPlan}\``);
  lines.push(`- locale: ${ctx.settings.locale}`);
  const hasLocalizedFinal =
    ctx.settings.translatePass === 1 &&
    existsSync(input.localizedFinalFile) &&
    statSync(input.localizedFinalFile).size > 0;
  if (hasLocalizedFinal) {
    lines.push(`- final_localized: \`${input.localizedFinalFile}\``);
  }
  lines.push(`- resume_start: ${ctx.resume.startIter}`);
  lines.push(`- archived_stale_artifacts: ${ctx.resume.archivedCount}`);
  if (ctx.resume.archiveDir !== '') {
    lines.push(`- stale_archive: \`${ctx.resume.archiveDir}\``);
  }
  const health = finalHealth(ctx);
  if (health !== undefined) {
    lines.push(
      `- final_health: critic=${health.total}, addressed=${health.addressed}, new=${health.newIssues}, invalid=${health.invalid}, valid_addressed_pct=${health.pct}`,
    );
  }
  const interventions = operatorInterventionsState(ctx.work);
  lines.push(
    `- operator_interventions: total=${interventions.total}, active=${interventions.active}, migrated=${interventions.migrated}`,
  );
  const shape = planDocumentShapeHealth(finalPlan);
  lines.push(
    `- final_plan_shape: missing_required_sections=${shape.missing}, impact_graph_mermaid=${shape.graph}`,
  );
  lines.push(
    `- final_references: stale=${input.finalStale}, ambiguous=${input.finalAmbiguous}, unresolved=${input.finalUnresolved}`,
  );
  lines.push(`- split_decision: ${input.splitDecision} — ${input.splitRationale}`);
  if (input.packageDir !== undefined) {
    lines.push(`- package_dir: \`${input.packageDir}\``);
    lines.push(
      `- package_documents: index/plan/run/journal/remaining-debt, phases=${input.packagePhaseCount}`,
    );
    if (input.packageHealth !== undefined) {
      const pkgHealth = input.packageHealth;
      lines.push(
        `- package_validation: ${pkgHealth.ok ? 'ok' : 'broken'} (missing_files=${pkgHealth.missingFiles}, missing_headings=${pkgHealth.missingHeadings}, broken_cross_refs=${pkgHealth.brokenCrossRefs}, forbidden_shell=${pkgHealth.forbiddenShell}, references=${pkgHealth.references.stale}/${pkgHealth.references.ambiguous}/${pkgHealth.references.unresolved})`,
      );
    }
  }
  if (input.finalStatus === 'clean') {
    lines.push('- FINAL: clean');
  } else {
    lines.push(`- FINAL: ${input.finalStatus} — ${input.finalReason}`);
  }
  lines.push('');
  if (ctx.mode === 'prompt') {
    lines.push('## v0 (created from prompt)');
    lines.push(
      `- lines: ${countNewlines(readFileSync(path.join(ctx.work, 'plan.v0.md'), 'utf8'))}`,
    );
    lines.push('');
  }
  lines.push('## Per-iteration');
  for (let i = 0; i <= input.iter; i += 1) {
    const critique = path.join(ctx.work, `critique.v${i}.json`);
    if (!existsSync(critique)) {
      continue;
    }
    const raw = jsonArrayLength(critique, 'issues');
    const update = path.join(ctx.work, `update.v${i}.json`);
    const acc = updateIssueCount(
      update,
      (issue) => issue.verdict === 'accept' || issue.verdict === 'downgrade',
    );
    const app = jsonArrayLength(update, 'applied');
    const health = critiqueHealth(ctx.work, ctx.skills.criticSchema, i, critique);
    lines.push(
      `- v${i}: critic=${raw}, accepted=${acc}, applied=${app}, addressed=${health.addressed}, new=${health.newIssues}, invalid=${health.invalid}, valid_addressed_pct=${health.pct}`,
    );
  }
  lines.push('');
  const rejectedContent = existsSync(rejectedLog) ? readFileSync(rejectedLog, 'utf8') : '';
  lines.push(`## Rejected pool (${countNewlines(rejectedContent)} entries)`);
  lines.push('```json');

  const head = `${lines.join('\n')}\n`;
  const tail = '```\n';
  writeFileSync(path.join(ctx.work, 'summary.md'), `${head}${rejectedContent}${tail}`);
}
