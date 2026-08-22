import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunContext } from '../../src/core/run-context.js';
import type { Quality, Role } from '../../src/types.js';
import { Scratch } from '../../src/runtime/scratch.js';
import {
  runCreatorClarify,
  runCreatorCreate,
  runCreatorReadinessAssessment,
  runCreatorUpdate,
} from '../../src/stages/plan/creator.js';
import { runCritic } from '../../src/stages/plan/critic.js';
import { runFixPass } from '../../src/stages/plan/fix-pass.js';
import { runFinalJudge, runJudge } from '../../src/stages/plan/judge.js';
import { runTranslatePass } from '../../src/stages/plan/translate-pass.js';
import {
  argvRecords,
  withEnvAsync,
  writeFakeBin,
  writeReadinessAssessment,
  writeStructuredPlanFile,
} from '../helpers/harness.js';
import { fixtureMatrix, makeTestRunContext } from '../helpers/test-context.js';

const ORIGINAL_SCOPE = 'ORIGINAL_SCOPE_BOUNDARY_SENTINEL';
const AUTHORITATIVE_FACT = '@fixture/authoritative-boundary';
const OPERATOR_DECISION = 'OPERATOR_DECISION_BOUNDARY_SENTINEL';
const ACTIVE_INTERVENTION = 'ACTIVE_INTERVENTION_BOUNDARY_SENTINEL';
const MATERIAL_FINDING = 'MATERIAL_FINDING_BOUNDARY_SENTINEL';
const ACTIVE_INVARIANT = 'ACTIVE_INVARIANT_BOUNDARY_SENTINEL';
const REJECTED_HISTORY = 'REJECTED_HISTORY_BOUNDARY_SENTINEL';
const FULL_HISTORY = 'FULL_HISTORY_BOUNDARY_SENTINEL';
const OMITTED_PLAN_BODY = 'HISTORY_PLAN_BODY_MUST_NOT_APPEAR';
const INVARIANT_ID = 'I-v0-C1';
const OCCURRENCE_ID = `O-${'a'.repeat(64)}`;
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

const roots: string[] = [];
const scratches: Scratch[] = [];

afterEach(() => {
  for (const scratch of scratches.splice(0)) {
    scratch.sweep();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface BoundaryFixture {
  readonly tmp: string;
  readonly work: string;
  readonly fakePath: string;
  readonly ctx: RunContext;
}

function allCodexMatrix() {
  const matrix = fixtureMatrix();
  for (const role of ['creator', 'critic', 'fixer', 'reviewer', 'translator', 'judge'] as const) {
    matrix[role] = { runner: 'codex', model: 'gpt-boundary-fixture', reasoning: 'high' };
  }
  return matrix;
}

function writeCurrentCritique(
  file: string,
  planVersion: number,
  scopeCoverage: 'original-scope' | 'direct-plan-scope' = 'original-scope',
): void {
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        plan_version: planVersion,
        summary: 'current boundary critique',
        issues: [
          {
            id: 'C1',
            addresses: null,
            severity: 'major',
            category: 'correctness',
            claim: 'current boundary issue',
            evidence: '## Work Plan',
            suggested_fix: 'fix the boundary issue',
            confidence: 1,
            duplicate_of: null,
          },
        ],
        review: {
          considered_context: REQUIRED_CRITIC_CONTEXT,
          invariant_assessments: [],
          scope_coverage: [scopeCoverage],
          issue_budget: { limit: 8, used: 1, exhausted: false },
          scan_complete: true,
          unresolved_coverage: [],
        },
      },
      null,
      2,
    )}\n`,
  );
}

function writeRevisionResult(file: string, version: number, planFile: string): void {
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        plan_version: version,
        plan_markdown: readFileSync(planFile, 'utf8'),
        issues: [
          {
            id: 'C1',
            verdict: 'accept',
            verdict_reason: 'boundary fixture accepted the correction',
            final_severity: 'major',
            duplicate_of: null,
          },
        ],
        applied: ['C1'],
        systemic_dispositions: [
          {
            issue_id: 'C1',
            scope: 'local',
            rationale: 'The fixture evidence confines the correction to one plan phase.',
            evidence_refs: [{ kind: 'plan-section', section: 'Work Plan' }],
            invariant: null,
          },
        ],
        rejected_append: [],
      },
      null,
      2,
    )}\n`,
  );
}

