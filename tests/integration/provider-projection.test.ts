import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runPlanLoop,
  type FinalProjection,
  type OccurrenceSourceProjection,
  type Runner,
} from '../../src/index.js';
import { stableTupleId } from '../../src/core/digest.js';
import { readRunRecords } from '../../src/core/run-store.js';
import type { JsonValue } from '../../src/core/json.js';
import type { RawOccurrenceDisposition } from '../../src/core/readiness-proof.js';
import {
  captureStderr,
  withEnvAsync,
  writeCritique,
  writeFakeBin,
  writeReadinessAssessment,
  writeStoreConfig,
  writeStructuredPlanFile,
} from '../helpers/harness.js';

const PROVIDERS = ['claude', 'codex', 'cursor'] as const satisfies readonly Runner[];
const INVARIANT_ID = 'I-v0-C1';
const OCCURRENCE_DIMENSION = 'provider-projection';
const OCCURRENCE_SUBJECT = 'final public and durable readiness fields';
const OCCURRENCE_ID = stableTupleId('O', [INVARIANT_ID, OCCURRENCE_DIMENSION, OCCURRENCE_SUBJECT]);
const GROUNDED_EVIDENCE: JsonValue[] = [{ kind: 'plan-section', section: 'Work Plan' }];

interface ProjectionCase {
  readonly disposition: RawOccurrenceDisposition;
  readonly fixRequired: boolean;
  readonly expectedStatus: FinalProjection['status'];
  readonly expectedOutcome: 'resolved' | 'violated' | 'unresolved';
}

const CASES: readonly ProjectionCase[] = [
  {
    disposition: 'satisfied',
    fixRequired: true,
    expectedStatus: 'clean',
    expectedOutcome: 'resolved',
  },
  {
    disposition: 'not-applicable',
    fixRequired: false,
    expectedStatus: 'clean',
    expectedOutcome: 'resolved',
  },
  {
    disposition: 'violated',
    fixRequired: false,
    expectedStatus: 'needs-review',
    expectedOutcome: 'violated',
  },
  {
    disposition: 'unresolved',
    fixRequired: false,
    expectedStatus: 'needs-review',
    expectedOutcome: 'unresolved',
  },
];

const MAJOR_ISSUE: JsonValue = {
  id: 'C1',
  addresses: null,
  severity: 'major',
  category: 'correctness',
  claim: 'The public projection needs a retained provider-neutral invariant.',
  evidence: '## Work Plan',
  evidence_refs: GROUNDED_EVIDENCE,
  suggested_fix: 'Retain one invariant across the public and durable final projections.',
  confidence: 1,
  duplicate_of: null,
};

interface FixtureArtifacts {
  readonly assessment: string;
  readonly critiqueV0: string;
  readonly revision: string;
  readonly revisionCodex: string;
  readonly updateMeta: string;
  readonly critiqueV1: string;
  readonly intermediateJudge: string;
  readonly fixProposal: string;
  readonly fixProposalCodex: string;
  readonly fixReview: string;
  readonly finalJudge: string;
}

interface ProviderRunProjection {
  readonly api: FinalProjection;
  readonly durable: FinalProjection;
}

function writeJson(file: string, value: JsonValue): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function evidenceFor(disposition: RawOccurrenceDisposition): JsonValue[] {
  return disposition === 'unresolved' ? [] : [...GROUNDED_EVIDENCE];
}

function invariantAssessments(
  disposition: RawOccurrenceDisposition,
  includeComplete: boolean,
): JsonValue[] {
  return [
    {
      invariant_id: INVARIANT_ID,
      ...(includeComplete ? { complete: true } : {}),
      occurrences: [
        {
          occurrence_id: OCCURRENCE_ID,
          disposition,
          evidence_refs: evidenceFor(disposition),
        },
      ],
    },
  ];
}

function writeCurrentCritique(file: string, disposition: RawOccurrenceDisposition): void {
  writeCritique(file, [], 1, true);
  const critique = JSON.parse(readFileSync(file, 'utf8')) as {
    review: { invariant_assessments: JsonValue[] };
  };
  critique.review.invariant_assessments = invariantAssessments(disposition, true);
  writeJson(file, critique);
}

function writeJudge(file: string, disposition: RawOccurrenceDisposition, ready: boolean): void {
  writeJson(file, {
    ready,
    rationale: `Provider-neutral ${disposition} fixture.`,
    revision_issue: null,
    coverage_complete: true,
    unresolved_occurrence_ids: disposition === 'unresolved' ? [OCCURRENCE_ID] : [],
    invariant_assessments: invariantAssessments(disposition, false),
  });
}

