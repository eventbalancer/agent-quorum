import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isJsonObject, type JsonObject, type JsonValue } from './json.js';
import { critiqueHealth } from './metrics.js';
import { operatorInterventionsState } from './interventions.js';
import { planDocumentShapeHealth } from './plan-shape.js';
import type { RunContext } from './run-context.js';

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

function lineCount(content: string): number {
  let count = 0;
  for (const ch of content) if (ch === '\n') count += 1;
  return count;
}

export interface SummaryInput {
  iter: number;
  finalRuFile: string;
  finalStale: number;
  finalAmbiguous: number;
  finalUnresolved: number;
  finalStatus: string;
  finalReason: string;
}

export function writeSummary(ctx: RunContext, input: SummaryInput): void {
  const lines: string[] = [];
  const rejectedLog = path.join(ctx.work, 'rejected-log.jsonl');
  const finalPlan = path.join(ctx.work, 'plan.final.md');

  lines.push('# plan-loop summary');
  lines.push('');
  lines.push(`- input: \`${ctx.inputPath}\``);
  lines.push(`- mode: ${ctx.mode}`);
  lines.push(`- workdir: \`${ctx.work}\``);
  lines.push(`- iterations: ${input.iter}`);
  lines.push(`- final: \`${finalPlan}\``);
  if (existsSync(input.finalRuFile) && statSync(input.finalRuFile).size > 0) {
    lines.push(`- final_ru: \`${input.finalRuFile}\``);
  }
  lines.push(`- resume_start: ${ctx.resume.startIter}`);
  lines.push(`- archived_stale_artifacts: ${ctx.resume.archivedCount}`);
  if (ctx.resume.archiveDir !== '') {
    lines.push(`- stale_archive: \`${ctx.resume.archiveDir}\``);
  }
  const lastCritique = path.join(ctx.work, `critique.v${ctx.lastCritiqueIter}.json`);
  if (ctx.lastCritiqueIter >= 0 && existsSync(lastCritique)) {
    const health = critiqueHealth(
      ctx.work,
      ctx.skills.criticSchema,
      ctx.lastCritiqueIter,
      lastCritique,
    );
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
  if (input.finalStatus === 'clean') {
    lines.push('- FINAL: clean');
  } else {
    lines.push(`- FINAL: ${input.finalStatus} — ${input.finalReason}`);
  }
  lines.push('');
  if (ctx.mode === 'prompt') {
    lines.push('## v0 (created from prompt)');
    lines.push(`- lines: ${lineCount(readFileSync(path.join(ctx.work, 'plan.v0.md'), 'utf8'))}`);
    lines.push('');
  }
  lines.push('## Per-iteration');
  for (let i = 0; i <= input.iter; i += 1) {
    const critique = path.join(ctx.work, `critique.v${i}.json`);
    if (!existsSync(critique)) continue;
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
  lines.push(`## Rejected pool (${lineCount(rejectedContent)} entries)`);
  lines.push('```json');

  const head = `${lines.join('\n')}\n`;
  const tail = '```\n';
  writeFileSync(path.join(ctx.work, 'summary.md'), `${head}${rejectedContent}${tail}`);
}
