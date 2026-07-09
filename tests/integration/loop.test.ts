import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIterationLoop } from '../../src/stages/plan/loop.js';
import type { RunContext } from '../../src/core/run-context.js';
import { Scratch } from '../../src/runtime/scratch.js';
import {
  fixtureMatrix,
  makeTestRunContext,
  type TestContextOptions,
} from '../helpers/test-context.js';
import {
  argvRecords,
  captureStderr,
  emptyCritique,
  REPO_ROOT,
  withEnvAsync,
  writeAcceptUpdate,
  writeCritique,
  writeFakeBin,
  writeStructuredPlanFile,
  writeUpdate,
  type StderrCapture,
} from '../helpers/harness.js';

const SINGLE_ISSUE = [
  {
    id: 'C1',
    addresses: null,
    severity: 'major',
    category: 'correctness',
    claim: 'issue',
    evidence: 'fixture',
    suggested_fix: 'fix',
    confidence: 1,
    duplicate_of: null,
  },
];

const ALL_DUPLICATE_ISSUES = [
  {
    id: 'C1',
    addresses: null,
    severity: 'nit',
    category: 'correctness',
    claim: 'duplicate issue',
    evidence: 'fixture',
    suggested_fix: 'fix',
    confidence: 1,
    duplicate_of: 'r1',
  },
];

let tmp: string;
let fake: string;
let work: string;
let scratch: Scratch;
let capture: StderrCapture;

function makeContext(options: TestContextOptions = {}): RunContext {
  return makeTestRunContext(tmp, work, scratch, options);
}

function seedWork(): void {
  const input = path.join(tmp, 'input.md');
  writeStructuredPlanFile(input, 'Input');
  copyFileSync(input, path.join(work, 'plan.v0.md'));
  writeFileSync(path.join(work, 'rejected-log.jsonl'), '');
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-looptest.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  work = path.join(tmp, 'work');
  mkdirSync(work);
  scratch = Scratch.create('loop-test');
  capture = captureStderr();
});

afterEach(() => {
  capture.restore();
  scratch.sweep();
  rmSync(tmp, { recursive: true, force: true });
});

function fakePath(): string {
  return `${fake}:${process.env.PATH ?? ''}`;
}

