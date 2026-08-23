import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildReadinessContract, RISK_DOMAINS } from '../../src/core/readiness-contract.js';
import { sha256 } from '../../src/core/digest.js';
import {
  applyFrozenReadinessContract,
  createReadinessProofCatalog,
  createReadinessProofState,
  projectOccurrenceCoverage,
  type RawOccurrenceDisposition,
  type ReadinessProofState,
} from '../../src/core/readiness-proof.js';
import { qualityMatrix } from '../../src/core/quality.js';
import { Scratch } from '../../src/runtime/scratch.js';
import {
  FINAL_JUDGE_METADATA,
  FINAL_JUDGE_METADATA_SCHEMA_VERSION,
  judgePrompt,
  runFinalJudge,
  runJudge,
} from '../../src/stages/plan/judge.js';
import { makeTestRunContext } from '../helpers/test-context.js';
import { captureStderr } from '../helpers/harness.js';
import type { StderrCapture } from '../helpers/harness.js';

vi.mock('../../src/providers/provider.js', () => ({
  providerRun: vi.fn(),
}));

const { providerRun } = await import('../../src/providers/provider.js');
const mockProviderRun = vi.mocked(providerRun);

const PLAN_CONTENT = '# Plan\n\nFixture plan content.\n';
const OCCURRENCE_IDS = ['O1', 'O2', 'O3', 'O4'] as const;
const EVIDENCE_REFS = [{ kind: 'plan-section', section: 'Plan' }] as const;

let tmp: string;
let work: string;
let scratch: Scratch;
let planFile: string;
let critiqueFile: string;
let outFile: string;
let capture: StderrCapture;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-judgetest.'));
  work = path.join(tmp, 'work');
  mkdirSync(work);
  scratch = Scratch.create('judge-test');
  planFile = path.join(work, 'plan.v0.md');
  critiqueFile = path.join(work, 'critique.v0.json');
  outFile = path.join(work, 'judge.v0.json');
  writeFileSync(planFile, PLAN_CONTENT);
  writeFileSync(critiqueFile, '{}\n');
  capture = captureStderr();
  vi.clearAllMocks();
});

afterEach(() => {
  capture.restore();
  scratch.sweep();
  rmSync(tmp, { recursive: true, force: true });
});

function proofState(): ReadinessProofState {
  const catalog = createReadinessProofCatalog({
    expectedPlanVersion: 0,
    invariants: [{ invariantId: 'I1', occurrenceIds: OCCURRENCE_IDS }],
    materialIssueIds: [],
  });
  const initial = createReadinessProofState({
    quality: 'balanced',
    matrix: qualityMatrix('balanced'),
    mode: 'plan',
    sourceDigest: '6'.repeat(64),
    authoritativeDigest: '7'.repeat(64),
    relationshipIds: [],
    maxIters: 2,
    trustedCatalog: catalog,
    invariants: [
      {
        id: 'I1',
        sourceFinding: 'F1',
        statement: 'The candidate remains implementation-ready.',
        occurrences: OCCURRENCE_IDS.map((id) => ({
          id,
          dimension: 'candidate',
          subject: id,
        })),
      },
    ],
  });
  const contract = buildReadinessContract({
    assessment: {
      boundary: {
        goal: 'Judge the exact candidate.',
        in_scope: ['current repository'],
        out_of_scope: [],
        constraints: [],
      },
      domain_assessments: RISK_DOMAINS.map((domain) => ({
        domain,
        applicability: domain === 'correctness' ? 'applicable' : 'not-applicable',
        risk: domain === 'correctness' ? 'high' : 'standard',
        rationale: `${domain} assessment`,
        evidence_refs: [],
      })),
      material_questions: [],
    },
    sourceDigest: initial.sourceDigest,
    systemDigest: initial.authoritativeDigest,
    quality: initial.quality,
    iterationLimit: initial.iterationLimit,
    issueBudget: initial.issueBudget.limit,
    operatorDecisionIds: [],
  });
  return applyFrozenReadinessContract(initial, contract);
}

function makeContext(state = proofState()) {
  const ctx = makeTestRunContext(tmp, work, scratch, {
    quality: 'balanced',
    maxIters: 2,
  });
  ctx.readinessProof = state;
  return ctx;
}