function writeRevisionMetadata(file: string, version: number): void {
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        plan_version: version,
        issues: [
          {
            id: 'C1',
            verdict: 'accept',
            verdict_reason: 'boundary fixture accepted the correction',
            final_severity: 'major',
            duplicate_of: null,
          },
        ],
        applied: ['C1'],
        systemic_dispositions: [
          {
            issue_id: 'C1',
            scope: 'local',
            rationale: 'The fixture evidence confines the correction to one plan phase.',
            evidence_refs: [{ kind: 'plan-section', section: 'Work Plan' }],
            invariant: null,
          },
        ],
        rejected_append: [],
      },
      null,
      2,
    )}\n`,
  );
}

function writeCodexMarkdownResult(file: string, markdownFile: string): void {
  writeFileSync(file, `${JSON.stringify({ plan_markdown: readFileSync(markdownFile, 'utf8') })}\n`);
}

function createBoundaryFixture(
  quality: Quality,
  mode: 'plan' | 'prompt' = 'prompt',
): BoundaryFixture {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-retained-boundary.'));
  roots.push(tmp);
  const fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  const work = path.join(tmp, 'work');
  mkdirSync(work);
  const scratch = Scratch.create('retained-boundary');
  scratches.push(scratch);
  const input = path.join(tmp, 'input.md');
  writeStructuredPlanFile(input, 'Boundary Input');
  if (mode === 'prompt') {
    writeFileSync(path.join(work, 'prompt.md'), `# Request\n\n${ORIGINAL_SCOPE}\n`);
  }
  copyFileSync(input, path.join(work, 'plan.v2.md'));
  writeFileSync(
    path.join(work, 'operator-interventions.jsonl'),
    [
      JSON.stringify({
        id: 'op-clarify-boundary',
        ts: '2026-08-17T00:00:00Z',
        target: 'all',
        message: OPERATOR_DECISION,
      }),
      JSON.stringify({
        id: 'intervention-boundary',
        ts: '2026-08-17T00:00:01Z',
        target: 'all',
        message: ACTIVE_INTERVENTION,
      }),
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(work, 'rejected-log.jsonl'),
    `${JSON.stringify({
      iter: 0,
      id: 'C7',
      claim: REJECTED_HISTORY,
      reason: 'out_of_plan_scope',
    })}\n`,
  );
  writeFileSync(
    path.join(work, 'critique.v0.json'),
    `${JSON.stringify({
      plan_version: 0,
      summary: FULL_HISTORY,
      issues: [
        {
          id: 'C7',
          severity: 'minor',
          addresses: null,
          claim: 'historic minor conclusion',
        },
      ],
    })}\n`,
  );
  writeFileSync(
    path.join(work, 'update.v0.json'),
    `${JSON.stringify({
      plan_version: 1,
      plan_markdown: OMITTED_PLAN_BODY,
      issues: [
        {
          id: 'C7',
          verdict: 'reject_out_of_scope',
          verdict_reason: 'historic minor conclusion is outside scope',
          final_severity: 'minor',
          duplicate_of: null,
        },
      ],
      applied: [],
      rejected_append: [],
    })}\n`,
  );
  writeCurrentCritique(path.join(work, 'critique.v2.json'), 2);

  const ctx = makeTestRunContext(tmp, work, scratch, {
    quality,
    maxIters: 5,
    mode,
    locale: 'fr',
    matrix: allCodexMatrix(),
  });
  ctx.systemContext = {
    schemaVersion: 1,
    scopeSource: mode === 'prompt' ? 'prompt' : 'direct-plan',
    originalRequestAvailable: mode === 'prompt',
    declaredScope: ['boundary-repository'],
    sources: [],
    digest: 'authoritative-boundary-digest',
    crossRepository: false,
    relationships: [],
    limitations: [],
    facts: {
      repositories: ['boundary-repository'],
      packages: [AUTHORITATIVE_FACT],
      packageExports: [`${AUTHORITATIVE_FACT}:.:./index.js`],
      packageScripts: [`${AUTHORITATIVE_FACT}:check:pnpm test`],
      images: [],
      workflows: ['boundary.yml'],
      ciTriggers: ['boundary.yml:push'],
      regions: ['test-region-1'],
      migrationCommands: [],
      deliveryStages: ['verify'],
      authorizationBoundaries: ['operator'],
      gates: ['boundary-green'],
    },
  };
  ctx.convergence.authoritativeDigest = ctx.systemContext.digest;
  ctx.convergence.exhaustedLimits = ['iteration-cap'];
  ctx.convergence.findings = [
    {
      id: INVARIANT_ID,
      issueRef: 'v0.C1',
      introducedPlanVersion: 1,
      severity: 'major',
      claim: MATERIAL_FINDING,
      disposition: {
        scope: 'cross-cutting',
        rationale: 'Every occurrence must preserve the boundary contract.',
      },
    },
  ];
  ctx.convergence.invariants = [
    {
      id: INVARIANT_ID,
      sourceFinding: INVARIANT_ID,
      statement: ACTIVE_INVARIANT,
      status: 'active',
      occurrences: [
        {
          id: OCCURRENCE_ID,
          dimension: 'provider-boundary',
          subject: 'all roles',
          disposition: 'unresolved',
          evidenceRefs: [],
        },
      ],
    },
  ];
  return { tmp, work, fakePath: `${fake}:${process.env.PATH ?? ''}`, ctx };
}

