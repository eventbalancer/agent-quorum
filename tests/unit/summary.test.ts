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
import { buildRunReport, writeSummary } from '../../src/stages/plan/summary.js';
import { Scratch } from '../../src/runtime/scratch.js';
import { finalProjection } from '../helpers/final-projection.js';
import { makeTestRunContext } from '../helpers/test-context.js';
import { writeCritique, writeStructuredPlanFile } from '../helpers/harness.js';

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
    severity: 'major',
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

describe('run summary', () => {
  it('renders supplied final facts and lineage metrics without copying prompt or plan bodies', () => {
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
    const rejectedClaimSecret = 'REJECTED_PROVIDER_CLAIM_SECRET_6fb57a';
    const rejectedReasonSecret = 'REJECTED_PROVIDER_REASON_SECRET_887df0';
    writeFileSync(
      path.join(work, 'rejected-log.jsonl'),
      `${JSON.stringify({
        iter: 1,
        id: 'r1',
        claim: rejectedClaimSecret,
        reason: rejectedReasonSecret,
      })}\n`,
    );

    writeCritique(path.join(work, 'critique.v0.json'), [issue('C1'), issue('C2'), issue('C3')], 0);
    writeCritique(path.join(work, 'critique.v1.json'), [issue('C1')], 1);
    writeFileSync(
      path.join(work, 'update.v0.json'),
      `${JSON.stringify({ issues: [{ id: 'C3', verdict: 'reject_hallucinated' }] })}\n`,
    );
    writeCritique(
      path.join(work, 'critique.v2.json'),
      [
        issue('C1'),
        issue('C2', { addresses: 'v1.C1' }),
        issue('C3', { addresses: 'v0.C3' }),
        issue('C4', { addresses: 'v0.C2' }),
        issue('C5', { introduced_by_revision: 'plan.v2.md' }),
        issue('C6', { duplicate_of: 'r1' }),
        issue('C7', {
          addresses: 'v9.C1',
          evidence_refs: [{ kind: 'repository', value: 'source.ts:2' }],
        }),
      ],
      2,
    );

    const final = finalProjection(work, {
      status: 'needs-review',
      decision: 'unable-to-decide',
      reasonCodes: ['fixture-unproved'],
      reasons: ['coverage-unproved'],
      judge: {
        required: true,
        allowed: true,
        evaluated: true,
        available: true,
        candidateUnchanged: true,
        verdict: false,
        rationale: 'material-proof-remains-unresolved',
        metadataPath: path.join(work, 'judge.final.json'),
      },
    });
    writeSummary(ctx, {
      iter: 2,
      localizedFinalFile: path.join(work, 'plan.final.ru.md'),
      finalStale: 0,
      finalAmbiguous: 0,
      finalUnresolved: 0,
      final,
      splitDecision: 'single',
      splitRationale: 'fixture',
      packagePhaseCount: 0,
    });

    const summary = readFileSync(path.join(work, 'summary.md'), 'utf8');
    expect(summary).toContain(
      'lineage={"new":1,"refinement":1,"reopened":1,"recurring":1,"revision-regression":1,"rejected-duplicate":0,"invalid-lineage":2}',
    );
    expect(summary).toContain('"format-mismatch":1');
    expect(summary).toContain(
      '- readiness: decision=unable-to-decide, reason_codes=fixture-unproved, satisfied=false',
    );
    expect(summary).toContain(`- readiness_artifact: \`${final.readiness.proofArtifactPath}\``);
    expect(summary).toContain(
      `- canonical_plan: version=${final.readiness.planVersion}, sha256=${final.readiness.canonicalPlanSha256}`,
    );
    expect(summary).toContain(
      '- final_judge: required=true, allowed=true, evaluated=true, available=true, candidate_unchanged=true, verdict=false',
    );
    expect(summary).not.toContain('material-proof-remains-unresolved');
    expect(summary).toContain('- FINAL: needs-review — coverage-unproved');
    expect(summary).toContain('## Rejected pool (1 entries)');
    expect(summary).toContain('- structured=1, malformed=0, iterations=1, unbound=0');
    expect(summary).not.toContain(rejectedClaimSecret);
    expect(summary).not.toContain(rejectedReasonSecret);
    expect(summary).not.toContain('PROMPT_BODY_SENTINEL');
    expect(summary).not.toContain('PLAN_BODY_SENTINEL');

    const report = buildRunReport(ctx, 2, final);
    expect(report.final).toBe(final);
    expect(report).not.toHaveProperty('status');
    expect(report).not.toHaveProperty('readiness');
    expect(report).not.toHaveProperty('convergence');
  });
});
