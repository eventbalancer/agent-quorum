import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { HaltError } from '../runtime/halt.js';
import { canonicalJsonSha256 } from './digest.js';
import type {
  FinalProjection,
  Quality,
  ReadinessLimit,
  ReadinessDecision,
  RiskDomain,
  RunFinalStatus,
  RunMode,
} from '../types.js';

export const RUN_RECORD_SCHEMA_VERSION = 1 as const;

export type RunState = 'running' | 'finished' | 'failed' | 'blocked';

export interface RunRecord {
  readonly schemaVersion: typeof RUN_RECORD_SCHEMA_VERSION;
  readonly runId: string;
  readonly name: string;
  readonly pid: number;
  readonly pgid: string;
  readonly procStartToken: string;
  readonly mode: RunMode;
  readonly inputPath: string;
  readonly workDir: string;
  readonly logPath: string;
  readonly plansDir: string;
  readonly startedAt: string;
  readonly quality: Quality;
  readonly state: RunState;
  readonly endedAt?: string;
  readonly exitCode?: number;
  readonly final?: FinalProjection;
}

export type RunRecordDraft = Omit<RunRecord, 'schemaVersion' | 'runId'>;

export type RunRecordPatch = Partial<Pick<RunRecord, 'state' | 'endedAt' | 'exitCode' | 'final'>>;

export interface WriteRunRecordOptions {
  readonly fixedRunId?: string;
}

// Process probes the store depends on for live-state inference. Injected so the
// store never spawns processes and stays unit-testable; the CLI passes the real
// implementations from `runtime/proc.ts`.
export interface RunStateProbes {
  readonly isAlive: (pid: number) => boolean;
  readonly pgidOf: (pid: number) => string | undefined;
  readonly procStartToken: (pid: number) => string | undefined;
}

const RUN_ID_TS_WIDTH = 9;
const RUN_ID_RANDOM_BYTES = 10;
const READINESS_DECISIONS = [
  'ready',
  'revision-required',
  'unable-to-decide',
  'limits-exhausted',
] as const satisfies readonly ReadinessDecision[];
const READINESS_LIMITS = [
  'issue-budget',
  'iteration-cap',
  'assurance-appetite',
] as const satisfies readonly ReadinessLimit[];
const UNABLE_TO_DECIDE_REASONS = [
  'boundary-challenge',
  'material-question-unresolved',
  'risk-applicability-unresolved',
  'required-evidence-unavailable',
  'canonical-plan-binding-mismatch',
  'fresh-review-required',
  'final-artifact-needs-review',
  'judge-inconsistent-after-status-projection',
  'independent-review-required',
  'exhaustive-applicable-scan-incomplete',
  'applicable-domain-scan-incomplete',
  'deterministic-check-incomplete',
  'cross-cutting-invariant-coverage-incomplete',
  'occurrence-source-missing',
  'occurrence-source-catalog-inexact',
  'occurrence-source-stale',
  'occurrence-source-inconsistent',
  'occurrence-source-inconclusive',
  'occurrence-proof-violated',
  'occurrence-proof-unresolved',
  'occurrence-source-disagreement',
  'occurrence-proof-incomplete',
  'judge-unavailable',
  'judge-not-ready',
  'critic-coverage-unresolved',
  'critic-scope-coverage-incomplete',
  'critic-context-incomplete',
  'material-revision-proof-incomplete',
  'proof-incomplete',
] as const;
const REVISION_REQUIRED_REASONS = ['material-issues', 'deterministic-check-failed'] as const;
const STABLE_PROOF_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const STRUCTURAL_REASONS = {
  blocked: [
    /^plan shape broken \(title=[01] missing_sections=[0-9]+ impact_graph_mermaid=[01] frontmatter=[01]\)$/,
    /^plan\.package not emitted: forced split over an empty\/absent Work Plan$/,
    /^plan\.package broken \(missing_files=[0-9]+ missing_headings=[0-9]+ broken_cross_refs=[0-9]+ forbidden_shell=[0-9]+ system_coverage_missing=[0-9]+\)$/,
  ],
  'needs-review': [
    /^[0-9]+ stale line reference\(s\) remain after fix-pass$/,
    /^[0-9]+ ambiguous \+ [0-9]+ unresolved reference\(s\) \(may be generic names or future files\)$/,
    /^plan\.package references need review \(stale=[0-9]+ ambiguous=[0-9]+ unresolved=[0-9]+\)$/,
  ],
} as const;
const RISK_DOMAINS = [
  'correctness',
  'public-compatibility',
  'data-migrations',
  'security-privacy-authorization',
  'concurrency-distributed-ordering',
  'cross-repository-delivery',
  'production-operability',
  'performance-cost',
] as const satisfies readonly RiskDomain[];
const RUN_STATES = [
  'running',
  'finished',
  'failed',
  'blocked',
] as const satisfies readonly RunState[];
const RUN_MODES = ['plan', 'prompt'] as const satisfies readonly RunMode[];
const QUALITIES = ['quick', 'balanced', 'thorough'] as const satisfies readonly Quality[];
const FINAL_STATUSES = [
  'clean',
  'needs-review',
  'blocked',
] as const satisfies readonly RunFinalStatus[];
const OCCURRENCE_SOURCES = ['critic', 'fix-reviewer', 'intermediate-judge', 'final-judge'] as const;
type OccurrenceSource = (typeof OCCURRENCE_SOURCES)[number];
const FINAL_SOURCE_REASONS = {
  critic: {
    required: ['independent-critic-required'],
    exempt: [],
  },
  'fix-reviewer': {
    required: ['fix-pass-replacement-retained', 'fix-pass-replacement-proof-stale'],
    exempt: [
      'not-required',
      'not-evaluated-for-current-candidate',
      'disabled',
      'no-findings',
      'proposal-failed',
      'review-failed',
      'replacement-rejected',
      'pre-fix-restored',
    ],
  },
  'intermediate-judge': {
    required: ['applicable-high-risk-judge-required'],
    exempt: ['standard-risk-judge-exempt'],
  },
  'final-judge': {
    required: ['applicable-high-risk-judge-required'],
    exempt: ['standard-risk-judge-exempt'],
  },
} as const satisfies Record<
  OccurrenceSource,
  { readonly required: readonly string[]; readonly exempt: readonly string[] }