function promptRecords(file: string): string[] {
  return readFileSync(file)
    .toString('utf8')
    .split('\0')
    .filter((record) => record !== '');
}

async function capturePrompts(
  fixture: BoundaryFixture,
  label: string,
  output: string,
  action: () => Promise<unknown>,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<string[]> {
  const prompt = path.join(fixture.tmp, `${label}.prompt`);
  const promptLog = path.join(fixture.tmp, `${label}.prompts`);
  await withEnvAsync(
    {
      PATH: fixture.fakePath,
      FAKE_CODEX_OUTPUT: output,
      FAKE_CODEX_PROMPT: prompt,
      FAKE_CODEX_PROMPT_LOG: promptLog,
      ...extraEnv,
    },
    action,
  );
  return promptRecords(promptLog);
}

function stageOf(prompt: string): string {
  return /^stage: (.+)$/m.exec(prompt)?.[1] ?? 'unknown';
}

function roleOf(prompt: string): string {
  return /^role: (.+)$/m.exec(prompt)?.[1] ?? 'unknown';
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

async function captureRevision(
  fixture: BoundaryFixture,
  quality: Quality,
  iter: number,
): Promise<string[]> {
  const revision = path.join(fixture.tmp, `revision-${iter}.md`);
  writeStructuredPlanFile(revision, `Boundary Revision ${iter + 1}`);
  const update = path.join(fixture.work, `update.v${iter}.json`);
  const next = path.join(fixture.work, `plan.v${iter + 1}.md`);
  if (quality === 'quick') {
    const oneShot = path.join(fixture.tmp, `one-shot-${iter}.json`);
    writeRevisionResult(oneShot, iter + 1, revision);
    return capturePrompts(fixture, `revision-${iter}`, oneShot, () =>
      runCreatorUpdate(
        fixture.ctx,
        iter,
        path.join(fixture.work, `plan.v${iter}.md`),
        path.join(fixture.work, `critique.v${iter}.json`),
        update,
        next,
      ),
    );
  }
  const metadata = path.join(fixture.tmp, `metadata-${iter}.json`);
  const wrappedRevision = path.join(fixture.tmp, `revision-${iter}.json`);
  writeRevisionMetadata(metadata, iter + 1);
  writeCodexMarkdownResult(wrappedRevision, revision);
  return capturePrompts(
    fixture,
    `revision-${iter}`,
    metadata,
    () =>
      runCreatorUpdate(
        fixture.ctx,
        iter,
        path.join(fixture.work, `plan.v${iter}.md`),
        path.join(fixture.work, `critique.v${iter}.json`),
        update,
        next,
      ),
    {
      FAKE_CODEX_OUTPUT_CALLS: path.join(fixture.tmp, `revision-${iter}.calls`),
      FAKE_CODEX_OUTPUT_1: wrappedRevision,
      FAKE_CODEX_OUTPUT_2: metadata,
    },
  );
}

function readinessOutput(fixture: BoundaryFixture): string {
  const file = path.join(fixture.tmp, 'readiness.json');
  writeFileSync(
    file,
    `${JSON.stringify({
      ready: true,
      rationale: 'boundary fixture is ready',
      coverage_complete: true,
      unresolved_occurrence_ids: [],
      invariant_assessments: [
        {
          invariant_id: INVARIANT_ID,
          satisfied: true,
          unresolved_occurrence_ids: [],
        },
      ],
    })}\n`,
  );
  return file;
}

function reviewerOutput(fixture: BoundaryFixture): string {
  const file = path.join(fixture.tmp, 'review.json');
  writeFileSync(
    file,
    `${JSON.stringify({
      approval: 'accept',
      coverage_complete: true,
      unresolved_occurrence_ids: [],
      invariant_assessments: [
        {
          invariant_id: INVARIANT_ID,
          satisfied: true,
          unresolved_occurrence_ids: [],
        },
      ],
      concerns: [],
    })}\n`,
  );
  return file;
}

async function captureEveryRole(quality: Quality): Promise<{ ctx: RunContext; prompts: string[] }> {
  const fixture = createBoundaryFixture(quality);
  const prompts: string[] = [];
  const clarification = path.join(fixture.tmp, 'clarification.json');
  writeFileSync(clarification, '{"questions":[]}\n');
  prompts.push(
    ...(await capturePrompts(fixture, 'clarification', clarification, () =>
      runCreatorClarify(
        fixture.ctx,
        fixture.ctx.inputPath,
        path.join(fixture.work, 'clarify.json'),
      ),
    )),
  );

  const created = path.join(fixture.tmp, 'created.md');
  const createdResult = path.join(fixture.tmp, 'created.json');
  writeStructuredPlanFile(created, 'Boundary Created Plan');
  writeCodexMarkdownResult(createdResult, created);
  prompts.push(
    ...(await capturePrompts(fixture, 'create', createdResult, () =>
      runCreatorCreate(fixture.ctx, fixture.ctx.inputPath, path.join(fixture.work, 'created.md')),
    )),
  );

  const criticResult = path.join(fixture.tmp, 'critic.json');
  writeCurrentCritique(criticResult, 2);
  prompts.push(
    ...(await capturePrompts(fixture, 'critic', criticResult, () =>
      runCritic(
        fixture.ctx,
        2,
        path.join(fixture.work, 'plan.v2.md'),
        path.join(fixture.work, 'critic-output.json'),
      ),
    )),
  );

  prompts.push(...(await captureRevision(fixture, quality, 2)));
  writeCurrentCritique(path.join(fixture.work, 'critique.v3.json'), 3);
  prompts.push(...(await captureRevision(fixture, quality, 3)));
  fixture.ctx.convergence.planVersion = 4;
  fixture.ctx.lastCritiqueIter = 3;
  const finalPlan = path.join(fixture.work, 'plan.final.md');
  copyFileSync(path.join(fixture.work, 'plan.v4.md'), finalPlan);

  if (fixture.ctx.quality.judge === 1) {
    const readiness = readinessOutput(fixture);
    prompts.push(
      ...(await capturePrompts(fixture, 'intermediate-judge', readiness, () =>
        runJudge(
          fixture.ctx,
          4,
          finalPlan,
          path.join(fixture.work, 'critique.v3.json'),
          path.join(fixture.work, 'judge.v4.json'),
        ),
      )),
    );
    prompts.push(
      ...(await capturePrompts(fixture, 'final-judge', readiness, () =>
        runFinalJudge(fixture.ctx, finalPlan),
      )),
    );
  }

  const translated = path.join(fixture.tmp, 'translated.md');
  const translatedResult = path.join(fixture.tmp, 'translated.json');
  writeFileSync(translated, '# Plan traduit\n');
  writeCodexMarkdownResult(translatedResult, translated);
  prompts.push(
    ...(await capturePrompts(fixture, 'translate', translatedResult, () =>
      runTranslatePass(fixture.ctx, finalPlan, path.join(fixture.work, 'plan.final.fr.md')),
    )),
  );

  writeFileSync(
    path.join(fixture.work, 'findings.json'),
    `${JSON.stringify({
      stale_lines: [{ file: 'fixture.md', line: 2, actual_lines: 1 }],
      ambiguous: [],
      unresolved: [],
    })}\n`,
  );
  const proposal = path.join(fixture.tmp, 'proposal.md');
  const proposalResult = path.join(fixture.tmp, 'proposal.json');
  writeStructuredPlanFile(proposal, 'Boundary Fixed Proposal');
  writeCodexMarkdownResult(proposalResult, proposal);
  const review = reviewerOutput(fixture);
  prompts.push(
    ...(await capturePrompts(fixture, 'fix', review, () => runFixPass(fixture.ctx, finalPlan), {
      FAKE_CODEX_OUTPUT_CALLS: path.join(fixture.tmp, 'fix.calls'),
      FAKE_CODEX_OUTPUT_1: proposalResult,
      FAKE_CODEX_OUTPUT_2: review,
    })),
  );
  return { ctx: fixture.ctx, prompts };
}

const EXPECTED_ROLE: Readonly<Record<string, Role>> = {
  clarification: 'creator',
  create: 'creator',
  review: 'critic',
  'revision-and-metadata': 'creator',
  'markdown-revision': 'creator',
  'update-metadata': 'creator',
  'intermediate-readiness': 'judge',
  'final-readiness': 'judge',
  translate: 'translator',
  'fix-proposal': 'fixer',
  'fix-proposal-review': 'reviewer',
};

describe('retained context at provider boundaries', () => {
  it.each([
    ['quick', 'best-effort'],
    ['balanced', 'cumulative'],
    ['thorough', 'exhaustive'],
  ] as const)(
    'delivers cumulative mandatory context through every %s role entry point',
    async (quality, promise) => {
      const { ctx, prompts } = await captureEveryRole(quality);
      const stages = prompts.map(stageOf);
      expect(stages).toContain('clarification');
      expect(stages).toContain('create');
      expect(stages).toContain('review');
      expect(
        stages.filter((stage) =>
          quality === 'quick'
            ? stage === 'revision-and-metadata'
            : stage === 'markdown-revision' || stage === 'update-metadata',
        ),
      ).toHaveLength(quality === 'quick' ? 2 : 4);
      expect(stages).toContain('fix-proposal');
      expect(stages).toContain('fix-proposal-review');
      expect(stages).toContain('translate');
      if (quality === 'quick') {
        expect(stages).not.toContain('intermediate-readiness');
        expect(stages).not.toContain('final-readiness');
      } else {
        expect(stages).toContain('intermediate-readiness');
        expect(stages).toContain('final-readiness');
      }

      for (const prompt of prompts) {
        const stage = stageOf(prompt);
        expect(roleOf(prompt)).toBe(EXPECTED_ROLE[stage]);
        expect(prompt).toContain('## Mandatory retained run context');
        expect(prompt).toContain('scope_source: prompt');
        expect(prompt).toContain(ORIGINAL_SCOPE);
        expect(prompt).toContain('declared_scope: boundary-repository');
        expect(prompt).toContain(`packages: ${AUTHORITATIVE_FACT}`);
        expect(prompt).toContain(OPERATOR_DECISION);
        expect(prompt).toContain(ACTIVE_INTERVENTION);
        expect(prompt).toContain(MATERIAL_FINDING);
        expect(prompt).toContain(ACTIVE_INVARIANT);
        expect(prompt).toContain(OCCURRENCE_ID);
        expect(prompt).toContain(`quality_promise: ${promise}`);
        expect(prompt).toContain('iteration_limit: 5');
        expect(prompt).toContain('issue_budget: 8');
        expect(prompt).toContain('exhausted_limits: iteration-cap');
        expect(/^considered_context_required: (.+)$/m.exec(prompt)?.[1]?.split(', ')).toEqual(
          REQUIRED_CRITIC_CONTEXT,
        );
        expect(/^scope_coverage_required: (.+)$/m.exec(prompt)?.[1]).toBe('original-scope');
        expect(/^scope_coverage_vocabulary: (.+)$/m.exec(prompt)?.[1]?.split(', ')).toEqual(
          CRITIC_SCOPE_COVERAGE_VOCABULARY,
        );
        expect(prompt).toContain(`requires_exhaustive_scan: ${String(quality === 'thorough')}`);
        expect(prompt).toContain('## Quality-adjusted retained history');
        expect(prompt).toContain(REJECTED_HISTORY);
        expect(prompt).not.toContain(OMITTED_PLAN_BODY);
        expect(occurrences(prompt, OPERATOR_DECISION)).toBe(1);
        expect(occurrences(prompt, ACTIVE_INTERVENTION)).toBe(1);
        expect(occurrences(prompt, REJECTED_HISTORY)).toBe(1);
      }

      for (const prompt of prompts.filter((entry) => /^plan_version: [2-9]$/m.test(entry))) {
        if (quality === 'quick') {
          expect(prompt).not.toContain(FULL_HISTORY);
          expect(prompt).toContain('- critique.v0.json.C7 [minor, addresses=new]');
        } else {
          expect(prompt).toContain(FULL_HISTORY);
          expect(occurrences(prompt, FULL_HISTORY)).toBe(1);
        }
      }
      expect(ctx.convergence.contextDeliveries.map((delivery) => delivery.stage)).toEqual(stages);
    },
    30_000,
  );

  it('delivers the direct-plan scope marker through the critic provider boundary', async () => {
    const fixture = createBoundaryFixture('quick', 'plan');
    const output = path.join(fixture.tmp, 'direct-critic.json');
    writeCurrentCritique(output, 2, 'direct-plan-scope');
    const [prompt] = await capturePrompts(fixture, 'direct-critic', output, () =>
      runCritic(
        fixture.ctx,
        2,
        path.join(fixture.work, 'plan.v2.md'),
        path.join(fixture.work, 'direct-critic-output.json'),
      ),
    );

    expect(prompt).toBeDefined();
    const capturedPrompt = prompt ?? '';
    expect(capturedPrompt).toContain('scope_source: direct-plan');
    expect(capturedPrompt).toContain('original_request: unavailable');
    expect(capturedPrompt).toContain('The direct plan is the declared scope.');
    expect(/^scope_coverage_required: (.+)$/m.exec(capturedPrompt)?.[1]).toBe('direct-plan-scope');
    expect(/^scope_coverage_vocabulary: (.+)$/m.exec(capturedPrompt)?.[1]?.split(', ')).toEqual(
      CRITIC_SCOPE_COVERAGE_VOCABULARY,
    );
    expect(capturedPrompt).not.toContain(ORIGINAL_SCOPE);
  });

  it('gives Assessment Mode the direct plan body with fixed read-only tools', async () => {
    const fixture = createBoundaryFixture('quick', 'plan');
    fixture.ctx.provider.matrix.creator = {
      runner: 'claude',
      model: 'claude-boundary-fixture',
      reasoning: 'high',
    };
    fixture.ctx.permissions.creator.createTools = 'Read,Grep,Glob,Write,Edit,Bash';
    fixture.ctx.permissions.creator.createDisallowedTools = '';

    const assessment = path.join(fixture.tmp, 'direct-assessment.json');
    const output = path.join(fixture.work, 'direct-assessment-output.json');
    const promptFile = path.join(fixture.tmp, 'direct-assessment.prompt');
    const argvFile = path.join(fixture.tmp, 'direct-assessment.argv');
    writeReadinessAssessment(assessment);

    await withEnvAsync(
      {
        PATH: fixture.fakePath,
        FAKE_READINESS_ASSESSMENT: assessment,
        FAKE_CLAUDE_PROMPT: promptFile,
        FAKE_CLAUDE_ARGV_LOG: argvFile,
      },
      () => runCreatorReadinessAssessment(fixture.ctx, output),
    );

    const prompt = readFileSync(promptFile, 'utf8');
    expect(prompt).toContain('## Direct plan (declared implementation scope)');
    expect(prompt).toContain('# Boundary Input');
    expect(prompt).toContain('fixture gate observable');

    const args = argvRecords(argvFile)[0] ?? [];
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(args[args.indexOf('--allowed-tools') + 1]).toBe('Read,Grep,Glob');
    expect(args[args.indexOf('--disallowed-tools') + 1]).toBe(
      'Write,Edit,NotebookEdit,Bash,Agent,Task,ToolSearch,AskUserQuestion',
    );
  });
});
