import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  combineUpdateJson,
  sanitizeCritiqueJson,
  sanitizeUpdateJson,
  sanitizeUpdateMetaJson,
  schemaValidQuiet,
  validateSchema,
} from '../../src/core/schema.js';
import { captureStderr, withEnv } from '../helpers/harness.js';

let tmp: string;

interface SanitizedUpdateIssue {
  verdict_reason: string;
  duplicate_of: null;
}

interface SanitizedUpdate {
  issues: SanitizedUpdateIssue[];
  rejected_append: Record<string, unknown>[];
}

interface SanitizedCritiqueIssue {
  id: string;
  addresses: string | null;
}

interface SanitizedCritique {
  issues: SanitizedCritiqueIssue[];
}

function writeJson(name: string, value: unknown): string {
  const file = path.join(tmp, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'plan-loop-schematest.'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('sanitizers', () => {
  it('sanitize_update_json strips fields and backfills defaults', () => {
    const file = writeJson('update.json', {
      plan_version: 1,
      plan_markdown: '# Plan',
      summary: 'drop me',
      issues: [{ id: 'C1', verdict: 'accept', final_severity: 'major', notes: 'drop me' }],
      applied: ['C1'],
      rejected_append: [{ id: 'C2', claim: 'claim', reason: 'reason', extra: 'drop me' }],
    });
    const capture = captureStderr();
    try {
      sanitizeUpdateJson(file);
    } finally {
      capture.restore();
    }
    const result = readJson(file) as SanitizedUpdate & Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual([
      'applied',
      'issues',
      'plan_markdown',
      'plan_version',
      'rejected_append',
    ]);
    expect(result.issues[0]?.verdict_reason).toBe('');
    expect(result.issues[0]?.duplicate_of).toBeNull();
    expect(result.issues[0]).not.toHaveProperty('notes');
    expect(result.rejected_append[0]).not.toHaveProperty('extra');
  });

  it('sanitize functions force plan_version to the loop iteration', () => {
    const update = writeJson('force-update.json', {
      plan_version: 0,
      plan_markdown: '# Plan',
      issues: [],
      applied: [],
      rejected_append: [],
    });
    const meta = writeJson('force-meta.json', {
      plan_version: 0,
      issues: [],
      applied: [],
      rejected_append: [],
    });
    const capture = captureStderr();
    try {
      sanitizeUpdateJson(update, 1);
      sanitizeUpdateMetaJson(meta, 1);
      expect((readJson(update) as { plan_version: number }).plan_version).toBe(1);
      expect((readJson(meta) as { plan_version: number }).plan_version).toBe(1);
      expect(() => {
        sanitizeUpdateJson(update, 'two');
      }).toThrow(/expected_version must be an integer/);
    } finally {
      capture.restore();
    }
  });

  it('sanitize_critique_json normalizes version-prefixed issue ids', () => {
    const file = writeJson('critique.json', {
      plan_version: 0,
      summary: 'verdict',
      issues: [
        {
          id: 'v0.C1',
          addresses: null,
          severity: 'major',
          category: 'correctness',
          claim: 'c',
          evidence: 'e',
          suggested_fix: 'f',
          confidence: 0.9,
          duplicate_of: null,
        },
        {
          id: 'C2',
          addresses: 'v0.C1',
          severity: 'minor',
          category: 'clarity',
          claim: 'c',
          evidence: 'e',
          suggested_fix: 'f',
          confidence: 0.8,
          duplicate_of: null,
        },
      ],
    });
    const capture = captureStderr();
    try {
      sanitizeCritiqueJson(file, 0);
    } finally {
      capture.restore();
    }
    const result = readJson(file) as SanitizedCritique;
    expect(result.issues[0]?.id).toBe('C1');
    expect(result.issues[1]?.id).toBe('C2');
    expect(result.issues[1]?.addresses).toBe('v0.C1');
    expect(result.issues.every((issue) => /^C[0-9]+$/.test(issue.id))).toBe(true);
  });

  it('combine_update_json assembles markdown and metadata', () => {
    const meta = writeJson('meta.json', {
      plan_version: 2,
      issues: [],
      applied: [],
      rejected_append: [],
    });
    const markdown = path.join(tmp, 'revision.md');
    writeFileSync(markdown, '# Revised\n');
    const out = path.join(tmp, 'update.json');
    combineUpdateJson(meta, markdown, out);
    expect(readJson(out)).toEqual({
      plan_version: 2,
      plan_markdown: '# Revised\n',
      issues: [],
      applied: [],
      rejected_append: [],
    });
  });
});

describe('in-process schema validation', () => {
  it('schema_valid_quiet returns validator status', () => {
    const schema = writeJson('schema.json', { required: ['ok'] });
    const valid = writeJson('valid.json', { ok: true });
    const invalid = writeJson('invalid.json', {});
    expect(schemaValidQuiet(valid, schema)).toBe(true);
    expect(schemaValidQuiet(invalid, schema)).toBe(false);
  });

  it('validate_schema runs in-process and reports failures with detail (adapted: no ajv binary)', () => {
    const schema = writeJson('detail.schema.json', { required: ['ok'] });
    const valid = writeJson('detail.valid.json', { ok: true });
    const invalid = writeJson('detail.invalid.json', {});
    const notJson = path.join(tmp, 'broken.json');
    writeFileSync(notJson, '{nope');
    const capture = captureStderr();
    try {
      expect(validateSchema(valid, schema)).toBe(true);
      expect(validateSchema(invalid, schema)).toBe(false);
      expect(capture.text()).toContain(`schema validation failed: ${invalid} vs ${schema}`);
      expect(validateSchema(notJson, schema)).toBe(false);
      expect(capture.text()).toContain(`not valid JSON: ${notJson}`);
    } finally {
      capture.restore();
    }
  });

  it('PLAN_LOOP_AJV_BIN is warned-and-ignored (adapted: Finding F8)', () => {
    const schema = writeJson('ajvbin.schema.json', { required: ['ok'] });
    const valid = writeJson('ajvbin.valid.json', { ok: true });
    const capture = captureStderr();
    try {
      const result = withEnv({ PLAN_LOOP_AJV_BIN: '/nonexistent/ajv' }, () =>
        validateSchema(valid, schema),
      );
      expect(result).toBe(true);
      expect(capture.text()).toContain('PLAN_LOOP_AJV_BIN is ignored');
    } finally {
      capture.restore();
    }
  });
});
