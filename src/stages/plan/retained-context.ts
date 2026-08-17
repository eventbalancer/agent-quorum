import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Role } from '../../types.js';
import {
  type ContextDelivery,
  type ContextReduction,
  writeConvergenceState,
} from '../../core/convergence.js';
import { isJsonObject, type JsonValue } from '../../core/json.js';
import { operatorInterventionsContext } from './interventions.js';
import type { RunContext } from '../../core/run-context.js';

const CONTEXT_ESTIMATE_OVERHEAD_BYTES = 512;
const REQUIRED_CRITIC_CONTEXT = [
  'original-scope',
  'authoritative-system-facts',
  'operator-decisions',
  'material-findings',
  'active-invariants',
  'quality-and-limits',
] as const;
const CRITIC_SCOPE_COVERAGE_VOCABULARY = [
  'original-scope',
  'declared-scope',
  'direct-plan-scope',
] as const;

export interface RetainedRoleContext {
  readonly mandatory: string;
  readonly optional: string;
}

export interface RetainedRolePromptInput {
  readonly ctx: RunContext;
  readonly role: Role;
  readonly stage: string;
  readonly planVersion: number;
  readonly skillFile: string;
  readonly schemaFile: string;
  readonly basePrompt: string;
  readonly persistVersionedState?: boolean;
}

function readIfPresent(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8').replace(/\n+$/, '') : '';
}

function migratedInterventions(work: string): string {
  const file = path.join(work, 'operator-intervention-migrations.jsonl');
  const raw = readIfPresent(file);
  if (raw === '') {
    return '- none';
  }
  return raw
    .split('\n')
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        const id = typeof value.intervention_id === 'string' ? value.intervention_id : 'unknown';
        const target = typeof value.target === 'string' ? value.target : 'all';
        const plan = typeof value.plan_ref === 'string' ? value.plan_ref : 'unknown';
        return [`- ${id} target=${target} migrated_to=${plan}`];
      } catch {
        return ['- invalid migration ledger entry'];
      }
    })
    .join('\n');
}

