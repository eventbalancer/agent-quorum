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
const REQUIRED_CRITIC_CONTEXT = [
  'original-scope',
  'authoritative-system-facts',
  'operator-decisions',
  'material-findings',
  'active-invariants',
  'quality-and-limits',
] as const;
const CRITIC_SCOPE_COVERAGE = ['original-scope', 'declared-scope', 'direct-plan-scope'] as const;
const CRITIC_RISK_DOMAINS = [
  'correctness',
  'public-compatibility',
  'data-migrations',
  'security-privacy-authorization',
  'concurrency-distributed-ordering',
  'cross-repository-delivery',
  'production-operability',
  'performance-cost',
] as const;
const CRITIC_APPLICABILITY = ['applicable', 'not-applicable', 'unknown'] as const;
const CRITIC_RISK_LEVELS = ['standard', 'high'] as const;
const SYSTEMIC_DISPOSITION = {
  issue_id: 'C1',
  scope: 'local',
  rationale: 'The cited plan section confines the finding to one location.',
  evidence_refs: [{ kind: 'plan-section', section: 'Work Plan' }],
  invariant: null,
} as const;
const CREATOR_ISSUE = {
  id: 'C1',
  verdict: 'accept',
  verdict_reason: 'The evidence supports the correction.',
  final_severity: 'major',
  duplicate_of: null,
} as const;
const COMPLETE_CRITIC_REVIEW = {
  considered_context: REQUIRED_CRITIC_CONTEXT,
  invariant_assessments: [],
  scope_coverage: ['original-scope'],
  issue_budget: { limit: 8, used: 0, exhausted: false },
  scan_complete: true,
  unresolved_coverage: [],
} as const;

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
    name: 'enriched creator update',
    schemaFile: skills.creatorSchema,
    valid: {
      plan_version: 1,
      plan_markdown: '# Work Plan',
      issues: [CREATOR_ISSUE],
      applied: ['C1'],
      systemic_dispositions: [SYSTEMIC_DISPOSITION],
      rejected_append: [],
    },
    invalid: {
      plan_version: 1,
      plan_markdown: '# Work Plan',
      issues: [CREATOR_ISSUE],
      applied: ['C1'],
      systemic_dispositions: [
        { ...SYSTEMIC_DISPOSITION, evidence_refs: [{ kind: 'unknown', value: 'Work Plan' }] },
      ],
      rejected_append: [],
    },
  },
  {
    name: 'enriched creator update metadata',
    schemaFile: skills.creatorMetaSchema,
    valid: {
      plan_version: 1,
      issues: [CREATOR_ISSUE],
      applied: ['C1'],
      systemic_dispositions: [SYSTEMIC_DISPOSITION],
      rejected_append: [],
    },
    invalid: {
      plan_version: 1,
      issues: [CREATOR_ISSUE],
      applied: ['C1'],
      systemic_dispositions: [
        { ...SYSTEMIC_DISPOSITION, evidence_refs: [{ kind: 'unknown', value: 'Work Plan' }] },
      ],
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
    name: 'enriched critique proof vocabulary',
    schemaFile: skills.criticSchema,
    valid: {
      plan_version: 0,
      summary: 'complete independent scan',
      review: COMPLETE_CRITIC_REVIEW,
      issues: [],
    },
    invalid: {
      plan_version: 0,
      summary: 'incomplete retained-context proof',
      review: {
        ...COMPLETE_CRITIC_REVIEW,
        considered_context: REQUIRED_CRITIC_CONTEXT.slice(0, -1),
      },
      issues: [],
    },
  },
  {
    name: 'bounded-readiness critique vocabulary',
    schemaFile: skills.criticSchema,
    valid: {
      plan_version: 0,
      summary: 'A high-risk applicable domain lacks required evidence.',
      domain_assessments: [
        {
          domain: 'security-privacy-authorization',
          applicability: 'applicable',
          risk: 'high',
          complete: false,
          rationale: 'The plan changes authorization behavior.',
          unavailable_evidence: ['deployed policy source'],
          evidence_refs: [{ kind: 'plan-section', section: 'Security' }],
        },
      ],
      boundary_challenges: [
        {
          id: 'B1',
          kind: 'scope-expansion',
          claim: 'The policy service must enter scope.',
          rationale: 'The scoped implementation cannot enforce the policy alone.',
          evidence: '## Out of Scope',
          evidence_refs: [{ kind: 'plan-section', section: 'Out of Scope' }],
        },
      ],
      opportunities: [
        {
          fingerprint: 'navigation-link',
          claim: 'Add a navigation link.',
          evidence: '## Verification',
          suggested_improvement: 'Link the verification section.',
          evidence_refs: [{ kind: 'plan-section', section: 'Verification' }],
        },
      ],
      issues: [],
    },
    invalid: {
      plan_version: 0,
      summary: 'Uses an unsupported applicability token.',
      domain_assessments: [
        {
          domain: 'security-privacy-authorization',
          applicability: 'unresolved',
          risk: 'high',
          complete: false,
          rationale: 'The plan changes authorization behavior.',
          unavailable_evidence: [],
          evidence_refs: [],
        },
      ],
      boundary_challenges: [],
      opportunities: [],
      issues: [],
    },
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

describe('critic proof vocabulary contract', () => {
  it('keeps the prompt instructions and schema on the same closed vocabularies', () => {
    const skill = skillText(skills.criticSkill);
    for (const token of [...REQUIRED_CRITIC_CONTEXT, ...CRITIC_SCOPE_COVERAGE]) {
      expect(skill).toContain(`\`${token}\``);
    }

    const schema = JSON.parse(readFileSync(skills.criticSchema, 'utf8')) as {
      properties: {
        review: {
          properties: {
            considered_context: { items: { enum: string[] } };
            scope_coverage: { items: { enum: string[] } };
          };
        };
      };
    };
    expect(schema.properties.review.properties.considered_context.items.enum).toEqual(
      REQUIRED_CRITIC_CONTEXT,
    );
    expect(schema.properties.review.properties.scope_coverage.items.enum).toEqual(
      CRITIC_SCOPE_COVERAGE,
    );
  });

  it('keeps bounded-readiness domain, applicability, and risk vocabularies aligned', () => {
    const skill = skillText(skills.criticSkill);
    for (const token of [...CRITIC_RISK_DOMAINS, ...CRITIC_APPLICABILITY, ...CRITIC_RISK_LEVELS]) {
      expect(skill).toContain(`\`${token}\``);
    }

    const schema = JSON.parse(readFileSync(skills.criticSchema, 'utf8')) as {
      $defs: {
        riskDomain: { enum: string[] };
        applicability: { enum: string[] };
        riskLevel: { enum: string[] };
      };
    };
    expect(schema.$defs.riskDomain.enum).toEqual(CRITIC_RISK_DOMAINS);
    expect(schema.$defs.applicability.enum).toEqual(CRITIC_APPLICABILITY);
    expect(schema.$defs.riskLevel.enum).toEqual(CRITIC_RISK_LEVELS);
  });

  it('keeps critic risk calibration aligned with the frozen assessment policy', () => {
    const skill = skillText(skills.criticSkill);
    expect(skill).toContain('Do not raise a frozen `standard` domain to `high` merely because');
    expect(skill).toContain('Additive or behavior-preserving local public-surface work');
    expect(skill).toContain('migration, authorization, data-integrity, distributed-ordering');
  });
});

describe('Judge final-readiness contract', () => {
  it('distinguishes canonical final evaluation from intermediate evidence', () => {
    const text = skillText(skills.judgeSkill);
    expect(text).toContain('scope: intermediate | final');
    expect(text).toContain('authoritative post-fix canonical artifact');
    expect(text).toContain('advisory only');
    expect(text).toContain('do not quote or reproduce plan text');
    expect(text).toContain('revision_issue');
    expect(text).toContain('inside the frozen boundary');
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
