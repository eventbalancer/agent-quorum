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

function readSchema(): JsonObject {
  const parsed = JSON.parse(readFileSync(CRITIC_SCHEMA, 'utf8')) as JsonValue;
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
  it('requires every object property while making canonical optional fields nullable', () => {
    const projected = projectCodexJsonSchema(readSchema());

    expect(projected.changed).toBe(true);
    expectEveryPropertyRequired(projected.schema);
    const review = (projected.schema.properties as JsonObject).review;
    expect(isJsonObject(review) ? review.type : undefined).toEqual(['object', 'null']);
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
      review: null,
      issues: [
        {
          id: 'C1',
          addresses: null,
          severity: 'minor',
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
      issues: [
        {
          id: 'C1',
          addresses: null,
          severity: 'minor',
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
});
