import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ajvModule from 'ajv/dist/2019.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FrozenReadinessContractError,
  RISK_DOMAINS,
  ReadinessContractValidationError,
  applicableRiskDomains,
  buildReadinessContract,
  computeBoundaryDigest,
  computeContractDigest,
  highRiskDomains,
  parseReadinessAssessment,
  parseReadinessContract,
  readReadinessContract,
  requiresReadinessJudge,
  writeFrozenReadinessContract,
  type ReadinessContract,
} from '../../src/core/readiness-contract.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../src/core/json.js';
import { REPO_ROOT } from '../helpers/harness.js';

const Ajv2019 = ajvModule.default;
const roots: string[] = [];

function assessment(): JsonObject {
  return {
    boundary: {
      goal: 'Make the planning decision bounded and evidence-based.',
      in_scope: ['planning loop'],
      out_of_scope: ['provider implementation'],
      constraints: ['preserve the public API'],
    },
    domain_assessments: RISK_DOMAINS.map((domain, index) => ({
      domain,
      applicability: index === 4 ? 'not-applicable' : 'applicable',
      risk: index === 3 || index === 4 ? 'high' : 'standard',
      rationale: `Assessment for ${domain}.`,
      evidence_refs: [`file-line:src/example.ts:${index + 1}`],
    })),
    material_questions: [
      {
        id: 'Q1',
        question: 'Which compatibility boundary should apply?',
        rationale: 'The answer changes the frozen scope.',
        options: ['Preserve all callers', 'Allow an additive migration'],
      },
    ],
  };
}

function build(
  raw: JsonValue = assessment(),
  quality: 'quick' | 'balanced' | 'thorough' = 'balanced',
): ReadinessContract {
  return buildReadinessContract({
    assessment: raw,
    sourceDigest: 'source-digest',
    systemDigest: 'system-digest',
    quality,
    iterationLimit: 8,
    issueBudget: 8,
    operatorDecisionIds: ['operator-Q1'],
  });
}

