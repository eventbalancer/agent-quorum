import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCreatorCreate } from '../../src/stages/plan/creator.js';
import { HaltError } from '../../src/runtime/halt.js';
import { Scratch } from '../../src/runtime/scratch.js';
import type { RoleMatrix } from '../../src/core/config.js';
import type { RunContext } from '../../src/core/run-context.js';
import { fixtureMatrix, makeTestRunContext } from '../helpers/test-context.js';
import {
  captureStderr,
  type StderrCapture,
  withEnvAsync,
  writeFakeBin,
  writeStructuredPlanFile,
} from '../helpers/harness.js';

let tmp: string;
let work: string;
let fake: string;
let scratch: Scratch;
let capture: StderrCapture;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-create-shape.'));
  work = path.join(tmp, 'work');
  mkdirSync(work, { recursive: true });
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  scratch = Scratch.create('create-shape-test');
  capture = captureStderr();
  writeFileSync(path.join(tmp, 'input.md'), 'Plan this task.\n');
});

afterEach(() => {
  capture.restore();
  scratch.sweep();
  rmSync(tmp, { recursive: true, force: true });
});

function fakePath(): string {
  return `${fake}:${process.env.PATH ?? ''}`;
}

function buildContext(matrix?: RoleMatrix): RunContext {
  return makeTestRunContext(tmp, work, scratch, matrix !== undefined ? { matrix } : {});
}

function writeStubPlan(file: string): void {
  writeFileSync(file, '# Plan\n\nThe plan has been created and saved.\n');
}

function writePartialPlan(file: string): void {
  const body = [
    '# Partial Plan',
    '',
    '## At a Glance',
    '- Outcome: partial.',
    '',
    '## Context',
    '- Partial context.',
    '',
    '## Scope',
    '- In scope: partial.',
    '',
  ].join('\n');
  writeFileSync(file, body);
}

async function captureHalt(run: Promise<void>): Promise<HaltError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof HaltError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected runCreatorCreate to throw HaltError');
}

describe('runCreatorCreate shape gate', () => {
  it('claude plan mode + stub artifact throws the targeted plan-mode diagnostic (exit 4)', async () => {
    const result = path.join(tmp, 'result.md');
    writeStubPlan(result);
    const ctx = buildContext();
    const out = path.join(work, 'plan.v0.md');

    const halt = await captureHalt(
      withEnvAsync(
        {
          PATH: fakePath(),
          CLAUDE_PERMISSION_MODE: 'plan',
          FAKE_CLAUDE_MARKDOWN_RESULT: result,
        },
        () => runCreatorCreate(ctx, ctx.inputPath, out),
      ),
    );

    expect(halt.exitCode).toBe(4);
    expect(halt.message).toContain('plan mode');
    expect(halt.message).toContain('~/.claude/plans');
    expect(halt.message).not.toContain('summary, wrapper');
  });

  it('claude plan mode + substantial-but-malformed plan still throws the targeted diagnostic', async () => {
    const result = path.join(tmp, 'result.md');
    writePartialPlan(result);
    const ctx = buildContext();
    const out = path.join(work, 'plan.v0.md');

    const halt = await captureHalt(
      withEnvAsync(
        {
          PATH: fakePath(),
          CLAUDE_PERMISSION_MODE: 'plan',
          FAKE_CLAUDE_MARKDOWN_RESULT: result,
        },
        () => runCreatorCreate(ctx, ctx.inputPath, out),
      ),
    );

    expect(halt.exitCode).toBe(4);
    expect(halt.message).toContain('plan mode');
    expect(halt.message).toContain('~/.claude/plans');
  });

  it('claude default mode + malformed plan keeps the generic shape-gate message (exit 4)', async () => {
    const result = path.join(tmp, 'result.md');
    writePartialPlan(result);
    const ctx = buildContext();
    const out = path.join(work, 'plan.v0.md');

    const halt = await captureHalt(
      withEnvAsync(
        {
          PATH: fakePath(),
          CLAUDE_PERMISSION_MODE: undefined,
          FAKE_CLAUDE_MARKDOWN_RESULT: result,
        },
        () => runCreatorCreate(ctx, ctx.inputPath, out),
      ),
    );

    expect(halt.exitCode).toBe(4);
    expect(halt.message).toContain('not a complete plan');
    expect(halt.message).toContain('summary, wrapper');
    expect(halt.message).not.toContain('~/.claude/plans');
  });

  it('non-claude creator under CLAUDE_PERMISSION_MODE=plan keeps the generic message (guard holds)', async () => {
    const result = path.join(tmp, 'result.json');
    const partialMarkdown = '# Partial Plan\n\n## At a Glance\n- Outcome: partial.\n';
    writeFileSync(result, `${JSON.stringify({ plan_markdown: partialMarkdown }, null, 2)}\n`);
    const ctx = buildContext({
      ...fixtureMatrix(),
      creator: { runner: 'codex', model: 'gpt-5.5', reasoning: 'low' },
    });
    const out = path.join(work, 'plan.v0.md');

    const halt = await captureHalt(
      withEnvAsync(
        {
          PATH: fakePath(),
          CLAUDE_PERMISSION_MODE: 'plan',
          FAKE_CODEX_OUTPUT: result,
          FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        },
        () => runCreatorCreate(ctx, ctx.inputPath, out),
      ),
    );

    expect(halt.exitCode).toBe(4);
    expect(halt.message).toContain('not a complete plan');
    expect(halt.message).not.toContain('plan mode');
    expect(halt.message).not.toContain('~/.claude/plans');
  });

  it('a shape-valid plan passes the gate in default mode (no throw)', async () => {
    const result = path.join(tmp, 'result.md');
    writeStructuredPlanFile(result, 'Complete Plan');
    const ctx = buildContext();
    const out = path.join(work, 'plan.v0.md');

    await expect(
      withEnvAsync(
        {
          PATH: fakePath(),
          CLAUDE_PERMISSION_MODE: undefined,
          FAKE_CLAUDE_MARKDOWN_RESULT: result,
        },
        () => runCreatorCreate(ctx, ctx.inputPath, out),
      ),
    ).resolves.toBeUndefined();
  });
});