function judgeOutput(
  changed: Partial<Record<(typeof OCCURRENCE_IDS)[number], RawOccurrenceDisposition>> = {},
  options: {
    readonly ready?: boolean;
    readonly rationale?: string;
    readonly revisionIssue?: unknown;
  } = {},
) {
  const dispositions = Object.fromEntries(
    OCCURRENCE_IDS.map((id) => [id, changed[id] ?? 'satisfied']),
  ) as Record<(typeof OCCURRENCE_IDS)[number], RawOccurrenceDisposition>;
  const unresolved = OCCURRENCE_IDS.filter((id) => dispositions[id] === 'unresolved');
  const conclusive = OCCURRENCE_IDS.every(
    (id) => dispositions[id] !== 'violated' && dispositions[id] !== 'unresolved',
  );
  return {
    ready: options.ready ?? conclusive,
    rationale: options.rationale ?? 'Exact coverage evaluated.',
    revision_issue: options.revisionIssue ?? null,
    coverage_complete: true,
    unresolved_occurrence_ids: unresolved,
    invariant_assessments: [
      {
        invariant_id: 'I1',
        occurrences: OCCURRENCE_IDS.map((id) => ({
          occurrence_id: id,
          disposition: dispositions[id],
          evidence_refs: dispositions[id] === 'unresolved' ? [] : EVIDENCE_REFS,
        })),
      },
    ],
  };
}

function mockOutput(
  output: unknown,
  options: { readonly status?: number; readonly mutateCandidate?: boolean } = {},
): void {
  mockProviderRun.mockImplementation(
    (_provider, _role, _mode, file, _skill, _schema, _tools, _disallowed, _prompt, runOptions) => {
      if ((options.status ?? 0) !== 0) {
        return Promise.resolve(options.status ?? 1);
      }
      writeFileSync(file, typeof output === 'string' ? output : JSON.stringify(output));
      const valid = runOptions?.validateOutput?.(file) ?? true;
      if (options.mutateCandidate) {
        writeFileSync(planFile, `${PLAN_CONTENT}\nMutated during Judge evaluation.\n`);
      }
      return Promise.resolve(valid ? 0 : 1);
    },
  );
}

