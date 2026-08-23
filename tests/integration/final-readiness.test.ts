import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runPlanLoop,
  type FinalProjection,
  type OccurrenceSourceProjection,
  type RunResult,
} from '../../src/index.js';
import { readRunRecords } from '../../src/core/run-store.js';
import {
  captureStderr,
  emptyCritique,
  withEnvAsync,
  writeCritique,
  writeFakeBin,
  writeReadinessAssessment,
  writeStoreConfig,
  writeStructuredPlanFile,
  type StderrCapture,
} from '../helpers/harness.js';

type TerminationKind =
  | 'zero-issue'
  | 'intermediate-judge'
  | 'creator-convergence'
  | 'stable-diff'
  | 'max-iters'
  | 'post-fix';

interface CaseSetup {
  readonly env: Record<string, string | undefined>;
  readonly quality: 'balanced' | 'thorough';
  readonly fix: boolean;
  readonly diffThreshold?: number;
  readonly expectedLog: string;
}

const MAJOR_ISSUE = {
  id: 'C1',
  addresses: null,
  severity: 'major',
  category: 'correctness',
  claim: 'fixture concern',
  evidence: 'fixture.md:1',
  suggested_fix: 'address it',
  confidence: 1,
  duplicate_of: null,
};

const NIT_ISSUE = { ...MAJOR_ISSUE, severity: 'nit', category: 'convention' };

let tmp: string;
let fake: string;
let work: string;
let input: string;
let capture: StderrCapture;
let highRiskAssessment: string;
let standardRiskAssessment: string;

function baseEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const assessment = extra.FAKE_READINESS_ASSESSMENT ?? highRiskAssessment;
  if (assessment === highRiskAssessment) {
    for (const [key, file] of Object.entries(extra)) {
      if (!/^FAKE_CODEX_OUTPUT(?:_[0-9]+)?$/.test(key) || file === undefined || !existsSync(file)) {
        continue;
      }
      try {
        const value = JSON.parse(readFileSync(file, 'utf8')) as {
          domain_assessments?: { domain?: string; risk?: string }[];
        };
        let changed = false;
        for (const domain of value.domain_assessments ?? []) {
          if (domain.domain === 'correctness' && domain.risk !== 'high') {
            domain.risk = 'high';
            changed = true;
          }
        }
        if (changed) {
          writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
        }
      } catch {
        continue;
      }
    }
  }
  return {
    PATH: `${fake}:${process.env.PATH ?? ''}`,
    AGENT_QUORUM_HOME: path.join(tmp, 'home'),
    AGENT_QUORUM_WORK_DIR: work,
    AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
    AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
    AGENT_QUORUM_CLARIFY: '0',
    AGENT_QUORUM_RETRY_COUNT: '0',
    AGENT_QUORUM_RETRY_DELAY_SECONDS: '0',
    FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
    FAKE_CLAUDE_PROMPT: path.join(tmp, 'claude.prompt'),
    FAKE_READINESS_ASSESSMENT: assessment,
    ...extra,
  };
}

