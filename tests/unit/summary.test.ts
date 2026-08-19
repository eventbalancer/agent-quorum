import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeSummary } from '../../src/stages/plan/summary.js';
import { Scratch } from '../../src/runtime/scratch.js';
import { makeTestRunContext } from '../helpers/test-context.js';
import { writeStructuredPlanFile } from '../helpers/harness.js';

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

function issue(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    addresses: null,
    severity: 'minor',
    category: 'testability',
    claim: `${id} claim`,
    evidence: '',
    evidence_refs: [{ kind: 'plan-section', section: 'Work Plan' }],
    suggested_fix: 'fix',
    confidence: 1,
    duplicate_of: null,
    ...overrides,
  };
}

function writeCritique(file: string, version: number, issues: unknown[]): void {
  writeFileSync(
    file,
    `${JSON.stringify({ plan_version: version, summary: `v${version}`, issues }, null, 2)}\n`,
  );
}

describe('convergence summary', () => {
  it('reports every lineage class without copying prompt or plan bodies (AC-8)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-summary.'));
    roots.push(root);
    const work = path.join(root, 'work');
    mkdirSync(work);
    const scratch = Scratch.create('summary-test');
    scratches.push(scratch);
    const ctx = makeTestRunContext(root, work, scratch, {
      quality: 'balanced',
      maxIters: 3,
      mode: 'prompt',
      projectRoot: root,
    });

    writeFileSync(ctx.inputPath, 'PROMPT_BODY_SENTINEL\n');
    for (let version = 0; version <= 2; version += 1) {
      const plan = path.join(work, `plan.v${version}.md`);
      writeStructuredPlanFile(plan, `Plan ${version}`);
      appendFileSync(plan, `PLAN_BODY_SENTINEL_${version}\n`);
    }
    copyFileSync(path.join(work, 'plan.v2.md'), path.join(work, 'plan.final.md'));
    writeFileSync(path.join(work, 'rejected-log.jsonl'), `${JSON.stringify({ id: 'r1' })}\n`);

    writeCritique(path.join(work, 'critique.v0.json'), 0, [issue('C1'), issue('C2'), issue('C3')]);
    writeCritique(path.join(work, 'critique.v1.json'), 1, [issue('C1')]);
    writeFileSync(
      path.join(work, 'update.v0.json'),
      `${JSON.stringify({ issues: [{ id: 'C3', verdict: 'reject_hallucinated' }] })}\n`,
    );
    writeCritique(path.join(work, 'critique.v2.json'), 2, [
      issue('C1'),
      issue('C2', { addresses: 'v1.C1' }),
      issue('C3', { addresses: 'v0.C3' }),
      issue('C4', { addresses: 'v0.C2' }),
      issue('C5', { introduced_by_revision: 'plan.v2.md' }),
      issue('C6', { severity: 'nit', duplicate_of: 'r1' }),
      issue('C7', {
        addresses: 'v9.C1',
        evidence_refs: [{ kind: 'repository', value: 'source.ts:2' }],
      }),
    ]);

    const convergence = {
      promise: 'cumulative' as const,
      satisfied: false,
      artifactPath: path.join(work, 'convergence.final.json'),
      exhaustedLimits: [],
      unresolvedCoverage: ['fixture-unproved'],
    };
    writeSummary(ctx, {
      iter: 2,
      localizedFinalFile: path.join(work, 'plan.final.ru.md'),
      finalStale: 0,
      finalAmbiguous: 0,
      finalUnresolved: 0,
      finalFacts: {
        status: 'needs-review',
        reason: 'coverage-unproved',
        structuralStatus: 'clean',
        structuralReason: '',
        convergence,
      },
      splitDecision: 'single',
      splitRationale: 'fixture',
      packagePhaseCount: 0,
    });

    const summary = readFileSync(path.join(work, 'summary.md'), 'utf8');
    expect(summary).toContain(
      'lineage={"new":1,"refinement":1,"reopened":1,"recurring":1,"revision-regression":1,"rejected-duplicate":1,"invalid-lineage":1}',
    );
    expect(summary).toContain('"format-mismatch":1');
    expect(summary).not.toContain('PROMPT_BODY_SENTINEL');
    expect(summary).not.toContain('PLAN_BODY_SENTINEL');
  });
});