function writeReviewer(file: string, disposition: RawOccurrenceDisposition): void {
  writeJson(file, {
    approval: 'accept',
    coverage_complete: true,
    unresolved_occurrence_ids: disposition === 'unresolved' ? [OCCURRENCE_ID] : [],
    invariant_assessments: invariantAssessments(disposition, false),
    concerns: [],
  });
}

function writeCodexMarkdown(file: string, markdownFile: string): void {
  writeJson(file, {
    plan_markdown: readFileSync(markdownFile, 'utf8').replace(/\n+$/, ''),
  });
}

function fixtureArtifacts(root: string, testCase: ProjectionCase): FixtureArtifacts {
  const assessment = path.join(root, 'assessment.json');
  writeReadinessAssessment(assessment, true);

  const critiqueV0 = path.join(root, 'critique.v0.json');
  writeCritique(critiqueV0, [MAJOR_ISSUE], 0, true);

  const revision = path.join(root, 'revision.md');
  writeStructuredPlanFile(revision, 'Provider-neutral Revision');
  if (testCase.fixRequired) {
    writeFileSync(
      revision,
      `${readFileSync(revision, 'utf8')}\n- Fixture finding: \`missing-provider-file.ts:99999\`\n`,
    );
  }
  const revisionCodex = path.join(root, 'revision.codex.json');
  writeCodexMarkdown(revisionCodex, revision);

  const updateMeta = path.join(root, 'update-meta.json');
  writeJson(updateMeta, {
    plan_version: 1,
    issues: [
      {
        id: 'C1',
        verdict: 'accept',
        verdict_reason: 'The invariant must remain explicit across final projections.',
        final_severity: 'major',
        duplicate_of: null,
      },
    ],
    applied: ['C1'],
    systemic_dispositions: [
      {
        issue_id: 'C1',
        scope: 'cross-cutting',
        rationale: 'The same final projection contract is consumed by API and durable records.',
        evidence_refs: [...GROUNDED_EVIDENCE],
        invariant: {
          statement: 'Public and durable final readiness projections remain semantically equal.',
          occurrences: [
            {
              dimension: OCCURRENCE_DIMENSION,
              subject: OCCURRENCE_SUBJECT,
            },
          ],
        },
      },
    ],
    rejected_append: [],
  });

  const loopDisposition =
    testCase.disposition === 'violated' || testCase.disposition === 'unresolved'
      ? 'satisfied'
      : testCase.disposition;
  const critiqueV1 = path.join(root, 'critique.v1.json');
  writeCurrentCritique(critiqueV1, loopDisposition);

  const intermediateJudge = path.join(root, 'judge.intermediate.json');
  writeJudge(intermediateJudge, loopDisposition, true);

  const fixProposal = path.join(root, 'fix-proposal.md');
  writeStructuredPlanFile(fixProposal, 'Provider-neutral Fixed Candidate');
  const fixProposalCodex = path.join(root, 'fix-proposal.codex.json');
  writeCodexMarkdown(fixProposalCodex, fixProposal);
  const fixReview = path.join(root, 'fix-review.json');
  writeReviewer(fixReview, loopDisposition);

  const finalJudge = path.join(root, 'judge.final.json');
  writeJudge(
    finalJudge,
    testCase.disposition,
    testCase.disposition === 'satisfied' || testCase.disposition === 'not-applicable',
  );

  return {
    assessment,
    critiqueV0,
    revision,
    revisionCodex,
    updateMeta,
    critiqueV1,
    intermediateJudge,
    fixProposal,
    fixProposalCodex,
    fixReview,
    finalJudge,
  };
}

function roleOverrides(runner: Runner): {
  readonly roles: Record<string, { readonly runner: Runner; readonly model: string }>;
} {
  return {
    roles: Object.fromEntries(
      ['creator', 'critic', 'fixer', 'reviewer', 'translator', 'judge'].map((role) => [
        role,
        { runner, model: `${runner}-provider-projection-fixture` },
      ]),
    ),
  };
}