describe('runJudge', () => {
  it.each([
    ['satisfied', 'satisfied', true],
    ['not-applicable', 'not-applicable', true],
    ['violated', 'violated', false],
    ['unresolved', 'unresolved', false],
  ] as const)(
    'admits the %s disposition against exact candidate bytes',
    async (_label, disposition, ready) => {
      mockOutput(judgeOutput({ O2: disposition }));
      const state = proofState();
      const ctx = makeContext(state);
      const stateBefore = JSON.stringify(state);
      const coverageBefore = projectOccurrenceCoverage(state);

      const result = await runJudge(ctx, state, 0, planFile, critiqueFile, outFile);

      expect(result.available).toBe(true);
      if (!result.available) {
        throw new Error('Judge result should be available');
      }
      expect(result.admitted.verdict).toBe(ready);
      expect(result.rationale).toBe(
        ready ? 'intermediate-judge-ready' : 'intermediate-judge-not-ready',
      );
      expect(
        result.admitted.snapshot.occurrences.find((entry) => entry.occurrenceId === 'O2'),
      ).toEqual({
        invariantId: 'I1',
        occurrenceId: 'O2',
        disposition,
        evidenceGrounded: disposition !== 'unresolved',
      });
      expect(result.binding).toEqual(result.admitted.snapshot.binding);
      expect(result.binding.candidate).toEqual({
        kind: 'versioned-plan',
        planVersion: 0,
        contentDigest: sha256(Buffer.from(PLAN_CONTENT)),
      });
      expect(result.candidateUnchanged).toBe(true);
      expect(JSON.stringify(state)).toBe(stateBefore);
      expect(ctx.readinessProof).not.toBe(state);
      expect(projectOccurrenceCoverage(ctx.readinessProof)).toEqual(coverageBefore);
      expect(ctx.readinessProof.contextDeliveries).toEqual([
        expect.objectContaining({ role: 'judge', stage: 'intermediate-readiness', planVersion: 0 }),
      ]);
      expect(
        ctx.readinessProof.sources.find((source) => source.source === 'intermediate-judge'),
      ).not.toHaveProperty('snapshot');
      expect(ctx.readinessProof.judgeEvaluatedPlanVersion).toBeUndefined();

      const prompt = mockProviderRun.mock.calls[0]?.[8] ?? '';
      expect(prompt).toContain(`plan_sha256: ${result.binding.candidate.contentDigest}`);
      expect(prompt).toContain(
        `occurrence_source_lineage_digest: ${result.binding.lineage.lineageDigest}`,
      );
    },
  );

  it('returns one admitted grounded revision fact for an intermediate negative verdict', async () => {
    mockOutput(
      judgeOutput(
        {},
        {
          ready: false,
          rationale: 'One concrete gap remains.',
          revisionIssue: {
            severity: 'major',
            category: 'clarity',
            claim: 'The candidate leaves one decision open.',
            evidence: 'The Plan section contains the open decision.',
            evidence_refs: EVIDENCE_REFS,
            suggested_fix: 'Resolve the decision in the Plan section.',
          },
        },
      ),
    );

    const state = proofState();
    const result = await runJudge(makeContext(state), state, 0, planFile, critiqueFile, outFile);

    expect(result.available).toBe(true);
    if (!result.available) {
      throw new Error('Judge result should be available');
    }
    expect(result.admitted.revisionIssue).toMatchObject({
      severity: 'major',
      claim: 'The candidate leaves one decision open.',
    });
    expect(result.admitted.materialIssueIds[0]).toMatch(/^judge-revision-[a-f0-9]{64}$/);
  });

  it.each([
    ['missing output', undefined],
    ['malformed output', 'not valid json{{{'],
    ['schema-incomplete output', { ready: true }],
  ])('keeps proof unavailable for %s', async (_label, output) => {
    if (output === undefined) {
      mockProviderRun.mockResolvedValue(0);
    } else {
      mockOutput(output);
    }

    const state = proofState();
    const result = await runJudge(makeContext(state), state, 0, planFile, critiqueFile, outFile);

    expect(result).toMatchObject({
      available: false,
      stage: 'intermediate',
      candidateUnchanged: true,
      rationale: 'intermediate-judge-proof-unavailable',
    });
  });

  it('keeps proof unavailable on provider failure', async () => {
    mockOutput({}, { status: 124 });
    const state = proofState();

    const result = await runJudge(makeContext(state), state, 0, planFile, critiqueFile, outFile);

    expect(result.available).toBe(false);
    expect(capture.text()).toContain('proof unavailable');
  });

  it('rejects an explicit proof state that is not the current run-context state', async () => {
    const state = proofState();
    const ctx = makeContext(proofState());

    await expect(runJudge(ctx, state, 0, planFile, critiqueFile, outFile)).rejects.toThrow(
      'requires the current run-context proof state',
    );
    expect(mockProviderRun).not.toHaveBeenCalled();
  });

  it('detects intermediate candidate mutation without mutating proof state', async () => {
    mockOutput(judgeOutput(), { mutateCandidate: true });
    const state = proofState();
    const before = JSON.stringify(state);

    const result = await runJudge(makeContext(state), state, 0, planFile, critiqueFile, outFile);

    expect(result).toMatchObject({
      available: true,
      candidateUnchanged: false,
      rationale: 'intermediate-judge-candidate-mutated',
    });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('labels intermediate critique context as current', () => {
    const prompt = judgePrompt(planFile, critiqueFile);
    expect(prompt).toContain('scope: intermediate');
    expect(prompt).toContain('critique_context: current critique for this plan revision');
  });
});

describe('runFinalJudge', () => {
  it('persists privacy-safe schema-v2 metadata with exact plan and proof identity', async () => {
    const providerRationale = 'JUDGE_PROVIDER_RATIONALE_SECRET_6c7f83';
    mockOutput(judgeOutput({}, { rationale: providerRationale }));
    const state = proofState();
    const ctx = makeContext(state);
    ctx.lastCritiqueIter = 0;

    const result = await runFinalJudge(ctx, state, planFile);

    expect(result.available).toBe(true);
    expect(result.candidateUnchanged).toBe(true);
    expect(result.metadataPath).toBe(path.join(work, FINAL_JUDGE_METADATA));
    expect(ctx.readinessProof.contextDeliveries).toEqual([
      expect.objectContaining({ role: 'judge', stage: 'final-readiness', planVersion: 0 }),
    ]);
    expect(
      ctx.readinessProof.sources.find((source) => source.source === 'final-judge'),
    ).not.toHaveProperty('snapshot');
    expect(ctx.readinessProof.judgeEvaluatedPlanVersion).toBeUndefined();
    expect(result.binding.candidate.contentDigest).toBe(sha256(Buffer.from(PLAN_CONTENT)));
    expect(readFileSync(path.join(work, 'judge.final.json'), 'utf8')).toBe(
      readFileSync(path.join(work, 'judge.final.raw'), 'utf8'),
    );

    const metadata = JSON.parse(readFileSync(result.metadataPath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(metadata).toMatchObject({
      schemaVersion: FINAL_JUDGE_METADATA_SCHEMA_VERSION,
      canonicalPlan: 'plan.final.md',
      planVersion: 0,
      planSha256: sha256(Buffer.from(PLAN_CONTENT)),
      observedPlanSha256: sha256(Buffer.from(PLAN_CONTENT)),
      readinessContractDigest: state.readinessContractDigest,
      catalogDigest: state.catalog.digest,
      source: 'final-judge',
      binding: result.binding,
      evaluated: true,
      available: true,
      candidateUnchanged: true,
      ready: true,
      rationale: 'final-judge-ready',
      verdictArtifact: 'judge.final.json',
      occurrenceProof: {
        coverageComplete: true,
        satisfied: true,
        unresolvedOccurrenceIds: [],
        violatedOccurrenceIds: [],
        materialIssueIds: [],
      },
    });
    expect(result.rationale).toBe('final-judge-ready');
    expect(JSON.stringify(metadata)).not.toContain(providerRationale);
    expect(JSON.stringify(metadata)).not.toContain('evidence_refs');
    expect(JSON.stringify(metadata)).not.toContain('"section"');

    const prompt = mockProviderRun.mock.calls[0]?.[8] ?? '';
    expect(prompt).toContain('scope: final');
    expect(prompt).toContain('critique_context: advisory');
    expect(prompt).toContain(`plan_sha256: ${result.binding.candidate.contentDigest}`);
    expect(prompt).toContain(
      `occurrence_source_lineage_digest: ${result.binding.lineage.lineageDigest}`,
    );
  });

  it('admits a final negative occurrence proof without synthesizing a revision issue', async () => {
    mockOutput(judgeOutput({ O3: 'violated' }));
    const state = proofState();

    const result = await runFinalJudge(makeContext(state), state, planFile);

    expect(result.available).toBe(true);
    if (!result.available) {
      throw new Error('Judge result should be available');
    }
    expect(result.admitted.verdict).toBe(false);
    expect(result.admitted.violatedOccurrenceIds).toEqual(['O3']);
    expect(result.admitted.materialIssueIds).toEqual([]);
    expect(result.admitted).not.toHaveProperty('revisionIssue');
  });

  it('projects a deterministic operational code for an empty negative rationale', async () => {
    mockOutput(judgeOutput({}, { ready: false, rationale: '' }));
    const state = proofState();

    const result = await runFinalJudge(makeContext(state), state, planFile);

    expect(result).toMatchObject({
      available: true,
      rationale: 'final-judge-not-ready',
    });
  });

  it('detects mutation and withholds the current verdict artifact', async () => {
    const originalSha256 = sha256(Buffer.from(PLAN_CONTENT));
    mockOutput(judgeOutput(), { mutateCandidate: true });
    const state = proofState();

    const result = await runFinalJudge(makeContext(state), state, planFile);

    expect(result).toMatchObject({
      available: true,
      candidateUnchanged: false,
      rationale: 'final-judge-candidate-mutated',
    });
    expect(result.binding.candidate.contentDigest).toBe(originalSha256);
    expect(existsSync(path.join(work, 'judge.final.json'))).toBe(false);
    expect(JSON.parse(readFileSync(result.metadataPath, 'utf8'))).toMatchObject({
      evaluated: true,
      available: false,
      candidateUnchanged: false,
      planSha256: originalSha256,
      observedPlanSha256: sha256(readFileSync(planFile)),
      verdictArtifact: null,
    });
  });

  it.each([1, 124])('persists unavailable metadata for provider status %s', async (status) => {
    mockOutput({}, { status });
    const state = proofState();

    const result = await runFinalJudge(makeContext(state), state, planFile);

    expect(result).toMatchObject({
      available: false,
      candidateUnchanged: true,
      rationale: 'final-judge-proof-unavailable',
    });
    expect(existsSync(path.join(work, 'judge.final.json'))).toBe(false);
    expect(JSON.parse(readFileSync(result.metadataPath, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      evaluated: false,
      available: false,
      ready: null,
      occurrenceProof: null,
      verdictArtifact: null,
    });
  });

  it('preserves malformed raw output but never admits it', async () => {
    mockOutput('not valid json{{{');
    const state = proofState();

    const result = await runFinalJudge(makeContext(state), state, planFile);

    expect(result.available).toBe(false);
    expect(existsSync(path.join(work, 'judge.final.raw'))).toBe(true);
    expect(existsSync(path.join(work, 'judge.final.json'))).toBe(false);
  });
});