>;
const CANDIDATE_KINDS = [
  'versioned-plan',
  'fix-proposal',
  'fix-applied',
  'canonical-plan',
] as const;
const EVALUATION_STAGES = [
  'review',
  'fix-proposal-review',
  'fix-applied-review',
  'intermediate-readiness',
  'final-readiness',
] as const;
const RETAINED_CONTEXT_CATEGORIES = [
  'original-scope',
  'authoritative-system-facts',
  'operator-decisions',
  'material-findings',
  'active-invariants',
  'quality-and-limits',
] as const;
const RAW_OCCURRENCE_DISPOSITIONS = [
  'satisfied',
  'violated',
  'not-applicable',
  'unresolved',
] as const;
type NormalizedOccurrenceOutcome = 'resolved' | 'violated' | 'unresolved';
const FINAL_JUDGE_RATIONALES = [
  'standard-risk-judge-exempt',
  'structural-blocked',
  'assurance-appetite-judge-unavailable',
  'final-judge-proof-unavailable',
  'final-judge-ready',
  'final-judge-not-ready',
  'final-judge-candidate-mutated',
  'final-candidate-mutated-during-system-check',
  'final-candidate-mutated-during-localization',
] as const;
const SOURCE_BINDINGS = {
  critic: [{ kind: 'versioned-plan', stage: 'review' }],
  'fix-reviewer': [
    { kind: 'fix-proposal', stage: 'fix-proposal-review' },
    { kind: 'fix-applied', stage: 'fix-applied-review' },
  ],
  'intermediate-judge': [{ kind: 'versioned-plan', stage: 'intermediate-readiness' }],
  'final-judge': [{ kind: 'canonical-plan', stage: 'final-readiness' }],
} as const;

// `r<ts36>-<hex>`: a constant non-digit prefix keeps every id from ever starting
// with a digit (so a bare all-digits selector is unambiguously a pid), while the
// zero-padded base36 epoch-millisecond segment keeps ids lexicographically
// sortable by start time.
export function generateRunId(): string {
  const ts = Date.now().toString(36).padStart(RUN_ID_TS_WIDTH, '0');
  const rand = randomBytes(RUN_ID_RANDOM_BYTES).toString('hex');
  return `r${ts}-${rand}`;
}

