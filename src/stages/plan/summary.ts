import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { countNewlines } from '../../runtime/files.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../core/json.js';
import { convergenceHealth, critiqueHealth, type CritiqueHealth } from '../../core/metrics.js';
import { operatorInterventionsState } from './interventions.js';
import { PACKAGE_DIR_NAME, SPLIT_DECISION_FILE, type PackageHealth } from './plan-package.js';
import { planDocumentShapeHealth } from './plan-shape.js';
import type { RunContext } from '../../core/run-context.js';
import {
  readinessLabel,
  type ConvergenceReport,
  type FinalReadiness,
  type RunFinalStatus,
} from '../../types.js';
import { convergenceReport, readConvergenceState } from '../../core/convergence.js';

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
  readonly finalFacts: RunReportFinalFacts;
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
  readonly status?: RunFinalStatus;
  readonly reason?: string;
  readonly structuralStatus?: RunFinalStatus;
  readonly structuralReason?: string;
  readonly readiness?: FinalReadiness;
  readonly readinessPath?: string;
  readonly convergence?: ConvergenceReport;
}

export interface RunReportFinalFacts {
  readonly status: RunFinalStatus;
  readonly reason: string;
  readonly structuralStatus: RunFinalStatus;
  readonly structuralReason: string;
  readonly readiness?: FinalReadiness;
  readonly readinessPath?: string;
  readonly convergence?: ConvergenceReport;
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

function relationshipCoverage(work: string, iteration: number): string {
  const systemCheckFile = path.join(work, `system-check.v${iteration}.json`);
  if (!existsSync(systemCheckFile)) {
    return '0/0';
  }
  try {
    const systemCheck = JSON.parse(readFileSync(systemCheckFile, 'utf8')) as JsonValue;
    const relationships =
      isJsonObject(systemCheck) && Array.isArray(systemCheck.relationships)
        ? systemCheck.relationships.filter(isJsonObject)
        : [];
    const covered = relationships.filter(
      (item) => item.disposition === 'covered' || item.disposition === 'not-applicable',
    ).length;
    return `${covered}/${relationships.length}`;
  } catch {
    return 'unavailable';
  }
}

function iterationSummaryLine(ctx: RunContext, iteration: number, critique: string): string {
  const raw = jsonArrayLength(critique, 'issues');
  const update = path.join(ctx.work, `update.v${iteration}.json`);
  const accepted = updateIssueCount(
    update,
    (issue) => issue.verdict === 'accept' || issue.verdict === 'downgrade',
  );
  const applied = jsonArrayLength(update, 'applied');
  const health = critiqueHealth(ctx.work, ctx.skills.criticSchema, iteration, critique);
  const convergence = convergenceHealth(
    ctx.work,
    ctx.skills.criticSchema,
    iteration,
    critique,
    ctx.provider.projectRoot,
  );
  const deliveries = ctx.convergence.contextDeliveries.filter(
    (item) => item.planVersion === iteration,
  );
  const mandatoryBytes = deliveries.reduce((sum, item) => sum + item.mandatoryBytes, 0);
  const optionalBytes = deliveries.reduce((sum, item) => sum + item.optionalBytes, 0);
  const planFile = path.join(ctx.work, `plan.v${iteration}.md`);
  const planBytes = existsSync(planFile) ? statSync(planFile).size : 0;
  const planLines = existsSync(planFile) ? countNewlines(readFileSync(planFile, 'utf8')) : 0;
  const state = readConvergenceState(path.join(ctx.work, `convergence.v${iteration}.json`));
  const activeInvariants = state?.invariants.filter((item) => item.status === 'active').length ?? 0;
  const coveredInvariants =
    state?.invariants.filter((item) => item.status === 'resolved').length ?? 0;
  const unresolvedOccurrences =
    state?.invariants.reduce(
      (count, invariant) =>
        count +
        invariant.occurrences.filter(
          (occurrence) =>
            occurrence.disposition === 'unresolved' || occurrence.disposition === 'violated',
        ).length,
      0,
    ) ?? 0;
  const omittedCategories = [...new Set(deliveries.flatMap((item) => item.omittedCategories))];
  return `- v${iteration}: critic=${raw}, accepted=${accepted}, applied=${applied}, addressed=${health.addressed}, new=${health.newIssues}, invalid=${health.invalid}, valid_addressed_pct=${health.pct}, lineage=${JSON.stringify(convergence.lineage)}, grounding=${JSON.stringify(convergence.grounding)}, evidence_kinds=${JSON.stringify(convergence.evidenceKinds)}, plan_lines=${planLines}, plan_bytes=${planBytes}, retained_mandatory_bytes=${mandatoryBytes}, retained_optional_bytes=${optionalBytes}, issue_budget=${state?.issueBudget.used ?? raw}/${state?.issueBudget.limit ?? 'unknown'}, issue_budget_exhausted=${String(state?.issueBudget.exhausted ?? false)}, invariants_active=${activeInvariants}, invariants_covered=${coveredInvariants}, invariant_occurrences_unresolved=${unresolvedOccurrences}, relationship_coverage=${relationshipCoverage(ctx.work, iteration)}, opportunities=${state?.opportunities.length ?? 0}, decision=${state?.decision ?? 'unavailable'}, reason_codes=${state !== undefined && state.reasonCodes.length > 0 ? state.reasonCodes.join('|') : 'none'}, omitted_optional_categories=${omittedCategories.length > 0 ? omittedCategories.join('|') : 'none'}, continuation_or_stop_reason=${state?.stopReason ?? 'unavailable'}`;
}

export function buildRunReport(
  ctx: RunContext,
  iter: number,
  facts?: RunReportFinalFacts,
): RunReport {
  const finalPlan = path.join(ctx.work, 'plan.final.md');
  const summaryFile = path.join(ctx.work, 'summary.md');
  const packageDir = path.join(ctx.work, PACKAGE_DIR_NAME);
  const splitDecision = readSplitDecision(ctx.work);
  const health = finalHealth(ctx);
  const convergence = convergenceReport(ctx.work, ctx.convergence);
  return {
    workDir: ctx.work,
    iterations: iter,
    ...(existsSync(finalPlan) ? { finalPlanPath: finalPlan } : {}),
    ...(existsSync(summaryFile) ? { summaryPath: summaryFile } : {}),
    ...(health !== undefined ? { health } : {}),
    ...(splitDecision !== undefined ? { splitDecision } : {}),
    ...(existsSync(packageDir) ? { packageDir } : {}),
    ...(facts !== undefined
      ? {
          status: facts.status,
          reason: facts.reason,
          structuralStatus: facts.structuralStatus,
          structuralReason: facts.structuralReason,
          ...(facts.readiness !== undefined ? { readiness: facts.readiness } : {}),
          ...(facts.readinessPath !== undefined ? { readinessPath: facts.readinessPath } : {}),
        }
      : {}),
    convergence,
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
    `- final_plan_shape: missing_required_sections=${shape.missing}, impact_graph_mermaid=${shape.graph}, frontmatter=${shape.frontmatter}`,
  );
  lines.push(
    `- final_references: stale=${input.finalStale}, ambiguous=${input.finalAmbiguous}, unresolved=${input.finalUnresolved}`,
  );
  const facts = input.finalFacts;
  if (facts.convergence !== undefined) {
    lines.push(
      `- convergence: decision=${facts.convergence.decision}, reason_codes=${facts.convergence.reasonCodes.join(',') || 'none'}, promise=${facts.convergence.promise}, satisfied=${String(facts.convergence.satisfied)}, exhausted_limits=${facts.convergence.exhaustedLimits.join(',') || 'none'}, unresolved_coverage=${facts.convergence.unresolvedCoverage.length}, applicable_domains=${facts.convergence.applicableRiskDomains.join(',') || 'none'}, high_risk_domains=${facts.convergence.highRiskDomains.join(',') || 'none'}, opportunities=${facts.convergence.opportunityCount}`,
    );
    lines.push(`- convergence_artifact: \`${facts.convergence.artifactPath}\``);
    lines.push(`- readiness_contract: \`${path.join(ctx.work, 'readiness-contract.json')}\``);
    lines.push(`- opportunities_artifact: \`${path.join(ctx.work, 'opportunities.json')}\``);
    if (facts.convergence.unresolvedCoverage.length > 0) {
      lines.push(
        `- convergence_unresolved_ids: ${facts.convergence.unresolvedCoverage.join(', ')}`,
      );
    }
  }
  lines.push(`- structural_status: ${facts.structuralStatus}`);
  if (facts.structuralReason !== '') {
    lines.push(`- structural_reason: ${facts.structuralReason}`);
  }
  if (facts.readiness !== undefined) {
    lines.push(
      `- final_judge: evaluated=${String(facts.readiness.evaluated)}, readiness=${readinessLabel(facts.readiness.ready)}, plan_sha256=${facts.readiness.planSha256}`,
    );
    if (facts.readinessPath !== undefined) {
      lines.push(`- final_judge_metadata: \`${facts.readinessPath}\``);
    }
  }
  lines.push(`- split_decision: ${input.splitDecision} — ${input.splitRationale}`);
  if (input.packageDir !== undefined) {
    lines.push(`- package_dir: \`${input.packageDir}\``);
    lines.push(
      `- package_documents: index/plan/run/journal/remaining-debt, phases=${input.packagePhaseCount}`,
    );
    if (input.packageHealth !== undefined) {
      const pkgHealth = input.packageHealth;
      lines.push(
        `- package_validation: ${pkgHealth.ok ? 'ok' : 'broken'} (missing_files=${pkgHealth.missingFiles}, missing_headings=${pkgHealth.missingHeadings}, broken_cross_refs=${pkgHealth.brokenCrossRefs}, forbidden_shell=${pkgHealth.forbiddenShell}, system_coverage_missing=${pkgHealth.systemCoverageMissing ?? 0}, references=${pkgHealth.references.stale}/${pkgHealth.references.ambiguous}/${pkgHealth.references.unresolved})`,
      );
    }
  }
  if (facts.status === 'clean') {
    lines.push('- FINAL: clean');
  } else {
    lines.push(`- FINAL: ${facts.status} — ${facts.reason}`);
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
    lines.push(iterationSummaryLine(ctx, i, critique));
  }
  lines.push('');
  const rejectedContent = existsSync(rejectedLog) ? readFileSync(rejectedLog, 'utf8') : '';
  lines.push(`## Rejected pool (${countNewlines(rejectedContent)} entries)`);
  lines.push('```json');

  const head = `${lines.join('\n')}\n`;
  const tail = '```\n';
  writeFileSync(path.join(ctx.work, 'summary.md'), `${head}${rejectedContent}${tail}`);
}
