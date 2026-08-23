import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { randomQueue } = vi.hoisted(() => ({ randomQueue: [] as Buffer[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (size: number): Buffer => randomQueue.shift() ?? actual.randomBytes(size),
  };
});

import {
  RUN_RECORD_SCHEMA_VERSION,
  deriveRunName,
  finalizeRunRecord,
  generateRunId,
  pruneRuns,
  readRunRecords,
  readRunRecordsAcross,
  resolveRunState,
  runNameFromWorkdir,
  runRecordPath,
  writeRunRecord,
  type RunRecord,
  type RunRecordDraft,
  type RunStateProbes,
} from '../../src/core/run-store.js';
import { HaltError } from '../../src/runtime/halt.js';
import {
  bindCanonicalPlan,
  bindVersionedPlan,
  createOccurrenceSourceBinding,
  createReadinessProofCatalog,
  createReadinessProofState,
  projectOccurrenceCoverage,
  replaceOccurrenceCoverageSnapshot,
} from '../../src/core/readiness-proof.js';
import { qualityMatrix } from '../../src/core/quality.js';
import type { FinalProjection } from '../../src/types.js';

const RETAIN_DEFAULTS = { keepCount: 50, maxAgeDays: 30 };

let stateDir: string;

function recentRunTimestamp(hoursAgo = 1): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function draft(overrides: Partial<RunRecordDraft> = {}): RunRecordDraft {
  return {
    name: 'demo',
    pid: 4242,
    pgid: '4242',
    procStartToken: 'tok-1',
    mode: 'plan',
    inputPath: '/tmp/in.md',
    workDir: path.join(stateDir, 'work'),
    logPath: path.join(stateDir, 'work', 'run.log'),
    plansDir: '/tmp/plans',
    startedAt: recentRunTimestamp(),
    quality: 'balanced',
    state: 'running',
    ...overrides,
  };
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    ...draft(),
    runId: 'r000000000-deadbeef',
    ...overrides,
  };
}

function finalProjection(workDir: string): FinalProjection {
  const canonicalPlanSha256 = 'a'.repeat(64);
  const invariantId = 'I-public-contract';
  const occurrenceId = 'O-public-contract';
  let state = createReadinessProofState({
    quality: 'quick',
    matrix: qualityMatrix('quick'),
    mode: 'plan',
    sourceDigest: 'b'.repeat(64),
    authoritativeDigest: 'c'.repeat(64),
    relationshipIds: [],
    maxIters: 1,
    trustedCatalog: createReadinessProofCatalog({
      expectedPlanVersion: 0,
      invariants: [{ invariantId, occurrenceIds: [occurrenceId] }],
      materialIssueIds: [],
    }),
    invariants: [
      {
        id: invariantId,
        sourceFinding: `catalog:${invariantId}`,
        statement: 'Public projections retain exact occurrence coverage.',
        occurrences: [
          {
            id: occurrenceId,
            dimension: 'durable-projection',
            subject: 'RunRecord.final',
          },
        ],
      },
    ],
  });
  const criticBinding = createOccurrenceSourceBinding(state, {
    source: 'critic',
    candidateKind: 'versioned-plan',
    contentDigest: canonicalPlanSha256,
  });
  state = bindVersionedPlan(state, {
    planVersion: 0,
    planSha256: canonicalPlanSha256,
    criticLineageDigest: criticBinding.lineage.lineageDigest,
  });
  state = replaceOccurrenceCoverageSnapshot(state, {
    source: 'critic',
    catalogDigest: state.catalog.digest,
    binding: criticBinding,
    occurrences: [
      {
        invariantId,
        occurrenceId,
        disposition: 'satisfied',
        evidenceGrounded: true,
      },
    ],
  });
  state = bindCanonicalPlan(state, {
    planVersion: 0,
    canonicalPlanSha256,
    compatibleWithVersionedProof: true,
  });
  const proofArtifactPath = path.join(workDir, 'convergence.final.json');
  return {
    status: 'clean',
    reasons: [],
    structuralStatus: 'clean',
    structuralReason: '',
    artifactPath: proofArtifactPath,
    readiness: {
      proofArtifactPath,
      planVersion: 0,
      canonicalPlanSha256,
      decision: 'ready',
      reasonCodes: [],
      satisfied: true,
      exhaustedLimits: [],
      unresolvedProofIds: [],
      applicableRiskDomains: [],
      highRiskDomains: [],
      opportunityCount: 0,
      occurrenceCoverage: projectOccurrenceCoverage(state),
    },
    judge: {
      required: false,
      allowed: true,
      evaluated: false,
      available: false,
      candidateUnchanged: true,
      verdict: null,
      rationale: 'standard-risk-judge-exempt',
    },
  };
}

