import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ajvModule from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BENCHMARK_ROOT } from '../../scripts/benchmark-planning/benchmark.js';
import type {
  PlanningSmokeResults,
  PlanningSmokeSentinel,
} from '../../scripts/benchmark-planning/model.js';
import {
  evaluatePlanningSmokeSentinel,
  loadPlanningSmoke,
} from '../../scripts/benchmark-planning/smoke.js';

const Ajv2020 = ajvModule.default;

let temporaryRoot: string;

beforeEach(() => {
  temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-planning-smoke.'));
});

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sentinel(id: string): PlanningSmokeSentinel {
  const selected = loadPlanningSmoke().manifest.sentinels.find((entry) => entry.id === id);
  if (selected === undefined) {
    throw new Error(`missing smoke sentinel fixture: ${id}`);
  }
  return selected;
}

function baseWorkDir(name: string): string {
  const workDir = path.join(temporaryRoot, name, 'run');
  mkdirSync(workDir, { recursive: true });
  writeJson(path.join(workDir, 'readiness-assessment.initial.json'), {});
  writeJson(path.join(workDir, 'readiness-contract.json'), {});
  writeFileSync(path.join(workDir, 'plan.v0.md'), '# Initial smoke plan\n');
  return workDir;
}

function writeReadyConvergence(
  workDir: string,
  planVersion: number,
  options: { readonly highRisk: boolean; readonly judged: boolean },
): string {
  const plan = '---\nstatus: clean\n---\n\n# Final smoke plan\n';
  const digest = sha256(plan);
  writeFileSync(path.join(workDir, 'plan.final.md'), plan);
  writeJson(path.join(workDir, 'convergence.final.json'), {
    decision: 'ready',
    satisfied: true,
    reasonCodes: [],
    unresolvedCoverage: [],
    planVersion,
    lastCritiquedPlanVersion: planVersion,
    planSha256: digest,
    canonicalPlanSha256: digest,
    riskDomains: [
      {
        domain: options.highRisk ? 'data-migrations' : 'correctness',
        applicability: 'applicable',
        risk: options.highRisk ? 'high' : 'standard',
      },
    ],
    ...(options.judged ? { judgeReady: true, judgeApprovedPlanVersion: planVersion } : {}),
  });
  return digest;
}

describe('planning live smoke manifest', () => {
  it('pins one quick standard prompt and one balanced high-risk revision sentinel', () => {
    const { manifest } = loadPlanningSmoke();

    expect(manifest.sentinels).toHaveLength(2);
    expect(manifest.sentinels).toMatchObject([
      {
        id: 'standard-create-ready',
        risk: 'standard',
        inputMode: 'prompt',
        quality: 'quick',
        expected: { judge: 'forbidden', minimumPlanVersion: 0 },
      },
      {
        id: 'high-revise-judge-ready',
        risk: 'high',
        inputMode: 'plan',
        quality: 'balanced',
        expected: { judge: 'required', minimumPlanVersion: 1 },
      },
    ]);
    expect(
      readFileSync(path.join(BENCHMARK_ROOT, 'smoke/high-revise-judge-ready.plan.md'), 'utf8'),
    ).toContain('complete payload directly to the final record path with writeFileSync');
  });

  it('accepts the standard create-to-ready flow without Judge', () => {
    const workDir = baseWorkDir('standard');
    writeReadyConvergence(workDir, 0, { highRisk: false, judged: false });
    writeJson(path.join(workDir, 'critique.v0.json'), { issues: [] });

    const result = evaluatePlanningSmokeSentinel({
      sentinel: sentinel('standard-create-ready'),
      outputDir: temporaryRoot,
      workDir,
      exitCode: 0,
    });

    expect(result).toMatchObject({
      passed: true,
      decision: 'ready',
      critiqueIterations: 1,
      planVersion: 0,
      failures: [],
    });
  });

  it('accepts a material revision with intermediate and final Judge proof', () => {
    const workDir = baseWorkDir('high');
    const digest = writeReadyConvergence(workDir, 1, { highRisk: true, judged: true });
    writeJson(path.join(workDir, 'critique.v0.json'), {
      issues: [{ id: 'C1', severity: 'major' }],
    });
    writeJson(path.join(workDir, 'critique.v1.json'), { issues: [] });
    writeJson(path.join(workDir, 'update.v0.json'), { applied: ['C1'] });
    writeJson(path.join(workDir, 'update-meta.v0.json'), { applied: ['C1'] });
    writeJson(path.join(workDir, 'judge.v1.json'), { ready: true });
    writeJson(path.join(workDir, 'judge.final.json'), { ready: true });
    writeJson(path.join(workDir, 'judge.final.meta.json'), { planSha256: digest });

    const result = evaluatePlanningSmokeSentinel({
      sentinel: sentinel('high-revise-judge-ready'),
      outputDir: temporaryRoot,
      workDir,
      exitCode: 0,
    });

    expect(result).toMatchObject({
      passed: true,
      decision: 'ready',
      critiqueIterations: 2,
      planVersion: 1,
      failures: [],
    });
  });

  it('fails when the live high-risk path skips material revision or Judge proof', () => {
    const workDir = baseWorkDir('incomplete-high');
    writeReadyConvergence(workDir, 0, { highRisk: true, judged: false });
    writeJson(path.join(workDir, 'critique.v0.json'), { issues: [] });

    const result = evaluatePlanningSmokeSentinel({
      sentinel: sentinel('high-revise-judge-ready'),
      outputDir: temporaryRoot,
      workDir,
      exitCode: 0,
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'too few exact-version critic passes',
        'required plan revision was not produced',
        'initial critic did not report the seeded material issue',
        'intermediate Judge artifact is missing',
        'final Judge proof is missing',
      ]),
    );
  });

  it('keeps smoke results compatible with the committed schema', () => {
    const schema = JSON.parse(
      readFileSync(path.join(BENCHMARK_ROOT, 'smoke-results.schema.json'), 'utf8'),
    ) as object;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const results: PlanningSmokeResults = {
      schemaVersion: 1,
      suiteId: 'bounded-readiness-smoke-v1',
      workspaceRevision: 'a'.repeat(40),
      providerConfigSha256: 'b'.repeat(64),
      passed: true,
      tasks: [
        {
          taskId: 'standard-create-ready',
          passed: true,
          decision: 'ready',
          critiqueIterations: 1,
          planVersion: 0,
          exitCode: 0,
          failures: [],
          finalPlan: 'standard-create-ready/run/plan.final.md',
          finalPlanSha256: 'c'.repeat(64),
        },
      ],
    };

    expect(validate(results), JSON.stringify(validate.errors)).toBe(true);
  });
});
