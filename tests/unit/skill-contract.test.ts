import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaValidQuiet } from '../../src/core/schema.js';
import { skillPaths } from '../../src/core/run-context.js';
import { REPO_ROOT } from '../helpers/harness.js';

const skills = skillPaths(REPO_ROOT);

function skillText(file: string): string {
  return readFileSync(file, 'utf8');
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-skillcontract.'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('role skill split-package contract', () => {
  it('every role skill states the single-master-plan + split-package contract', () => {
    for (const file of [
      skills.creatorSkill,
      skills.criticSkill,
      skills.fixerSkill,
      skills.reviewerSkill,
    ]) {
      const text = skillText(file);
      expect(text, `${path.basename(path.dirname(file))} mentions plan.package`).toContain(
        'plan.package',
      );
      expect(text, `${path.basename(path.dirname(file))} mentions split-ready`).toContain(
        'split-ready',
      );
    }
  });

  it('the creator skill enumerates the split-ready per-phase fields', () => {
    const text = skillText(skills.creatorSkill);
    for (const field of [
      'goal',
      'prerequisites',
      'touch surfaces',
      'ordered steps',
      'local verification',
      'acceptance gate',
      'common pitfalls',
      'stop conditions',
    ]) {
      expect(text, `creator lists "${field}"`).toContain(field);
    }
    expect(text).toContain('one master plan');
  });
});

describe('execute skill package-aware workflow', () => {
  const executeSkill = path.join(REPO_ROOT, '.agents', 'skills', 'execute', 'SKILL.md');

  it('states one entry point covering single-file plans and plan.package directories', () => {
    const text = skillText(executeSkill);
    expect(text).toContain('plan.package');
    expect(text.toLowerCase()).toContain('one entry point');
  });

  it('states the positioning-report fields, override handling, and phase-approval boundary', () => {
    const text = skillText(executeSkill).toLowerCase();
    expect(text).toContain('positioning report');
    expect(text).toContain('last completed unit');
    expect(text).toContain('next unit');
    expect(text).toContain('override');
    expect(text).toContain('phase boundaries');
    expect(text).toContain('stop report');
  });
});

describe('unchanged role schemas still validate their fixtures', () => {
  function fixture(name: string, value: unknown): string {
    const file = path.join(tmp, name);
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    return file;
  }

  it('validates a critique fixture', () => {
    const file = fixture('critique.json', { plan_version: 0, summary: 'ok', issues: [] });
    expect(schemaValidQuiet(file, skills.criticSchema)).toBe(true);
  });

  it('validates an update fixture', () => {
    const file = fixture('update.json', {
      plan_version: 1,
      plan_markdown: '# Plan',
      issues: [],
      applied: [],
      rejected_append: [],
    });
    expect(schemaValidQuiet(file, skills.creatorSchema)).toBe(true);
  });

  it('validates an update-meta fixture', () => {
    const file = fixture('update-meta.json', {
      plan_version: 1,
      issues: [],
      applied: [],
      rejected_append: [],
    });
    expect(schemaValidQuiet(file, skills.creatorMetaSchema)).toBe(true);
  });

  it('validates a review fixture', () => {
    const file = fixture('review.json', { approval: 'accept', concerns: [] });
    expect(schemaValidQuiet(file, skills.reviewerSchema)).toBe(true);
  });
});
