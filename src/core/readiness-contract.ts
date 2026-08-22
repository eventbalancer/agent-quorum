import { createHash, randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isJsonObject, type JsonObject, type JsonValue } from './json.js';
import type { Quality, RiskApplicability, RiskDomain, RiskLevel } from '../types.js';

export const READINESS_CONTRACT_SCHEMA_VERSION = 1;
export const RISK_DOMAINS = [
  'correctness',
  'public-compatibility',
  'data-migrations',
  'security-privacy-authorization',
  'concurrency-distributed-ordering',
  'cross-repository-delivery',
  'production-operability',
  'performance-cost',
] as const satisfies readonly RiskDomain[];

export interface ReadinessBoundary {
  readonly goal: string;
  readonly inScope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly constraints: readonly string[];
}

export interface ReadinessAppetite {
  readonly quality: Quality;
  readonly iterationLimit: number;
  readonly issueBudget: number;
  readonly judgeAllowed: boolean;
  readonly exhaustiveApplicableDomains: boolean;
}

export interface ReadinessDomainAssessment {
  readonly domain: RiskDomain;
  readonly applicability: RiskApplicability;
  readonly risk: RiskLevel;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
}

export interface ReadinessMaterialQuestion {
  readonly id: string;
  readonly question: string;
  readonly rationale: string;
  readonly options: readonly string[];
}

export interface ReadinessAssessment {
  readonly boundary: ReadinessBoundary;
  readonly domainAssessments: readonly ReadinessDomainAssessment[];
  readonly unresolvedMaterialQuestions: readonly ReadinessMaterialQuestion[];
}

export interface ReadinessContract {
  readonly schemaVersion: 1;
  readonly sourceDigest: string;
  readonly systemDigest: string;
  readonly boundary: ReadinessBoundary;
  readonly appetite: ReadinessAppetite;
  readonly domainAssessments: readonly ReadinessDomainAssessment[];
  readonly unresolvedMaterialQuestions: readonly ReadinessMaterialQuestion[];
  readonly operatorDecisionIds: readonly string[];
  readonly boundaryDigest: string;
  readonly contractDigest: string;
}

export interface BuildReadinessContractInput {
  readonly assessment: string | JsonValue;
  readonly sourceDigest: string;
  readonly systemDigest: string;
  readonly quality: Quality;
  readonly iterationLimit: number;
  readonly issueBudget: number;
  readonly operatorDecisionIds: readonly string[];
}

export type FrozenReadinessContractWrite = 'written' | 'unchanged';

export class ReadinessContractValidationError extends Error {
  override name = 'ReadinessContractValidationError';
}

export class FrozenReadinessContractError extends Error {
  override name = 'FrozenReadinessContractError';
}

const CONTRACT_KEYS = [
  'schemaVersion',
  'sourceDigest',
  'systemDigest',
  'boundary',
  'appetite',
  'domainAssessments',
  'unresolvedMaterialQuestions',
  'operatorDecisionIds',
  'boundaryDigest',
  'contractDigest',
] as const;

function invalid(message: string): never {
  throw new ReadinessContractValidationError(message);
}

function parseJson(value: string | JsonValue, label: string): JsonValue {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return invalid(`${label} is not valid JSON`);
  }
}

function exactObject(
  value: JsonValue | undefined,
  keys: readonly string[],
  label: string,
): JsonObject {
  if (!isJsonObject(value)) {
    return invalid(`${label} must be an object`);
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      invalid(`${label} contains unknown property ${key}`);
    }
  }
  for (const key of keys) {
    if (!(key in value)) {
      invalid(`${label} is missing property ${key}`);
    }
  }
  return value;
}

function nonBlankString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return invalid(`${label} must be a non-blank string`);
  }
  return value;
}