interface MutableBinding {
  candidate: {
    kind: string;
    planVersion: number;
    contentDigest: string;
  };
  lineage: {
    evaluationStage: string;
    lineageDigest: string;
  };
}

interface MutableOccurrence {
  invariantId: string;
  occurrenceId: string;
  disposition: string;
  evidenceGrounded: boolean;
}

interface MutableSourceProjection {
  source: string;
  required: boolean;
  available: boolean;
  catalogExact: boolean;
  current: boolean;
  consistent: boolean;
  conclusive: boolean;
  reason: string;
  expectedBinding?: MutableBinding;
  snapshot?: {
    source: string;
    catalogDigest: string;
    binding: MutableBinding;
    occurrences: MutableOccurrence[];
  };
}

interface MutableFinalProjection {
  status: string;
  reasons: string[];
  structuralStatus: string;
  structuralReason: string;
  readiness: {
    canonicalPlanSha256: string;
    decision: string;
    reasonCodes: string[];
    satisfied: boolean;
    exhaustedLimits: string[];
    unresolvedProofIds: string[];
    applicableRiskDomains: string[];
    highRiskDomains: string[];
    occurrenceCoverage: {
      catalogDigest: string;
      sources: MutableSourceProjection[];
    };
  };
  judge: {
    required: boolean;
    allowed: boolean;
    evaluated: boolean;
    available: boolean;
    candidateUnchanged: boolean;
    verdict: boolean | null;
    rationale: string;
    binding?: MutableBinding;
  };
}

function mutableFinalProjection(workDir: string): MutableFinalProjection {
  return structuredClone(finalProjection(workDir)) as unknown as MutableFinalProjection;
}

function sourceAt(
  final: MutableFinalProjection,
  source: MutableSourceProjection['source'],
): MutableSourceProjection {
  const projected = final.readiness.occurrenceCoverage.sources.find(
    (candidate) => candidate.source === source,
  );
  if (projected === undefined) {
    throw new TypeError(`fixture source is unavailable: ${source}`);
  }
  return projected;
}

function requiredJudgeProjection(workDir: string): MutableFinalProjection {
  const final = mutableFinalProjection(workDir);
  const coverage = final.readiness.occurrenceCoverage;
  final.readiness.applicableRiskDomains = ['correctness'];
  final.readiness.highRiskDomains = ['correctness'];
  const finalJudge = sourceAt(final, 'final-judge');
  const criticSnapshot = sourceAt(final, 'critic').snapshot;
  if (criticSnapshot === undefined) {
    throw new TypeError('fixture critic snapshot is unavailable');
  }
  const binding: MutableBinding = {
    candidate: {
      kind: 'canonical-plan',
      planVersion: 0,
      contentDigest: final.readiness.canonicalPlanSha256,
    },
    lineage: {
      evaluationStage: 'final-readiness',
      lineageDigest: 'd'.repeat(64),
    },
  };
  const intermediateBinding: MutableBinding = {
    candidate: {
      kind: 'versioned-plan',
      planVersion: 0,
      contentDigest: final.readiness.canonicalPlanSha256,
    },
    lineage: {
      evaluationStage: 'intermediate-readiness',
      lineageDigest: 'e'.repeat(64),
    },
  };
  Object.assign(sourceAt(final, 'intermediate-judge'), {
    required: true,
    available: true,
    catalogExact: true,
    current: true,
    consistent: true,
    conclusive: true,
    reason: 'applicable-high-risk-judge-required',
    expectedBinding: structuredClone(intermediateBinding),
    snapshot: {
      source: 'intermediate-judge',
      catalogDigest: coverage.catalogDigest,
      binding: structuredClone(intermediateBinding),
      occurrences: structuredClone(criticSnapshot.occurrences),
    },
  });
  Object.assign(finalJudge, {
    required: true,
    available: true,
    catalogExact: true,
    current: true,
    consistent: true,
    conclusive: true,
    reason: 'applicable-high-risk-judge-required',
    expectedBinding: structuredClone(binding),
    snapshot: {
      source: 'final-judge',
      catalogDigest: coverage.catalogDigest,
      binding: structuredClone(binding),
      occurrences: structuredClone(criticSnapshot.occurrences),
    },
  });
  Object.assign(final.judge, {
    required: true,
    allowed: true,
    evaluated: true,
    available: true,
    candidateUnchanged: true,
    verdict: true,
    rationale: 'final-judge-ready',
    binding: structuredClone(binding),
  });
  return final;
}

