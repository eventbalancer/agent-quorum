import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Scratch } from '../../src/runtime/scratch.js';
import { retainedRolePrompt } from '../../src/stages/plan/retained-context.js';
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

describe('retained role context', () => {
  it.each([
    ['quick', 'best-effort'],
    ['balanced', 'cumulative'],
    ['thorough', 'exhaustive'],
  ] as const)('delivers mandatory categories to every planning role in %s', (quality, promise) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-retained.'));
    roots.push(tmp);
    const work = path.join(tmp, 'work');
    mkdirSync(work);
    const scratch = Scratch.create('retained-test');
    scratches.push(scratch);
    const input = path.join(tmp, 'input.md');
    writeStructuredPlanFile(input, 'Input');
    copyFileSync(input, path.join(work, 'plan.v0.md'));
    writeFileSync(
      path.join(work, 'rejected-log.jsonl'),
      `${JSON.stringify({ iter: 0, id: 'r-kept', claim: 'disputed claim', reason: 'out_of_plan_scope' })}\n`,
    );
    writeFileSync(
      path.join(work, 'operator-interventions.jsonl'),
      `${JSON.stringify({ id: 'op-clarify-scope', target: 'all', message: 'Keep the declared scope.' })}\n`,
    );
    const ctx = makeTestRunContext(tmp, work, scratch, { mode: 'plan', quality });
    ctx.convergence.findings = [
      {
        id: 'I-v0-C1',
        issueRef: 'v0.C1',
        introducedPlanVersion: 1,
        severity: 'major',
        claim: 'Consumer coverage is incomplete.',
        disposition: {
          scope: 'cross-cutting',
          rationale: 'All consumers share the contract.',
          evidenceRefs: [{ kind: 'plan-section', section: 'System Coverage' }],
        },
      },
    ];
    ctx.convergence.invariants = [
      {
        id: 'I-v0-C1',
        sourceFinding: 'I-v0-C1',
        statement: 'Every consumer uses the same contract.',
        status: 'active',
        occurrences: [
          {
            id: `O-${'a'.repeat(64)}`,
            dimension: 'consumer',
            subject: 'api',
            disposition: 'unresolved',
            evidenceRefs: [],
          },
        ],
      },
    ];
    const roleSkills = {
      creator: ctx.skills.creatorSkill,
      critic: ctx.skills.criticSkill,
      fixer: ctx.skills.fixerSkill,
      reviewer: ctx.skills.reviewerSkill,
      translator: ctx.skills.translatorSkill,
      judge: ctx.skills.judgeSkill,
    };
    for (const role of ['creator', 'critic', 'fixer', 'reviewer', 'translator', 'judge'] as const) {
      const prompt = retainedRolePrompt({
        ctx,
        role,
        stage: 'fixture',
        planVersion: 0,
        skillFile: roleSkills[role],
        schemaFile: '',
        basePrompt: '## Candidate\nfixture',
      });
      expect(prompt).toContain('## Mandatory retained run context');
      expect(prompt).toContain('original_request: unavailable');
      expect(prompt).toContain('### Authoritative system facts');
      expect(prompt).toContain('### Operator decisions and interventions');
      expect(prompt).toContain('op-clarify-scope');
      expect(prompt).toContain('### Rejected finding dispositions');
      expect(prompt).toContain('r-kept');
      expect(prompt).toContain('### Findings and invariants');
      expect(prompt).toContain('I-v0-C1');
      expect(prompt).toContain(
        'evidence_refs=[{"kind":"plan-section","section":"System Coverage"}]',
      );
      expect(prompt).toContain(`quality_promise: ${promise}`);
      expect(prompt.split('Keep the declared scope.')).toHaveLength(2);
    }
    const persisted = JSON.parse(readFileSync(path.join(work, 'convergence.v0.json'), 'utf8')) as {
      contextDeliveries: {
        role: string;
        stage: string;
        mandatoryBytes: number;
        totalInputBytes: number;
      }[];
    };
    expect(persisted.contextDeliveries.map(({ role, stage }) => ({ role, stage }))).toEqual(
      ['creator', 'critic', 'fixer', 'reviewer', 'translator', 'judge'].map((role) => ({
        role,
        stage: 'fixture',
      })),
    );
    expect(persisted.contextDeliveries.every((delivery) => delivery.mandatoryBytes > 0)).toBe(true);
    expect(persisted.contextDeliveries.every((delivery) => delivery.totalInputBytes > 0)).toBe(
      true,
    );
  });

  it('compacts quick history while balanced and thorough retain full role metadata', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-history.'));
    roots.push(tmp);
    const work = path.join(tmp, 'work');
    mkdirSync(work);
    const scratch = Scratch.create('history-test');
    scratches.push(scratch);
    writeFileSync(
      path.join(work, 'rejected-log.jsonl'),
      `${JSON.stringify({ iter: 0, id: 'C7', claim: 'Keep duplicate detection', reason: 'not-applicable' })}\n`,
    );
    writeFileSync(
      path.join(work, 'critique.v0.json'),
      `${JSON.stringify({
        plan_version: 0,
        summary: 'prior review',
        issues: [
          {
            id: 'C7',
            severity: 'minor',
            addresses: null,
            claim: 'Keep duplicate detection',
          },
        ],
      })}\n`,
    );
    writeFileSync(
      path.join(work, 'update.v0.json'),
      `${JSON.stringify({
        plan_version: 1,
        plan_markdown: 'PREVIOUS PLAN BODY MUST NOT BE RETAINED',
        issues: [
          {
            id: 'C7',
            verdict: 'reject',
            verdict_reason: 'not applicable to this scope',
            final_severity: 'minor',
          },
        ],
        applied: [],
      })}\n`,
    );

    const quick = makeTestRunContext(tmp, work, scratch, { quality: 'quick' });
    const quickPrompt = retainedRolePrompt({
      ctx: quick,
      role: 'critic',
      stage: 'review',
      planVersion: 1,
      skillFile: quick.skills.criticSkill,
      schemaFile: quick.skills.criticSchema,
      basePrompt: '## Plan\ncurrent',
    });
    expect(quickPrompt).toContain('- v0.C7 reason=not-applicable: Keep duplicate detection');
    expect(quickPrompt).toContain(
      '- critique.v0.json.C7 [minor, addresses=new]: Keep duplicate detection',
    );
    expect(quickPrompt).toContain(
      '- update.v0.json.C7 [minor, verdict=reject]: not applicable to this scope',
    );
    expect(quickPrompt).not.toContain('"plan_markdown"');
    expect(quickPrompt).not.toContain('PREVIOUS PLAN BODY MUST NOT BE RETAINED');
    expect(quick.convergence.contextDeliveries.at(-1)?.reductions).toMatchObject([
      { category: 'resolved-minor-nit-and-rejected-detail' },
    ]);

    for (const quality of ['balanced', 'thorough'] as const) {
      const full = makeTestRunContext(tmp, work, scratch, { quality });
      const prompt = retainedRolePrompt({
        ctx: full,
        role: 'critic',
        stage: 'review',
        planVersion: 1,
        skillFile: full.skills.criticSkill,
        schemaFile: full.skills.criticSchema,
        basePrompt: '## Plan\ncurrent',
      });
      expect(prompt).toContain('"claim":"Keep duplicate detection"');
      expect(prompt).toContain('"summary":"prior review"');
      expect(prompt).toContain('"verdict": "reject"');
      expect(prompt).not.toContain('"plan_markdown"');
      expect(prompt).not.toContain('PREVIOUS PLAN BODY MUST NOT BE RETAINED');
    }
  });

  it('records a known input limit without blocking on the byte estimate', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-bound.'));
    roots.push(tmp);
    const work = path.join(tmp, 'work');
    mkdirSync(work);
    const scratch = Scratch.create('bound-test');
    scratches.push(scratch);
    const ctx = makeTestRunContext(tmp, work, scratch);
    ctx.config.inputLimits.critic = { tokens: 10, source: 'operator' };
    const prompt = retainedRolePrompt({
      ctx,
      role: 'critic',
      stage: 'review',
      planVersion: 0,
      skillFile: ctx.skills.criticSkill,
      schemaFile: ctx.skills.criticSchema,
      basePrompt: 'candidate',
    });

    expect(prompt).toContain('## Mandatory retained run context');
    expect(ctx.convergence.exhaustedLimits).not.toContain('provider-context');
    expect(existsSync(path.join(work, 'convergence.v0.json'))).toBe(true);
    expect(ctx.convergence.contextDeliveries.at(-1)).toMatchObject({
      role: 'critic',
      stage: 'review',
      inputTokenLimit: 10,
      inputLimitSource: 'operator',
    });
    expect(ctx.convergence.contextDeliveries.at(-1)?.totalInputBytes).toBeGreaterThan(10);
  });

  it('records an unknown provider bound without downgrading convergence', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-unknown-bound.'));
    roots.push(tmp);
    const work = path.join(tmp, 'work');
    mkdirSync(work);
    const scratch = Scratch.create('unknown-bound-test');
    scratches.push(scratch);
    const ctx = makeTestRunContext(tmp, work, scratch);
    ctx.config.inputLimits.critic = { tokens: null, source: 'unknown' };

    const prompt = retainedRolePrompt({
      ctx,
      role: 'critic',
      stage: 'review',
      planVersion: 0,
      skillFile: ctx.skills.criticSkill,
      schemaFile: ctx.skills.criticSchema,
      basePrompt: 'candidate',
    });

    expect(prompt).toContain('## Mandatory retained run context');
    expect(ctx.convergence.exhaustedLimits).not.toContain('unknown-provider-context');
    expect(ctx.convergence.unresolvedCoverage).not.toContain('critic:review:unknown-context-bound');
    expect(ctx.convergence.contextDeliveries.at(-1)).toMatchObject({
      role: 'critic',
      stage: 'review',
      inputTokenLimit: null,
      inputLimitSource: 'unknown',
    });
  });
});
