import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPlanLoop } from '../../src/index.js';
import {
  captureStderr,
  emptyCritique,
  withEnvAsync,
  writeCritique,
  writeFakeBin,
  writeStoreConfig,
  writeStructuredPlanFile,
  type StderrCapture,
} from '../helpers/harness.js';

let tmp: string;
let fake: string;
let work: string;
let input: string;
let capture: StderrCapture;

function env(output?: string): Record<string, string | undefined> {
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
    ...(output !== undefined ? { FAKE_CODEX_OUTPUT: output } : {}),
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-convergence-limits.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  work = path.join(tmp, 'work');
  mkdirSync(work);
  mkdirSync(path.join(tmp, 'plans'));
  mkdirSync(path.join(tmp, 'state'));
  writeStoreConfig(path.join(tmp, 'home'));
  input = path.join(tmp, 'input.md');
  writeStructuredPlanFile(input, 'Limit Input');
  capture = captureStderr();
});

afterEach(() => {
  capture.restore();
  rmSync(tmp, { recursive: true, force: true });
});

describe('honest convergence limits', () => {
  it('does not block a provider call from a byte estimate above a configured token limit', async () => {
    const critique = path.join(tmp, 'known-limit.json');
    emptyCritique(critique);
    const result = await withEnvAsync(env(critique), () =>
      runPlanLoop({
        input,
        iters: 1,
        quality: 'quick',
        fix: false,
        translate: false,
        workDir: work,
        config: { roles: { critic: { inputTokenLimit: 10 } } },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('clean');
    expect(result.convergence?.exhaustedLimits).not.toContain('provider-context');
    expect(existsSync(path.join(tmp, 'codex.prompt'))).toBe(true);
    expect(readFileSync(path.join(work, 'plan.v0.md'), 'utf8')).toContain('status: clean');
    expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toContain('status: clean');
    expect(capture.text()).toContain('proof-satisfied');
  });

  it('does not downgrade convergence solely because the model context bound is unknown', async () => {
    const critique = path.join(tmp, 'empty.json');
    emptyCritique(critique);
    const result = await withEnvAsync(env(critique), () =>
      runPlanLoop({
        input,
        iters: 1,
        quality: 'quick',
        fix: false,
        translate: false,
        workDir: work,
        config: { roles: { critic: { model: 'unregistered-fixture-model' } } },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('clean');
    expect(result.convergence?.exhaustedLimits).not.toContain('unknown-provider-context');
    expect(result.convergence?.unresolvedCoverage).not.toContain(
      'critic:review:unknown-context-bound',
    );
  });

  it('reports issue-budget exhaustion even when all capped findings are duplicates', async () => {
    const critique = path.join(tmp, 'budget.json');
    writeFileSync(
      path.join(work, 'rejected-log.jsonl'),
      `${Array.from({ length: 8 }, (_, index) => JSON.stringify({ id: `r${index + 1}` })).join('\n')}\n`,
    );
    writeCritique(
      critique,
      Array.from({ length: 8 }, (_, index) => ({
        id: `C${index + 1}`,
        addresses: null,
        severity: 'nit',
        category: 'convention',
        claim: `duplicate ${index + 1}`,
        evidence: '## Work Plan',
        suggested_fix: 'none',
        confidence: 1,
        duplicate_of: `r${index + 1}`,
      })),
    );
    const result = await withEnvAsync(env(critique), () =>
      runPlanLoop({
        input,
        iters: 1,
        quality: 'quick',
        fix: false,
        translate: false,
        workDir: work,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('needs-review');
    expect(result.convergence?.exhaustedLimits).toContain('issue-budget');
    expect(result.convergence?.unresolvedCoverage).toContain('plan.v0:scan-incomplete');
    expect(capture.text()).not.toContain('proof-satisfied');
  });

  it('makes an incomplete direct-plan scope explicit without fabricating a request', async () => {
    const critique = path.join(tmp, 'incomplete-scope.json');
    emptyCritique(critique);
    const parsed = JSON.parse(readFileSync(critique, 'utf8')) as {
      review: { scope_coverage: string[] };
    };
    parsed.review.scope_coverage = [];
    writeFileSync(critique, `${JSON.stringify(parsed, null, 2)}\n`);

    const result = await withEnvAsync(env(critique), () =>
      runPlanLoop({
        input,
        iters: 1,
        quality: 'quick',
        fix: false,
        translate: false,
        workDir: work,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('needs-review');
    expect(result.convergence?.exhaustedLimits).toContain('authoritative-scope');
    expect(result.convergence?.unresolvedCoverage).toContain('direct-plan:declared-scope-unproved');
    const prompt = readFileSync(path.join(tmp, 'codex.prompt'), 'utf8');
    expect(prompt).toContain('scope_source: direct-plan');
    expect(prompt).toContain('original_request: unavailable');
  });
});