function requiredFixProjection(workDir: string): MutableFinalProjection {
  const final = mutableFinalProjection(workDir);
  const coverage = final.readiness.occurrenceCoverage;
  const criticSnapshot = sourceAt(final, 'critic').snapshot;
  if (criticSnapshot === undefined) {
    throw new TypeError('fixture critic snapshot is unavailable');
  }
  const binding: MutableBinding = {
    candidate: {
      kind: 'fix-applied',
      planVersion: 0,
      contentDigest: 'f'.repeat(64),
    },
    lineage: {
      evaluationStage: 'fix-applied-review',
      lineageDigest: '9'.repeat(64),
    },
  };
  Object.assign(sourceAt(final, 'fix-reviewer'), {
    required: true,
    available: true,
    catalogExact: true,
    current: true,
    consistent: true,
    conclusive: true,
    reason: 'fix-pass-replacement-retained',
    expectedBinding: structuredClone(binding),
    snapshot: {
      source: 'fix-reviewer',
      catalogDigest: coverage.catalogDigest,
      binding: structuredClone(binding),
      occurrences: structuredClone(criticSnapshot.occurrences),
    },
  });
  return final;
}

function needsReviewProjection(workDir: string): MutableFinalProjection {
  const final = mutableFinalProjection(workDir);
  final.status = 'needs-review';
  final.reasons = ['Readiness proof: unable-to-decide:fresh-review-required'];
  final.readiness.decision = 'unable-to-decide';
  final.readiness.reasonCodes = ['fresh-review-required'];
  final.readiness.satisfied = false;
  final.readiness.unresolvedProofIds = ['canonical-plan:fresh-review-required'];
  return final;
}

function persistFinalProjection(written: RunRecord, final: MutableFinalProjection): Buffer {
  const file = runRecordPath(stateDir, written.runId);
  const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  stored.state = final.status === 'blocked' ? 'blocked' : 'finished';
  stored.exitCode = final.status === 'blocked' ? 6 : 0;
  stored.endedAt = recentRunTimestamp();
  stored.final = final;
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
  return readFileSync(file);
}

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-runstore.'));
  randomQueue.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('run identity', () => {
  it('generateRunId yields a sortable, non-digit-leading id', () => {
    const id = generateRunId();
    expect(id).toMatch(/^r[0-9a-z]+-[0-9a-f]+$/);
    expect(/^[0-9]/.test(id)).toBe(false);
  });

  it('deriveRunName suffixes only on a tracked collision', () => {
    expect(deriveRunName([], 'feat')).toBe('feat');
    const first = [record({ runId: 'r1', name: 'feat' })];
    expect(deriveRunName(first, 'feat')).toBe('feat-2');
    const second = [...first, record({ runId: 'r2', name: 'feat-2' })];
    expect(deriveRunName(second, 'feat')).toBe('feat-3');
  });

  it('runNameFromWorkdir strips the loop- prefix', () => {
    expect(runNameFromWorkdir('/x/loop-feat')).toBe('feat');
    expect(runNameFromWorkdir('/x/custom')).toBe('custom');
  });
});

