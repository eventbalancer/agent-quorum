import { readFileSync } from 'node:fs';
import path from 'node:path';
import ajvModule from 'ajv/dist/2019.js';
import { describe, expect, it } from 'vitest';
import { isJsonObject, type JsonObject, type JsonValue } from '../../src/core/json.js';
import {
  normalizeCodexJsonValue,
  projectCodexJsonSchema,
} from '../../src/providers/codex-schema.js';
import { SKILLS_DIR } from '../helpers/harness.js';

const Ajv2019 = ajvModule.default;
const CRITIC_SCHEMA = path.join(SKILLS_DIR, 'plan-critic', 'critique.schema.json');
const JUDGE_SCHEMA = path.join(SKILLS_DIR, 'plan-judge', 'readiness.schema.json');
const CRITIC_RISK_DOMAINS = [
  'correctness',
  'public-compatibility',
  'data-migrations',
  'security-privacy-authorization',
  'concurrency-distributed-ordering',
  'cross-repository-delivery',
  'production-operability',
  'performance-cost',
];

function completeCriticReview(): JsonObject {
  return {
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
    issue_budget: { limit: 8, used: 0, exhausted: false },
    scan_complete: true,
    unresolved_coverage: [],
  };
}

function completeDomainAssessments(): JsonObject[] {
  return CRITIC_RISK_DOMAINS.map((domain) => ({
    domain,
    applicability: 'not-applicable',
    risk: 'standard',
    complete: true,
    rationale: `${domain} does not apply to this candidate.`,
    unavailable_evidence: [],
    evidence_refs: [{ kind: 'plan-section', section: 'Scope' }],
  }));
}

function readSchema(file = CRITIC_SCHEMA): JsonObject {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  if (!isJsonObject(parsed)) {
    throw new TypeError('fixture schema must be an object');
  }
  return parsed;
}

function expectEveryPropertyRequired(value: JsonValue): void {
  if (Array.isArray(value)) {
    value.forEach(expectEveryPropertyRequired);
    return;
  }
  if (!isJsonObject(value)) {
    return;
  }
  const properties = value.properties;
  if (isJsonObject(properties)) {
    expect(value.required).toEqual(Object.keys(properties));
  }
  Object.values(value).forEach(expectEveryPropertyRequired);
}