describe('iteration loop', () => {
  it('MAX_ITERS fallback uses the last revision', async () => {
    seedWork();
    const critique = path.join(tmp, 'critique.json');
    writeCritique(critique, SINGLE_ISSUE);
    const next = path.join(tmp, 'next.md');
    writeStructuredPlanFile(next, 'Next');
    const update = path.join(tmp, 'update.json');
    writeAcceptUpdate(update, 1, next);
    const ctx = makeContext({ maxIters: 1, diffThreshold: 0 });

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CLAUDE_JSON_RESULT: update,
        FAKE_CLAUDE_REQUIRE_DRAFT7: '1',
      },
      () => runIterationLoop(ctx, 0),
    );

    expect(capture.text()).toContain('hit MAX_ITERS=1 without convergence');
    expect(JSON.parse(readFileSync(path.join(work, 'update.v0.json'), 'utf8'))).toEqual(
      JSON.parse(readFileSync(update, 'utf8')),
    );
    expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe(
      readFileSync(path.join(work, 'plan.v1.md'), 'utf8'),
    );
  });

  it('stable-diff break uses the stable revision', async () => {
    seedWork();
    const critique = path.join(tmp, 'critique.json');
    writeCritique(critique, SINGLE_ISSUE);
    const update = path.join(tmp, 'update.json');
    writeAcceptUpdate(update, 1, path.join(tmp, 'input.md'));
    const ctx = makeContext({ maxIters: 2 });

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CLAUDE_JSON_RESULT: update,
      },
      () => runIterationLoop(ctx, 0),
    );

    expect(capture.text()).toContain('stable-diff at v1');
    expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe(
      readFileSync(path.join(work, 'plan.v1.md'), 'utf8'),
    );
  });

  it('full topology mode includes ecosystem.yaml', async () => {
    seedWork();
    writeFileSync(
      path.join(tmp, 'ecosystem.yaml'),
      'name: fixture-ecosystem\nrepos:\n  - fixture\n',
    );
    const empty = path.join(tmp, 'empty.json');
    emptyCritique(empty);
    const promptCapture = path.join(tmp, 'codex.prompt');
    const ctx = makeContext({ quality: 'thorough', maxIters: 1 });

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: empty,
        FAKE_CODEX_PROMPT: promptCapture,
      },
      () => runIterationLoop(ctx, 0),
    );

    const prompt = readFileSync(promptCapture, 'utf8');
    expect(prompt).toContain('## Repo topology (ecosystem.yaml)');
    expect(prompt).toContain('name: fixture-ecosystem');
  });

  it('compact topology mode uses summary', async () => {
    seedWork();
    writeFileSync(
      path.join(tmp, 'ecosystem.yaml'),
      'name: fixture-ecosystem\nrepos:\n  - fixture\n',
    );
    const empty = path.join(tmp, 'empty.json');
    emptyCritique(empty);
    const promptCapture = path.join(tmp, 'codex.prompt');
    const ctx = makeContext({ quality: 'quick', maxIters: 1 });

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: empty,
        FAKE_CODEX_PROMPT: promptCapture,
      },
      () => runIterationLoop(ctx, 0),
    );

    const prompt = readFileSync(promptCapture, 'utf8');
    expect(prompt).toContain('## Repo topology summary');
    const skill = readFileSync(path.join(REPO_ROOT, 'skills', 'plan-critic', 'SKILL.md'), 'utf8');
    const headingCount = (text: string) =>
      text.split('## Repo topology (ecosystem.yaml)').length - 1;
    expect(headingCount(prompt)).toBe(headingCount(skill));
    expect(prompt).not.toContain('name: fixture-ecosystem');
  });

  it('critic prompt receives operator interventions', async () => {
    seedWork();
    writeFileSync(
      path.join(work, 'operator-interventions.jsonl'),
      `${JSON.stringify({
        id: 'i-critic-1',
        ts: '2026-06-10T00:00:00Z',
        target: 'critic',
        message: 'critic must check identity-aware convergence',
      })}\n`,
    );
    const empty = path.join(tmp, 'empty.json');
    emptyCritique(empty);
    const promptCapture = path.join(tmp, 'codex.prompt');
    const ctx = makeContext({ maxIters: 1 });

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: empty,
        FAKE_CODEX_PROMPT: promptCapture,
      },
      () => runIterationLoop(ctx, 0),
    );

    const prompt = readFileSync(promptCapture, 'utf8');
    expect(prompt).toContain('## Operator interventions');
    expect(prompt).toContain('critic must check identity-aware convergence');
  });

  it('consumes Claude critic output with a draft-07 schema', async () => {
    seedWork();
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const matrix = fixtureMatrix();
    matrix.critic = {
      runner: 'claude',
      model: 'claude-opus-4-8',
      reasoning: 'xhigh',
    };
    const ctx = makeContext({ maxIters: 1, matrix });

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_JSON_RESULT: critique,
        FAKE_CLAUDE_REQUIRE_DRAFT7: '1',
      },
      () => runIterationLoop(ctx, 0),
    );

    expect(JSON.parse(readFileSync(path.join(work, 'critique.v0.json'), 'utf8'))).toEqual(
      JSON.parse(readFileSync(critique, 'utf8')),
    );
    expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe(
      readFileSync(path.join(work, 'plan.v0.md'), 'utf8'),
    );
  });

  it('split update produces revision, metadata, and combined update (quality balanced)', async () => {
    seedWork();
    const critique = path.join(tmp, 'critique.json');
    writeCritique(critique, SINGLE_ISSUE);
    const revision = path.join(tmp, 'revision.md');
    writeStructuredPlanFile(revision, 'Split Revision');
    const meta = path.join(tmp, 'meta.json');
    writeFileSync(
      meta,
      `${JSON.stringify(
        {
          plan_version: 1,
          issues: [
            {
              id: 'C1',
              verdict: 'accept',
              verdict_reason: 'fixture',
              final_severity: 'minor',
              duplicate_of: null,
            },
          ],
          applied: ['C1'],
          rejected_append: [],
        },
        null,
        2,
      )}\n`,
    );
    const ctx = makeContext({ quality: 'balanced', maxIters: 2 });

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CLAUDE_MARKDOWN_RESULT: revision,
        FAKE_CLAUDE_JSON_RESULT: meta,
        FAKE_CLAUDE_REQUIRE_DRAFT7: '1',
      },
      () => runIterationLoop(ctx, 0),
    );

    expect(capture.text()).toContain('converged at v1 (no accepted blockers/majors)');
    expect(readFileSync(path.join(work, 'plan.revision.v0.md'), 'utf8')).toBe(
      readFileSync(revision, 'utf8'),
    );
    const update = JSON.parse(readFileSync(path.join(work, 'update.v0.json'), 'utf8')) as {
      plan_markdown: string;
    };
    expect(update.plan_markdown).toBe(readFileSync(revision, 'utf8'));
    expect(JSON.parse(readFileSync(path.join(work, 'update-meta.v0.json'), 'utf8'))).toEqual(
      JSON.parse(readFileSync(meta, 'utf8')),
    );
  });

  it('an invalid one-shot update falls back to the split flow', async () => {
    seedWork();
    const critique = path.join(tmp, 'critique.json');
    writeCritique(critique, SINGLE_ISSUE);
    const invalidOneShot = path.join(tmp, 'invalid-one-shot.json');
    writeFileSync(
      invalidOneShot,
      `${JSON.stringify({ plan_version: 1, issues: [], applied: [], rejected_append: [] }, null, 2)}\n`,
    );
    const revision = path.join(tmp, 'revision.md');
    writeStructuredPlanFile(revision, 'Fallback Revision');
    const meta = path.join(tmp, 'meta.json');
    writeFileSync(
      meta,
      `${JSON.stringify(
        {
          plan_version: 1,
          issues: [
            {
              id: 'C1',
              verdict: 'accept',
              verdict_reason: 'fixture',
              final_severity: 'minor',
              duplicate_of: null,
            },
          ],
          applied: ['C1'],
          rejected_append: [],
        },
        null,
        2,
      )}\n`,
    );
    const ctx = makeContext({ quality: 'quick', maxIters: 2 });

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CLAUDE_JSON_CALLS: path.join(tmp, 'claude.json.calls'),
        FAKE_CLAUDE_JSON_RESULT: invalidOneShot,
        FAKE_CLAUDE_JSON_RESULT_2: meta,
        FAKE_CLAUDE_MARKDOWN_RESULT: revision,
      },
      () => runIterationLoop(ctx, 0),
    );

    expect(capture.text()).toContain(
      'WARNING: one-shot creator update failed; falling back to split update',
    );
    expect(capture.text()).toContain('converged at v1 (no accepted blockers/majors)');
    expect(readFileSync(path.join(work, 'plan.v1.md'), 'utf8')).toBe(
      readFileSync(revision, 'utf8'),
    );
  });

  it('a one-shot Claude schema rejection falls back without retrying either JSON call', async () => {
    seedWork();
    const critique = path.join(tmp, 'critique.json');
    writeCritique(critique, SINGLE_ISSUE);
    const revision = path.join(tmp, 'schema-fallback-revision.md');
    writeStructuredPlanFile(revision, 'Schema Fallback Revision');
    const meta = path.join(tmp, 'schema-fallback-meta.json');
    writeFileSync(
      meta,
      `${JSON.stringify(
        {
          plan_version: 1,
          issues: [
            {
              id: 'C1',
              verdict: 'accept',
              verdict_reason: 'fixture',
              final_severity: 'minor',
              duplicate_of: null,
            },
          ],
          applied: ['C1'],
          rejected_append: [],
        },
        null,
        2,
      )}\n`,
    );
    const argvLog = path.join(tmp, 'claude-schema-fallback.argv');
    const ctx = makeContext({ quality: 'quick', maxIters: 2 });
    ctx.provider = {
      ...ctx.provider,
      retry: { retryCount: 3, retryDelaySeconds: 0 },
    };

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CLAUDE_ARGV_LOG: argvLog,
        FAKE_CLAUDE_JSON_RESULT: meta,
        FAKE_CLAUDE_MARKDOWN_RESULT: revision,
        FAKE_CLAUDE_REQUIRE_DRAFT7: '1',
        FAKE_CLAUDE_SCHEMA_REJECT: '1',
        FAKE_CLAUDE_SCHEMA_REJECT_TITLE: 'PlanUpdate',
      },
      () => runIterationLoop(ctx, 0),
    );

    const records = argvRecords(argvLog);
    const jsonRecords = records.filter((record) => record.includes('--json-schema'));
    const schemaTitles = jsonRecords.map((record) => {
      const schemaIndex = record.indexOf('--json-schema');
      const schema = JSON.parse(record[schemaIndex + 1] ?? '{}') as { title?: unknown };
      return schema.title;
    });
    expect(records).toHaveLength(3);
    expect(jsonRecords).toHaveLength(2);
    expect(schemaTitles).toEqual(['PlanUpdate', 'PlanUpdateMeta']);

    const log = capture.text();
    expect(log).toContain('schema-incompatible');
    expect(log).toContain('WARNING: one-shot creator update failed; falling back to split update');
    expect(log).not.toContain('retry 1/3');
    expect(readFileSync(path.join(work, 'plan.revision.v0.md'), 'utf8')).toBe(
      readFileSync(revision, 'utf8'),
    );
    expect(JSON.parse(readFileSync(path.join(work, 'update-meta.v0.json'), 'utf8'))).toEqual(
      JSON.parse(readFileSync(meta, 'utf8')),
    );
    const update = JSON.parse(readFileSync(path.join(work, 'update.v0.json'), 'utf8')) as {
      plan_markdown: string;
    };
    expect(update.plan_markdown).toBe(readFileSync(revision, 'utf8'));
    expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe(
      readFileSync(revision, 'utf8'),
    );
  });

  it('all-duplicate critique converges without creator update (AC-1)', async () => {
    seedWork();
    const critique = path.join(tmp, 'critique.json');
    writeCritique(critique, ALL_DUPLICATE_ISSUES);
    const ctx = makeContext({ maxIters: 2 });

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () => runIterationLoop(ctx, 0),
    );

    expect(capture.text()).toContain('converged at v0 (critic returned no issues)');
    expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe(
      readFileSync(path.join(work, 'plan.v0.md'), 'utf8'),
    );
    expect(existsSync(path.join(work, 'plan.v1.md'))).toBe(false);
  });

  it('health log includes unanchored count for non-duplicate issues (FR-2)', async () => {
    seedWork();
    const critique = path.join(tmp, 'critique.json');
    writeCritique(critique, SINGLE_ISSUE);
    const next = path.join(tmp, 'next.md');
    writeStructuredPlanFile(next, 'Next');
    const update = path.join(tmp, 'update.json');
    writeAcceptUpdate(update, 1, next);
    const ctx = makeContext({ maxIters: 1, diffThreshold: 0 });

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CLAUDE_JSON_RESULT: update,
      },
      () => runIterationLoop(ctx, 0),
    );

    const text = capture.text();
    expect(text).toContain('unanchored=');
    expect(text).toContain('possible evidence drift');
  });

  it('judge ready:true exits at v0 without creator update (AC-4)', async () => {
    seedWork();
    const critiqueFile = path.join(tmp, 'critique.json');
    writeCritique(critiqueFile, [
      {
        id: 'C1',
        addresses: null,
        severity: 'nit',
        category: 'convention',
        claim: 'minor nit',
        evidence: 'fixture:1',
        suggested_fix: 'fix',
        confidence: 1,
        duplicate_of: null,
      },
    ]);
    const judgeResult = path.join(tmp, 'judge-result.json');
    writeFileSync(judgeResult, JSON.stringify({ ready: true, rationale: 'implementation-ready' }));
    const ctx = makeContext({ quality: 'balanced', maxIters: 2 });

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critiqueFile,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CLAUDE_JSON_RESULT: judgeResult,
        FAKE_CLAUDE_REQUIRE_DRAFT7: '1',
      },
      () => runIterationLoop(ctx, 0),
    );

    expect(capture.text()).toContain('converged at v0 (judge verdict: implementation-ready)');
    expect(JSON.parse(readFileSync(path.join(work, 'judge.v0.json'), 'utf8'))).toEqual({
      ready: true,
      rationale: 'implementation-ready',
    });
    expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe(
      readFileSync(path.join(work, 'plan.v0.md'), 'utf8'),
    );
    expect(existsSync(path.join(work, 'plan.v1.md'))).toBe(false);
  });

  it('judge is absent from log when quality is quick (AC-6)', async () => {
    seedWork();
    const critiqueFile = path.join(tmp, 'critique.json');
    writeCritique(critiqueFile, [
      {
        id: 'C1',
        addresses: null,
        severity: 'nit',
        category: 'convention',
        claim: 'minor nit',
        evidence: 'fixture:1',
        suggested_fix: 'fix',
        confidence: 1,
        duplicate_of: null,
      },
    ]);
    const next = path.join(tmp, 'next.md');
    writeStructuredPlanFile(next, 'Next');
    const update = path.join(tmp, 'update.json');
    writeAcceptUpdate(update, 1, next);
    const ctx = makeContext({ quality: 'quick', maxIters: 1 });

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critiqueFile,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CLAUDE_JSON_RESULT: update,
      },
      () => runIterationLoop(ctx, 0),
    );

    expect(capture.text()).not.toContain('— judge (');
  });

  it('creator prompt receives operator interventions and migrates them', async () => {
    seedWork();
    writeFileSync(
      path.join(work, 'operator-interventions.jsonl'),
      `${JSON.stringify({
        id: 'i-creator-1',
        ts: '2026-06-10T00:00:00Z',
        target: 'creator',
        message: 'creator must preserve published-version hydration',
      })}\n`,
    );
    const critique = path.join(tmp, 'critique.json');
    writeCritique(critique, SINGLE_ISSUE);
    const update = path.join(tmp, 'update.json');
    writeUpdate(update, 1, readFileSync(path.join(tmp, 'input.md'), 'utf8'));
    const claudePrompt = path.join(tmp, 'claude.prompt');
    const ctx = makeContext({ maxIters: 1 });

    await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CLAUDE_JSON_RESULT: update,
        FAKE_CLAUDE_PROMPT: claudePrompt,
      },
      () => runIterationLoop(ctx, 0),
    );

    const prompt = readFileSync(claudePrompt, 'utf8');
    expect(prompt).toContain('## Operator interventions');
    expect(prompt).toContain('creator must preserve published-version hydration');
    const migrations = readFileSync(
      path.join(work, 'operator-intervention-migrations.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { plan_ref: string });
    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.plan_ref).toBe('plan.v1.md');
  });
});