describe('run records', () => {
  it('writeRunRecord mints a non-digit id and a finalize round-trip preserves real paths', () => {
    const written = writeRunRecord(stateDir, draft());
    expect(written.schemaVersion).toBe(RUN_RECORD_SCHEMA_VERSION);
    expect(/^[0-9]/.test(written.runId)).toBe(false);
    expect(existsSync(runRecordPath(stateDir, written.runId))).toBe(true);

    finalizeRunRecord(stateDir, written.runId, {
      state: 'finished',
      exitCode: 0,
      final: finalProjection(written.workDir),
      endedAt: recentRunTimestamp(),
    });

    const all = readRunRecords(stateDir);
    expect(all).toHaveLength(1);
    const read = all[0];
    expect(read?.runId).toBe(written.runId);
    expect(read?.state).toBe('finished');
    expect(read?.exitCode).toBe(0);
    expect(read?.final).toEqual(finalProjection(written.workDir));
    expect(read?.workDir).toBe(written.workDir);
    expect(read?.logPath).toBe(written.logPath);
  });

  it('regenerates and retries when the generated record path already exists', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    const bufA = Buffer.alloc(10, 0xaa);
    const bufB = Buffer.alloc(10, 0xbb);
    randomQueue.push(bufA, bufA, bufB);

    const first = writeRunRecord(stateDir, draft());
    const second = writeRunRecord(stateDir, draft());

    expect(second.runId).not.toBe(first.runId);
    expect(existsSync(runRecordPath(stateDir, first.runId))).toBe(true);
    expect(existsSync(runRecordPath(stateDir, second.runId))).toBe(true);
  });

  it('throws for a fixedRunId collision instead of regenerating', () => {
    const existing = writeRunRecord(stateDir, draft());
    expect(() => writeRunRecord(stateDir, draft(), { fixedRunId: existing.runId })).toThrow(
      HaltError,
    );
  });

  it('skips an unsupported pre-version record without rewriting it', () => {
    const written = writeRunRecord(stateDir, draft());
    const file = runRecordPath(stateDir, written.runId);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete stored.schemaVersion;
    writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
    const before = readFileSync(file);

    expect(readRunRecords(stateDir)).toEqual([]);
    expect(readFileSync(file)).toEqual(before);
  });

  it('skips an unrecognized future schema version without rewriting it', () => {
    const written = writeRunRecord(stateDir, draft());
    const file = runRecordPath(stateDir, written.runId);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    stored.schemaVersion = RUN_RECORD_SCHEMA_VERSION + 1;
    writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
    const before = readFileSync(file);

    expect(readRunRecords(stateDir)).toEqual([]);
    expect(readFileSync(file)).toEqual(before);
  });

  it('skips a malformed current final projection without rewriting it', () => {
    const written = writeRunRecord(stateDir, draft());
    const file = runRecordPath(stateDir, written.runId);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    stored.state = 'finished';
    stored.exitCode = 0;
    stored.endedAt = recentRunTimestamp();
    stored.final = { ...finalProjection(written.workDir), status: 'ready' };
    writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
    const before = readFileSync(file);

    expect(readRunRecords(stateDir)).toEqual([]);
    expect(readFileSync(file)).toEqual(before);
  });

  it('skips inconsistent occurrence aggregates without rewriting them', () => {
    const written = writeRunRecord(stateDir, draft());
    const file = runRecordPath(stateDir, written.runId);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const final = structuredClone(finalProjection(written.workDir)) as unknown as {
      readiness: { occurrenceCoverage: { outcomes: { outcome: string }[] } };
    };
    const outcome = final.readiness.occurrenceCoverage.outcomes[0];
    if (outcome === undefined) {
      throw new Error('canonical fixture did not project its occurrence');
    }
    outcome.outcome = 'violated';
    stored.state = 'finished';
    stored.exitCode = 0;
    stored.endedAt = recentRunTimestamp();
    stored.final = final;
    writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
    const before = readFileSync(file);

    expect(readRunRecords(stateDir)).toEqual([]);
    expect(readFileSync(file)).toEqual(before);
  });

  it.each([
    {
      name: 'snapshot catalog digest',
      mutate: (final: MutableFinalProjection): void => {
        const snapshot = sourceAt(final, 'critic').snapshot;
        if (snapshot === undefined) {
          throw new TypeError('fixture critic snapshot is unavailable');
        }
        snapshot.catalogDigest = 'e'.repeat(64);
      },
    },
    {
      name: 'snapshot binding',
      mutate: (final: MutableFinalProjection): void => {
        const snapshot = sourceAt(final, 'critic').snapshot;
        if (snapshot === undefined) {
          throw new TypeError('fixture critic snapshot is unavailable');
        }
        snapshot.binding.lineage.lineageDigest = 'e'.repeat(64);
      },
    },
    {
      name: 'snapshot occurrence tuple',
      mutate: (final: MutableFinalProjection): void => {
        const occurrence = sourceAt(final, 'critic').snapshot?.occurrences[0];
        if (occurrence === undefined) {
          throw new TypeError('fixture critic occurrence is unavailable');
        }
        occurrence.invariantId = 'I-forged';
      },
    },
    {
      name: 'omitted snapshot occurrence',
      mutate: (final: MutableFinalProjection): void => {
        const snapshot = sourceAt(final, 'critic').snapshot;
        if (snapshot === undefined) {
          throw new TypeError('fixture critic snapshot is unavailable');
        }
        snapshot.occurrences = [];
      },
    },
    {
      name: 'duplicate snapshot occurrence',
      mutate: (final: MutableFinalProjection): void => {
        const snapshot = sourceAt(final, 'critic').snapshot;
        const occurrence = snapshot?.occurrences[0];
        if (snapshot === undefined || occurrence === undefined) {
          throw new TypeError('fixture critic occurrence is unavailable');
        }
        snapshot.occurrences.push(structuredClone(occurrence));
      },
    },
    {
      name: 'derived source currency flag',
      mutate: (final: MutableFinalProjection): void => {
        sourceAt(final, 'critic').current = false;
      },
    },
    {
      name: 'snapshot on an exempt source',
      mutate: (final: MutableFinalProjection): void => {
        const coverage = final.readiness.occurrenceCoverage;
        const criticSnapshot = sourceAt(final, 'critic').snapshot;
        if (criticSnapshot === undefined) {
          throw new TypeError('fixture critic snapshot is unavailable');
        }
        sourceAt(final, 'fix-reviewer').snapshot = {
          source: 'fix-reviewer',
          catalogDigest: coverage.catalogDigest,
          binding: {
            candidate: {
              kind: 'fix-proposal',
              planVersion: 0,
              contentDigest: 'e'.repeat(64),
            },
            lineage: {
              evaluationStage: 'fix-proposal-review',
              lineageDigest: 'f'.repeat(64),
            },
          },
          occurrences: structuredClone(criticSnapshot.occurrences),
        };
      },
    },
  ])('skips a projection with a forged $name', ({ mutate }) => {
    const written = writeRunRecord(stateDir, draft());
    const final = mutableFinalProjection(written.workDir);
    mutate(final);
    const before = persistFinalProjection(written, final);

    expect(readRunRecords(stateDir)).toEqual([]);
    expect(readFileSync(runRecordPath(stateDir, written.runId))).toEqual(before);
  });

  it('rejects a coherently substituted catalog digest across coverage and snapshots', () => {
    const written = writeRunRecord(stateDir, draft());
    const final = mutableFinalProjection(written.workDir);
    const coverage = final.readiness.occurrenceCoverage;
    const substitutedDigest = 'e'.repeat(64);
    coverage.catalogDigest = substitutedDigest;
    for (const source of coverage.sources) {
      if (source.snapshot !== undefined) {
        source.snapshot.catalogDigest = substitutedDigest;
      }
    }
    const before = persistFinalProjection(written, final);

    expect(readRunRecords(stateDir)).toEqual([]);
    expect(readFileSync(runRecordPath(stateDir, written.runId))).toEqual(before);
  });

  it.each(['critic', 'fix-reviewer', 'intermediate-judge', 'final-judge'] as const)(
    'rejects an arbitrary durable source reason for %s',
    (source) => {
      const written = writeRunRecord(stateDir, draft());
      const final = mutableFinalProjection(written.workDir);
      sourceAt(final, source).reason = 'provider-supplied-reason';
      persistFinalProjection(written, final);

      expect(readRunRecords(stateDir)).toEqual([]);
    },
  );

  it.each(['fix-reviewer', 'intermediate-judge', 'final-judge'] as const)(
    'rejects an arbitrary durable required reason for %s',
    (source) => {
      const written = writeRunRecord(stateDir, draft());
      const final =
        source === 'fix-reviewer'
          ? requiredFixProjection(written.workDir)
          : requiredJudgeProjection(written.workDir);
      sourceAt(final, source).reason = 'provider-supplied-reason';
      persistFinalProjection(written, final);

      expect(readRunRecords(stateDir)).toEqual([]);
    },
  );

  it('accepts the stable required fix-reviewer source reason', () => {
    const written = writeRunRecord(stateDir, draft());
    const final = requiredFixProjection(written.workDir);

    finalizeRunRecord(stateDir, written.runId, {
      state: 'finished',
      exitCode: 0,
      endedAt: recentRunTimestamp(),
      final: final as unknown as FinalProjection,
    });

    expect(readRunRecords(stateDir)[0]?.final).toEqual(final);
  });

  it('accepts a canonically projected non-ready reduction', () => {
    const written = writeRunRecord(stateDir, draft());
    const final = needsReviewProjection(written.workDir);

    finalizeRunRecord(stateDir, written.runId, {
      state: 'finished',
      exitCode: 0,
      endedAt: recentRunTimestamp(),
      final: final as unknown as FinalProjection,
    });

    expect(readRunRecords(stateDir)[0]?.final).toEqual(final);
  });

  it.each([
    {
      name: 'unknown readiness reason',
      mutate: (final: MutableFinalProjection): void => {
        final.readiness.reasonCodes = ['SECRET BODY'];
        final.reasons = ['Readiness proof: unable-to-decide:SECRET BODY'];
      },
    },
    {
      name: 'noncanonical readiness reason order',
      mutate: (final: MutableFinalProjection): void => {
        final.readiness.reasonCodes = ['risk-applicability-unresolved', 'boundary-challenge'];
        final.reasons = [
          'Readiness proof: unable-to-decide:risk-applicability-unresolved,boundary-challenge',
        ];
      },
    },
    {
      name: 'provider text in an unresolved proof ID',
      mutate: (final: MutableFinalProjection): void => {
        final.readiness.unresolvedProofIds = ['SECRET BODY'];
      },
    },
    {
      name: 'arbitrary final reason',
      mutate: (final: MutableFinalProjection): void => {
        final.reasons = ['SECRET BODY'];
      },
    },
  ])('rejects a non-ready projection with $name', ({ mutate }) => {
    const written = writeRunRecord(stateDir, draft());
    const final = needsReviewProjection(written.workDir);
    mutate(final);
    persistFinalProjection(written, final);

    expect(readRunRecords(stateDir)).toEqual([]);
  });

  it('requires limits-exhausted reasons to equal the canonical exhausted limits', () => {
    const written = writeRunRecord(stateDir, draft());
    const final = needsReviewProjection(written.workDir);
    final.readiness.decision = 'limits-exhausted';
    final.readiness.reasonCodes = ['iteration-cap'];
    final.readiness.exhaustedLimits = ['issue-budget'];
    final.reasons = ['Readiness proof: limits-exhausted:iteration-cap'];
    persistFinalProjection(written, final);

    expect(readRunRecords(stateDir)).toEqual([]);
  });

  it('rejects structural prose outside the finalizer aggregate vocabulary', () => {
    const written = writeRunRecord(stateDir, draft());
    const final = mutableFinalProjection(written.workDir);
    final.status = 'needs-review';
    final.structuralStatus = 'needs-review';
    final.structuralReason = 'SECRET BODY';
    final.reasons = ['SECRET BODY', 'finalization:monotonic-downgrade'];
    persistFinalProjection(written, final);

    expect(readRunRecords(stateDir)).toEqual([]);
  });

  it('rejects a clean status when the projected candidate is known to have changed', () => {
    const written = writeRunRecord(stateDir, draft());
    const final = mutableFinalProjection(written.workDir);
    final.judge.candidateUnchanged = false;
    final.judge.rationale = 'final-candidate-mutated-during-localization';
    persistFinalProjection(written, final);

    expect(readRunRecords(stateDir)).toEqual([]);
  });

  it.each([
    {
      name: 'readiness reason',
      mutate: (final: MutableFinalProjection): void => {
        final.readiness.reasonCodes = ['forged-ready-reason'];
      },
    },
    {
      name: 'exhausted limit',
      mutate: (final: MutableFinalProjection): void => {
        final.readiness.exhaustedLimits = ['iteration-cap'];
      },
    },
    {
      name: 'unresolved proof ID',
      mutate: (final: MutableFinalProjection): void => {
        final.readiness.unresolvedProofIds = ['proof:still-unresolved'];
      },
    },
  ])('rejects a ready projection that retains a $name', ({ mutate }) => {
    const written = writeRunRecord(stateDir, draft());
    const final = mutableFinalProjection(written.workDir);
    mutate(final);
    persistFinalProjection(written, final);

    expect(readRunRecords(stateDir)).toEqual([]);
  });

  it('requires both Judge occurrence sources when high-risk domains are projected', () => {
    const written = writeRunRecord(stateDir, draft());
    const final = mutableFinalProjection(written.workDir);
    final.readiness.applicableRiskDomains = ['correctness'];
    final.readiness.highRiskDomains = ['correctness'];
    persistFinalProjection(written, final);

    expect(readRunRecords(stateDir)).toEqual([]);
  });

  it('cross-links Judge requirement and binding to the final-Judge occurrence source', () => {
    const valid = writeRunRecord(stateDir, draft({ name: 'valid-required-judge' }));
    const required = requiredJudgeProjection(valid.workDir);
    finalizeRunRecord(stateDir, valid.runId, {
      state: 'finished',
      exitCode: 0,
      endedAt: recentRunTimestamp(),
      final: required as unknown as FinalProjection,
    });
    expect(readRunRecords(stateDir).map((entry) => entry.runId)).toContain(valid.runId);

    const mismatchedRequirement = writeRunRecord(
      stateDir,
      draft({ name: 'mismatched-requirement' }),
    );
    const forgedRequirement = mutableFinalProjection(mismatchedRequirement.workDir);
    forgedRequirement.judge.required = true;
    forgedRequirement.judge.rationale = 'final-judge-proof-unavailable';
    persistFinalProjection(mismatchedRequirement, forgedRequirement);

    const missingBinding = writeRunRecord(stateDir, draft({ name: 'missing-binding' }));
    const forgedBinding = requiredJudgeProjection(missingBinding.workDir);
    delete forgedBinding.judge.binding;
    expect(() => {
      finalizeRunRecord(stateDir, missingBinding.runId, {
        state: 'finished',
        exitCode: 0,
        endedAt: recentRunTimestamp(),
        final: forgedBinding as unknown as FinalProjection,
      });
    }).toThrow('run record patch is invalid');

    expect(
      readRunRecords(stateDir)
        .filter((entry) => entry.final !== undefined)
        .map((entry) => entry.runId),
    ).toEqual([valid.runId]);
  });

  it('rejects arbitrary Judge rationale text from the durable projection', () => {
    const written = writeRunRecord(stateDir, draft());
    const final = mutableFinalProjection(written.workDir);
    final.judge.rationale = 'provider supplied raw rationale';
    persistFinalProjection(written, final);

    expect(readRunRecords(stateDir)).toEqual([]);
  });

  it('rejects a stable Judge rationale that contradicts its verdict', () => {
    const written = writeRunRecord(stateDir, draft());
    const final = requiredJudgeProjection(written.workDir);
    final.judge.rationale = 'final-judge-not-ready';
    persistFinalProjection(written, final);

    expect(readRunRecords(stateDir)).toEqual([]);
  });

  it.each([
    { state: 'failed' as const, exitCode: 1 },
    { state: 'blocked' as const, exitCode: 6 },
    { state: 'finished' as const, exitCode: 6 },
  ])('rejects a clean final projection on $state lifecycle facts', ({ state, exitCode }) => {
    const written = writeRunRecord(stateDir, draft());
    expect(() => {
      finalizeRunRecord(stateDir, written.runId, {
        state,
        exitCode,
        endedAt: recentRunTimestamp(),
        final: finalProjection(written.workDir),
      });
    }).toThrow('run record patch is invalid');
  });

  it('skips a current finished record without a final projection and leaves it unchanged', () => {
    const written = writeRunRecord(stateDir, draft());
    const file = runRecordPath(stateDir, written.runId);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    stored.state = 'finished';
    stored.exitCode = 0;
    stored.endedAt = recentRunTimestamp();
    writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
    const before = readFileSync(file);

    expect(readRunRecords(stateDir)).toEqual([]);
    expect(readFileSync(file)).toEqual(before);
  });

  it('rejects internal finalization state from the durable public projection', () => {
    const written = writeRunRecord(stateDir, draft());
    expect(() => {
      finalizeRunRecord(stateDir, written.runId, {
        state: 'finished',
        exitCode: 0,
        endedAt: recentRunTimestamp(),
        final: {
          ...finalProjection(written.workDir),
          proof: { rawProviderEvidence: 'must-not-persist' },
        } as FinalProjection,
      });
    }).toThrow('run record patch is invalid');
    expect(readRunRecords(stateDir)[0]?.final).toBeUndefined();
  });
});

