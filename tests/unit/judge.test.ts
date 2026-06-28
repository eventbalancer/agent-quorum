import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runJudge } from '../../src/stages/plan/judge.js';
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