function writeVerdict(
  name: string,
  ready: boolean,
  rationale = `${name} rationale`,
  coverageComplete = true,
): string {
  const file = path.join(tmp, `${name}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        ready,
        rationale,
        revision_issue: null,
        coverage_complete: coverageComplete,
        unresolved_occurrence_ids: [],
        invariant_assessments: [],
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

function writeUpdateMeta(name: string, withMajor: boolean): string {
  const file = path.join(tmp, `${name}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        plan_version: 1,
        issues: [
          {
            id: 'C1',
            verdict: withMajor ? 'accept' : 'reject_taste',
            verdict_reason: 'fixture',
            final_severity: 'major',
            duplicate_of: null,
          },
        ],
        applied: withMajor ? ['C1'] : [],
        systemic_dispositions: withMajor
          ? [
              {
                issue_id: 'C1',
                scope: 'local',
                rationale: 'Fixture evidence confines the correction to the named plan phase.',
                evidence_refs: [{ kind: 'plan-section', section: 'Work Plan' }],
                invariant: null,
              },
            ]
          : [],
        rejected_append: [],
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

const RISK_DOMAIN_IDS = [
  'correctness',
  'public-compatibility',
  'data-migrations',
  'security-privacy-authorization',
  'concurrency-distributed-ordering',
  'cross-repository-delivery',
  'production-operability',
  'performance-cost',
] as const;

const RETAINED_CONTEXT_CATEGORIES = [
  'original-scope',
  'authoritative-system-facts',
  'operator-decisions',
  'material-findings',
  'active-invariants',
  'quality-and-limits',
] as const;

function requireFinal(result: RunResult): FinalProjection {
  expect(result.final).toBeDefined();
  if (result.final === undefined) {
    throw new TypeError('run result is missing the final projection');
  }
  return result.final;
}

function source(
  final: FinalProjection,
  sourceName: OccurrenceSourceProjection['source'],
): OccurrenceSourceProjection {
  const projected = final.readiness.occurrenceCoverage.sources.find(
    (item) => item.source === sourceName,
  );
  expect(projected).toBeDefined();
  if (projected === undefined) {
    throw new TypeError(`missing ${sourceName} occurrence source projection`);
  }
  return projected;
}

interface ProjectionExpectation {
  readonly status: FinalProjection['status'];
  readonly structuralStatus: FinalProjection['structuralStatus'];
  readonly structuralReason: string;
  readonly digest: string;
  readonly planVersion: number;
  readonly decision: FinalProjection['readiness']['decision'];
  readonly reasonCodes: readonly string[];
  readonly exhaustedLimits?: FinalProjection['readiness']['exhaustedLimits'];
  readonly unresolvedProofIds: readonly string[];
  readonly reasons: readonly string[];
  readonly judge: Pick<
    FinalProjection['judge'],
    | 'required'
    | 'allowed'
    | 'evaluated'
    | 'available'
    | 'candidateUnchanged'
    | 'verdict'
    | 'rationale'
  >;
  readonly coverageReasonCodes?: readonly string[];
  readonly materialIssueIds?: readonly string[];
  readonly staleOccurrenceSources?: readonly OccurrenceSourceProjection['source'][];
  readonly fixReviewerRequired?: boolean;
  readonly opportunityCount?: number;
  readonly applicableRiskDomains?: FinalProjection['readiness']['applicableRiskDomains'];
  readonly highRiskDomains?: FinalProjection['readiness']['highRiskDomains'];
}

function expectProjectionContract(final: FinalProjection, expected: ProjectionExpectation): void {
  expect(Object.keys(final).sort()).toEqual(
    [
      'artifactPath',
      'judge',
      'readiness',
      'reasons',
      'status',
      'structuralReason',
      'structuralStatus',
    ].sort(),
  );
  expect(final).toMatchObject({
    status: expected.status,
    reasons: expected.reasons,
    structuralStatus: expected.structuralStatus,
    structuralReason: expected.structuralReason,
  });
  expect(path.basename(final.artifactPath)).toBe('convergence.final.json');
  expect(existsSync(final.artifactPath)).toBe(true);
  expect(Object.keys(final.readiness).sort()).toEqual(
    [
      'applicableRiskDomains',
      'canonicalPlanSha256',
      'decision',
      'exhaustedLimits',
      'highRiskDomains',
      'occurrenceCoverage',
      'opportunityCount',
      'planVersion',
      'proofArtifactPath',
      'reasonCodes',
      'satisfied',
      'unresolvedProofIds',
    ].sort(),
  );
  expect(final.readiness).toMatchObject({
    proofArtifactPath: final.artifactPath,
    planVersion: expected.planVersion,
    canonicalPlanSha256: expected.digest,
    decision: expected.decision,
    reasonCodes: expected.reasonCodes,
    satisfied: expected.decision === 'ready',
    exhaustedLimits: expected.exhaustedLimits ?? [],
    unresolvedProofIds: expected.unresolvedProofIds,
    applicableRiskDomains: expected.applicableRiskDomains ?? ['correctness'],
    highRiskDomains: expected.highRiskDomains ?? ['correctness'],
    opportunityCount: expected.opportunityCount ?? 0,
  });

  const coverage = final.readiness.occurrenceCoverage;
  expect(Object.keys(coverage).sort()).toEqual(
    [
      'catalogDigest',
      'catalogExact',
      'disagreementOccurrenceIds',
      'expectedOccurrenceIds',
      'expectedPlanVersion',
      'invariants',
      'materialIssueIds',
      'outcomes',
      'proofSatisfied',
      'reasonCodes',
      'resolvedOccurrenceIds',
      'retainedContextCategories',
      'riskDomainIds',
      'sourceConsistent',
      'sources',
      'sourcesConclusive',
      'sourcesCurrent',
      'unresolvedOccurrenceIds',
      'violatedOccurrenceIds',
    ].sort(),
  );
  expect(coverage).toMatchObject({
    expectedPlanVersion: expected.planVersion,
    riskDomainIds: RISK_DOMAIN_IDS,
    retainedContextCategories: RETAINED_CONTEXT_CATEGORIES,
    expectedOccurrenceIds: [],
    outcomes: [],
    resolvedOccurrenceIds: [],
    violatedOccurrenceIds: [],
    unresolvedOccurrenceIds: [],
    disagreementOccurrenceIds: [],
    invariants: [],
    materialIssueIds: expected.materialIssueIds ?? [],
    catalogExact: expected.staleOccurrenceSources === undefined,
    sourcesCurrent: expected.staleOccurrenceSources === undefined,
    sourcesConclusive: expected.staleOccurrenceSources === undefined,
    sourceConsistent: true,
    proofSatisfied: expected.staleOccurrenceSources === undefined,
    reasonCodes: expected.coverageReasonCodes ?? [],
  });
  expect(coverage.catalogDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(coverage.sources.map((item) => item.source)).toEqual([
    'critic',
    'fix-reviewer',
    'intermediate-judge',
    'final-judge',
  ]);
  for (const projected of coverage.sources) {
    const stale = expected.staleOccurrenceSources?.includes(projected.source) ?? false;
    expect(projected).toMatchObject(
      stale
        ? {
            required: true,
            available: false,
            catalogExact: false,
            current: false,
            consistent: true,
            conclusive: false,
          }
        : {
            catalogExact: true,
            current: true,
            consistent: true,
            conclusive: true,
          },
    );
    if (projected.snapshot !== undefined) {
      expect(projected.snapshot).toEqual({
        source: projected.source,
        catalogDigest: coverage.catalogDigest,
        binding: projected.expectedBinding,
        occurrences: [],
      });
    }
  }

  expect(source(final, 'fix-reviewer')).toMatchObject(
    expected.fixReviewerRequired === true
      ? { required: true, available: true, reason: 'fix-pass-replacement-retained' }
      : { required: false, available: false, reason: 'disabled' },
  );

  const finalJudge = source(final, 'final-judge');
  const judgeKeys = [
    'allowed',
    'available',
    'candidateUnchanged',
    'evaluated',
    'rationale',
    'required',
    'verdict',
    ...(final.judge.binding === undefined ? [] : ['binding']),
    ...(final.judge.metadataPath === undefined ? [] : ['metadataPath']),
  ];
  expect(Object.keys(final.judge).sort()).toEqual(judgeKeys.sort());
  expect(final.judge).toMatchObject(expected.judge);
  if (final.judge.binding !== undefined) {
    expect(final.judge.binding).toEqual(finalJudge.expectedBinding);
    expect(final.judge.binding).toMatchObject({
      candidate: {
        kind: 'canonical-plan',
        planVersion: expected.planVersion,
        contentDigest: expected.digest,
      },
      lineage: { evaluationStage: 'final-readiness' },
    });
    expect(final.judge.binding.lineage.lineageDigest).toMatch(/^[0-9a-f]{64}$/);
  }
  if (final.judge.metadataPath !== undefined) {
    expect(final.judge.metadataPath).toBe(
      path.join(path.dirname(final.artifactPath), 'judge.final.meta.json'),
    );
  }

  const serialized = JSON.stringify(final);
  expect(serialized).not.toContain('"evidence"');
  expect(serialized).not.toContain('"evidenceRefs"');
  expect(serialized).not.toContain('"claim"');
  expect(serialized).not.toContain('"suggestedFix"');
  expect(serialized).not.toContain('fixture concern');
  expect(serialized).not.toContain('address it');
}

function setupCase(kind: TerminationKind, finalVerdict: string): CaseSetup {
  const critique = path.join(tmp, 'critique.json');
  switch (kind) {
    case 'zero-issue':
      emptyCritique(critique);
      return {
        env: baseEnv({ FAKE_CODEX_OUTPUT: critique, FAKE_CLAUDE_JSON_RESULT: finalVerdict }),
        quality: 'balanced',
        fix: false,
        expectedLog: 'iter=0 — intermediate judge',
      };
    case 'intermediate-judge': {
      writeCritique(critique, [NIT_ISSUE]);
      const calls = path.join(tmp, 'claude-json.calls');
      const intermediate = writeVerdict('intermediate-ready', true);
      return {
        env: baseEnv({
          FAKE_CODEX_OUTPUT: critique,
          FAKE_CLAUDE_JSON_RESULT: finalVerdict,
          FAKE_CLAUDE_JSON_CALLS: calls,
          FAKE_CLAUDE_JSON_RESULT_1: intermediate,
          FAKE_CLAUDE_JSON_RESULT_2: finalVerdict,
        }),
        quality: 'balanced',
        fix: false,
        expectedLog: 'ready at v0',
      };
    }
    case 'creator-convergence': {
      writeCritique(critique, [MAJOR_ISSUE]);
      const revision = path.join(tmp, 'creator-converged.md');
      writeStructuredPlanFile(revision, 'Creator Converged');
      const meta = writeUpdateMeta('creator-converged-meta', false);
      return {
        env: baseEnv({
          FAKE_CODEX_OUTPUT: critique,
          FAKE_CLAUDE_MARKDOWN_RESULT: revision,
          FAKE_CLAUDE_JSON_RESULT: finalVerdict,
          FAKE_CLAUDE_JSON_CALLS: path.join(tmp, 'claude-json.calls'),
          FAKE_CLAUDE_JSON_RESULT_1: meta,
          FAKE_CLAUDE_JSON_RESULT_2: finalVerdict,
        }),
        quality: 'balanced',
        fix: false,
        expectedLog: 'hit MAX_ITERS=1 without proof',
      };
    }
    case 'stable-diff': {
      writeCritique(critique, [MAJOR_ISSUE]);
      const meta = writeUpdateMeta('stable-meta', true);
      return {
        env: baseEnv({
          FAKE_CODEX_OUTPUT: critique,
          FAKE_CLAUDE_MARKDOWN_RESULT: input,
          FAKE_CLAUDE_JSON_RESULT: finalVerdict,
          FAKE_CLAUDE_JSON_CALLS: path.join(tmp, 'claude-json.calls'),
          FAKE_CLAUDE_JSON_RESULT_1: meta,
          FAKE_CLAUDE_JSON_RESULT_2: finalVerdict,
        }),
        quality: 'balanced',
        fix: false,
        expectedLog: 'stable-diff telemetry at v1',
      };
    }
    case 'max-iters': {
      writeCritique(critique, [MAJOR_ISSUE]);
      const revision = path.join(tmp, 'max-iters.md');
      writeStructuredPlanFile(revision, 'MAX ITERS Revision');
      const meta = writeUpdateMeta('max-iters-meta', true);
      return {
        env: baseEnv({
          FAKE_CODEX_OUTPUT: critique,
          FAKE_CLAUDE_MARKDOWN_RESULT: revision,
          FAKE_CLAUDE_JSON_RESULT: finalVerdict,
          FAKE_CLAUDE_JSON_CALLS: path.join(tmp, 'claude-json.calls'),
          FAKE_CLAUDE_JSON_RESULT_1: meta,
          FAKE_CLAUDE_JSON_RESULT_2: finalVerdict,
        }),
        quality: 'thorough',
        fix: false,
        diffThreshold: 0,
        expectedLog: 'hit MAX_ITERS=1 without proof',
      };
    }
    case 'post-fix': {
      writeFileSync(
        input,
        `${readFileSync(input, 'utf8')}\n- Broken reference: \`missing-file.ts:99999\`\n`,
      );
      emptyCritique(critique);
      const fixed = path.join(tmp, 'fixed.md');
      writeStructuredPlanFile(fixed, 'Post-fix Final');
      const review = path.join(tmp, 'review.json');
      writeFileSync(
        review,
        `${JSON.stringify({
          approval: 'accept',
          coverage_complete: true,
          unresolved_occurrence_ids: [],
          invariant_assessments: [],
          concerns: [],
        })}\n`,
      );
      return {
        env: baseEnv({
          FAKE_CODEX_OUTPUT: critique,
          FAKE_CODEX_OUTPUT_CALLS: path.join(tmp, 'codex.calls'),
          FAKE_CODEX_OUTPUT_1: critique,
          FAKE_CODEX_OUTPUT_2: review,
          FAKE_CLAUDE_MARKDOWN_RESULT: fixed,
          FAKE_CLAUDE_JSON_RESULT: finalVerdict,
        }),
        quality: 'balanced',
        fix: true,
        expectedLog: 'fix-pass: clean accept, using proposal as final plan',
      };
    }
    default: {
      kind satisfies never;
      throw new Error('unreachable termination kind');
    }
  }
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-final-readiness.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  work = path.join(tmp, 'work');
  mkdirSync(work);
  mkdirSync(path.join(tmp, 'plans'));
  mkdirSync(path.join(tmp, 'state'));
  writeStoreConfig(path.join(tmp, 'home'));
  input = path.join(tmp, 'input.md');
  writeStructuredPlanFile(input, 'Readiness Input');
  highRiskAssessment = path.join(tmp, 'readiness-high.json');
  standardRiskAssessment = path.join(tmp, 'readiness-standard.json');
  writeReadinessAssessment(highRiskAssessment, true);
  writeReadinessAssessment(standardRiskAssessment);
  capture = captureStderr();
});

afterEach(() => {
  capture.restore();
  rmSync(tmp, { recursive: true, force: true });
});

describe('final Judge termination and verdict matrix', () => {
  const cases = (
    [
      'zero-issue',
      'intermediate-judge',
      'creator-convergence',
      'stable-diff',
      'max-iters',
      'post-fix',
    ] as const
  ).flatMap((kind) => [true, false].map((ready) => ({ kind, ready })));

  it.each(cases)(
    '$kind records final ready=$ready for the delivered plan',
    async ({ kind, ready }) => {
      const finalVerdict = writeVerdict('final-verdict', ready);
      const setup = setupCase(kind, finalVerdict);

      const result = await withEnvAsync(setup.env, () =>
        runPlanLoop({
          input,
          iters: 1,
          quality: setup.quality,
          fix: setup.fix,
          translate: false,
          workDir: work,
          ...(setup.diffThreshold !== undefined
            ? { config: { settings: { diffThreshold: setup.diffThreshold } } }
            : {}),
        }),
      );

      const finalPlan = path.join(work, 'plan.final.md');
      const planBytes = readFileSync(finalPlan);
      const digest = createHash('sha256').update(planBytes).digest('hex');
      const limitsExhausted = ['creator-convergence', 'stable-diff', 'max-iters'].includes(kind);
      const expectedStatus = ready && !limitsExhausted ? 'clean' : 'needs-review';
      const inconsistentVerdict = kind === 'intermediate-judge' && !ready;
      const decision = limitsExhausted ? 'limits-exhausted' : ready ? 'ready' : 'unable-to-decide';
      const reasonCodes = limitsExhausted
        ? ['iteration-cap']
        : ready
          ? []
          : [
              inconsistentVerdict
                ? 'judge-inconsistent-after-status-projection'
                : 'judge-not-ready',
            ];
      const unresolvedProofIds = limitsExhausted
        ? ['plan.v1:not-independently-reviewed']
        : ready
          ? []
          : [inconsistentVerdict ? 'final-judge:inconsistent-verdict' : 'plan.v0:judge'];
      const reasons =
        decision === 'ready' ? [] : [`Readiness proof: ${decision}:${reasonCodes.join(',')}`];
      const staleCoverageReasons = [
        'occurrence-source:critic:missing',
        'occurrence-source:critic:catalog-inexact',
        'occurrence-source:critic:stale',
        'occurrence-source:critic:inconclusive',
        'occurrence-source:intermediate-judge:missing',
        'occurrence-source:intermediate-judge:catalog-inexact',
        'occurrence-source:intermediate-judge:stale',
        'occurrence-source:intermediate-judge:inconclusive',
      ];
      expect(result.exitCode).toBe(0);
      const final = requireFinal(result);
      expectProjectionContract(final, {
        status: expectedStatus,
        structuralStatus: 'clean',
        structuralReason: '',
        digest,
        planVersion: limitsExhausted ? 1 : 0,
        decision,
        reasonCodes,
        exhaustedLimits: limitsExhausted ? ['iteration-cap'] : [],
        unresolvedProofIds,
        reasons,
        judge: {
          required: true,
          allowed: true,
          evaluated: true,
          available: true,
          candidateUnchanged: true,
          verdict: ready,
          rationale: ready ? 'final-judge-ready' : 'final-judge-not-ready',
        },
        coverageReasonCodes: limitsExhausted ? staleCoverageReasons : [],
        materialIssueIds: kind === 'stable-diff' || kind === 'max-iters' ? ['I-v0-C1'] : [],
        ...(limitsExhausted
          ? { staleOccurrenceSources: ['critic', 'intermediate-judge'] as const }
          : {}),
        fixReviewerRequired: kind === 'post-fix',
        opportunityCount: kind === 'intermediate-judge' ? 1 : 0,
      });
      expect(result).not.toHaveProperty('status');
      expect(result).not.toHaveProperty('structuralStatus');
      expect(result).not.toHaveProperty('convergence');
      expect(result).not.toHaveProperty('readiness');
      expect(result).not.toHaveProperty('readinessPath');
      expect(capture.text()).toContain(setup.expectedLog);

      const metadata = JSON.parse(
        readFileSync(path.join(work, 'judge.final.meta.json'), 'utf8'),
      ) as unknown;
      const readinessContractDigest =
        typeof metadata === 'object' && metadata !== null && 'readinessContractDigest' in metadata
          ? metadata.readinessContractDigest
          : undefined;
      expect(readinessContractDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(metadata).toEqual({
        schemaVersion: 2,
        source: 'final-judge',
        planVersion: final.readiness.planVersion,
        planSha256: digest,
        observedPlanSha256: digest,
        canonicalPlan: 'plan.final.md',
        binding: final.judge.binding,
        catalogDigest: final.readiness.occurrenceCoverage.catalogDigest,
        readinessContractDigest,
        evaluated: true,
        available: true,
        candidateUnchanged: true,
        ready,
        rationale: ready ? 'final-judge-ready' : 'final-judge-not-ready',
        verdictArtifact: 'judge.final.json',
        occurrenceProof: {
          coverageComplete: true,
          unresolvedOccurrenceIds: [],
          violatedOccurrenceIds: [],
          occurrences: [],
          materialIssueIds: [],
          satisfied: true,
        },
      });
      expect(readFileSync(path.join(work, 'judge.final.json'), 'utf8')).toBe(
        readFileSync(path.join(work, 'judge.final.raw'), 'utf8'),
      );

      const summary = readFileSync(path.join(work, 'summary.md'), 'utf8');
      expect(summary).toContain('- structural_status: clean');
      expect(summary).toContain(
        `- final_judge: required=true, allowed=true, evaluated=true, available=true, candidate_unchanged=true, verdict=${String(ready)}`,
      );
      expect(summary).not.toContain('final-verdict rationale');
      expect(summary).toContain(`- FINAL: ${expectedStatus}`);
      const runLog = readFileSync(path.join(work, 'run.log'), 'utf8');
      expect(runLog).not.toContain('final-verdict rationale');
      expect(runLog.indexOf('FINAL:')).toBeGreaterThan(runLog.lastIndexOf('final validation pass'));
      const finalPrompt = readFileSync(path.join(tmp, 'claude.prompt'), 'utf8');
      expect(finalPrompt).toContain(`plan_sha256: ${digest}`);
      expect(finalPrompt).toContain(
        `## Plan\n${planBytes.toString('utf8')}\n\n## Critique Context`,
      );

      const records = readRunRecords(path.join(tmp, 'state'));
      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record).toMatchObject({
        state: 'finished',
        exitCode: 0,
        final,
      });
      expect(record?.final).toEqual(final);
      expect(record).not.toHaveProperty('finalStatus');
      expect(record).not.toHaveProperty('finalReason');
      expect(record).not.toHaveProperty('structuralStatus');
      expect(record).not.toHaveProperty('finalConvergence');
      expect(record).not.toHaveProperty('finalReadiness');
    },
    30_000,
  );

  it('keeps final coverage proof separate from intermediate Judge approval', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const intermediate = writeVerdict('intermediate-ready', true);
    const finalUnproved = writeVerdict('final-coverage-unproved', true, 'coverage unproved', false);
    const calls = path.join(tmp, 'claude-json.calls');

    const result = await withEnvAsync(
      baseEnv({
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CLAUDE_JSON_RESULT: finalUnproved,
        FAKE_CLAUDE_JSON_CALLS: calls,
        FAKE_CLAUDE_JSON_RESULT_1: intermediate,
        FAKE_CLAUDE_JSON_RESULT_2: finalUnproved,
        FAKE_CLAUDE_JSON_RESULT_3: finalUnproved,
      }),
      () =>
        runPlanLoop({
          input,
          iters: 1,
          quality: 'balanced',
          fix: false,
          translate: false,
          workDir: work,
        }),
    );

    const final = requireFinal(result);
    const digest = createHash('sha256')
      .update(readFileSync(path.join(work, 'plan.final.md')))
      .digest('hex');
    const coverageReasonCodes = [
      'occurrence-source:final-judge:missing',
      'occurrence-source:final-judge:catalog-inexact',
      'occurrence-source:final-judge:stale',
      'occurrence-source:final-judge:inconclusive',
    ];
    expectProjectionContract(final, {
      status: 'needs-review',
      structuralStatus: 'clean',
      structuralReason: '',
      digest,
      planVersion: 0,
      decision: 'unable-to-decide',
      reasonCodes: [
        'judge-unavailable',
        'occurrence-proof-incomplete',
        'occurrence-source-missing',
      ],
      unresolvedProofIds: ['occurrence-source:final-judge', 'plan.v0:judge'],
      reasons: [
        'Readiness proof: unable-to-decide:judge-unavailable,occurrence-proof-incomplete,occurrence-source-missing',
      ],
      judge: {
        required: true,
        allowed: true,
        evaluated: false,
        available: false,
        candidateUnchanged: true,
        verdict: null,
        rationale: 'final-judge-proof-unavailable',
      },
      coverageReasonCodes,
      staleOccurrenceSources: ['final-judge'],
    });
    const proof = JSON.parse(
      readFileSync(path.join(work, 'convergence.final.json'), 'utf8'),
    ) as unknown;
    expect(proof).toMatchObject({
      schemaVersion: 3,
      canonicalPlanSha256: digest,
      reduction: {
        decision: 'unable-to-decide',
        reasonCodes: [
          'judge-unavailable',
          'occurrence-proof-incomplete',
          'occurrence-source-missing',
        ],
        satisfied: false,
      },
    });
    expect(proof).not.toHaveProperty('judgeApprovedPlanVersion');
  });

  it('cannot clean a canonical plan mutated by the final Judge provider', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const verdict = writeVerdict('mutation-ready', true);
    const mutatedPlan = path.join(tmp, 'mutated-final.md');
    writeStructuredPlanFile(mutatedPlan, 'Mutated During Final Judge');
    writeFileSync(
      mutatedPlan,
      readFileSync(mutatedPlan, 'utf8').replaceAll('Fixture Phase', 'Mutated Phase'),
    );
    const mutationCalls = path.join(tmp, 'final-mutation.calls');

    const result = await withEnvAsync(
      baseEnv({
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CLAUDE_JSON_RESULT: verdict,
        FAKE_CLAUDE_FINAL_PLAN_MUTATION_SOURCE: mutatedPlan,
        FAKE_CLAUDE_FINAL_PLAN_MUTATION_TARGET: path.join(work, 'plan.final.md'),
        FAKE_CLAUDE_FINAL_PLAN_MUTATION_CALLS: mutationCalls,
      }),
      () =>
        runPlanLoop({
          input,
          iters: 1,
          quality: 'balanced',
          fix: false,
          translate: false,
          workDir: work,
          config: { split: { mode: 'always' } },
        }),
    );

    const finalPlan = path.join(work, 'plan.final.md');
    const finalDigest = createHash('sha256').update(readFileSync(finalPlan)).digest('hex');
    const systemCheck = JSON.parse(
      readFileSync(path.join(work, 'system-check.final.json'), 'utf8'),
    ) as { planSha256: string };
    const convergence = JSON.parse(
      readFileSync(path.join(work, 'convergence.final.json'), 'utf8'),
    ) as {
      canonicalPlanSha256: string;
      hasCanonicalBindingMismatch: boolean;
      reduction: { unresolvedProofIds: string[] };
    };

    const final = requireFinal(result);
    expectProjectionContract(final, {
      status: 'needs-review',
      structuralStatus: 'clean',
      structuralReason: '',
      digest: finalDigest,
      planVersion: 0,
      decision: 'unable-to-decide',
      reasonCodes: [
        'canonical-plan-binding-mismatch',
        'final-artifact-needs-review',
        'fresh-review-required',
      ],
      unresolvedProofIds: [
        'canonical-plan:fresh-review-required',
        'canonical-plan:proof-hash-mismatch',
        'final-artifact:needs-review',
      ],
      reasons: [
        'Readiness proof: unable-to-decide:canonical-plan-binding-mismatch,final-artifact-needs-review,fresh-review-required',
      ],
      judge: {
        required: true,
        allowed: true,
        evaluated: true,
        available: true,
        candidateUnchanged: true,
        verdict: true,
        rationale: 'final-judge-ready',
      },
    });
    expect(convergence.hasCanonicalBindingMismatch).toBe(true);
    expect(convergence.reduction.unresolvedProofIds).toContain(
      'canonical-plan:proof-hash-mismatch',
    );
    expect(convergence.canonicalPlanSha256).toBe(finalDigest);
    expect(systemCheck.planSha256).toBe(finalDigest);
    expect(final.readiness.canonicalPlanSha256).toBe(finalDigest);
    expect(readFileSync(finalPlan, 'utf8')).toContain('# Mutated During Final Judge');
    expect(readFileSync(finalPlan, 'utf8')).toContain('status: needs-review');
    const packageDir = path.join(work, 'plan.package');
    expect(readFileSync(path.join(packageDir, 'plan.md'))).toEqual(readFileSync(finalPlan));
    expect(readFileSync(path.join(packageDir, 'README.md'), 'utf8')).toContain(
      '# Mutated During Final Judge - change pack',
    );
    expect(readFileSync(path.join(packageDir, 'run.md'), 'utf8')).toContain(
      '# Mutated During Final Judge - runbook',
    );
    expect(existsSync(path.join(packageDir, 'phase-1-fixture-phase.md'))).toBe(false);
    expect(existsSync(path.join(packageDir, 'phase-1-mutated-phase.md'))).toBe(true);
    expect(readFileSync(mutationCalls, 'utf8')).toBe('2');
    expect(readFileSync(path.join(work, 'run.log'), 'utf8')).not.toContain('FINAL: clean');
  });

  it('does not let final Judge readiness substitute for rejected intermediate proof', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const intermediate = writeVerdict('intermediate-not-ready', false);
    const finalReady = writeVerdict('final-ready', true);
    const calls = path.join(tmp, 'claude-json.calls');

    const result = await withEnvAsync(
      baseEnv({
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CLAUDE_JSON_RESULT: finalReady,
        FAKE_CLAUDE_JSON_CALLS: calls,
        FAKE_CLAUDE_JSON_RESULT_1: intermediate,
        FAKE_CLAUDE_JSON_RESULT_2: finalReady,
        FAKE_CLAUDE_JSON_RESULT_3: finalReady,
      }),
      () =>
        runPlanLoop({
          input,
          iters: 1,
          quality: 'balanced',
          fix: false,
          translate: false,
          workDir: work,
        }),
    );

    const final = requireFinal(result);
    const digest = createHash('sha256')
      .update(readFileSync(path.join(work, 'plan.final.md')))
      .digest('hex');
    expectProjectionContract(final, {
      status: 'needs-review',
      structuralStatus: 'clean',
      structuralReason: '',
      digest,
      planVersion: 0,
      decision: 'unable-to-decide',
      reasonCodes: ['judge-inconsistent-after-status-projection'],
      unresolvedProofIds: ['final-judge:inconsistent-verdict'],
      reasons: ['Readiness proof: unable-to-decide:judge-inconsistent-after-status-projection'],
      judge: {
        required: true,
        allowed: true,
        evaluated: true,
        available: true,
        candidateUnchanged: true,
        verdict: true,
        rationale: 'final-judge-ready',
      },
    });
    const state = JSON.parse(readFileSync(path.join(work, 'convergence.final.json'), 'utf8')) as {
      hasJudgeInconsistency: boolean;
      judgeApprovedPlanVersion?: number;
      reduction: { reasonCodes: string[]; unresolvedProofIds: string[] };
    };
    expect(state).toMatchObject({
      hasJudgeInconsistency: true,
      reduction: {
        reasonCodes: ['judge-inconsistent-after-status-projection'],
        unresolvedProofIds: ['final-judge:inconsistent-verdict'],
      },
    });
  });

  it('keeps a changed final coverage proof from cleaning the projected plan', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const intermediate = writeVerdict('intermediate-ready', true);
    const finalUnproved = writeVerdict('final-first-unproved', true, 'first proof', false);
    const finalProved = writeVerdict('final-second-proved', true, 'second proof', true);
    const calls = path.join(tmp, 'claude-json.calls');

    const result = await withEnvAsync(
      baseEnv({
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CLAUDE_JSON_RESULT: finalProved,
        FAKE_CLAUDE_JSON_CALLS: calls,
        FAKE_CLAUDE_JSON_RESULT_1: intermediate,
        FAKE_CLAUDE_JSON_RESULT_2: finalUnproved,
        FAKE_CLAUDE_JSON_RESULT_3: finalProved,
      }),
      () =>
        runPlanLoop({
          input,
          iters: 1,
          quality: 'balanced',
          fix: false,
          translate: false,
          workDir: work,
        }),
    );

    const final = requireFinal(result);
    const digest = createHash('sha256')
      .update(readFileSync(path.join(work, 'plan.final.md')))
      .digest('hex');
    expectProjectionContract(final, {
      status: 'needs-review',
      structuralStatus: 'clean',
      structuralReason: '',
      digest,
      planVersion: 0,
      decision: 'ready',
      reasonCodes: [],
      unresolvedProofIds: [],
      reasons: ['finalization:monotonic-downgrade'],
      judge: {
        required: true,
        allowed: true,
        evaluated: true,
        available: true,
        candidateUnchanged: true,
        verdict: true,
        rationale: 'final-judge-ready',
      },
    });
    expect(readFileSync(calls, 'utf8')).toBe('3');
    expect(readFileSync(path.join(work, 'summary.md'), 'utf8')).toContain(
      '- FINAL: needs-review — finalization:monotonic-downgrade',
    );
  });

  it('keeps intermediate and final Judge rationale out of normal run logging', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const intermediateSecret = 'INTERMEDIATE_JUDGE_PRIVATE_BODY_68f121';
    const finalSecret = 'FINAL_JUDGE_PRIVATE_BODY_d19c04';
    const intermediate = writeVerdict('intermediate-private', true, intermediateSecret);
    const finalNotReady = writeVerdict('final-private', false, finalSecret);
    const calls = path.join(tmp, 'claude-json.calls');

    const result = await withEnvAsync(
      baseEnv({
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CLAUDE_JSON_RESULT: finalNotReady,
        FAKE_CLAUDE_JSON_CALLS: calls,
        FAKE_CLAUDE_JSON_RESULT_1: intermediate,
        FAKE_CLAUDE_JSON_RESULT_2: finalNotReady,
        FAKE_CLAUDE_JSON_RESULT_3: finalNotReady,
      }),
      () =>
        runPlanLoop({
          input,
          iters: 1,
          quality: 'balanced',
          fix: false,
          translate: false,
          workDir: work,
        }),
    );

    const runLog = readFileSync(path.join(work, 'run.log'), 'utf8');
    const summary = readFileSync(path.join(work, 'summary.md'), 'utf8');
    const final = requireFinal(result);
    const digest = createHash('sha256')
      .update(readFileSync(path.join(work, 'plan.final.md')))
      .digest('hex');
    expectProjectionContract(final, {
      status: 'needs-review',
      structuralStatus: 'clean',
      structuralReason: '',
      digest,
      planVersion: 0,
      decision: 'unable-to-decide',
      reasonCodes: ['judge-inconsistent-after-status-projection'],
      unresolvedProofIds: ['final-judge:inconsistent-verdict'],
      reasons: ['Readiness proof: unable-to-decide:judge-inconsistent-after-status-projection'],
      judge: {
        required: true,
        allowed: true,
        evaluated: true,
        available: true,
        candidateUnchanged: true,
        verdict: false,
        rationale: 'final-judge-not-ready',
      },
    });
    expect(runLog).not.toContain(intermediateSecret);
    expect(runLog).not.toContain(finalSecret);
    expect(summary).not.toContain(intermediateSecret);
    expect(summary).not.toContain(finalSecret);
    expect(final.reasons.join('\n')).not.toContain(finalSecret);
    expect(final.judge.rationale).toBe('final-judge-not-ready');
    expect(JSON.stringify(final)).not.toContain(intermediateSecret);
    expect(JSON.stringify(final)).not.toContain(finalSecret);
    const record = readRunRecords(path.join(tmp, 'state'))[0];
    expect(record?.final).toEqual(final);
    expect(record?.final?.reasons.join('\n')).not.toContain(finalSecret);
    expect(record?.final?.judge.rationale).toBe('final-judge-not-ready');
    expect(JSON.stringify(record)).not.toContain(finalSecret);
    const metadata = readFileSync(path.join(work, 'judge.final.meta.json'), 'utf8');
    expect(metadata).toContain('"rationale": "final-judge-not-ready"');
    expect(metadata).not.toContain(finalSecret);
  });

  it('degrades exhausted schema-invalid final output to unknown needs-review', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const invalid = path.join(tmp, 'invalid-verdict.json');
    writeFileSync(invalid, '{"ready":true}\n');
    const calls = path.join(tmp, 'claude-json.calls');

    const result = await withEnvAsync(
      baseEnv({
        AGENT_QUORUM_RETRY_COUNT: '1',
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CLAUDE_JSON_RESULT: invalid,
        FAKE_CLAUDE_JSON_CALLS: calls,
      }),
      () =>
        runPlanLoop({
          input,
          iters: 1,
          quality: 'balanced',
          fix: false,
          translate: false,
          workDir: work,
        }),
    );

    const final = requireFinal(result);
    const digest = createHash('sha256')
      .update(readFileSync(path.join(work, 'plan.final.md')))
      .digest('hex');
    const coverageReasonCodes = [
      'occurrence-source:intermediate-judge:missing',
      'occurrence-source:intermediate-judge:catalog-inexact',
      'occurrence-source:intermediate-judge:stale',
      'occurrence-source:intermediate-judge:inconclusive',
      'occurrence-source:final-judge:missing',
      'occurrence-source:final-judge:catalog-inexact',
      'occurrence-source:final-judge:stale',
      'occurrence-source:final-judge:inconclusive',
    ];
    expect(result.exitCode).toBe(0);
    expectProjectionContract(final, {
      status: 'needs-review',
      structuralStatus: 'clean',
      structuralReason: '',
      digest,
      planVersion: 0,
      decision: 'unable-to-decide',
      reasonCodes: [
        'judge-unavailable',
        'occurrence-proof-incomplete',
        'occurrence-source-missing',
      ],
      unresolvedProofIds: [
        'occurrence-source:final-judge',
        'occurrence-source:intermediate-judge',
        'plan.v0:judge',
      ],
      reasons: [
        'Readiness proof: unable-to-decide:judge-unavailable,occurrence-proof-incomplete,occurrence-source-missing',
      ],
      judge: {
        required: true,
        allowed: true,
        evaluated: false,
        available: false,
        candidateUnchanged: true,
        verdict: null,
        rationale: 'final-judge-proof-unavailable',
      },
      coverageReasonCodes,
      staleOccurrenceSources: ['intermediate-judge', 'final-judge'],
    });
    expect(readFileSync(calls, 'utf8')).toBe('6');
    expect(existsSync(path.join(work, 'plan.final.md'))).toBe(true);
    expect(existsSync(path.join(work, 'judge.final.json'))).toBe(false);
    expect(
      JSON.parse(readFileSync(path.join(work, 'judge.final.meta.json'), 'utf8')),
    ).toMatchObject({
      schemaVersion: 2,
      evaluated: false,
      available: false,
      candidateUnchanged: true,
      ready: null,
      occurrenceProof: null,
      verdictArtifact: null,
    });
    expect(readFileSync(path.join(work, 'summary.md'), 'utf8')).toContain(
      'final_judge: required=true, allowed=true, evaluated=false, available=false, candidate_unchanged=true, verdict=unavailable',
    );
    expect(readFileSync(path.join(work, 'run.log'), 'utf8')).toContain('FINAL: needs-review');
  }, 30_000);

  it('keeps structural needs-review distinct from a positive readiness verdict', async () => {
    writeFileSync(
      input,
      `${readFileSync(input, 'utf8')}\n- Broken reference: \`missing-file.ts:99999\`\n`,
    );
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const verdict = writeVerdict('structurally-warned-ready', true);

    const result = await withEnvAsync(
      baseEnv({ FAKE_CODEX_OUTPUT: critique, FAKE_CLAUDE_JSON_RESULT: verdict }),
      () =>
        runPlanLoop({
          input,
          iters: 1,
          quality: 'balanced',
          fix: false,
          translate: false,
          workDir: work,
        }),
    );

    const final = requireFinal(result);
    const digest = createHash('sha256')
      .update(readFileSync(path.join(work, 'plan.final.md')))
      .digest('hex');
    const structuralReason =
      '0 ambiguous + 1 unresolved reference(s) (may be generic names or future files)';
    expect(result.exitCode).toBe(0);
    expectProjectionContract(final, {
      status: 'needs-review',
      structuralStatus: 'needs-review',
      structuralReason,
      digest,
      planVersion: 0,
      decision: 'unable-to-decide',
      reasonCodes: ['final-artifact-needs-review', 'fresh-review-required'],
      unresolvedProofIds: ['canonical-plan:fresh-review-required', 'final-artifact:needs-review'],
      reasons: [
        structuralReason,
        'Readiness proof: unable-to-decide:final-artifact-needs-review,fresh-review-required',
      ],
      judge: {
        required: true,
        allowed: true,
        evaluated: true,
        available: true,
        candidateUnchanged: true,
        verdict: true,
        rationale: 'final-judge-ready',
      },
    });
    expect(final.structuralReason).toContain('reference');
  });

  it('skips final Judge when structural status is blocked', async () => {
    writeFileSync(input, '# Broken plan\n');
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const critiqueValue = JSON.parse(readFileSync(critique, 'utf8')) as {
      domain_assessments: { evidence_refs: unknown[] }[];
    };
    for (const assessment of critiqueValue.domain_assessments) {
      assessment.evidence_refs = [{ kind: 'plan-section', section: 'Broken plan' }];
    }
    writeFileSync(critique, `${JSON.stringify(critiqueValue)}\n`);

    const result = await withEnvAsync(baseEnv({ FAKE_CODEX_OUTPUT: critique }), () =>
      runPlanLoop({
        input,
        iters: 1,
        quality: 'balanced',
        fix: false,
        translate: false,
        workDir: work,
      }),
    );

    const final = requireFinal(result);
    const digest = createHash('sha256')
      .update(readFileSync(path.join(work, 'plan.final.md')))
      .digest('hex');
    const structuralReason =
      'plan shape broken (title=1 missing_sections=10 impact_graph_mermaid=0 frontmatter=0)';
    const coverageReasonCodes = [
      'occurrence-source:intermediate-judge:missing',
      'occurrence-source:intermediate-judge:catalog-inexact',
      'occurrence-source:intermediate-judge:stale',
      'occurrence-source:intermediate-judge:inconclusive',
      'occurrence-source:final-judge:missing',
      'occurrence-source:final-judge:catalog-inexact',
      'occurrence-source:final-judge:stale',
      'occurrence-source:final-judge:inconclusive',
    ];
    expect(result.exitCode).toBe(6);
    expectProjectionContract(final, {
      status: 'blocked',
      structuralStatus: 'blocked',
      structuralReason,
      digest,
      planVersion: 0,
      decision: 'unable-to-decide',
      reasonCodes: [
        'canonical-plan-binding-mismatch',
        'final-artifact-needs-review',
        'fresh-review-required',
      ],
      unresolvedProofIds: [
        'canonical-plan:fresh-review-required',
        'canonical-plan:proof-hash-mismatch',
        'final-artifact:needs-review',
      ],
      reasons: [
        structuralReason,
        'Readiness proof: unable-to-decide:canonical-plan-binding-mismatch,final-artifact-needs-review,fresh-review-required',
      ],
      judge: {
        required: true,
        allowed: true,
        evaluated: false,
        available: false,
        candidateUnchanged: true,
        verdict: null,
        rationale: 'structural-blocked',
      },
      coverageReasonCodes,
      staleOccurrenceSources: ['intermediate-judge', 'final-judge'],
    });
    expect(existsSync(path.join(work, 'judge.final.raw'))).toBe(false);
    expect(readFileSync(path.join(work, 'summary.md'), 'utf8')).toContain(
      'final_judge: required=true, allowed=true, evaluated=false, available=false, candidate_unchanged=true, verdict=unavailable',
    );
    expect(readRunRecords(path.join(tmp, 'state'))[0]).toMatchObject({
      state: 'blocked',
      exitCode: 6,
      final,
    });
  });

  it('keeps quick quality free of final Judge calls and artifacts', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);

    const result = await withEnvAsync(
      baseEnv({
        FAKE_CODEX_OUTPUT: critique,
        FAKE_READINESS_ASSESSMENT: standardRiskAssessment,
      }),
      () =>
        runPlanLoop({
          input,
          iters: 1,
          quality: 'quick',
          fix: false,
          translate: false,
          workDir: work,
        }),
    );

    const final = requireFinal(result);
    const digest = createHash('sha256')
      .update(readFileSync(path.join(work, 'plan.final.md')))
      .digest('hex');
    expect(result.exitCode).toBe(0);
    expectProjectionContract(final, {
      status: 'clean',
      structuralStatus: 'clean',
      structuralReason: '',
      digest,
      planVersion: 0,
      decision: 'ready',
      reasonCodes: [],
      unresolvedProofIds: [],
      reasons: [],
      judge: {
        required: false,
        allowed: false,
        evaluated: false,
        available: false,
        candidateUnchanged: true,
        verdict: null,
        rationale: 'standard-risk-judge-exempt',
      },
      highRiskDomains: [],
    });
    expect(source(final, 'intermediate-judge')).toEqual({
      source: 'intermediate-judge',
      required: false,
      available: false,
      catalogExact: true,
      current: true,
      consistent: true,
      conclusive: true,
      reason: 'standard-risk-judge-exempt',
    });
    expect(source(final, 'final-judge')).toEqual({
      source: 'final-judge',
      required: false,
      available: false,
      catalogExact: true,
      current: true,
      consistent: true,
      conclusive: true,
      reason: 'standard-risk-judge-exempt',
    });
    expect(existsSync(path.join(work, 'judge.final.raw'))).toBe(false);
    expect(existsSync(path.join(work, 'judge.final.json'))).toBe(false);
    expect(existsSync(path.join(work, 'judge.final.meta.json'))).toBe(false);
    expect(readFileSync(path.join(work, 'summary.md'), 'utf8')).toContain(
      'final_judge: required=false, allowed=false, evaluated=false, available=false, candidate_unchanged=true, verdict=unavailable',
    );
    expect(readFileSync(path.join(work, 'run.log'), 'utf8')).not.toContain('FINAL JUDGE:');
  });
});