function uniqueStrings(
  value: JsonValue | undefined,
  label: string,
  minimum = 0,
  maximum?: number,
): string[] {
  if (!Array.isArray(value) || value.length < minimum) {
    return invalid(`${label} must contain at least ${minimum} string entries`);
  }
  if (maximum !== undefined && value.length > maximum) {
    return invalid(`${label} must contain at most ${maximum} string entries`);
  }
  const result = value.map((entry, index) => nonBlankString(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) {
    return invalid(`${label} must not contain duplicate entries`);
  }
  return result;
}

function integerAtLeast(value: JsonValue | undefined, minimum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    return invalid(`${label} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function parseQuality(value: JsonValue | undefined, label: string): Quality {
  if (value !== 'quick' && value !== 'balanced' && value !== 'thorough') {
    return invalid(`${label} must be quick, balanced, or thorough`);
  }
  return value;
}

function parseDomain(value: JsonValue | undefined, label: string): RiskDomain {
  if (typeof value !== 'string' || !(RISK_DOMAINS as readonly string[]).includes(value)) {
    return invalid(`${label} is not a recognized risk domain`);
  }
  return value as RiskDomain;
}

function parseApplicability(value: JsonValue | undefined, label: string): RiskApplicability {
  if (value !== 'applicable' && value !== 'not-applicable' && value !== 'unknown') {
    return invalid(`${label} must be applicable, not-applicable, or unknown`);
  }
  return value;
}

function parseRisk(value: JsonValue | undefined, label: string): RiskLevel {
  if (value !== 'standard' && value !== 'high') {
    return invalid(`${label} must be standard or high`);
  }
  return value;
}

function validateDomainSet(assessments: readonly ReadinessDomainAssessment[], label: string): void {
  const seen = new Set<RiskDomain>();
  for (const assessment of assessments) {
    if (seen.has(assessment.domain)) {
      invalid(`${label} contains duplicate domain ${assessment.domain}`);
    }
    seen.add(assessment.domain);
  }
  for (const domain of RISK_DOMAINS) {
    if (!seen.has(domain)) {
      invalid(`${label} is missing domain ${domain}`);
    }
  }
}

function parseBoundary(value: JsonValue | undefined, snakeCase: boolean): ReadinessBoundary {
  const label = 'boundary';
  const inScopeKey = snakeCase ? 'in_scope' : 'inScope';
  const outOfScopeKey = snakeCase ? 'out_of_scope' : 'outOfScope';
  const object = exactObject(value, ['goal', inScopeKey, outOfScopeKey, 'constraints'], label);
  return {
    goal: nonBlankString(object.goal, `${label}.goal`),
    inScope: uniqueStrings(object[inScopeKey], `${label}.${inScopeKey}`),
    outOfScope: uniqueStrings(object[outOfScopeKey], `${label}.${outOfScopeKey}`),
    constraints: uniqueStrings(object.constraints, `${label}.constraints`),
  };
}

function parseDomainAssessment(
  value: JsonValue,
  index: number,
  snakeCase: boolean,
): ReadinessDomainAssessment {
  const label = `domain assessments[${index}]`;
  const evidenceKey = snakeCase ? 'evidence_refs' : 'evidenceRefs';
  const object = exactObject(
    value,
    ['domain', 'applicability', 'risk', 'rationale', evidenceKey],
    label,
  );
  return {
    domain: parseDomain(object.domain, `${label}.domain`),
    applicability: parseApplicability(object.applicability, `${label}.applicability`),
    risk: parseRisk(object.risk, `${label}.risk`),
    rationale: nonBlankString(object.rationale, `${label}.rationale`),
    evidenceRefs: uniqueStrings(object[evidenceKey], `${label}.${evidenceKey}`),
  };
}

function parseDomainAssessments(
  value: JsonValue | undefined,
  label: string,
  snakeCase: boolean,
): ReadinessDomainAssessment[] {
  if (!Array.isArray(value) || value.length !== RISK_DOMAINS.length) {
    return invalid(`${label} must contain exactly ${RISK_DOMAINS.length} entries`);
  }
  const assessments = value.map((entry, index) => parseDomainAssessment(entry, index, snakeCase));
  validateDomainSet(assessments, label);
  return assessments;
}

function parseMaterialQuestion(value: JsonValue, index: number): ReadinessMaterialQuestion {
  const label = `material questions[${index}]`;
  const object = exactObject(value, ['id', 'question', 'rationale', 'options'], label);
  return {
    id: nonBlankString(object.id, `${label}.id`),
    question: nonBlankString(object.question, `${label}.question`),
    rationale: nonBlankString(object.rationale, `${label}.rationale`),
    options: uniqueStrings(object.options, `${label}.options`, 2, 6),
  };
}

function parseMaterialQuestions(
  value: JsonValue | undefined,
  label: string,
): ReadinessMaterialQuestion[] {
  if (!Array.isArray(value)) {
    return invalid(`${label} must be an array`);
  }
  const questions = value.map(parseMaterialQuestion);
  const ids = questions.map((question) => question.id);
  if (new Set(ids).size !== ids.length) {
    invalid(`${label} must not contain duplicate ids`);
  }
  return questions;
}

export function parseReadinessAssessment(value: string | JsonValue): ReadinessAssessment {
  const root = exactObject(
    parseJson(value, 'readiness assessment'),
    ['boundary', 'domain_assessments', 'material_questions'],
    'readiness assessment',
  );
  const assessments = parseDomainAssessments(root.domain_assessments, 'domain_assessments', true);
  const ordered = RISK_DOMAINS.map((domain) => {
    const assessment = assessments.find((entry) => entry.domain === domain);
    if (assessment === undefined) {
      return invalid(`domain_assessments is missing domain ${domain}`);
    }
    return assessment;
  });
  return {
    boundary: parseBoundary(root.boundary, true),
    domainAssessments: ordered,
    unresolvedMaterialQuestions: parseMaterialQuestions(
      root.material_questions,
      'material_questions',
    ),
  };
}

function parseAppetite(value: JsonValue | undefined): ReadinessAppetite {
  const object = exactObject(
    value,
    ['quality', 'iterationLimit', 'issueBudget', 'judgeAllowed', 'exhaustiveApplicableDomains'],
    'appetite',
  );
  const quality = parseQuality(object.quality, 'appetite.quality');
  const judgeAllowed = quality !== 'quick';
  const exhaustiveApplicableDomains = quality === 'thorough';
  if (object.judgeAllowed !== judgeAllowed) {
    invalid(`appetite.judgeAllowed must be ${String(judgeAllowed)} for ${quality}`);
  }
  if (object.exhaustiveApplicableDomains !== exhaustiveApplicableDomains) {
    invalid(
      `appetite.exhaustiveApplicableDomains must be ${String(exhaustiveApplicableDomains)} for ${quality}`,
    );
  }
  return {
    quality,
    iterationLimit: integerAtLeast(object.iterationLimit, 1, 'appetite.iterationLimit'),
    issueBudget: integerAtLeast(object.issueBudget, 0, 'appetite.issueBudget'),
    judgeAllowed,
    exhaustiveApplicableDomains,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return invalid('readiness contract contains a non-JSON value');
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function computeBoundaryDigest(boundary: ReadinessBoundary): string {
  return sha256(boundary);
}

type ReadinessContractContent = Omit<ReadinessContract, 'contractDigest'>;

export function computeContractDigest(contract: ReadinessContractContent): string {
  return sha256(contract);
}

function contractContent(contract: ReadinessContract): ReadinessContractContent {
  return {
    schemaVersion: contract.schemaVersion,
    sourceDigest: contract.sourceDigest,
    systemDigest: contract.systemDigest,
    boundary: contract.boundary,
    appetite: contract.appetite,
    domainAssessments: contract.domainAssessments,
    unresolvedMaterialQuestions: contract.unresolvedMaterialQuestions,
    operatorDecisionIds: contract.operatorDecisionIds,
    boundaryDigest: contract.boundaryDigest,
  };
}

export function buildReadinessContract(input: BuildReadinessContractInput): ReadinessContract {
  const assessment = parseReadinessAssessment(input.assessment);
  const quality = parseQuality(input.quality, 'quality');
  const sourceDigest = nonBlankString(input.sourceDigest, 'sourceDigest');
  const systemDigest = nonBlankString(input.systemDigest, 'systemDigest');
  const iterationLimit = integerAtLeast(input.iterationLimit, 1, 'iterationLimit');
  const issueBudget = integerAtLeast(input.issueBudget, 0, 'issueBudget');
  const operatorDecisionIds = uniqueStrings([...input.operatorDecisionIds], 'operatorDecisionIds');
  const appetite: ReadinessAppetite = {
    quality,
    iterationLimit,
    issueBudget,
    judgeAllowed: quality !== 'quick',
    exhaustiveApplicableDomains: quality === 'thorough',
  };
  const boundaryDigest = computeBoundaryDigest(assessment.boundary);
  const content: ReadinessContractContent = {
    schemaVersion: READINESS_CONTRACT_SCHEMA_VERSION,
    sourceDigest,
    systemDigest,
    boundary: assessment.boundary,
    appetite,
    domainAssessments: assessment.domainAssessments,
    unresolvedMaterialQuestions: assessment.unresolvedMaterialQuestions,
    operatorDecisionIds,
    boundaryDigest,
  };
  return { ...content, contractDigest: computeContractDigest(content) };
}

export function parseReadinessContract(value: string | JsonValue): ReadinessContract {
  const root = exactObject(
    parseJson(value, 'readiness contract'),
    CONTRACT_KEYS,
    'readiness contract',
  );
  if (root.schemaVersion !== READINESS_CONTRACT_SCHEMA_VERSION) {
    invalid(`readiness contract schemaVersion must be ${READINESS_CONTRACT_SCHEMA_VERSION}`);
  }
  const contract: ReadinessContract = {
    schemaVersion: READINESS_CONTRACT_SCHEMA_VERSION,
    sourceDigest: nonBlankString(root.sourceDigest, 'sourceDigest'),
    systemDigest: nonBlankString(root.systemDigest, 'systemDigest'),
    boundary: parseBoundary(root.boundary, false),
    appetite: parseAppetite(root.appetite),
    domainAssessments: parseDomainAssessments(root.domainAssessments, 'domainAssessments', false),
    unresolvedMaterialQuestions: parseMaterialQuestions(
      root.unresolvedMaterialQuestions,
      'unresolvedMaterialQuestions',
    ),
    operatorDecisionIds: uniqueStrings(root.operatorDecisionIds, 'operatorDecisionIds'),
    boundaryDigest: nonBlankString(root.boundaryDigest, 'boundaryDigest'),
    contractDigest: nonBlankString(root.contractDigest, 'contractDigest'),
  };
  if (contract.boundaryDigest !== computeBoundaryDigest(contract.boundary)) {
    invalid('boundaryDigest does not match boundary');
  }
  if (contract.contractDigest !== computeContractDigest(contractContent(contract))) {
    invalid('contractDigest does not match readiness contract contents');
  }
  return contract;
}

export function readReadinessContract(file: string): ReadinessContract {
  return parseReadinessContract(readFileSync(file, 'utf8'));
}

function serializeContract(contract: ReadinessContract): string {
  return `${JSON.stringify(contract, null, 2)}\n`;
}

function sameFrozenContract(
  file: string,
  expected: ReadinessContract,
  expectedBytes: string,
): boolean {
  const existingBytes = readFileSync(file, 'utf8');
  if (existingBytes === expectedBytes) {
    return true;
  }
  try {
    return readReadinessContract(file).contractDigest === expected.contractDigest;
  } catch (error) {
    throw new FrozenReadinessContractError(
      `existing readiness contract is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export function writeFrozenReadinessContract(
  file: string,
  contract: ReadinessContract,
): FrozenReadinessContractWrite {
  const validated = parseReadinessContract(serializeContract(contract));
  const serialized = serializeContract(validated);
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    if (sameFrozenContract(file, validated, serialized)) {
      return 'unchanged';
    }
    throw new FrozenReadinessContractError('readiness contract is frozen and cannot be changed');
  }

  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temporary, serialized, { flag: 'wx' });
  try {
    linkSync(temporary, file);
    return 'written';
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      if (sameFrozenContract(file, validated, serialized)) {
        return 'unchanged';
      }
      throw new FrozenReadinessContractError('readiness contract is frozen and cannot be changed');
    }
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function applicableRiskDomains(contract: ReadinessContract): RiskDomain[] {
  return contract.domainAssessments
    .filter((assessment) => assessment.applicability === 'applicable')
    .map((assessment) => assessment.domain);
}

export function highRiskDomains(contract: ReadinessContract): RiskDomain[] {
  return contract.domainAssessments
    .filter((assessment) => assessment.applicability === 'applicable' && assessment.risk === 'high')
    .map((assessment) => assessment.domain);
}

export function requiresReadinessJudge(contract: ReadinessContract): boolean {
  return highRiskDomains(contract).length > 0;
}
