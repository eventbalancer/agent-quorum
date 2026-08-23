import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ajvModule from 'ajv/dist/2019.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FrozenReadinessContractError,
  READINESS_CONTRACT_SCHEMA_VERSION,
  READINESS_PROOF_CATALOG_SEED_VERSION,
  RETAINED_CONTEXT_CATEGORIES,
  RISK_DOMAINS,
  ReadinessContractValidationError,
  applicableRiskDomains,
  buildReadinessContract,
  computeBoundaryDigest,
  computeContractDigest,
  computeReadinessProofCatalogSeedDigest,
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
const SOURCE_DIGEST = 'a'.repeat(64);
const SYSTEM_DIGEST = 'b'.repeat(64);

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
    sourceDigest: SOURCE_DIGEST,
    systemDigest: SYSTEM_DIGEST,
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

  it('rejects provider-controlled material-question identities without echoing them', () => {
    const secret = 'MATERIAL_QUESTION_ID_SECRET_437ab9';
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
    first.id = secret;

    let message = '';
    try {
      parseReadinessAssessment(invalidQuestion);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('material questions[0].id must use the Q<number> format');
    expect(message).not.toContain(secret);
  });
});

describe('frozen readiness contract', () => {
  it('derives appetite, stable digests, risk selectors, and Judge need', () => {
    const quick = build(assessment(), 'quick');
    const thorough = build(assessment(), 'thorough');

    expect(quick.schemaVersion).toBe(READINESS_CONTRACT_SCHEMA_VERSION);
    expect(quick.appetite).toEqual({
      quality: 'quick',
      iterationLimit: 8,
      issueBudget: 8,
      judgeAllowed: false,
      exhaustiveApplicableDomains: false,
    });
    expect(thorough.appetite.judgeAllowed).toBe(true);
    expect(thorough.appetite.exhaustiveApplicableDomains).toBe(true);
    const seedContent = {
      seedVersion: READINESS_PROOF_CATALOG_SEED_VERSION,
      riskDomains: [...RISK_DOMAINS],
      retainedContextCategories: [...RETAINED_CONTEXT_CATEGORIES],
    } as const;
    expect(quick.proofCatalogSeed).toEqual({
      ...seedContent,
      seedDigest: computeReadinessProofCatalogSeedDigest(seedContent),
    });
    expect(quick.proofCatalogSeed.seedDigest).toBe(
      '8ed637c3b8fd6203c825d66a4ff653295e4f4415fb57737f998c39a17052b7f9',
    );
    expect(quick.proofCatalogSeed).not.toHaveProperty('invariantIds');
    expect(quick.proofCatalogSeed).not.toHaveProperty('occurrenceIds');
    expect(quick.boundaryDigest).toBe(computeBoundaryDigest(quick.boundary));
    const content = {
      schemaVersion: quick.schemaVersion,
      sourceDigest: quick.sourceDigest,
      systemDigest: quick.systemDigest,
      proofCatalogSeed: quick.proofCatalogSeed,
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

  it.each([
    ['sourceDigest', 'A'.repeat(64), SYSTEM_DIGEST],
    ['systemDigest', SOURCE_DIGEST, 'b'.repeat(63)],
  ])('rejects malformed %s at direct construction', (label, sourceDigest, systemDigest) => {
    expect(() =>
      buildReadinessContract({
        assessment: assessment(),
        sourceDigest,
        systemDigest,
        quality: 'balanced',
        iterationLimit: 8,
        issueBudget: 8,
        operatorDecisionIds: [],
      }),
    ).toThrow(`${label} must be a lowercase 64-character SHA-256 digest`);
  });

  it.each([
    ['sourceDigest', (contract: JsonObject) => (contract.sourceDigest = 'A'.repeat(64))],
    ['systemDigest', (contract: JsonObject) => (contract.systemDigest = 'b'.repeat(63))],
    [
      'proofCatalogSeed.seedDigest',
      (contract: JsonObject) => {
        const seed = contract.proofCatalogSeed;
        if (!isJsonObject(seed)) {
          throw new TypeError('proof catalog seed fixture must be an object');
        }
        seed.seedDigest = 'not-a-digest';
      },
    ],
    ['boundaryDigest', (contract: JsonObject) => (contract.boundaryDigest = 'A'.repeat(64))],
    ['contractDigest', (contract: JsonObject) => (contract.contractDigest = 'f'.repeat(63))],
  ] as const)('rejects malformed persisted %s', (label, mutate) => {
    const contract = cloneObject(build());
    mutate(contract);

    expect(() => parseReadinessContract(contract)).toThrow(
      `${label} must be a lowercase 64-character SHA-256 digest`,
    );
  });

  it('produces the same digest for provider domain order and JSON property order changes', () => {
    const forward = assessment();
    const reversed = cloneObject(forward);
    if (!('domain_assessments' in reversed) || !Array.isArray(reversed.domain_assessments)) {
      throw new Error('fixture domain_assessments must be an array');
    }
    reversed.domain_assessments.reverse();

    const built = build(forward);
    expect(built.contractDigest).toBe(build(reversed).contractDigest);
    const reorderedProperties = Object.fromEntries(Object.entries(built).reverse());
    expect(parseReadinessContract(JSON.stringify(reorderedProperties))).toEqual(built);
  });

  it('rejects changed or reordered frozen proof-catalog seed identities', () => {
    const reordered = cloneObject(build());
    if (
      !('proofCatalogSeed' in reordered) ||
      !isJsonObject(reordered.proofCatalogSeed) ||
      !Array.isArray(reordered.proofCatalogSeed.riskDomains)
    ) {
      throw new Error('fixture proofCatalogSeed.riskDomains must be an array');
    }
    reordered.proofCatalogSeed.riskDomains.reverse();
    expect(() => parseReadinessContract(reordered)).toThrow(
      'proofCatalogSeed.riskDomains[0] must be correctness',
    );

    const tamperedDigest = cloneObject(build());
    if (!('proofCatalogSeed' in tamperedDigest) || !isJsonObject(tamperedDigest.proofCatalogSeed)) {
      throw new Error('fixture proofCatalogSeed must be an object');
    }
    tamperedDigest.proofCatalogSeed.seedDigest = 'f'.repeat(64);
    expect(() => parseReadinessContract(tamperedDigest)).toThrow(
      'proofCatalogSeed.seedDigest does not match the frozen seed',
    );
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

  it('strictly rejects a persisted schema-v1 contract before accepting current fields', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-readiness-invalid.'));
    roots.push(root);
    const file = path.join(root, 'readiness-contract.json');
    const legacy = cloneObject(build());
    legacy.schemaVersion = 1;
    delete legacy.proofCatalogSeed;
    writeFileSync(file, `${JSON.stringify(legacy)}\n`);

    expect(() => readReadinessContract(file)).toThrow(ReadinessContractValidationError);
    expect(() => readReadinessContract(file)).toThrow('readiness contract schemaVersion must be 2');
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

    const secretQuestion = cloneObject(valid);
    if (
      !('material_questions' in secretQuestion) ||
      !Array.isArray(secretQuestion.material_questions)
    ) {
      throw new Error('fixture material_questions must be an array');
    }
    const firstQuestion = secretQuestion.material_questions[0];
    if (
      typeof firstQuestion !== 'object' ||
      firstQuestion === null ||
      Array.isArray(firstQuestion)
    ) {
      throw new Error('fixture material question must be an object');
    }
    firstQuestion.id = 'MATERIAL_QUESTION_ID_SECRET_437ab9';
    expect(validate(secretQuestion)).toBe(false);

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
