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
import { skillPaths } from '../../src/core/run-context.js';
import { captureStderr, REPO_ROOT, withEnv } from '../helpers/harness.js';

const skills = skillPaths(REPO_ROOT);

let tmp: string;

interface SanitizedUpdateIssue {
  verdict_reason: string;
  duplicate_of: null;
}

interface SanitizedUpdate {
  issues: SanitizedUpdateIssue[];
  rejected_append: Record<string, unknown>[];
  systemic_dispositions?: {
    evidence_refs?: unknown[];
  }[];
}

interface SanitizedCritiqueIssue {
  id: string;
  addresses: string | null;
}

interface SanitizedCritiqueOpportunity {
  fingerprint: string;
  claim: string;
  evidence: string;
  suggested_improvement: string;
  evidence_refs: unknown[];
}

interface SanitizedCritique {
  issues: SanitizedCritiqueIssue[];
  domain_assessments: unknown[];
  boundary_challenges: unknown[];
  opportunities: SanitizedCritiqueOpportunity[];
  review?: {
    issue_budget?: {
      used: number;
      exhausted: boolean;
    };
  };
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
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-schematest.'));
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
          severity: 'major',
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
    expect(result.domain_assessments).toEqual([]);
    expect(result.boundary_challenges).toEqual([]);
    expect(result.opportunities).toEqual([]);
  });

  it('moves legacy minor and nit issues into non-blocking opportunities', () => {
    const file = writeJson('legacy-opportunities.json', {
      plan_version: 2,
      summary: 'Only optional improvements remain.',
      issues: [
        {
          id: 'C1',
          addresses: null,
          severity: 'minor',
          category: 'clarity',
          claim: 'Name the local verification gate.',
          evidence: '## Verification',
          evidence_refs: [{ kind: 'plan-section', section: 'Verification' }],
          suggested_fix: 'Add the gate name.',
          confidence: 0.9,
          duplicate_of: null,
        },
        {
          id: 'C2',
          addresses: null,
          severity: 'nit',
          category: 'convention',
          claim: 'Shorten the orientation paragraph.',
          evidence: '## At a Glance',
          suggested_fix: 'Remove repeated context.',
          confidence: 0.8,
          duplicate_of: null,
        },
      ],
      review: {
        considered_context: [
          'original-scope',
          'authoritative-system-facts',
          'operator-decisions',
          'material-findings',
          'active-invariants',
          'quality-and-limits',
        ],
        invariant_assessments: [],
        scope_coverage: ['original-scope'],
        issue_budget: { limit: 8, used: 2, exhausted: true },
        scan_complete: true,
        unresolved_coverage: [],
      },
    });
    expect(schemaValidQuiet(file, skills.criticSchema)).toBe(false);
    const capture = captureStderr();
    try {
      sanitizeCritiqueJson(file, 2);
      expect(capture.text()).toContain('moving 2 non-material critique issue(s)');
    } finally {
      capture.restore();
    }

    const result = readJson(file) as SanitizedCritique;
    expect(result.issues).toEqual([]);
    expect(result.review?.issue_budget?.used).toBe(0);
    expect(result.review?.issue_budget?.exhausted).toBe(false);
    expect(result.opportunities).toHaveLength(2);
    expect(result.opportunities[0]).toMatchObject({
      claim: 'Name the local verification gate.',
      evidence: '## Verification',
      suggested_improvement: 'Add the gate name.',
      evidence_refs: [{ kind: 'plan-section', section: 'Verification' }],
    });
    expect(result.opportunities[0]?.fingerprint).toMatch(/^O-[a-f0-9]{64}$/);
    expect(result.opportunities[1]?.evidence_refs).toEqual([]);
    expect(schemaValidQuiet(file, skills.criticSchema)).toBe(true);
  });

  it('preserves bounded-readiness critic arrays and fills missing opportunity fields', () => {
    const domainAssessment = {
      domain: 'security-privacy-authorization',
      applicability: 'applicable',
      risk: 'high',
      complete: false,
      rationale: 'The plan changes authorization but the policy source is unavailable.',
      unavailable_evidence: ['authorization policy'],
      evidence_refs: [{ kind: 'plan-section', section: 'Security' }],
    };
    const boundaryChallenge = {
      id: 'B1',
      kind: 'scope-expansion',
      claim: 'The authorization service must enter scope.',
      rationale: 'The scoped API cannot enforce the required policy alone.',
      evidence: '## Out of Scope',
      evidence_refs: [{ kind: 'plan-section', section: 'Out of Scope' }],
    };
    const file = writeJson('bounded-readiness.json', {
      plan_version: 1,
      summary: 'A boundary decision is required.',
      issues: [],
      domain_assessments: [domainAssessment],
      boundary_challenges: [boundaryChallenge],
      opportunities: [
        {
          claim: 'Add a navigation link.',
          evidence: '## Verification',
          suggested_improvement: 'Link to the verification section.',
        },
      ],
    });

    sanitizeCritiqueJson(file, 1);

    const result = readJson(file) as SanitizedCritique;
    expect(result.domain_assessments).toEqual([domainAssessment]);
    expect(result.boundary_challenges).toEqual([boundaryChallenge]);
    expect(result.opportunities[0]?.fingerprint).toMatch(/^O-[a-f0-9]{64}$/);
    expect(result.opportunities[0]?.evidence_refs).toEqual([]);
    expect(schemaValidQuiet(file, skills.criticSchema)).toBe(true);
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

  it('preserves systemic-disposition evidence through both update paths', () => {
    const systemicDisposition = {
      issue_id: 'C1',
      scope: 'local',
      rationale: 'The evidence limits this finding to the Work Plan section.',
      evidence_refs: [{ kind: 'plan-section', section: 'Work Plan' }],
      invariant: null,
    };
    const issue = {
      id: 'C1',
      verdict: 'accept',
      verdict_reason: 'The cited section demonstrates the local correction.',
      final_severity: 'major',
      duplicate_of: null,
    };
    const update = writeJson('enriched-update.json', {
      plan_version: 1,
      plan_markdown: '# Work Plan',
      issues: [issue],
      applied: ['C1'],
      systemic_dispositions: [systemicDisposition],
      rejected_append: [],
    });
    const meta = writeJson('enriched-meta.json', {
      plan_version: 1,
      issues: [issue],
      applied: ['C1'],
      systemic_dispositions: [systemicDisposition],
      rejected_append: [],
    });
    const markdown = path.join(tmp, 'enriched-plan.md');
    const combined = path.join(tmp, 'enriched-combined.json');
    writeFileSync(markdown, '# Work Plan\n');

    sanitizeUpdateJson(update, 1);
    sanitizeUpdateMetaJson(meta, 1);
    combineUpdateJson(meta, markdown, combined);

    for (const file of [update, meta, combined]) {
      const result = readJson(file) as SanitizedUpdate;
      expect(result.systemic_dispositions?.[0]?.evidence_refs).toEqual(
        systemicDisposition.evidence_refs,
      );
    }
    expect(schemaValidQuiet(update, skills.creatorSchema)).toBe(true);
    expect(schemaValidQuiet(meta, skills.creatorMetaSchema)).toBe(true);
    expect(schemaValidQuiet(combined, skills.creatorSchema)).toBe(true);
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

  it('AGENT_QUORUM_AJV_BIN is warned-and-ignored (adapted: Finding F8)', () => {
    const schema = writeJson('ajvbin.schema.json', { required: ['ok'] });
    const valid = writeJson('ajvbin.valid.json', { ok: true });
    const capture = captureStderr();
    try {
      const result = withEnv({ AGENT_QUORUM_AJV_BIN: '/nonexistent/ajv' }, () =>
        validateSchema(valid, schema),
      );
      expect(result).toBe(true);
      expect(capture.text()).toContain('AGENT_QUORUM_AJV_BIN is ignored');
    } finally {
      capture.restore();
    }
  });
});
