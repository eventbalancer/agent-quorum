import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FINAL_JUDGE_METADATA,
  judgePrompt,
  runFinalJudge,
  runJudge,
} from '../../src/stages/plan/judge.js';
import { Scratch } from '../../src/runtime/scratch.js';
import { skillPaths } from '../../src/core/run-context.js';
import { makeTestRunContext } from '../helpers/test-context.js';
import { captureStderr, REPO_ROOT } from '../helpers/harness.js';
import type { StderrCapture } from '../helpers/harness.js';

vi.mock('../../src/providers/provider.js', () => ({
  providerRun: vi.fn(),
}));

const { providerRun } = await import('../../src/providers/provider.js');
const mockProviderRun = vi.mocked(providerRun);

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
  writeFileSync(planFile, '# Plan\n\nFixture plan content.');
  writeFileSync(
    critiqueFile,
    JSON.stringify({ issues: [{ id: 'C1', severity: 'nit', category: 'style', claim: 'nit' }] }),
  );
  capture = captureStderr();
  vi.clearAllMocks();
});

afterEach(() => {
  capture.restore();
  scratch.sweep();
  rmSync(tmp, { recursive: true, force: true });
});

function makeContext() {
  return makeTestRunContext(tmp, work, scratch, { quality: 'balanced' });
}

describe('runJudge', () => {
  it('returns ready:true on a valid verdict', async () => {
    mockProviderRun.mockImplementation((_provider, _role, _mode, file) => {
      writeFileSync(file, JSON.stringify({ ready: true, rationale: 'looks good' }));
      return Promise.resolve(0);
    });

    const ctx = makeContext();
    const result = await runJudge(ctx, 0, planFile, critiqueFile, outFile);
    expect(result).toEqual({ ready: true, rationale: 'looks good' });
  });

  it('labels the intermediate critique as current context', () => {
    const prompt = judgePrompt(planFile, critiqueFile);
    expect(prompt).toContain('scope: intermediate');
    expect(prompt).toContain('critique_context: current critique for this plan revision');
  });

  it('returns not-ready on non-zero provider status', async () => {
    mockProviderRun.mockResolvedValue(1);

    const ctx = makeContext();
    const result = await runJudge(ctx, 0, planFile, critiqueFile, outFile);
    expect(result).toEqual({ ready: false, rationale: '' });
    expect(capture.text()).toContain('judge provider call failed');
  });

  it('returns not-ready on schema-invalid output', async () => {
    mockProviderRun.mockImplementation((_provider, _role, _mode, file) => {
      writeFileSync(file, JSON.stringify({ unexpected_field: true }));
      return Promise.resolve(0);
    });

    const ctx = makeContext();
    const skills = skillPaths(REPO_ROOT);
    const ctxWithRealSkills = { ...ctx, skills };
    const result = await runJudge(ctxWithRealSkills, 0, planFile, critiqueFile, outFile);
    expect(result).toEqual({ ready: false, rationale: '' });
    expect(capture.text()).toContain('schema validation');
  });

  it('returns not-ready on malformed JSON output', async () => {
    mockProviderRun.mockImplementation((_provider, _role, _mode, file) => {
      writeFileSync(file, 'not valid json{{{');
      return Promise.resolve(0);
    });

    const ctx = makeContext();
    const skills = skillPaths(REPO_ROOT);
    const ctxWithRealSkills = { ...ctx, skills };
    const result = await runJudge(ctxWithRealSkills, 0, planFile, critiqueFile, outFile);
    expect(result).toEqual({ ready: false, rationale: '' });
  });
});

describe('runFinalJudge', () => {
  function mockFinalOutput(output: unknown, status = 0): void {
    mockProviderRun.mockImplementation(
      (_provider, _role, _mode, file, _skill, _schema, _tools, _disallowed, _prompt, options) => {
        if (status !== 0) {
          return Promise.resolve(status);
        }
        writeFileSync(file, typeof output === 'string' ? output : JSON.stringify(output));
        const valid = options?.validateOutput?.(file) ?? true;
        return Promise.resolve(valid ? 0 : 1);
      },
    );
  }

  it('binds a valid verdict to the exact final-plan bytes', async () => {
    mockFinalOutput({ ready: true, rationale: 'implementation ready' });
    const ctx = makeContext();
    ctx.lastCritiqueIter = 0;

    const result = await runFinalJudge(ctx, planFile);

    const digest = createHash('sha256').update(readFileSync(planFile)).digest('hex');
    expect(result.readiness).toEqual({
      evaluated: true,
      ready: true,
      rationale: 'implementation ready',
      planSha256: digest,
    });
    expect(result.metadataPath).toBe(path.join(work, FINAL_JUDGE_METADATA));
    expect(readFileSync(path.join(work, 'judge.final.json'), 'utf8')).toBe(
      readFileSync(path.join(work, 'judge.final.raw'), 'utf8'),
    );
    expect(JSON.parse(readFileSync(result.metadataPath, 'utf8'))).toEqual({
      canonical_plan: 'plan.final.md',
      plan_sha256: digest,
      evaluated: true,
      ready: true,
      rationale: 'implementation ready',
      verdict_artifact: 'judge.final.json',
    });
    const prompt = mockProviderRun.mock.calls[0]?.[8] ?? '';
    expect(prompt).toContain('scope: final');
    expect(prompt).toContain('critique_context: advisory');
    expect(prompt).toContain(`plan_sha256: ${digest}`);
  });

  it('uses a deterministic fallback for an empty negative rationale', async () => {
    mockFinalOutput({ ready: false, rationale: '' });

    const result = await runFinalJudge(makeContext(), planFile);

    expect(result.readiness).toMatchObject({
      evaluated: true,
      ready: false,
      rationale: 'Final Judge returned ready=false without a rationale.',
    });
  });

  it.each([1, 124])(
    'reports unknown readiness for exhausted provider status %s',
    async (status) => {
      writeFileSync(path.join(work, 'judge.final.raw'), 'stale output');
      mockFinalOutput({}, status);

      const result = await runFinalJudge(makeContext(), planFile);

      expect(result.readiness).toMatchObject({
        evaluated: false,
        ready: null,
        rationale: 'Final Judge did not produce a valid verdict after provider retries.',
      });
      expect(existsSync(path.join(work, 'judge.final.json'))).toBe(false);
      expect(existsSync(path.join(work, 'judge.final.raw'))).toBe(false);
    },
  );

  it('reports unknown readiness and preserves invalid raw output', async () => {
    mockFinalOutput({ ready: true });
    const ctx = { ...makeContext(), skills: skillPaths(REPO_ROOT) };

    const result = await runFinalJudge(ctx, planFile);

    expect(result.readiness.evaluated).toBe(false);
    expect(result.readiness.ready).toBeNull();
    expect(existsSync(path.join(work, 'judge.final.raw'))).toBe(true);
    expect(existsSync(path.join(work, 'judge.final.json'))).toBe(false);
    expect(JSON.parse(readFileSync(result.metadataPath, 'utf8'))).toMatchObject({
      evaluated: false,
      ready: null,
      verdict_artifact: null,
    });
  });
});