describe('Codex structured-output schema projection', () => {
  it('requires every object property without making required critic fields nullable', () => {
    const projected = projectCodexJsonSchema(readSchema());

    expect(projected.changed).toBe(true);
    expectEveryPropertyRequired(projected.schema);
    const properties = projected.schema.properties as JsonObject;
    const review = properties.review;
    expect(isJsonObject(review) ? review.type : undefined).toBe('object');
    for (const field of ['domain_assessments', 'boundary_challenges', 'opportunities']) {
      const property = properties[field];
      expect(isJsonObject(property) ? property.type : undefined).toBe('array');
    }
  });

  it('removes schema keywords unsupported by Codex while retaining canonical constraints', () => {
    const canonical = readSchema();
    const projected = projectCodexJsonSchema(canonical);
    const canonicalReview = (canonical.properties as JsonObject).review as JsonObject;
    const canonicalReviewProperties = canonicalReview.properties as JsonObject;
    const projectedReview = (projected.schema.properties as JsonObject).review as JsonObject;
    const projectedReviewProperties = projectedReview.properties as JsonObject;

    expect((canonicalReviewProperties.considered_context as JsonObject).uniqueItems).toBe(true);
    expect((canonicalReviewProperties.scope_coverage as JsonObject).uniqueItems).toBe(true);
    expect(
      (projectedReviewProperties.considered_context as JsonObject).uniqueItems,
    ).toBeUndefined();
    expect((projectedReviewProperties.scope_coverage as JsonObject).uniqueItems).toBeUndefined();
    expect(projected.changed).toBe(true);
  });

  it('removes projected null placeholders before canonical validation', () => {
    const canonical = readSchema();
    const projectedOutput: JsonValue = {
      plan_version: 0,
      summary: 'No issues.',
      review: completeCriticReview(),
      domain_assessments: completeDomainAssessments(),
      boundary_challenges: [],
      opportunities: [],
      issues: [
        {
          id: 'C1',
          addresses: null,
          severity: 'major',
          category: 'clarity',
          claim: 'Clarify the phase gate.',
          evidence: '## Verification',
          evidence_refs: [
            {
              kind: 'file-line',
              value: null,
              path: 'src/index.ts',
              line: 1,
              section: null,
              phase: null,
              gate: null,
              command: null,
              repository: null,
              topology_id: null,
            },
          ],
          invariant_id: null,
          introduced_by_revision: null,
          suggested_fix: 'Name the gate.',
          confidence: null,
          duplicate_of: null,
        },
      ],
    };

    const normalized = normalizeCodexJsonValue(projectedOutput, canonical);

    expect(normalized).toEqual({
      plan_version: 0,
      summary: 'No issues.',
      review: completeCriticReview(),
      domain_assessments: completeDomainAssessments(),
      boundary_challenges: [],
      opportunities: [],
      issues: [
        {
          id: 'C1',
          addresses: null,
          severity: 'major',
          category: 'clarity',
          claim: 'Clarify the phase gate.',
          evidence: '## Verification',
          evidence_refs: [{ kind: 'file-line', path: 'src/index.ts', line: 1 }],
          suggested_fix: 'Name the gate.',
          confidence: null,
          duplicate_of: null,
        },
      ],
    });
    const validate = new Ajv2019({ strict: false }).compile(canonical);
    expect(validate(normalized)).toBe(true);
  });

  it('normalizes bounded-readiness arrays from projected Codex output', () => {
    const canonical = readSchema();
    const projectedEvidenceRef = {
      kind: 'plan-section',
      value: null,
      path: null,
      line: null,
      section: 'Security',
      phase: null,
      gate: null,
      command: null,
      repository: null,
      topology_id: null,
    };
    const projectedOutput: JsonValue = {
      plan_version: 3,
      summary: 'The boundary must be revised before readiness can be decided.',
      review: completeCriticReview(),
      domain_assessments: completeDomainAssessments().map((assessment) =>
        assessment.domain === 'security-privacy-authorization'
          ? {
              domain: 'security-privacy-authorization',
              applicability: 'applicable',
              risk: 'high',
              complete: false,
              rationale: 'The required policy source is unavailable.',
              unavailable_evidence: ['deployed policy source'],
              evidence_refs: [projectedEvidenceRef],
            }
          : assessment,
      ),
      boundary_challenges: [
        {
          id: 'B1',
          kind: 'scope-expansion',
          claim: 'The policy service must enter scope.',
          rationale: 'The scoped component cannot enforce the policy alone.',
          evidence: '## Out of Scope',
          evidence_refs: [projectedEvidenceRef],
        },
      ],
      opportunities: [
        {
          fingerprint: 'navigation-link',
          claim: 'Add a navigation link.',
          evidence: '## Verification',
          suggested_improvement: 'Link to verification.',
          evidence_refs: [],
        },
      ],
      issues: [],
    };

    const normalized = normalizeCodexJsonValue(projectedOutput, canonical);

    expect(normalized).toEqual({
      plan_version: 3,
      summary: 'The boundary must be revised before readiness can be decided.',
      review: completeCriticReview(),
      domain_assessments: completeDomainAssessments().map((assessment) =>
        assessment.domain === 'security-privacy-authorization'
          ? {
              domain: 'security-privacy-authorization',
              applicability: 'applicable',
              risk: 'high',
              complete: false,
              rationale: 'The required policy source is unavailable.',
              unavailable_evidence: ['deployed policy source'],
              evidence_refs: [{ kind: 'plan-section', section: 'Security' }],
            }
          : assessment,
      ),
      boundary_challenges: [
        {
          id: 'B1',
          kind: 'scope-expansion',
          claim: 'The policy service must enter scope.',
          rationale: 'The scoped component cannot enforce the policy alone.',
          evidence: '## Out of Scope',
          evidence_refs: [{ kind: 'plan-section', section: 'Security' }],
        },
      ],
      opportunities: [
        {
          fingerprint: 'navigation-link',
          claim: 'Add a navigation link.',
          evidence: '## Verification',
          suggested_improvement: 'Link to verification.',
          evidence_refs: [],
        },
      ],
      issues: [],
    });
    const validate = new Ajv2019({ strict: false }).compile(canonical);
    expect(validate(normalized)).toBe(true);
  });

  it('normalizes required Judge occurrence evidence through shared schema definitions', () => {
    const canonical = readSchema(JUDGE_SCHEMA);
    const projectedOutput: JsonValue = {
      ready: false,
      rationale: 'An occurrence is unresolved.',
      revision_issue: null,
      coverage_complete: true,
      unresolved_occurrence_ids: ['O2'],
      invariant_assessments: [
        {
          invariant_id: 'I1',
          occurrences: [
            {
              occurrence_id: 'O1',
              disposition: 'satisfied',
              evidence_refs: [
                {
                  kind: 'plan-section',
                  value: null,
                  path: null,
                  line: null,
                  section: 'Verification',
                  phase: null,
                  gate: null,
                  command: null,
                  repository: null,
                  topology_id: null,
                },
              ],
            },
            {
              occurrence_id: 'O2',
              disposition: 'unresolved',
              evidence_refs: [],
            },
          ],
        },
      ],
    };

    const normalized = normalizeCodexJsonValue(projectedOutput, canonical);

    expect(normalized).toEqual({
      ready: false,
      rationale: 'An occurrence is unresolved.',
      revision_issue: null,
      coverage_complete: true,
      unresolved_occurrence_ids: ['O2'],
      invariant_assessments: [
        {
          invariant_id: 'I1',
          occurrences: [
            {
              occurrence_id: 'O1',
              disposition: 'satisfied',
              evidence_refs: [{ kind: 'plan-section', section: 'Verification' }],
            },
            {
              occurrence_id: 'O2',
              disposition: 'unresolved',
              evidence_refs: [],
            },
          ],
        },
      ],
    });
    const validate = new Ajv2019({ strict: false }).compile(canonical);
    expect(validate(normalized)).toBe(true);
  });
});