function interventionLedger(work: string): Record<string, unknown>[] {
  const raw = readIfPresent(path.join(work, 'operator-interventions.jsonl'));
  if (raw === '') {
    return [];
  }
  return raw.split('\n').flatMap((line) => {
    try {
      const value = JSON.parse(line) as JsonValue;
      return isJsonObject(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

function migratedInterventionIds(work: string): Set<string> {
  const raw = readIfPresent(path.join(work, 'operator-intervention-migrations.jsonl'));
  if (raw === '') {
    return new Set();
  }
  return new Set(
    raw.split('\n').flatMap((line) => {
      try {
        const value = JSON.parse(line) as JsonValue;
        return isJsonObject(value) && typeof value.intervention_id === 'string'
          ? [value.intervention_id]
          : [];
      } catch {
        return [];
      }
    }),
  );
}

function durableClarificationDecisions(work: string): string {
  const migrated = migratedInterventionIds(work);
  const decisions = interventionLedger(work).filter(
    (entry) =>
      typeof entry.id === 'string' && entry.id.startsWith('op-clarify-') && migrated.has(entry.id),
  );
  if (decisions.length === 0) {
    return '- none migrated; active clarification decisions appear once in active interventions';
  }
  return decisions
    .map((entry) => {
      const id = typeof entry.id === 'string' ? entry.id : 'unknown';
      const message =
        typeof entry.message === 'string' ? entry.message.replaceAll('\n', '\n  ') : '';
      return `- ${id}\n  ${message}`;
    })
    .join('\n');
}

function compactRejectedFindingDispositions(work: string): string {
  const rejected = readIfPresent(path.join(work, 'rejected-log.jsonl'));
  if (rejected === '') {
    return '- none';
  }
  return rejected
    .split('\n')
    .map((line, index) => {
      try {
        const value = JSON.parse(line) as JsonValue;
        if (!isJsonObject(value)) {
          return `- entry-${index + 1}: invalid`;
        }
        const iter = typeof value.iter === 'number' ? `v${value.iter}.` : '';
        const id = typeof value.id === 'string' ? value.id : `entry-${index + 1}`;
        const reason = typeof value.reason === 'string' ? value.reason : 'unavailable';
        const claim = typeof value.claim === 'string' ? `: ${value.claim}` : '';
        return `- ${iter}${id} reason=${reason}${claim}`;
      } catch {
        return `- entry-${index + 1}: invalid`;
      }
    })
    .join('\n');
}

function rejectedFindingDispositions(work: string, mode: 'compact' | 'full'): string {
  const rejected = readIfPresent(path.join(work, 'rejected-log.jsonl'));
  if (rejected === '') {
    return '- none';
  }
  return mode === 'compact' ? compactRejectedFindingDispositions(work) : rejected;
}

function originalScope(ctx: RunContext): string {
  if (ctx.mode === 'prompt') {
    const promptFile = path.join(ctx.work, 'prompt.md');
    return `scope_source: prompt\noriginal_request:\n${readIfPresent(promptFile) || readIfPresent(ctx.inputPath)}`;
  }
  return [
    'scope_source: direct-plan',
    'original_request: unavailable',
    'The direct plan is the declared scope. Do not fabricate an unavailable original request.',
  ].join('\n');
}

function systemFacts(ctx: RunContext): string {
  const system = ctx.systemContext;
  const relationships =
    system.relationships.length === 0
      ? '- none extracted'
      : system.relationships
          .map(
            (edge) =>
              `- ${edge.id} type=${edge.type} producer=${edge.producer} consumer=${edge.consumer} authority=${edge.authorityPath} ordering=${edge.ordering}`,
          )
          .join('\n');
  return [
    `authoritative_digest: ${system.digest}`,
    `cross_repository: ${String(system.crossRepository)}`,
    `declared_scope: ${system.declaredScope.join(', ') || 'unavailable'}`,
    `packages: ${system.facts.packages.join(', ') || 'none'}`,
    `package_exports: ${system.facts.packageExports.join(', ') || 'none'}`,
    `package_scripts: ${system.facts.packageScripts.join(', ') || 'none'}`,
    `images: ${system.facts.images.join(', ') || 'none'}`,
    `workflows: ${system.facts.workflows.join(', ') || 'none'}`,
    `ci_triggers: ${system.facts.ciTriggers.join(', ') || 'none'}`,
    `regions: ${system.facts.regions.join(', ') || 'none'}`,
    `migration_commands: ${system.facts.migrationCommands.join(', ') || 'none'}`,
    `delivery_stages: ${system.facts.deliveryStages.join(', ') || 'none'}`,
    `authorization_boundaries: ${system.facts.authorizationBoundaries.join(', ') || 'none'}`,
    `gates: ${system.facts.gates.join(', ') || 'none'}`,
    'relationships:',
    relationships,
    `limitations: ${system.limitations.join(', ') || 'none'}`,
  ].join('\n');
}

function findingsAndInvariants(ctx: RunContext): string {
  const state = ctx.convergence;
  const findings =
    state.findings.length === 0
      ? '- none'
      : state.findings
          .map(
            (finding) =>
              `- ${finding.id} issue=${finding.issueRef} severity=${finding.severity} scope=${finding.disposition.scope} claim=${finding.claim} rationale=${finding.disposition.rationale || 'unavailable'} evidence_refs=${JSON.stringify(finding.disposition.evidenceRefs ?? [])} superseded_by=${finding.disposition.supersededBy ?? 'none'}`,
          )
          .join('\n');
  const invariants =
    state.invariants.length === 0
      ? '- none'
      : state.invariants
          .map((invariant) => {
            const occurrences = invariant.occurrences
              .map(
                (occurrence) =>
                  `  - ${occurrence.id} dimension=${occurrence.dimension} subject=${occurrence.subject} disposition=${occurrence.disposition} evidence_refs=${JSON.stringify(occurrence.evidenceRefs)}`,
              )
              .join('\n');
            return `- ${invariant.id} status=${invariant.status} last_reviewed_plan_version=${invariant.lastReviewedPlanVersion ?? 'unavailable'}: ${invariant.statement}\n${occurrences}`;
          })
          .join('\n');
  return `material_findings:\n${findings}\nactive_and_resolved_invariants:\n${invariants}`;
}

function priorConclusions(
  ctx: RunContext,
  planVersion: number,
  mode = ctx.quality.previousCritiques,
): string {
  const files: string[] = [];
  for (let version = 0; version < planVersion; version += 1) {
    const critique = path.join(ctx.work, `critique.v${version}.json`);
    const update = path.join(ctx.work, `update.v${version}.json`);
    if (existsSync(critique)) {
      files.push(critique);
    }
    if (existsSync(update)) {
      files.push(update);
    }
  }
  if (files.length === 0) {
    return '- none';
  }
  if (mode === 'compact') {
    return files.map((file) => compactPriorConclusion(file)).join('\n');
  }
  return files
    .map((file) => `#### ${path.basename(file)}\n${fullPriorConclusion(file)}`)
    .join('\n\n');
}

function compactPriorConclusion(file: string): string {
  const name = path.basename(file);
  try {
    const value = JSON.parse(readIfPresent(file)) as JsonValue;
    if (!isJsonObject(value)) {
      return `- ${name}: invalid`;
    }
    const issues = Array.isArray(value.issues) ? value.issues.filter(isJsonObject) : [];
    if (issues.length === 0) {
      return `- ${name}: no issues`;
    }
    return issues
      .map((issue) => {
        const id = typeof issue.id === 'string' ? issue.id : 'unknown';
        const severity =
          typeof issue.final_severity === 'string'
            ? issue.final_severity
            : typeof issue.severity === 'string'
              ? issue.severity
              : 'unknown';
        const conclusion =
          typeof issue.verdict === 'string'
            ? `verdict=${issue.verdict}`
            : `addresses=${typeof issue.addresses === 'string' ? issue.addresses : 'new'}`;
        const claim =
          typeof issue.claim === 'string'
            ? issue.claim
            : typeof issue.verdict_reason === 'string'
              ? issue.verdict_reason
              : '';
        return `- ${name}.${id} [${severity}, ${conclusion}]${claim === '' ? '' : `: ${claim}`}`;
      })
      .join('\n');
  } catch {
    return `- ${name}: invalid`;
  }
}

function fullPriorConclusion(file: string): string {
  const raw = readIfPresent(file);
  if (!path.basename(file).startsWith('update.v')) {
    return raw;
  }
  try {
    const value = JSON.parse(raw) as JsonValue;
    if (!isJsonObject(value)) {
      return raw;
    }
    const metadata = { ...value };
    delete metadata.plan_markdown;
    delete metadata.rejected_append;
    return JSON.stringify(metadata, null, 2);
  } catch {
    return raw;
  }
}

function retainedHistory(ctx: RunContext, planVersion: number, mode: 'compact' | 'full'): string {
  return [
    '## Quality-adjusted retained history',
    'The conclusions below remain disputable. Active material findings and invariants are retained separately in the mandatory block.',
    '### Rejected finding dispositions',
    rejectedFindingDispositions(ctx.work, mode),
    '### Prior disputable role conclusions',
    priorConclusions(ctx, planVersion, mode),
  ].join('\n\n');
}

function skillAndSchemaBytes(skillFile: string, schemaFile: string): number {
  return Buffer.byteLength(readIfPresent(skillFile)) + Buffer.byteLength(readIfPresent(schemaFile));
}

export function buildRetainedRoleContext(
  ctx: RunContext,
  role: Role,
  stage: string,
  planVersion: number,
): RetainedRoleContext {
  const active = operatorInterventionsContext(ctx.work, role);
  const ledger = interventionLedger(ctx.work);
  ctx.convergence.interventionIds = [
    ...new Set(
      ledger
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    ),
  ];
  ctx.convergence.operatorDecisionIds = ctx.convergence.interventionIds.filter((id) =>
    id.startsWith('op-clarify-'),
  );
  const mandatory = [
    '## Mandatory retained run context',
    'This context is evidence, not consensus. Prior role conclusions are disputable claims. Judge every claim independently and preserve conflicting evidence-backed conclusions.',
    `role: ${role}`,
    `stage: ${stage}`,
    `plan_version: ${planVersion}`,
    `quality_promise: ${ctx.convergence.promise}`,
    `required_proof_level: ${ctx.convergence.requiredProofLevel}`,
    `requires_exhaustive_scan: ${String(ctx.convergence.requiresExhaustiveScan)}`,
    `iteration_limit: ${ctx.settings.maxIters}`,
    `issue_budget: ${ctx.convergence.issueBudget.limit}`,
    `exhausted_limits: ${ctx.convergence.exhaustedLimits.join(', ') || 'none'}`,
    '### Critic proof vocabulary',
    `considered_context_required: ${REQUIRED_CRITIC_CONTEXT.join(', ')}`,
    `scope_coverage_required: ${ctx.mode === 'prompt' ? 'original-scope' : 'direct-plan-scope'}`,
    `scope_coverage_vocabulary: ${CRITIC_SCOPE_COVERAGE_VOCABULARY.join(', ')}`,
    '### Original scope',
    originalScope(ctx),
    '### Authoritative system facts',
    systemFacts(ctx),
    '### Operator decisions and interventions',
    active || 'No active interventions.',
    'Durable clarification decisions (operator-authoritative even after migration):',
    durableClarificationDecisions(ctx.work),
    'Migrated interventions (identity retained; body is represented by the referenced plan):',
    migratedInterventions(ctx.work),
    '### Findings and invariants',
    findingsAndInvariants(ctx),
  ].join('\n\n');
  const optional = retainedHistory(ctx, planVersion, ctx.quality.previousCritiques);
  return { mandatory, optional };
}

export function retainedRolePrompt(input: RetainedRolePromptInput): string {
  const retained = buildRetainedRoleContext(input.ctx, input.role, input.stage, input.planVersion);
  const optional = retained.optional;
  const reductions: ContextReduction[] = [];
  const omittedCategories: string[] = [];
  if (input.ctx.quality.previousCritiques === 'compact' && optional !== '') {
    const full = retainedHistory(input.ctx, input.planVersion, 'full');
    const reducedBytes = Buffer.byteLength(full) - Buffer.byteLength(optional);
    if (reducedBytes > 0) {
      reductions.push({
        category: 'resolved-minor-nit-and-rejected-detail',
        bytes: reducedBytes,
      });
    }
  }
  const prompt = [retained.mandatory, optional, input.basePrompt].filter(Boolean).join('\n\n');
  const mandatoryBytes = Buffer.byteLength(retained.mandatory);
  const optionalBytes = Buffer.byteLength(optional);
  const totalInputBytes =
    skillAndSchemaBytes(input.skillFile, input.schemaFile) +
    Buffer.byteLength(prompt) +
    CONTEXT_ESTIMATE_OVERHEAD_BYTES;
  const limit = input.ctx.config.inputLimits[input.role];
  const delivery: ContextDelivery = {
    role: input.role,
    stage: input.stage,
    planVersion: input.planVersion,
    mandatoryBytes,
    optionalBytes,
    totalInputBytes,
    inputTokenLimit: limit.tokens,
    inputLimitSource: limit.source,
    reductions,
    omittedCategories,
  };
  input.ctx.convergence.contextDeliveries.push(delivery);
  if (input.persistVersionedState !== false) {
    writeConvergenceState(input.ctx.work, input.ctx.convergence);
  }
  return prompt;
}