// `base`, suffixed only when a still-tracked record already holds the bare name.
// `name` is a convenience handle; name resolution returns the most recent match,
// so an older same-base run stays addressable by its `runId`/`--last`.
export function deriveRunName(existing: readonly RunRecord[], base: string): string {
  const taken = new Set(existing.map((record) => record.name));
  if (!taken.has(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

// The inverse of the default `loop-<name>` workdir convention: recover a run's
// name from an explicit `--work` directory so a relocated run stays addressable.
export function runNameFromWorkdir(dir: string): string {
  const baseName = path.basename(dir);
  return baseName.startsWith('loop-') ? baseName.slice('loop-'.length) : baseName;
}

// Orders records most-recent-first: newer startedAt wins, ties broken by the
// (sortable) runId. Used by selector resolution and the run listing.
export function compareRunsByRecency(a: RunRecord, b: RunRecord): number {
  if (a.startedAt !== b.startedAt) {
    return a.startedAt < b.startedAt ? 1 : -1;
  }
  if (a.runId === b.runId) {
    return 0;
  }
  return a.runId < b.runId ? 1 : -1;
}

function runsDirOf(stateDir: string): string {
  return path.join(stateDir, 'runs');
}

export function runRecordPath(stateDir: string, runId: string): string {
  return path.join(runsDirOf(stateDir), `${runId}.json`);
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isEexist(error: unknown): boolean {
  return hasErrnoCode(error, 'EEXIST');
}

function serializeRecord(record: RunRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isEnumValue<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isEnumArray<T extends string>(value: unknown, allowed: readonly T[]): value is T[] {
  return Array.isArray(value) && value.every((entry) => isEnumValue(entry, allowed));
}

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function hasSortedUniqueStrings(values: readonly string[]): boolean {
  return (
    hasUniqueStrings(values) &&
    values.every((value, index) => {
      const previous = values[index - 1];
      return previous === undefined || previous.localeCompare(value) <= 0;
    })
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isBinding(value: unknown): boolean {
  const binding = objectValue(value);
  const candidate = objectValue(binding?.candidate);
  const lineage = objectValue(binding?.lineage);
  return (
    candidate !== undefined &&
    lineage !== undefined &&
    hasOnlyKeys(binding ?? {}, ['candidate', 'lineage']) &&
    hasOnlyKeys(candidate, ['kind', 'planVersion', 'contentDigest']) &&
    hasOnlyKeys(lineage, ['evaluationStage', 'lineageDigest']) &&
    isEnumValue(candidate.kind, CANDIDATE_KINDS) &&
    isNonNegativeInteger(candidate.planVersion) &&
    isSha256(candidate.contentDigest) &&
    isEnumValue(lineage.evaluationStage, EVALUATION_STAGES) &&
    isSha256(lineage.lineageDigest)
  );
}

function isSourceBinding(value: unknown, source: OccurrenceSource): boolean {
  if (!isBinding(value)) {
    return false;
  }
  const binding = objectValue(value);
  const candidate = objectValue(binding?.candidate);
  const lineage = objectValue(binding?.lineage);
  return SOURCE_BINDINGS[source].some(
    (allowed) => allowed.kind === candidate?.kind && allowed.stage === lineage?.evaluationStage,
  );
}

function bindingsEqual(left: unknown, right: unknown): boolean {
  const leftBinding = objectValue(left);
  const rightBinding = objectValue(right);
  const leftCandidate = objectValue(leftBinding?.candidate);
  const rightCandidate = objectValue(rightBinding?.candidate);
  const leftLineage = objectValue(leftBinding?.lineage);
  const rightLineage = objectValue(rightBinding?.lineage);
  return (
    leftCandidate?.kind === rightCandidate?.kind &&
    leftCandidate?.planVersion === rightCandidate?.planVersion &&
    leftCandidate?.contentDigest === rightCandidate?.contentDigest &&
    leftLineage?.evaluationStage === rightLineage?.evaluationStage &&
    leftLineage?.lineageDigest === rightLineage?.lineageDigest
  );
}

function isOccurrence(value: unknown): boolean {
  const occurrence = objectValue(value);
  if (
    occurrence === undefined ||
    !hasOnlyKeys(occurrence, ['invariantId', 'occurrenceId', 'disposition', 'evidenceGrounded']) ||
    !isNonEmptyString(occurrence.invariantId) ||
    !isNonEmptyString(occurrence.occurrenceId) ||
    !isEnumValue(occurrence.disposition, RAW_OCCURRENCE_DISPOSITIONS) ||
    typeof occurrence.evidenceGrounded !== 'boolean'
  ) {
    return false;
  }
  return occurrence.disposition === 'unresolved' || occurrence.evidenceGrounded;
}

function occurrencesCanonicallySorted(values: readonly unknown[]): boolean {
  return values.every((value, index) => {
    const occurrence = objectValue(value);
    const previous = objectValue(values[index - 1]);
    if (occurrence === undefined || previous === undefined) {
      return index === 0;
    }
    return (
      (String(previous.occurrenceId).localeCompare(String(occurrence.occurrenceId)) ||
        String(previous.invariantId).localeCompare(String(occurrence.invariantId)) ||
        String(previous.disposition).localeCompare(String(occurrence.disposition))) <= 0
    );
  });
}

function isSnapshot(value: unknown, source: OccurrenceSource): boolean {
  const snapshot = objectValue(value);
  return (
    snapshot?.source === source &&
    hasOnlyKeys(snapshot, ['source', 'catalogDigest', 'binding', 'occurrences']) &&
    isSha256(snapshot.catalogDigest) &&
    isSourceBinding(snapshot.binding, source) &&
    Array.isArray(snapshot.occurrences) &&
    snapshot.occurrences.every(isOccurrence) &&
    occurrencesCanonicallySorted(snapshot.occurrences) &&
    hasUniqueStrings(
      snapshot.occurrences.map((entry) => {
        const occurrence = objectValue(entry);
        return `${String(occurrence?.invariantId)}\0${String(occurrence?.occurrenceId)}`;
      }),
    )
  );
}

interface ParsedSourceProjection {
  readonly value: Record<string, unknown>;
  readonly source: OccurrenceSource;
  readonly required: boolean;
  readonly available: boolean;
  readonly catalogExact: boolean;
  readonly current: boolean;
  readonly conclusive: boolean;
  readonly outcomes: ReadonlyMap<string, NormalizedOccurrenceOutcome>;
}

function normalizedOccurrenceOutcome(value: Record<string, unknown>): NormalizedOccurrenceOutcome {
  if (value.disposition === 'violated') {
    return 'violated';
  }
  return value.disposition === 'unresolved' ? 'unresolved' : 'resolved';
}

function parseSourceProjection(
  value: unknown,
  expectedSource: OccurrenceSource,
  expectedPlanVersion: number,
  catalogDigest: string,
  invariantOccurrences: ReadonlyMap<string, string>,
): ParsedSourceProjection | undefined {
  const source = objectValue(value);
  if (
    source?.source !== expectedSource ||
    !hasOnlyKeys(source, [
      'source',
      'required',
      'available',
      'catalogExact',
      'current',
      'consistent',
      'conclusive',
      'reason',
      'expectedBinding',
      'snapshot',
    ]) ||
    typeof source.required !== 'boolean' ||
    typeof source.available !== 'boolean' ||
    typeof source.catalogExact !== 'boolean' ||
    typeof source.current !== 'boolean' ||
    typeof source.consistent !== 'boolean' ||
    typeof source.conclusive !== 'boolean' ||
    !isNonEmptyString(source.reason)
  ) {
    return undefined;
  }
  const hasExpectedBinding = source.expectedBinding !== undefined;
  const hasSnapshot = source.snapshot !== undefined;
  const expectedCandidate = objectValue(objectValue(source.expectedBinding)?.candidate);
  const allowedReasons = source.required
    ? FINAL_SOURCE_REASONS[expectedSource].required
    : FINAL_SOURCE_REASONS[expectedSource].exempt;
  if (
    (expectedSource === 'critic' && !source.required) ||
    !(allowedReasons as readonly string[]).includes(source.reason) ||
    hasExpectedBinding !== source.required ||
    hasSnapshot !== source.available
  ) {
    return undefined;
  }
  if (!source.required) {
    return !source.available &&
      source.catalogExact &&
      source.current &&
      source.consistent &&
      source.conclusive
      ? {
          value: source,
          source: expectedSource,
          required: false,
          available: false,
          catalogExact: true,
          current: true,
          conclusive: true,
          outcomes: new Map(),
        }
      : undefined;
  }
  if (
    !isSourceBinding(source.expectedBinding, expectedSource) ||
    expectedCandidate?.planVersion !== expectedPlanVersion
  ) {
    return undefined;
  }
  const expectedBinding = objectValue(source.expectedBinding);
  if (expectedBinding === undefined) {
    return undefined;
  }
  if (!hasSnapshot) {
    return !source.available &&
      !source.catalogExact &&
      !source.current &&
      source.consistent &&
      !source.conclusive
      ? {
          value: source,
          source: expectedSource,
          required: true,
          available: false,
          catalogExact: false,
          current: false,
          conclusive: false,
          outcomes: new Map(),
        }
      : undefined;
  }
  if (!isSnapshot(source.snapshot, expectedSource)) {
    return undefined;
  }
  const snapshot = objectValue(source.snapshot);
  if (
    snapshot?.catalogDigest !== catalogDigest ||
    !bindingsEqual(snapshot.binding, expectedBinding)
  ) {
    return undefined;
  }
  const occurrences = snapshot.occurrences as unknown[];
  if (occurrences.length !== invariantOccurrences.size) {
    return undefined;
  }
  const outcomes = new Map<string, NormalizedOccurrenceOutcome>();
  for (const occurrenceValue of occurrences) {
    const occurrence = objectValue(occurrenceValue);
    if (
      occurrence === undefined ||
      typeof occurrence.occurrenceId !== 'string' ||
      typeof occurrence.invariantId !== 'string' ||
      outcomes.has(occurrence.occurrenceId) ||
      invariantOccurrences.get(occurrence.occurrenceId) !== occurrence.invariantId
    ) {
      return undefined;
    }
    outcomes.set(occurrence.occurrenceId, normalizedOccurrenceOutcome(occurrence));
  }
  const conclusive = [...outcomes.values()].every((outcome) => outcome !== 'unresolved');
  if (
    !source.available ||
    !source.catalogExact ||
    !source.current ||
    source.conclusive !== conclusive
  ) {
    return undefined;
  }
  return {
    value: source,
    source: expectedSource,
    required: true,
    available: true,
    catalogExact: true,
    current: true,
    conclusive,
    outcomes,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function readinessReasonsMatch(
  decision: ReadinessDecision,
  reasonCodes: readonly string[],
  exhaustedLimits: readonly ReadinessLimit[],
): boolean {
  if (!hasSortedUniqueStrings(reasonCodes) || !hasSortedUniqueStrings(exhaustedLimits)) {
    return false;
  }
  if (decision === 'ready') {
    return reasonCodes.length === 0 && exhaustedLimits.length === 0;
  }
  if (decision === 'limits-exhausted') {
    return exhaustedLimits.length > 0 && sameStrings(reasonCodes, exhaustedLimits);
  }
  if (decision === 'revision-required') {
    return (
      exhaustedLimits.length === 0 &&
      reasonCodes.length > 0 &&
      reasonCodes.every((reason) =>
        (REVISION_REQUIRED_REASONS as readonly string[]).includes(reason),
      )
    );
  }
  return (
    reasonCodes.length > 0 &&
    reasonCodes.every((reason) => (UNABLE_TO_DECIDE_REASONS as readonly string[]).includes(reason))
  );
}

function isStableProofId(value: string): boolean {
  return STABLE_PROOF_ID.test(value);
}

function structuralReasonMatches(status: RunFinalStatus, reason: string): boolean {
  if (status === 'clean') {
    return reason === '';
  }
  return STRUCTURAL_REASONS[status].some((pattern) => pattern.test(reason));
}

function finalReasonsMatch(
  status: RunFinalStatus,
  reasons: readonly string[],
  structuralStatus: RunFinalStatus,
  structuralReason: string,
  readiness: Record<string, unknown>,
): boolean {
  const expected: string[] = [];
  if (structuralStatus !== 'clean') {
    expected.push(structuralReason);
  }
  if (readiness.satisfied !== true) {
    const reasonCodes = readiness.reasonCodes as string[];
    expected.push(`Readiness proof: ${String(readiness.decision)}:${reasonCodes.join(',')}`);
  } else if (status !== 'clean') {
    expected.push('finalization:monotonic-downgrade');
  }
  return sameStrings(reasons, expected);
}

function isOccurrenceCoverage(value: unknown): boolean {
  const coverage = objectValue(value);
  if (
    coverage === undefined ||
    !hasOnlyKeys(coverage, [
      'catalogDigest',
      'expectedPlanVersion',
      'riskDomainIds',
      'invariants',
      'materialIssueIds',
      'retainedContextCategories',
      'expectedOccurrenceIds',
      'sources',
      'outcomes',
      'resolvedOccurrenceIds',
      'violatedOccurrenceIds',
      'unresolvedOccurrenceIds',
      'disagreementOccurrenceIds',
      'catalogExact',
      'sourcesCurrent',
      'sourcesConclusive',
      'sourceConsistent',
      'proofSatisfied',
      'reasonCodes',
    ]) ||
    !isSha256(coverage.catalogDigest) ||
    !isNonNegativeInteger(coverage.expectedPlanVersion) ||
    !isEnumArray(coverage.riskDomainIds, RISK_DOMAINS) ||
    !Array.isArray(coverage.invariants) ||
    !isStringArray(coverage.materialIssueIds) ||
    !isEnumArray(coverage.retainedContextCategories, RETAINED_CONTEXT_CATEGORIES) ||
    !isStringArray(coverage.expectedOccurrenceIds) ||
    !Array.isArray(coverage.sources) ||
    coverage.sources.length !== OCCURRENCE_SOURCES.length ||
    !Array.isArray(coverage.outcomes) ||
    !isStringArray(coverage.resolvedOccurrenceIds) ||
    !isStringArray(coverage.violatedOccurrenceIds) ||
    !isStringArray(coverage.unresolvedOccurrenceIds) ||
    !isStringArray(coverage.disagreementOccurrenceIds) ||
    typeof coverage.catalogExact !== 'boolean' ||
    typeof coverage.sourcesCurrent !== 'boolean' ||
    typeof coverage.sourcesConclusive !== 'boolean' ||
    typeof coverage.sourceConsistent !== 'boolean' ||
    typeof coverage.proofSatisfied !== 'boolean' ||
    !isStringArray(coverage.reasonCodes)
  ) {
    return false;
  }

  const expectedPlanVersion = coverage.expectedPlanVersion;
  const invariantOccurrences = new Map<string, string>();
  const invariantIds: string[] = [];
  for (const invariantValue of coverage.invariants) {
    const invariant = objectValue(invariantValue);
    if (
      invariant === undefined ||
      !hasOnlyKeys(invariant, ['invariantId', 'occurrenceIds']) ||
      !isNonEmptyString(invariant.invariantId) ||
      !isStringArray(invariant.occurrenceIds) ||
      !hasSortedUniqueStrings(invariant.occurrenceIds)
    ) {
      return false;
    }
    invariantIds.push(invariant.invariantId);
    for (const occurrenceId of invariant.occurrenceIds) {
      if (invariantOccurrences.has(occurrenceId)) {
        return false;
      }
      invariantOccurrences.set(occurrenceId, invariant.invariantId);
    }
  }

  if (
    !hasSortedUniqueStrings(invariantIds) ||
    !hasUniqueStrings(coverage.expectedOccurrenceIds) ||
    !sameStrings(coverage.expectedOccurrenceIds, [...invariantOccurrences.keys()]) ||
    !hasSortedUniqueStrings(coverage.materialIssueIds) ||
    !sameStrings(coverage.riskDomainIds, RISK_DOMAINS) ||
    !sameStrings(coverage.retainedContextCategories, RETAINED_CONTEXT_CATEGORIES)
  ) {
    return false;
  }

  const expectedCatalogDigest = canonicalJsonSha256({
    expectedPlanVersion,
    riskDomainIds: coverage.riskDomainIds,
    invariants: coverage.invariants,
    materialIssueIds: coverage.materialIssueIds,
    retainedContextCategories: coverage.retainedContextCategories,
  });
  if (coverage.catalogDigest !== expectedCatalogDigest) {
    return false;
  }

  const sources: ParsedSourceProjection[] = [];
  for (const [index, sourceValue] of coverage.sources.entries()) {
    const expectedSource = OCCURRENCE_SOURCES[index];
    if (expectedSource === undefined) {
      return false;
    }
    const source = parseSourceProjection(
      sourceValue,
      expectedSource,
      expectedPlanVersion,
      coverage.catalogDigest,
      invariantOccurrences,
    );
    if (source === undefined) {
      return false;
    }
    sources.push(source);
  }

  const requiredSources = sources.filter((source) => source.required);
  const disagreementSources = new Set<OccurrenceSource>();
  const disagreementOccurrenceIds: string[] = [];
  const derivedOutcomes: {
    readonly invariantId: string;
    readonly occurrenceId: string;
    readonly outcome: NormalizedOccurrenceOutcome;
  }[] = [];
  for (const [occurrenceId, invariantId] of invariantOccurrences) {
    const sourceOutcomes = requiredSources.map((source) => ({
      source: source.source,
      outcome: source.outcomes.get(occurrenceId) ?? ('unresolved' as const),
    }));
    const resolvedSources = sourceOutcomes.filter((entry) => entry.outcome === 'resolved');
    const violatedSources = sourceOutcomes.filter((entry) => entry.outcome === 'violated');
    if (resolvedSources.length > 0 && violatedSources.length > 0) {
      disagreementOccurrenceIds.push(occurrenceId);
      for (const entry of [...resolvedSources, ...violatedSources]) {
        disagreementSources.add(entry.source);
      }
    }
    derivedOutcomes.push({
      invariantId,
      occurrenceId,
      outcome:
        violatedSources.length > 0
          ? 'violated'
          : sourceOutcomes.every((entry) => entry.outcome === 'resolved')
            ? 'resolved'
            : 'unresolved',
    });
  }

  for (const [index, derived] of derivedOutcomes.entries()) {
    const projected = objectValue(coverage.outcomes[index]);
    if (
      projected === undefined ||
      !hasOnlyKeys(projected, ['invariantId', 'occurrenceId', 'outcome']) ||
      projected.invariantId !== derived.invariantId ||
      projected.occurrenceId !== derived.occurrenceId ||
      projected.outcome !== derived.outcome
    ) {
      return false;
    }
  }
  if (coverage.outcomes.length !== derivedOutcomes.length) {
    return false;
  }

  const aggregateIds = (outcome: NormalizedOccurrenceOutcome): string[] =>
    derivedOutcomes.filter((entry) => entry.outcome === outcome).map((entry) => entry.occurrenceId);
  const resolvedOccurrenceIds = aggregateIds('resolved');
  const violatedOccurrenceIds = aggregateIds('violated');
  const unresolvedOccurrenceIds = aggregateIds('unresolved');
  const catalogExact = requiredSources.every((source) => source.catalogExact);
  const sourcesCurrent = requiredSources.every((source) => source.current);
  const sourcesConclusive = requiredSources.every((source) => source.conclusive);
  const sourceConsistent = requiredSources.every(
    (source) => !disagreementSources.has(source.source),
  );
  const expectedReasonCodes: string[] = [];
  for (const source of requiredSources) {
    const consistent = !disagreementSources.has(source.source);
    if (!source.available) {
      expectedReasonCodes.push(`occurrence-source:${source.source}:missing`);
    }
    if (!source.catalogExact) {
      expectedReasonCodes.push(`occurrence-source:${source.source}:catalog-inexact`);
    }
    if (!source.current) {
      expectedReasonCodes.push(`occurrence-source:${source.source}:stale`);
    }
    if (!source.conclusive) {
      expectedReasonCodes.push(`occurrence-source:${source.source}:inconclusive`);
    }
    if (!consistent) {
      expectedReasonCodes.push(`occurrence-source:${source.source}:inconsistent`);
    }
  }
  expectedReasonCodes.push(
    ...violatedOccurrenceIds.map((id) => `occurrence:${id}:violated`),
    ...unresolvedOccurrenceIds.map((id) => `occurrence:${id}:unresolved`),
    ...disagreementOccurrenceIds.map((id) => `occurrence:${id}:disagreement`),
  );
  const proofSatisfied =
    catalogExact &&
    sourcesCurrent &&
    sourcesConclusive &&
    sourceConsistent &&
    violatedOccurrenceIds.length === 0 &&
    unresolvedOccurrenceIds.length === 0 &&
    disagreementOccurrenceIds.length === 0;
  return (
    sources.every(
      (source) => source.value.consistent === !disagreementSources.has(source.source),
    ) &&
    sameStrings(coverage.resolvedOccurrenceIds, resolvedOccurrenceIds) &&
    sameStrings(coverage.violatedOccurrenceIds, violatedOccurrenceIds) &&
    sameStrings(coverage.unresolvedOccurrenceIds, unresolvedOccurrenceIds) &&
    sameStrings(coverage.disagreementOccurrenceIds, disagreementOccurrenceIds) &&
    coverage.catalogExact === catalogExact &&
    coverage.sourcesCurrent === sourcesCurrent &&
    coverage.sourcesConclusive === sourcesConclusive &&
    coverage.sourceConsistent === sourceConsistent &&
    sameStrings(coverage.reasonCodes, expectedReasonCodes) &&
    coverage.proofSatisfied === proofSatisfied
  );
}

function isPathWithin(workDir: string, candidate: unknown): candidate is string {
  if (!isNonEmptyString(candidate) || !path.isAbsolute(candidate)) {
    return false;
  }
  const relative = path.relative(path.resolve(workDir), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function isReadinessProjection(value: unknown, workDir: string): boolean {
  const readiness = objectValue(value);
  const coverage = objectValue(readiness?.occurrenceCoverage);
  const applicableDomains = new Set(
    Array.isArray(readiness?.applicableRiskDomains) ? readiness.applicableRiskDomains : [],
  );
  const ready = readiness?.decision === 'ready';
  return (
    readiness !== undefined &&
    hasOnlyKeys(readiness, [
      'proofArtifactPath',
      'planVersion',
      'canonicalPlanSha256',
      'decision',
      'reasonCodes',
      'satisfied',
      'exhaustedLimits',
      'unresolvedProofIds',
      'applicableRiskDomains',
      'highRiskDomains',
      'opportunityCount',
      'occurrenceCoverage',
    ]) &&
    isPathWithin(workDir, readiness.proofArtifactPath) &&
    isNonNegativeInteger(readiness.planVersion) &&
    isSha256(readiness.canonicalPlanSha256) &&
    isEnumValue(readiness.decision, READINESS_DECISIONS) &&
    isStringArray(readiness.reasonCodes) &&
    typeof readiness.satisfied === 'boolean' &&
    readiness.satisfied === (readiness.decision === 'ready') &&
    isEnumArray(readiness.exhaustedLimits, READINESS_LIMITS) &&
    isStringArray(readiness.unresolvedProofIds) &&
    hasSortedUniqueStrings(readiness.unresolvedProofIds) &&
    readiness.unresolvedProofIds.every(isStableProofId) &&
    isEnumArray(readiness.applicableRiskDomains, RISK_DOMAINS) &&
    hasUniqueStrings(readiness.applicableRiskDomains) &&
    isEnumArray(readiness.highRiskDomains, RISK_DOMAINS) &&
    hasUniqueStrings(readiness.highRiskDomains) &&
    readiness.highRiskDomains.every((domain) => applicableDomains.has(domain)) &&
    isNonNegativeInteger(readiness.opportunityCount) &&
    isOccurrenceCoverage(readiness.occurrenceCoverage) &&
    coverage?.expectedPlanVersion === readiness.planVersion &&
    (!readiness.satisfied || coverage.proofSatisfied === true) &&
    readinessReasonsMatch(readiness.decision, readiness.reasonCodes, readiness.exhaustedLimits) &&
    (!ready || readiness.unresolvedProofIds.length === 0)
  );
}

function isJudgeProjection(
  value: unknown,
  readiness: Record<string, unknown>,
  finalJudgeSource: Record<string, unknown>,
  structuralStatus: unknown,
): boolean {
  const judge = objectValue(value);
  if (
    judge === undefined ||
    !hasOnlyKeys(judge, [
      'required',
      'allowed',
      'evaluated',
      'available',
      'candidateUnchanged',
      'verdict',
      'rationale',
      'binding',
      'metadataPath',
    ]) ||
    typeof judge.required !== 'boolean' ||
    typeof judge.allowed !== 'boolean' ||
    typeof judge.evaluated !== 'boolean' ||
    typeof judge.available !== 'boolean' ||
    typeof judge.candidateUnchanged !== 'boolean' ||
    (judge.verdict !== null && typeof judge.verdict !== 'boolean') ||
    !isEnumValue(judge.rationale, FINAL_JUDGE_RATIONALES) ||
    (judge.binding !== undefined && !isBinding(judge.binding)) ||
    (judge.metadataPath !== undefined && !isNonEmptyString(judge.metadataPath))
  ) {
    return false;
  }
  if (judge.available !== (judge.verdict !== null) || (judge.available && !judge.evaluated)) {
    return false;
  }
  const sourceRequired = finalJudgeSource.required === true;
  const sourceAvailable = finalJudgeSource.available === true;
  if (
    judge.required !== sourceRequired ||
    judge.available !== sourceAvailable ||
    (judge.binding !== undefined) !== judge.available ||
    (!judge.allowed && (judge.evaluated || judge.available))
  ) {
    return false;
  }
  const rationaleMatches =
    (judge.rationale === 'standard-risk-judge-exempt' &&
      !judge.required &&
      !judge.evaluated &&
      !judge.available &&
      judge.verdict === null) ||
    (judge.rationale === 'structural-blocked' &&
      structuralStatus === 'blocked' &&
      !judge.evaluated &&
      !judge.available &&
      judge.verdict === null) ||
    (judge.rationale === 'assurance-appetite-judge-unavailable' &&
      judge.required &&
      !judge.allowed &&
      !judge.evaluated &&
      !judge.available &&
      judge.verdict === null) ||
    (judge.rationale === 'final-judge-proof-unavailable' &&
      judge.required &&
      judge.allowed &&
      judge.candidateUnchanged &&
      !judge.available &&
      judge.verdict === null) ||
    (judge.rationale === 'final-judge-ready' &&
      judge.required &&
      judge.allowed &&
      judge.evaluated &&
      judge.available &&
      judge.candidateUnchanged &&
      judge.verdict === true) ||
    (judge.rationale === 'final-judge-not-ready' &&
      judge.required &&
      judge.allowed &&
      judge.evaluated &&
      judge.available &&
      judge.candidateUnchanged &&
      judge.verdict === false) ||
    (judge.rationale === 'final-judge-candidate-mutated' &&
      judge.required &&
      judge.allowed &&
      !judge.available &&
      !judge.candidateUnchanged &&
      judge.verdict === null) ||
    (judge.rationale === 'final-candidate-mutated-during-system-check' &&
      !judge.evaluated &&
      !judge.available &&
      !judge.candidateUnchanged &&
      judge.verdict === null) ||
    (judge.rationale === 'final-candidate-mutated-during-localization' &&
      !judge.available &&
      !judge.candidateUnchanged &&
      judge.verdict === null);
  if (!rationaleMatches) {
    return false;
  }
  if (!sourceRequired) {
    return (
      !judge.evaluated &&
      !judge.available &&
      judge.verdict === null &&
      judge.binding === undefined &&
      judge.metadataPath === undefined
    );
  }
  const expectedBinding = objectValue(finalJudgeSource.expectedBinding);
  const expectedCandidate = objectValue(expectedBinding?.candidate);
  if (
    expectedBinding === undefined ||
    expectedCandidate?.planVersion !== readiness.planVersion ||
    expectedCandidate?.contentDigest !== readiness.canonicalPlanSha256 ||
    (judge.binding !== undefined && !bindingsEqual(judge.binding, expectedBinding)) ||
    (judge.available &&
      (!judge.allowed ||
        !judge.evaluated ||
        !judge.candidateUnchanged ||
        judge.binding === undefined ||
        !bindingsEqual(objectValue(finalJudgeSource.snapshot)?.binding, expectedBinding)))
  ) {
    return false;
  }
  return true;
}

function isFinalProjection(value: unknown, workDir: string): boolean {
  const final = objectValue(value);
  const readiness = objectValue(final?.readiness);
  const coverage = objectValue(readiness?.occurrenceCoverage);
  const finalJudgeSource = objectValue(
    Array.isArray(coverage?.sources) ? coverage.sources[OCCURRENCE_SOURCES.length - 1] : undefined,
  );
  const intermediateJudgeSource = objectValue(
    Array.isArray(coverage?.sources) ? coverage.sources[OCCURRENCE_SOURCES.length - 2] : undefined,
  );
  const judge = objectValue(final?.judge);
  const highRiskRequired =
    Array.isArray(readiness?.highRiskDomains) && readiness.highRiskDomains.length > 0;
  return (
    final !== undefined &&
    hasOnlyKeys(final, [
      'status',
      'reasons',
      'structuralStatus',
      'structuralReason',
      'artifactPath',
      'readiness',
      'judge',
    ]) &&
    isEnumValue(final.status, FINAL_STATUSES) &&
    isStringArray(final.reasons) &&
    hasUniqueStrings(final.reasons) &&
    isEnumValue(final.structuralStatus, FINAL_STATUSES) &&
    typeof final.structuralReason === 'string' &&
    isPathWithin(workDir, final.artifactPath) &&
    readiness !== undefined &&
    isReadinessProjection(readiness, workDir) &&
    final.artifactPath === readiness.proofArtifactPath &&
    finalJudgeSource !== undefined &&
    intermediateJudgeSource !== undefined &&
    finalJudgeSource.required === highRiskRequired &&
    intermediateJudgeSource.required === highRiskRequired &&
    isJudgeProjection(final.judge, readiness, finalJudgeSource, final.structuralStatus) &&
    judge !== undefined &&
    (judge.metadataPath === undefined || isPathWithin(workDir, judge.metadataPath)) &&
    structuralReasonMatches(final.structuralStatus, final.structuralReason) &&
    (final.status === 'blocked') === (final.structuralStatus === 'blocked') &&
    finalReasonsMatch(
      final.status,
      final.reasons,
      final.structuralStatus,
      final.structuralReason,
      readiness,
    ) &&
    (final.status !== 'clean' ||
      (final.structuralStatus === 'clean' &&
        readiness.satisfied === true &&
        coverage?.proofSatisfied === true &&
        judge.candidateUnchanged === true &&
        (judge.required === false ||
          (judge.allowed === true &&
            judge.evaluated === true &&
            judge.available === true &&
            judge.verdict === true)))) &&
    (readiness.satisfied !== true ||
      judge.required === false ||
      (judge.allowed === true &&
        judge.evaluated === true &&
        judge.available === true &&
        judge.candidateUnchanged === true &&
        judge.verdict === true))
  );
}

function isRunLifecycleConsistent(record: Record<string, unknown>): boolean {
  const state = record.state;
  const final = objectValue(record.final);
  if (state === 'running') {
    return record.endedAt === undefined && record.exitCode === undefined && final === undefined;
  }
  if (!isNonEmptyString(record.endedAt) || !Number.isInteger(record.exitCode)) {
    return false;
  }
  if (state === 'failed') {
    return record.exitCode !== 0 && final === undefined;
  }
  if (state === 'blocked') {
    return record.exitCode === 6 && final?.status === 'blocked';
  }
  return (
    state === 'finished' &&
    record.exitCode === 0 &&
    (final?.status === 'clean' || final?.status === 'needs-review')
  );
}

const LEGACY_FINAL_FIELDS = [
  'finalStatus',
  'finalReason',
  'structuralStatus',
  'structuralReason',
  'finalReadiness',
  'finalConvergence',
] as const;

function parseRunRecord(value: unknown): RunRecord | undefined {
  const record = objectValue(value);
  if (
    record?.schemaVersion !== RUN_RECORD_SCHEMA_VERSION ||
    !hasOnlyKeys(record, [
      'schemaVersion',
      'runId',
      'name',
      'pid',
      'pgid',
      'procStartToken',
      'mode',
      'inputPath',
      'workDir',
      'logPath',
      'plansDir',
      'startedAt',
      'quality',
      'state',
      'endedAt',
      'exitCode',
      'final',
    ]) ||
    LEGACY_FINAL_FIELDS.some((field) => field in record) ||
    !isNonEmptyString(record.runId) ||
    !isNonEmptyString(record.name) ||
    !isNonNegativeInteger(record.pid) ||
    !isNonEmptyString(record.pgid) ||
    !isNonEmptyString(record.procStartToken) ||
    !isEnumValue(record.mode, RUN_MODES) ||
    !isNonEmptyString(record.inputPath) ||
    !isNonEmptyString(record.workDir) ||
    !isNonEmptyString(record.logPath) ||
    !isNonEmptyString(record.plansDir) ||
    !isNonEmptyString(record.startedAt) ||
    !isEnumValue(record.quality, QUALITIES) ||
    !isEnumValue(record.state, RUN_STATES) ||
    (record.endedAt !== undefined && !isNonEmptyString(record.endedAt)) ||
    (record.exitCode !== undefined && !Number.isInteger(record.exitCode)) ||
    (record.final !== undefined && !isFinalProjection(record.final, record.workDir)) ||
    !isRunLifecycleConsistent(record)
  ) {
    return undefined;
  }
  return record as unknown as RunRecord;
}

// Sole owner of record creation. The exclusive `wx` open is the atomic create
// and the only collision check. Without a fixed id it regenerates on collision
// and retries internally; with the launch parent's pre-minted id a collision is
// fatal so the parent-printed id can never desync from the written record.
export function writeRunRecord(
  stateDir: string,
  draft: RunRecordDraft,
  options: WriteRunRecordOptions = {},
): RunRecord {
  const runsDir = runsDirOf(stateDir);
  mkdirSync(runsDir, { recursive: true });
  const fixedRunId = options.fixedRunId;
  for (;;) {
    const runId = fixedRunId ?? generateRunId();
    const record: RunRecord = { schemaVersion: RUN_RECORD_SCHEMA_VERSION, runId, ...draft };
    if (parseRunRecord(record) === undefined) {
      throw new TypeError('run record draft is invalid');
    }
    try {
      writeFileSync(path.join(runsDir, `${runId}.json`), serializeRecord(record), { flag: 'wx' });
      return record;
    } catch (error) {
      if (!isEexist(error)) {
        throw error;
      }
      if (fixedRunId !== undefined) {
        throw new HaltError(`run record already exists for id ${runId}`, 1, false);
      }
    }
  }
}

// Update of the already-reserved record: merge the patch and atomically replace
// the file via a temp + rename. No collision check — the path was reserved at
// create time. A missing record is a no-op (best-effort, like registry cleanup).
export function finalizeRunRecord(stateDir: string, runId: string, patch: RunRecordPatch): void {
  const target = runRecordPath(stateDir, runId);
  let current: RunRecord | undefined;
  try {
    current = parseRunRecord(JSON.parse(readFileSync(target, 'utf8')));
  } catch {
    return;
  }
  if (current === undefined) {
    return;
  }
  const merged: RunRecord = { ...current, ...patch };
  if (parseRunRecord(merged) === undefined) {
    throw new TypeError('run record patch is invalid');
  }
  const tmp = `${target}.${process.pid}`;
  writeFileSync(tmp, serializeRecord(merged));
  renameSync(tmp, target);
}

export function readRunRecords(stateDir: string): RunRecord[] {
  let entries: string[];
  try {
    entries = readdirSync(runsDirOf(stateDir));
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    try {
      const runId = entry.slice(0, -5);
      const record = parseRunRecord(
        JSON.parse(readFileSync(runRecordPath(stateDir, runId), 'utf8')),
      );
      if (record?.runId === runId) {
        records.push(record);
      }
    } catch {
      continue;
    }
  }
  return records;
}

function canonicalExistingStoreDir(stateDir: string): string | undefined {
  try {
    if (!statSync(stateDir).isDirectory()) {
      return undefined;
    }
    return realpathSync(stateDir);
  } catch {
    return undefined;
  }
}

// Read-only union across stores: missing stores are skipped, and aliases read once.
export function readRunRecordsAcross(stateDirs: readonly string[]): RunRecord[] {
  const seen = new Set<string>();
  const records: RunRecord[] = [];
  for (const stateDir of stateDirs) {
    const canonical = canonicalExistingStoreDir(stateDir);
    if (canonical === undefined || seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    records.push(...readRunRecords(canonical));
  }
  return records;
}

// A `running` record is live only when its pid is alive AND still carries the
// recorded pgid and start token — the start token rejects a record whose pid was
// recycled by an unrelated process that happens to share the pgid. A stale
// `running` record is inferred `finished` when its plan landed, else `failed`.
export function resolveRunState(record: RunRecord, probes: RunStateProbes): RunState {
  if (record.state !== 'running') {
    return record.state;
  }
  const live =
    probes.isAlive(record.pid) &&
    probes.pgidOf(record.pid) === record.pgid &&
    probes.procStartToken(record.pid) === record.procStartToken;
  if (live) {
    return 'running';
  }
  return existsSync(path.join(record.workDir, 'plan.final.md')) ? 'finished' : 'failed';
}

export interface RetentionPolicy {
  readonly keepCount?: number;
  readonly maxAgeDays?: number;
  readonly dryRun?: boolean;
}

export interface PruneResult {
  readonly removed: string[];
  readonly kept: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RetentionDefaults {
  readonly keepCount: number;
  readonly maxAgeDays: number;
}

interface ResolvedRetention {
  readonly keepCount: number;
  readonly maxAgeDays: number;
  readonly dryRun: boolean;
}

function resolveRetention(policy: RetentionPolicy, defaults: RetentionDefaults): ResolvedRetention {
  return {
    keepCount: policy.keepCount ?? defaults.keepCount,
    maxAgeDays: policy.maxAgeDays ?? defaults.maxAgeDays,
    dryRun: policy.dryRun === true,
  };
}

// The count bound the run listing shares with prune so "recent finished" never
// shows more than retention keeps.
export function retentionKeepCount(defaults: RetentionDefaults): number {
  return defaults.keepCount;
}

// Bound the ledger by removing only terminal records (state on disk is not
// `running`) beyond `keepCount` most-recent, or older than `maxAgeDays`.
// Functional workdirs are never touched; prune removes records only.
export function pruneRuns(
  stateDir: string,
  policy: RetentionPolicy,
  defaults: RetentionDefaults,
): PruneResult {
  const { keepCount, maxAgeDays, dryRun } = resolveRetention(policy, defaults);
  const records = readRunRecords(stateDir);
  const terminal = records
    .filter((record) => record.state !== 'running')
    .sort(compareRunsByRecency);
  const nowMs = Date.now();
  const removed: string[] = [];
  for (const [index, record] of terminal.entries()) {
    const endedMs = Date.parse(record.endedAt ?? record.startedAt);
    const tooOld =
      maxAgeDays > 0 && Number.isFinite(endedMs) && nowMs - endedMs > maxAgeDays * MS_PER_DAY;
    if (index >= keepCount || tooOld) {
      removed.push(record.runId);
      if (!dryRun) {
        rmSync(runRecordPath(stateDir, record.runId), { force: true });
      }
    }
  }
  return { removed, kept: records.length - removed.length };
}
