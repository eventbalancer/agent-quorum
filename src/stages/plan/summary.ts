import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { countNewlines } from '../../runtime/files.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../core/json.js';
import { convergenceHealth, critiqueHealth, type CritiqueHealth } from '../../core/metrics.js';
import { operatorInterventionsState } from './interventions.js';
import { PACKAGE_DIR_NAME, SPLIT_DECISION_FILE, type PackageHealth } from './plan-package.js';
import { planDocumentShapeHealth } from './plan-shape.js';
import type { RunContext } from '../../core/run-context.js';
import type { FinalProjection } from '../../types.js';

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

interface RejectedPoolSummary {
  readonly entries: number;
  readonly structured: number;
  readonly malformed: number;
  readonly iterationCount: number;
  readonly unbound: number;
}

function rejectedPoolSummary(file: string): RejectedPoolSummary {
  if (!existsSync(file)) {
    return { entries: 0, structured: 0, malformed: 0, iterationCount: 0, unbound: 0 };
  }
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  const iterations = new Set<number>();
  let structured = 0;
  let unbound = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as JsonValue;
      if (!isJsonObject(entry)) {
        continue;
      }
      structured += 1;
      if (typeof entry.iter === 'number' && Number.isSafeInteger(entry.iter) && entry.iter >= 0) {
        iterations.add(entry.iter);
      } else {
        unbound += 1;
      }
    } catch {
      continue;
    }
  }
  return {
    entries: lines.length,
    structured,
    malformed: lines.length - structured,
    iterationCount: iterations.size,
    unbound,
  };
}

export interface SummaryInput {
  readonly iter: number;
  readonly localizedFinalFile: string;
  readonly finalStale: number;
  readonly finalAmbiguous: number;
  readonly finalUnresolved: number;
  readonly final: FinalProjection;
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
  readonly final?: FinalProjection;
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
  const deliveries = ctx.readinessProof.contextDeliveries.filter(
    (item) => item.planVersion === iteration,
  );
  const mandatoryBytes = deliveries.reduce((sum, item) => sum + item.mandatoryBytes, 0);
  const optionalBytes = deliveries.reduce((sum, item) => sum + item.optionalBytes, 0);
  const planFile = path.join(ctx.work, `plan.v${iteration}.md`);
  const planBytes = existsSync(planFile) ? statSync(planFile).size : 0;
  const planLines = existsSync(planFile) ? countNewlines(readFileSync(planFile, 'utf8')) : 0;
  const omittedCategories = [...new Set(deliveries.flatMap((item) => item.omittedCategories))];
  return `- v${iteration}: critic=${raw}, accepted=${accepted}, applied=${applied}, addressed=${health.addressed}, new=${health.newIssues}, invalid=${health.invalid}, valid_addressed_pct=${health.pct}, lineage=${JSON.stringify(convergence.lineage)}, grounding=${JSON.stringify(convergence.grounding)}, evidence_kinds=${JSON.stringify(convergence.evidenceKinds)}, plan_lines=${planLines}, plan_bytes=${planBytes}, retained_mandatory_bytes=${mandatoryBytes}, retained_optional_bytes=${optionalBytes}, relationship_coverage=${relationshipCoverage(ctx.work, iteration)}, omitted_optional_categories=${omittedCategories.length > 0 ? omittedCategories.join('|') : 'none'}`;
}

export function buildRunReport(ctx: RunContext, iter: number, final?: FinalProjection): RunReport {
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
    ...(final !== undefined ? { final } : {}),
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
  const final = input.final;
  const readiness = final.readiness;
  const coverage = readiness.occurrenceCoverage;
  const judge = final.judge;
  lines.push(
    `- readiness: decision=${readiness.decision}, reason_codes=${readiness.reasonCodes.join(',') || 'none'}, satisfied=${String(readiness.satisfied)}, exhausted_limits=${readiness.exhaustedLimits.join(',') || 'none'}, unresolved_proof=${readiness.unresolvedProofIds.length}, applicable_domains=${readiness.applicableRiskDomains.join(',') || 'none'}, high_risk_domains=${readiness.highRiskDomains.join(',') || 'none'}, opportunities=${readiness.opportunityCount}`,
  );
  lines.push(`- readiness_artifact: \`${readiness.proofArtifactPath}\``);
  lines.push(
    `- canonical_plan: version=${readiness.planVersion}, sha256=${readiness.canonicalPlanSha256}`,
  );
  if (readiness.unresolvedProofIds.length > 0) {
    lines.push(`- unresolved_proof_ids: ${readiness.unresolvedProofIds.join(', ')}`);
  }
  lines.push(
    `- occurrence_coverage: expected=${coverage.expectedOccurrenceIds.length}, resolved=${coverage.resolvedOccurrenceIds.length}, violated=${coverage.violatedOccurrenceIds.length}, unresolved=${coverage.unresolvedOccurrenceIds.length}, disagreement=${coverage.disagreementOccurrenceIds.length}, catalog_exact=${String(coverage.catalogExact)}, sources_current=${String(coverage.sourcesCurrent)}, sources_conclusive=${String(coverage.sourcesConclusive)}, source_consistent=${String(coverage.sourceConsistent)}, proof_satisfied=${String(coverage.proofSatisfied)}, reason_codes=${coverage.reasonCodes.join(',') || 'none'}`,
  );
  lines.push(`- structural_status: ${final.structuralStatus}`);
  if (final.structuralReason !== '') {
    lines.push(`- structural_reason: ${final.structuralReason}`);
  }
  lines.push(
    `- final_judge: required=${String(judge.required)}, allowed=${String(judge.allowed)}, evaluated=${String(judge.evaluated)}, available=${String(judge.available)}, candidate_unchanged=${String(judge.candidateUnchanged)}, verdict=${judge.verdict === null ? 'unavailable' : String(judge.verdict)}`,
  );
  if (judge.metadataPath !== undefined) {
    lines.push(`- final_judge_metadata: \`${judge.metadataPath}\``);
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
  if (final.status === 'clean') {
    lines.push('- FINAL: clean');
  } else {
    lines.push(`- FINAL: ${final.status} — ${final.reasons.join(', ') || 'unspecified'}`);
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
  const rejected = rejectedPoolSummary(rejectedLog);
  lines.push(`## Rejected pool (${rejected.entries} entries)`);
  lines.push(
    `- structured=${rejected.structured}, malformed=${rejected.malformed}, iterations=${rejected.iterationCount}, unbound=${rejected.unbound}`,
  );
  writeFileSync(path.join(ctx.work, 'summary.md'), `${lines.join('\n')}\n`);
}
