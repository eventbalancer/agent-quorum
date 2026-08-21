import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { convergenceHealth } from '../../src/core/metrics.js';
import { sanitizeCritiqueJson } from '../../src/core/schema.js';
import { REPO_ROOT } from '../helpers/harness.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function issue(id: string, evidenceRef: Record<string, unknown>) {
  return {
    id,
    addresses: null,
    severity: 'major',
    category: 'testability',
    claim: `${id} claim`,
    evidence: '',
    evidence_refs: [evidenceRef],
    suggested_fix: 'fix',
    confidence: 1,
    duplicate_of: null,
  };
}

describe('rich convergence health', () => {
  it('classifies every typed evidence kind plus malformed, mismatched, and unanchored cases', () => {
    const project = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-evidence.'));
    roots.push(project);
    const outside = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-evidence-outside.'));
    roots.push(outside);
    const work = path.join(project, 'work');
    mkdirSync(work);
    writeFileSync(path.join(project, 'source.ts'), 'one\ntwo\nthree\n');
    writeFileSync(path.join(outside, 'escaped.ts'), 'external\n');
    mkdirSync(path.join(outside, 'escaped-repository'));
    symlinkSync(path.join(outside, 'escaped.ts'), path.join(project, 'escaped.ts'));
    symlinkSync(
      path.join(outside, 'escaped-repository'),
      path.join(project, 'escaped-repository'),
      'dir',
    );
    writeFileSync(
      path.join(work, 'plan.v0.md'),
      '# Plan\n\n## Work Plan\n\n### P1\n\nRelease gate verified with `pnpm run test`.\n\n### P2\n\nA different gate applies.\n',
    );
    writeFileSync(
      path.join(work, 'system-context.json'),
      JSON.stringify({ relationships: [{ id: `R-${'a'.repeat(64)}` }] }),
    );
    writeFileSync(path.join(work, 'rejected-log.jsonl'), '');
    const issues = [
      issue('C1', { kind: 'file-line', path: 'source.ts', line: 2 }),
      issue('C2', { kind: 'plan-section', section: 'Work Plan' }),
      issue('C3', { kind: 'phase-gate', phase: 'P1', gate: 'Release gate verified' }),
      issue('C4', { kind: 'command', command: 'pnpm run test' }),
      issue('C5', { kind: 'repository', repository: '.' }),
      issue('C6', { kind: 'topology', topology_id: `R-${'a'.repeat(64)}` }),
      issue('C7', { kind: 'file-line', path: 'missing.ts', line: 1 }),
      issue('C8', { kind: 'repository', value: 'source.ts:2' }),
      { ...issue('C9', { kind: 'command', command: '' }), evidence_refs: [], evidence: '' },
      issue('C10', { kind: 'command', value: `R-${'a'.repeat(64)}` }),
      issue('C11', { kind: 'command', command: 'pnpm run missing' }),
      issue('C12', { kind: 'file-line', path: '/etc/hosts', line: 1 }),
      issue('C13', { kind: 'phase-gate', phase: 'P1' }),
      issue('C14', { kind: 'repository', repository: '/tmp' }),
      issue('C15', { kind: 'file-line', path: 'escaped.ts', line: 1 }),
      issue('C16', { kind: 'repository', repository: 'escaped-repository' }),
      issue('C17', { kind: 'phase-gate', phase: 'P2', gate: 'Release gate verified' }),
    ];
    const critique = path.join(work, 'critique.v0.json');
    writeFileSync(
      critique,
      JSON.stringify({ plan_version: 0, summary: 'evidence matrix', issues }),
    );

    const health = convergenceHealth(
      work,
      path.join(REPO_ROOT, 'skills', 'plan-critic', 'critique.schema.json'),
      0,
      critique,
      project,
    );
    expect(health.grounding).toEqual({
      grounded: 6,
      malformed: 8,
      'format-mismatch': 2,
      unanchored: 1,
    });
    expect(health.evidenceKinds).toMatchObject({
      'file-line': 4,
      'plan-section': 1,
      'phase-gate': 3,
      command: 3,
      repository: 4,
      topology: 1,
    });
  });

  it('grounds provider phase labels after sanitizing them to stable phase ids', () => {
    const project = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-phase-evidence.'));
    roots.push(project);
    const work = path.join(project, 'work');
    mkdirSync(work);
    writeFileSync(
      path.join(work, 'plan.v0.md'),
      '# Plan\n\n## Work Plan\n\n### P3 - Report and Status Projection\n\nAcceptance gate includes `critique_iterations` in every status branch.\n',
    );
    writeFileSync(path.join(work, 'rejected-log.jsonl'), '');
    const critique = path.join(work, 'critique.v0.json');
    writeFileSync(
      critique,
      JSON.stringify({
        plan_version: 0,
        summary: 'phase evidence',
        issues: [
          issue('C1', {
            kind: 'phase-gate',
            phase: 'P3 - Report and Status Projection',
            gate: 'Acceptance gate includes critique_iterations in every status branch.',
          }),
        ],
      }),
    );

    sanitizeCritiqueJson(critique, 0);

    const sanitized = JSON.parse(readFileSync(critique, 'utf8')) as {
      issues: { evidence_refs: { phase: string }[] }[];
    };
    expect(sanitized.issues[0]?.evidence_refs[0]?.phase).toBe('P3');
    expect(
      convergenceHealth(
        work,
        path.join(REPO_ROOT, 'skills', 'plan-critic', 'critique.schema.json'),
        0,
        critique,
        project,
      ).grounding,
    ).toEqual({ grounded: 1, malformed: 0, 'format-mismatch': 0, unanchored: 0 });
  });

  it('grounds a structurally valid evidence list when any typed target exists', () => {
    const project = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-partial-evidence.'));
    roots.push(project);
    const work = path.join(project, 'work');
    mkdirSync(work);
    writeFileSync(
      path.join(work, 'plan.v0.md'),
      '# Plan\n\n## Verified Facts\n\nFacts.\n\n## Work Plan\n\n### P4 Focused Coverage\n',
    );
    writeFileSync(path.join(work, 'rejected-log.jsonl'), '');
    const critique = path.join(work, 'critique.v0.json');
    writeFileSync(
      critique,
      JSON.stringify({
        plan_version: 0,
        summary: 'partial evidence target coverage',
        issues: [
          {
            ...issue('C1', { kind: 'plan-section', section: 'Original scope' }),
            evidence_refs: [
              { kind: 'plan-section', section: 'Original scope' },
              { kind: 'plan-section', section: 'P4 Focused Coverage' },
              { kind: 'plan-section', section: 'Verified Facts' },
            ],
          },
          {
            ...issue('C2', { kind: 'plan-section', section: 'Original scope' }),
            evidence_refs: [
              { kind: 'plan-section', section: 'Original scope' },
              { kind: 'plan-section', section: 'Still missing' },
            ],
          },
        ],
      }),
    );

    expect(
      convergenceHealth(
        work,
        path.join(REPO_ROOT, 'skills', 'plan-critic', 'critique.schema.json'),
        0,
        critique,
        project,
      ).grounding,
    ).toEqual({ grounded: 1, malformed: 1, 'format-mismatch': 0, unanchored: 0 });
  });

  it('distinguishes revision regressions from ordinary refinements', () => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-lineage.'));
    roots.push(work);
    const schema = path.join(REPO_ROOT, 'skills', 'plan-critic', 'critique.schema.json');
    const parent = {
      plan_version: 0,
      summary: 'parent',
      issues: [issue('C1', { kind: 'command', command: 'pnpm run test' })],
    };
    writeFileSync(path.join(work, 'critique.v0.json'), JSON.stringify(parent));
    writeFileSync(path.join(work, 'rejected-log.jsonl'), '');
    writeFileSync(path.join(work, 'plan.v1.md'), '# Plan\n\n## Work Plan\n');
    const child = path.join(work, 'critique.v1.json');
    writeFileSync(
      child,
      JSON.stringify({
        plan_version: 1,
        summary: 'child',
        issues: [
          { ...issue('C1', { kind: 'command', command: 'pnpm run test' }), addresses: 'v0.C1' },
          {
            ...issue('C2', { kind: 'command', command: 'pnpm run test' }),
            addresses: 'v0.C1',
            introduced_by_revision: 'plan.v1.md',
          },
        ],
      }),
    );
    const health = convergenceHealth(work, schema, 1, child, work);
    expect(health.lineage.refinement).toBe(1);
    expect(health.lineage['revision-regression']).toBe(1);
  });

  it('reports every lineage class from valid stored parents and dispositions', () => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-all-lineage.'));
    roots.push(work);
    const schema = path.join(REPO_ROOT, 'skills', 'plan-critic', 'critique.schema.json');
    const evidence = { kind: 'command', command: 'pnpm run test' };
    writeFileSync(
      path.join(work, 'critique.v0.json'),
      JSON.stringify({
        plan_version: 0,
        summary: 'old parents',
        issues: [issue('C1', evidence), issue('C2', evidence), issue('C3', evidence)],
      }),
    );
    writeFileSync(
      path.join(work, 'critique.v1.json'),
      JSON.stringify({
        plan_version: 1,
        summary: 'immediate parent',
        issues: [issue('C1', evidence)],
      }),
    );
    writeFileSync(
      path.join(work, 'update.v0.json'),
      JSON.stringify({ issues: [{ id: 'C3', verdict: 'reject_hallucinated' }] }),
    );
    writeFileSync(path.join(work, 'rejected-log.jsonl'), `${JSON.stringify({ id: 'r1' })}\n`);
    writeFileSync(path.join(work, 'plan.v2.md'), '# Plan\n\n## Work Plan\n');
    const current = path.join(work, 'critique.v2.json');
    writeFileSync(
      current,
      JSON.stringify({
        plan_version: 2,
        summary: 'all classes',
        issues: [
          issue('C1', evidence),
          { ...issue('C2', evidence), addresses: 'v1.C1' },
          { ...issue('C3', evidence), addresses: 'v0.C3' },
          { ...issue('C4', evidence), addresses: 'v0.C2' },
          { ...issue('C5', evidence), introduced_by_revision: 'plan.v2.md' },
          { ...issue('C6', evidence), duplicate_of: 'r1' },
          { ...issue('C7', { kind: 'repository', value: 'source.ts:2' }), addresses: 'v9.C1' },
        ],
      }),
    );

    const health = convergenceHealth(work, schema, 2, current, work);
    expect(health.lineage).toEqual({
      new: 1,
      refinement: 1,
      reopened: 1,
      recurring: 1,
      'revision-regression': 1,
      'rejected-duplicate': 0,
      'invalid-lineage': 2,
    });
    expect(health.grounding['format-mismatch']).toBe(1);
  });

  it('does not let revision markers mask invalid parent or invariant lineage', () => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-invalid-regression.'));
    roots.push(work);
    const schema = path.join(REPO_ROOT, 'skills', 'plan-critic', 'critique.schema.json');
    writeFileSync(path.join(work, 'plan.v1.md'), '# Plan\n\n## Work Plan\n');
    writeFileSync(
      path.join(work, 'convergence.v1.json'),
      JSON.stringify({ invariants: [{ id: 'I-valid', status: 'active' }] }),
    );
    writeFileSync(path.join(work, 'rejected-log.jsonl'), '');
    const current = path.join(work, 'critique.v1.json');
    writeFileSync(
      current,
      JSON.stringify({
        issues: [
          {
            ...issue('C1', { kind: 'plan-section', section: 'Work Plan' }),
            addresses: 'v99.C9',
            introduced_by_revision: 'plan.v1.md',
          },
          {
            ...issue('C2', { kind: 'plan-section', section: 'Work Plan' }),
            invariant_id: 'I-missing',
            introduced_by_revision: 'plan.v1.md',
          },
        ],
      }),
    );
    expect(convergenceHealth(work, schema, 1, current, work).lineage).toMatchObject({
      'revision-regression': 0,
      'invalid-lineage': 2,
    });
  });
});