function providerEnvironment(
  root: string,
  runner: Runner,
  artifacts: FixtureArtifacts,
  fixRequired: boolean,
): Record<string, string | undefined> {
  const common = {
    FAKE_READINESS_ASSESSMENT: artifacts.assessment,
    FAKE_CODEX_PROMPT: path.join(root, `${runner}.codex.prompt`),
    FAKE_CLAUDE_PROMPT: path.join(root, `${runner}.claude.prompt`),
    FAKE_CURSOR_PROMPT: path.join(root, `${runner}.cursor.prompt`),
  };

  if (runner === 'codex') {
    return {
      ...common,
      FAKE_CODEX_OUTPUT: artifacts.finalJudge,
      FAKE_CODEX_OUTPUT_CALLS: path.join(root, 'codex.calls'),
      FAKE_CODEX_OUTPUT_1: artifacts.critiqueV0,
      FAKE_CODEX_OUTPUT_2: artifacts.revisionCodex,
      FAKE_CODEX_OUTPUT_3: artifacts.updateMeta,
      FAKE_CODEX_OUTPUT_4: artifacts.critiqueV1,
      FAKE_CODEX_OUTPUT_5: artifacts.intermediateJudge,
      ...(fixRequired
        ? {
            FAKE_CODEX_OUTPUT_6: artifacts.fixProposalCodex,
            FAKE_CODEX_OUTPUT_7: artifacts.fixReview,
          }
        : {}),
    };
  }

  if (runner === 'claude') {
    return {
      ...common,
      FAKE_CLAUDE_REQUIRE_DRAFT7: '1',
      FAKE_CLAUDE_JSON_RESULT: artifacts.finalJudge,
      FAKE_CLAUDE_JSON_CALLS: path.join(root, 'claude-json.calls'),
      FAKE_CLAUDE_JSON_RESULT_1: artifacts.critiqueV0,
      FAKE_CLAUDE_JSON_RESULT_2: artifacts.updateMeta,
      FAKE_CLAUDE_JSON_RESULT_3: artifacts.critiqueV1,
      FAKE_CLAUDE_JSON_RESULT_4: artifacts.intermediateJudge,
      ...(fixRequired ? { FAKE_CLAUDE_JSON_RESULT_5: artifacts.fixReview } : {}),
      FAKE_CLAUDE_MARKDOWN_RESULT: artifacts.revision,
      FAKE_CLAUDE_MARKDOWN_CALLS: path.join(root, 'claude-markdown.calls'),
      ...(fixRequired ? { FAKE_CLAUDE_MARKDOWN_RESULT_2: artifacts.fixProposal } : {}),
    };
  }

  return {
    ...common,
    FAKE_CURSOR_JSON_RESULT: artifacts.finalJudge,
    FAKE_CURSOR_JSON_CALLS: path.join(root, 'cursor-json.calls'),
    FAKE_CURSOR_JSON_RESULT_1: artifacts.critiqueV0,
    FAKE_CURSOR_JSON_RESULT_2: artifacts.updateMeta,
    FAKE_CURSOR_JSON_RESULT_3: artifacts.critiqueV1,
    FAKE_CURSOR_JSON_RESULT_4: artifacts.intermediateJudge,
    ...(fixRequired ? { FAKE_CURSOR_JSON_RESULT_5: artifacts.fixReview } : {}),
    FAKE_CURSOR_MARKDOWN_RESULT: artifacts.revision,
    FAKE_CURSOR_MARKDOWN_CALLS: path.join(root, 'cursor-markdown.calls'),
    ...(fixRequired ? { FAKE_CURSOR_MARKDOWN_RESULT_2: artifacts.fixProposal } : {}),
  };
}

function requiredFinal(result: { readonly final?: FinalProjection }): FinalProjection {
  expect(result.final).toBeDefined();
  if (result.final === undefined) {
    throw new TypeError('provider projection run did not return a final projection');
  }
  return result.final;
}

function source(
  final: FinalProjection,
  sourceName: OccurrenceSourceProjection['source'],
): OccurrenceSourceProjection {
  const value = final.readiness.occurrenceCoverage.sources.find(
    (entry) => entry.source === sourceName,
  );
  expect(value).toBeDefined();
  if (value === undefined) {
    throw new TypeError(`provider projection is missing ${sourceName}`);
  }
  return value;
}

function normalizeWorkdirPaths(final: FinalProjection, work: string): unknown {
  const normalized = JSON.parse(JSON.stringify(final)) as Record<string, unknown>;
  const replacePath = (owner: Record<string, unknown>, key: string): void => {
    const value = owner[key];
    if (typeof value === 'string') {
      owner[key] = path.relative(realpathSync(work), value);
    }
  };
  replacePath(normalized, 'artifactPath');
  const readiness = normalized.readiness as Record<string, unknown>;
  replacePath(readiness, 'proofArtifactPath');
  const judge = normalized.judge as Record<string, unknown>;
  replacePath(judge, 'metadataPath');
  return normalized;
}