function cloneObject(value: unknown): JsonObject {
  const cloned = JSON.parse(JSON.stringify(value)) as JsonValue;
  if (!isJsonObject(cloned)) {
    throw new Error('cloned fixture must be an object');
  }
  return cloned;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('readiness assessment contract', () => {
  it('strictly converts snake_case provider output and orders all eight domains', () => {
    const raw = assessment();
    const domains = raw.domain_assessments;
    if (!Array.isArray(domains)) {
      throw new Error('fixture domain_assessments must be an array');
    }
    domains.reverse();

    const parsed = parseReadinessAssessment(raw);

    expect(parsed.boundary.inScope).toEqual(['planning loop']);
    expect(parsed.domainAssessments.map((entry) => entry.domain)).toEqual(RISK_DOMAINS);
    expect(parsed.unresolvedMaterialQuestions).toEqual([
      {
        id: 'Q1',
        question: 'Which compatibility boundary should apply?',
        rationale: 'The answer changes the frozen scope.',
        options: ['Preserve all callers', 'Allow an additive migration'],
      },
    ]);
  });

  it('rejects missing, duplicate, and unknown domain assessments', () => {
    const missing = cloneObject(assessment());
    if (!('domain_assessments' in missing) || !Array.isArray(missing.domain_assessments)) {
      throw new Error('fixture domain_assessments must be an array');
    }
    missing.domain_assessments.pop();
    expect(() => parseReadinessAssessment(missing)).toThrow(
      'domain_assessments must contain exactly 8 entries',
    );

    const duplicate = cloneObject(assessment());
    if (!('domain_assessments' in duplicate) || !Array.isArray(duplicate.domain_assessments)) {
      throw new Error('fixture domain_assessments must be an array');
    }
    duplicate.domain_assessments[7] = duplicate.domain_assessments[0] ?? null;
    expect(() => parseReadinessAssessment(duplicate)).toThrow('contains duplicate domain');

    const unknown = cloneObject(assessment());
    if (!('domain_assessments' in unknown) || !Array.isArray(unknown.domain_assessments)) {
      throw new Error('fixture domain_assessments must be an array');
    }
    const first = unknown.domain_assessments[0];
    if (typeof first !== 'object' || first === null || Array.isArray(first)) {
      throw new Error('fixture domain assessment must be an object');
    }
    first.domain = 'availability';
    expect(() => parseReadinessAssessment(unknown)).toThrow('not a recognized risk domain');
  });

  it('rejects extra fields and material questions without reusable options', () => {
    const extra = assessment();
    extra.summary = 'not part of the contract';
    expect(() => parseReadinessAssessment(extra)).toThrow('unknown property summary');

    const invalidQuestion = cloneObject(assessment());
    if (
      !('material_questions' in invalidQuestion) ||
      !Array.isArray(invalidQuestion.material_questions)
    ) {
      throw new Error('fixture material_questions must be an array');
    }
    const first = invalidQuestion.material_questions[0];
    if (typeof first !== 'object' || first === null || Array.isArray(first)) {
      throw new Error('fixture material question must be an object');
    }
    first.options = ['Only one'];
    expect(() => parseReadinessAssessment(invalidQuestion)).toThrow(
      'options must contain at least 2 string entries',
    );
  });
});

describe('frozen readiness contract', () => {
  it('derives appetite, stable digests, risk selectors, and Judge need', () => {
    const quick = build(assessment(), 'quick');
    const thorough = build(assessment(), 'thorough');

    expect(quick.appetite).toEqual({
      quality: 'quick',
      iterationLimit: 8,
      issueBudget: 8,
      judgeAllowed: false,
      exhaustiveApplicableDomains: false,
    });
    expect(thorough.appetite.judgeAllowed).toBe(true);
    expect(thorough.appetite.exhaustiveApplicableDomains).toBe(true);
    expect(quick.boundaryDigest).toBe(computeBoundaryDigest(quick.boundary));
    const content = {
      schemaVersion: quick.schemaVersion,
      sourceDigest: quick.sourceDigest,
      systemDigest: quick.systemDigest,
      boundary: quick.boundary,
      appetite: quick.appetite,
      domainAssessments: quick.domainAssessments,
      unresolvedMaterialQuestions: quick.unresolvedMaterialQuestions,
      operatorDecisionIds: quick.operatorDecisionIds,
      boundaryDigest: quick.boundaryDigest,
    };
    expect(quick.contractDigest).toBe(computeContractDigest(content));
    expect(parseReadinessContract(JSON.stringify(quick))).toEqual(quick);
    expect(applicableRiskDomains(quick)).not.toContain('concurrency-distributed-ordering');
    expect(highRiskDomains(quick)).toEqual(['security-privacy-authorization']);
    expect(requiresReadinessJudge(quick)).toBe(true);
  });

  it('produces the same digest for provider domain order and JSON property order changes', () => {
    const forward = assessment();
    const reversed = cloneObject(forward);
    if (!('domain_assessments' in reversed) || !Array.isArray(reversed.domain_assessments)) {
      throw new Error('fixture domain_assessments must be an array');
    }
    reversed.domain_assessments.reverse();

    expect(build(forward).contractDigest).toBe(build(reversed).contractDigest);
  });

  it('rejects tampered content and quality-inconsistent appetite flags', () => {
    const tampered = cloneObject(build());
    if (
      !('boundary' in tampered) ||
      typeof tampered.boundary !== 'object' ||
      tampered.boundary === null ||
      Array.isArray(tampered.boundary)
    ) {
      throw new Error('fixture boundary must be an object');
    }
    tampered.boundary.goal = 'Changed after freezing.';
    expect(() => parseReadinessContract(tampered)).toThrow('boundaryDigest does not match');

    const invalidAppetite = cloneObject(build());
    if (
      !('appetite' in invalidAppetite) ||
      typeof invalidAppetite.appetite !== 'object' ||
      invalidAppetite.appetite === null ||
      Array.isArray(invalidAppetite.appetite)
    ) {
      throw new Error('fixture appetite must be an object');
    }
    invalidAppetite.appetite.judgeAllowed = false;
    expect(() => parseReadinessContract(invalidAppetite)).toThrow(
      'appetite.judgeAllowed must be true for balanced',
    );
  });

  it('atomically writes once, accepts identical semantics, and rejects a changed contract', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-readiness.'));
    roots.push(root);
    const file = path.join(root, 'nested', 'readiness-contract.json');
    const original = build();

    expect(writeFrozenReadinessContract(file, original)).toBe('written');
    expect(writeFrozenReadinessContract(file, original)).toBe('unchanged');

    writeFileSync(file, JSON.stringify(original));
    expect(writeFrozenReadinessContract(file, original)).toBe('unchanged');

    const changedAssessment = assessment();
    if (
      typeof changedAssessment.boundary !== 'object' ||
      changedAssessment.boundary === null ||
      Array.isArray(changedAssessment.boundary)
    ) {
      throw new Error('fixture boundary must be an object');
    }
    changedAssessment.boundary.goal = 'A materially changed goal.';
    const changed = build(changedAssessment);
    expect(() => writeFrozenReadinessContract(file, changed)).toThrow(FrozenReadinessContractError);
    expect(readReadinessContract(file)).toEqual(original);
  });

  it('throws a strict validation error when a persisted contract is malformed', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-readiness-invalid.'));
    roots.push(root);
    const file = path.join(root, 'readiness-contract.json');
    writeFileSync(file, '{"schemaVersion":1}\n');

    expect(() => readReadinessContract(file)).toThrow(ReadinessContractValidationError);
  });
});

describe('readiness assessment provider schema', () => {
  it('accepts the exact vocabulary and rejects duplicate or missing domains', () => {
    const schemaFile = path.join(
      REPO_ROOT,
      'skills',
      'plan-creator',
      'readiness-contract.schema.json',
    );
    const schema = JSON.parse(readFileSync(schemaFile, 'utf8')) as object;
    const validate = new Ajv2019({ strict: true }).compile(schema);
    const valid = assessment();
    expect(validate(valid)).toBe(true);

    const duplicate = cloneObject(valid);
    if (!('domain_assessments' in duplicate) || !Array.isArray(duplicate.domain_assessments)) {
      throw new Error('fixture domain_assessments must be an array');
    }
    duplicate.domain_assessments[7] = duplicate.domain_assessments[0] ?? null;
    expect(validate(duplicate)).toBe(false);

    const missing = cloneObject(valid);
    if (!('domain_assessments' in missing) || !Array.isArray(missing.domain_assessments)) {
      throw new Error('fixture domain_assessments must be an array');
    }
    missing.domain_assessments.pop();
    expect(validate(missing)).toBe(false);
  });

  it('keeps Assessment Mode instructions synchronized with the schema vocabulary', () => {
    const skill = readFileSync(path.join(REPO_ROOT, 'skills', 'plan-creator', 'SKILL.md'), 'utf8');
    expect(skill).toContain('## Assessment Mode');
    for (const domain of RISK_DOMAINS) {
      expect(skill).toContain(`\`${domain}\``);
    }
    for (const token of ['applicable', 'not-applicable', 'unknown', 'standard', 'high']) {
      expect(skill).toContain(`\`${token}\``);
    }
    expect(skill).toContain('all eight domains exactly once');
  });
});