describe('readRunRecordsAcross', () => {
  it('unions records across stores and dedupes repeated/trailing-slash derivations', () => {
    const other = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-runstore-b.'));
    try {
      const a = writeRunRecord(stateDir, draft({ name: 'alpha' }));
      const b = writeRunRecord(other, draft({ name: 'beta' }));

      const union = readRunRecordsAcross([stateDir, other]);
      expect(union.map((entry) => entry.runId).sort()).toEqual([a.runId, b.runId].sort());

      const deduped = readRunRecordsAcross([stateDir, `${stateDir}/`, stateDir]);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.runId).toBe(a.runId);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('collapses a symlinked duplicate store to a single read', () => {
    const written = writeRunRecord(stateDir, draft({ name: 'alpha' }));
    const linkParent = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-runstore-link.'));
    const link = path.join(linkParent, 'state-link');
    symlinkSync(stateDir, link);
    try {
      const deduped = readRunRecordsAcross([stateDir, link]);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.runId).toBe(written.runId);
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
    }
  });

  it('skips a missing or non-directory store without throwing', () => {
    const written = writeRunRecord(stateDir, draft({ name: 'alpha' }));
    const missing = path.join(stateDir, 'does-not-exist');
    const file = path.join(stateDir, 'a-file');
    writeFileSync(file, 'not a directory\n');
    const union = readRunRecordsAcross([missing, file, stateDir]);
    expect(union).toHaveLength(1);
    expect(union[0]?.runId).toBe(written.runId);
  });

  it('returns an empty array for empty input', () => {
    expect(readRunRecordsAcross([])).toEqual([]);
  });

  it('never rewrites record files', () => {
    const written = writeRunRecord(stateDir, draft({ name: 'alpha' }));
    const file = runRecordPath(stateDir, written.runId);
    const before = readFileSync(file);
    readRunRecordsAcross([stateDir, stateDir]);
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});

describe('resolveRunState', () => {
  const live: RunStateProbes = {
    isAlive: () => true,
    pgidOf: () => '4242',
    procStartToken: () => 'tok-1',
  };
  const dead: RunStateProbes = {
    isAlive: () => false,
    pgidOf: () => undefined,
    procStartToken: () => undefined,
  };
  const recycledPid: RunStateProbes = {
    isAlive: () => true,
    pgidOf: () => '4242',
    procStartToken: () => 'tok-RECYCLED',
  };

  it('keeps a genuinely live running record running', () => {
    expect(resolveRunState(record(), live)).toBe('running');
  });

  it('infers finished/failed for a dead running record by plan presence', () => {
    const rec = record();
    expect(resolveRunState(rec, dead)).toBe('failed');
    mkdirSync(rec.workDir, { recursive: true });
    writeFileSync(path.join(rec.workDir, 'plan.final.md'), '# done\n');
    expect(resolveRunState(rec, dead)).toBe('finished');
  });

  it('rejects a pgid-matching record whose start token no longer matches', () => {
    const rec = record();
    expect(resolveRunState(rec, recycledPid)).toBe('failed');
    mkdirSync(rec.workDir, { recursive: true });
    writeFileSync(path.join(rec.workDir, 'plan.final.md'), '# done\n');
    expect(resolveRunState(rec, recycledPid)).toBe('finished');
  });

  it('returns an already-terminal state unchanged', () => {
    expect(resolveRunState(record({ state: 'finished' }), dead)).toBe('finished');
  });
});

describe('pruneRuns', () => {
  function seedFinished(name: string, startedAt: string): string {
    const written = writeRunRecord(stateDir, draft({ name, startedAt }));
    finalizeRunRecord(stateDir, written.runId, {
      state: 'finished',
      exitCode: 0,
      endedAt: startedAt,
      final: finalProjection(written.workDir),
    });
    return written.runId;
  }

  it('removes terminal records beyond keepCount, keeps running, and dry-run removes none', () => {
    const running = writeRunRecord(stateDir, draft({ name: 'live' }));
    for (let i = 0; i < 4; i += 1) {
      seedFinished(`done-${i}`, recentRunTimestamp(4 - i));
    }

    const dry = pruneRuns(stateDir, { keepCount: 2, dryRun: true }, RETAIN_DEFAULTS);
    expect(dry.removed).toHaveLength(2);
    expect(readRunRecords(stateDir)).toHaveLength(5);

    const real = pruneRuns(stateDir, { keepCount: 2 }, RETAIN_DEFAULTS);
    expect(real.removed).toHaveLength(2);
    const remaining = readRunRecords(stateDir);
    expect(remaining).toHaveLength(3);
    expect(remaining.some((entry) => entry.runId === running.runId)).toBe(true);
  });

  it('removes terminal records older than maxAgeDays', () => {
    const old = seedFinished('old', '2020-01-01T00:00:00Z');
    const recent = seedFinished('recent', recentRunTimestamp());
    const result = pruneRuns(stateDir, { keepCount: 100, maxAgeDays: 30 }, RETAIN_DEFAULTS);
    expect(result.removed).toContain(old);
    expect(result.removed).not.toContain(recent);
  });

  it('resolved defaults bound retention when the policy omits the field', () => {
    for (let i = 0; i < 4; i += 1) {
      seedFinished(`done-${i}`, recentRunTimestamp(4 - i));
    }
    const result = pruneRuns(stateDir, {}, { keepCount: 1, maxAgeDays: 0 });
    expect(result.removed).toHaveLength(3);
    expect(readRunRecords(stateDir)).toHaveLength(1);
  });

  it('an explicit policy keepCount overrides the resolved default', () => {
    for (let i = 0; i < 4; i += 1) {
      seedFinished(`done-${i}`, recentRunTimestamp(4 - i));
    }
    const result = pruneRuns(stateDir, { keepCount: 3 }, { keepCount: 1, maxAgeDays: 0 });
    expect(result.removed).toHaveLength(1);
  });
});