async function runProvider(
  root: string,
  fake: string,
  input: string,
  stateDir: string,
  runner: Runner,
  testCase: ProjectionCase,
  artifacts: FixtureArtifacts,
): Promise<ProviderRunProjection> {
  const work = path.join(root, `work-${runner}`);
  mkdirSync(work);
  const env = {
    PATH: `${fake}:${process.env.PATH ?? ''}`,
    AGENT_QUORUM_HOME: path.join(root, 'home'),
    AGENT_QUORUM_PLANS_DIR: path.join(root, 'plans'),
    AGENT_QUORUM_STATE_DIR: stateDir,
    AGENT_QUORUM_CLARIFY: '0',
    AGENT_QUORUM_RETRY_COUNT: '0',
    AGENT_QUORUM_RETRY_DELAY_SECONDS: '0',
    AGENT_QUORUM_RESUME: undefined,
    ...providerEnvironment(root, runner, artifacts, testCase.fixRequired),
  };
  const result = await withEnvAsync(env, () =>
    runPlanLoop({
      input,
      iters: 2,
      quality: 'balanced',
      fix: testCase.fixRequired,
      translate: false,
      workDir: work,
      home: path.join(root, 'home'),
      config: roleOverrides(runner),
    }),
  );
  expect(result.exitCode).toBe(0);
  expect(result.runId).toBeDefined();
  const api = requiredFinal(result);
  const durableRecord = readRunRecords(stateDir).find((record) => record.runId === result.runId);
  expect(durableRecord).toBeDefined();
  expect(durableRecord?.final).toEqual(api);
  if (durableRecord?.final === undefined) {
    throw new TypeError('provider projection run record did not persist the final projection');
  }

  expect(api).toMatchObject({
    status: testCase.expectedStatus,
    readiness: {
      planVersion: 1,
      decision: testCase.expectedStatus === 'clean' ? 'ready' : 'unable-to-decide',
      occurrenceCoverage: {
        expectedOccurrenceIds: [OCCURRENCE_ID],
        outcomes: [
          {
            invariantId: INVARIANT_ID,
            occurrenceId: OCCURRENCE_ID,
            outcome: testCase.expectedOutcome,
          },
        ],
      },
    },
    judge: {
      required: true,
      available: true,
      candidateUnchanged: true,
      verdict: testCase.disposition === 'satisfied' || testCase.disposition === 'not-applicable',
    },
  });
  expect(api.readiness.canonicalPlanSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(source(api, 'critic').snapshot?.occurrences).toEqual([
    expect.objectContaining({
      occurrenceId: OCCURRENCE_ID,
      disposition:
        testCase.disposition === 'violated' || testCase.disposition === 'unresolved'
          ? 'satisfied'
          : testCase.disposition,
    }),
  ]);
  expect(source(api, 'fix-reviewer')).toMatchObject(
    testCase.fixRequired
      ? {
          required: true,
          available: true,
          reason: 'fix-pass-replacement-retained',
          snapshot: {
            occurrences: [
              expect.objectContaining({
                occurrenceId: OCCURRENCE_ID,
                disposition: 'satisfied',
              }),
            ],
          },
        }
      : { required: false, available: false, reason: 'disabled' },
  );
  expect(source(api, 'final-judge').snapshot?.occurrences).toEqual([
    expect.objectContaining({
      occurrenceId: OCCURRENCE_ID,
      disposition: testCase.disposition,
    }),
  ]);

  return { api, durable: durableRecord.final };
}

describe('provider-neutral public and durable final projections', () => {
  it.each(CASES)(
    'projects $disposition with fixRequired=$fixRequired identically for every provider',
    async (testCase) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-provider-projection.'));
      const capture = captureStderr();
      try {
        const fake = path.join(root, 'bin');
        writeFakeBin(fake);
        const stateDir = path.join(root, 'state');
        const plansDir = path.join(root, 'plans');
        mkdirSync(stateDir);
        mkdirSync(plansDir);
        writeStoreConfig(path.join(root, 'home'));
        const input = path.join(root, 'input.md');
        writeStructuredPlanFile(input, 'Provider Projection Input');
        if (testCase.fixRequired) {
          writeFileSync(
            input,
            `${readFileSync(input, 'utf8')}\n- Fixture finding: \`missing-provider-file.ts:99999\`\n`,
          );
        }
        const artifacts = fixtureArtifacts(root, testCase);

        const projections: ProviderRunProjection[] = [];
        for (const runner of PROVIDERS) {
          projections.push(
            await runProvider(root, fake, input, stateDir, runner, testCase, artifacts),
          );
        }

        const normalized = projections.map(({ api }, index) =>
          normalizeWorkdirPaths(api, path.join(root, `work-${PROVIDERS[index] ?? ''}`)),
        );
        expect(normalized[1]).toEqual(normalized[0]);
        expect(normalized[2]).toEqual(normalized[0]);
        for (const [index, projection] of projections.entries()) {
          expect(
            normalizeWorkdirPaths(
              projection.durable,
              path.join(root, `work-${PROVIDERS[index] ?? ''}`),
            ),
          ).toEqual(normalized[index]);
        }
      } finally {
        capture.restore();
        rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
