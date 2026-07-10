import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ajvModule from 'ajv/dist/ajv.js';
import type { AnySchema } from 'ajv/dist/ajv.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaValidQuiet } from '../../src/core/schema.js';
import { skillPaths } from '../../src/core/run-context.js';
import { claudeJsonSchema } from '../../src/providers/claude.js';
import { REPO_ROOT } from '../helpers/harness.js';

const skills = skillPaths(REPO_ROOT);
const DRAFT_2019_09_SCHEMA = 'https://json-schema.org/draft/2019-09/schema';
const DRAFT_07_SCHEMA = 'http://json-schema.org/draft-07/schema#';
const Ajv = ajvModule.default;

interface SchemaContract {
  readonly name: string;
  readonly schemaFile: string;
  readonly valid: unknown;
  readonly invalid: unknown;
}

const schemaContracts: readonly SchemaContract[] = [
  {
    name: 'clarification',
    schemaFile: skills.clarifySchema,
    valid: { questions: [] },
    invalid: {
      questions: [
        {
          id: 'Q1',
          question: 'Which region?',
          why: 'Changes deployment.',
          options: ['Only one option'],
        },
      ],
    },
  },
  {
    name: 'creator update',
    schemaFile: skills.creatorSchema,
    valid: {
      plan_version: 1,
      plan_markdown: '# Plan',
      issues: [],
      applied: [],
      rejected_append: [],
    },
    invalid: {
      plan_version: 1,
      issues: [],
      applied: [],
      rejected_append: [],
    },
  },
  {
    name: 'creator update metadata',
    schemaFile: skills.creatorMetaSchema,
    valid: {
      plan_version: 1,
      issues: [],
      applied: [],
      rejected_append: [],
    },
    invalid: {
      plan_version: 0,
      issues: [],
      applied: [],
      rejected_append: [],
    },
  },
  {
    name: 'critique',
    schemaFile: skills.criticSchema,
    valid: { plan_version: 0, summary: 'ok', issues: [] },
    invalid: { plan_version: 0, issues: [] },
  },
  {
    name: 'fix review',
    schemaFile: skills.reviewerSchema,
    valid: { approval: 'accept', concerns: [] },
    invalid: { approval: 'approve', concerns: [] },
  },
  {
    name: 'readiness judgment',
    schemaFile: skills.judgeSchema,
    valid: { ready: true, rationale: 'ready' },
    invalid: { ready: true },
  },
];

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

describe('Judge final-readiness contract', () => {
  it('distinguishes canonical final evaluation from intermediate evidence', () => {
    const text = skillText(skills.judgeSkill);
    expect(text).toContain('scope: intermediate | final');
    expect(text).toContain('authoritative post-fix canonical artifact');
    expect(text).toContain('advisory only');
    expect(text).toContain('do not quote or reproduce plan text');
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

describe('Claude JSON-mode schema contracts', () => {
  function fixture(name: string, value: unknown): string {
    const file = path.join(tmp, name);
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    return file;
  }

  it.each(schemaContracts)(
    'projects only the $schema metadata for $name and preserves validation results',
    ({ name, schemaFile, valid, invalid }) => {
      const canonical = JSON.parse(readFileSync(schemaFile, 'utf8')) as Record<string, unknown>;
      const projected = JSON.parse(claudeJsonSchema(schemaFile)) as Record<string, unknown>;
      expect(canonical.$schema).toBe(DRAFT_2019_09_SCHEMA);
      expect(projected.$schema).toBe(DRAFT_07_SCHEMA);
      expect(projected).toEqual({ ...canonical, $schema: DRAFT_07_SCHEMA });

      const validFile = fixture(`${name}-valid.json`, valid);
      const invalidFile = fixture(`${name}-invalid.json`, invalid);
      expect(schemaValidQuiet(validFile, schemaFile)).toBe(true);
      expect(schemaValidQuiet(invalidFile, schemaFile)).toBe(false);

      const draft7 = new Ajv({ strict: true });
      const validateProjected = draft7.compile(projected as AnySchema);
      expect(validateProjected(valid)).toBe(true);
      expect(validateProjected(invalid)).toBe(false);
    },
  );
});
