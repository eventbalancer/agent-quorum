import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import ajvModule from 'ajv/dist/2019.js';
import type { ValidateFunction } from 'ajv/dist/2019.js';
import { HaltError } from '../runtime/halt.js';
import { err, log } from '../runtime/log.js';
import { isJsonObject, type JsonObject, type JsonValue } from './json.js';

const Ajv2019 = ajvModule.default;

let ajv: InstanceType<typeof Ajv2019> | undefined;
const compiledSchemas = new Map<string, ValidateFunction>();
let ajvBinWarned = false;

// AGENT_QUORUM_AJV_BIN selected the validator binary in the reference; schema
// validation now runs in-process, so a set value is obsolete — warned once and
// ignored, never an error (Finding F8).
function warnObsoleteAjvBin(): void {
  if (ajvBinWarned) {
    return;
  }
  if (process.env.AGENT_QUORUM_AJV_BIN) {
    log(
      'WARNING: AGENT_QUORUM_AJV_BIN is ignored — schema validation runs in-process via the ajv npm package',
    );
    ajvBinWarned = true;
  }
}

function compiledSchema(schemaPath: string): ValidateFunction {
  let validate = compiledSchemas.get(schemaPath);
  if (validate !== undefined) {
    return validate;
  }
  ajv ??= new Ajv2019({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
  validate = ajv.compile(schema);
  compiledSchemas.set(schemaPath, validate);
  return validate;
}

export function validateSchema(file: string, schemaPath: string): boolean {
  warnObsoleteAjvBin();
  let data: JsonValue;
  try {
    data = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  } catch {
    err(`not valid JSON: ${file}`);
    return false;
  }
  let validate: ValidateFunction;
  try {
    validate = compiledSchema(schemaPath);
  } catch {
    err(`schema validation failed: ${file} vs ${schemaPath} (code=compile-failed)`);
    return false;
  }
  if (!validate(data)) {
    const violations = validate.errors?.length ?? 0;
    err(
      `schema validation failed: ${file} vs ${schemaPath} (code=invalid-data violations=${String(violations)})`,
    );
    return false;
  }
  return true;
}

export function schemaValidQuiet(file: string, schemaPath: string): boolean {
  let data: JsonValue;
  try {
    data = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  } catch {
    return false;
  }
  try {
    return compiledSchema(schemaPath)(data);
  } catch {
    return false;
  }
}

function writeJsonInPlace(file: string, value: JsonValue): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function checkExpectedVersion(
  name: string,
  expectedVersion: number | string | undefined,
): number | undefined {
  if (expectedVersion === undefined || expectedVersion === '') {
    return undefined;
  }
  if (!/^[0-9]+$/.test(String(expectedVersion))) {
    const message = `${name}: expected_version must be an integer: ${String(expectedVersion)}`;
    err(message);
    throw new HaltError(message, 1, true);
  }
  return Number(expectedVersion);
}

function sortedExtraKeys(value: JsonObject, known: readonly string[]): string[] {
  return Object.keys(value)
    .sort()
    .filter((key) => !known.includes(key));
}

const CRITIQUE_ISSUE_KEYS = [
  'id',
  'addresses',
  'severity',
  'category',
  'claim',
  'evidence',
  'suggested_fix',
  'confidence',
  'duplicate_of',
  'evidence_refs',
  'invariant_id',
  'introduced_by_revision',
];

const CRITIQUE_OPPORTUNITY_KEYS = [
  'fingerprint',
  'claim',
  'evidence',
  'suggested_improvement',
  'evidence_refs',
];

function canonicalPhaseId(value: string): string {
  const match = /^\s*(P[0-9]+)(?=\s|[-–—:]|$)/i.exec(value);
  return match?.[1]?.toUpperCase() ?? value;
}

function sanitizedEvidenceRef(value: JsonValue): JsonObject {
  const ref = isJsonObject(value) ? value : {};
  const kind = typeof ref.kind === 'string' ? ref.kind : null;
  const fallback = typeof ref.value === 'string' ? ref.value : undefined;
  const result: JsonObject = { kind };
  const keepFallback = (): void => {
    if (fallback !== undefined) {
      result.value = fallback;
    }
  };

  switch (kind) {
    case 'file-line':
      if (
        typeof ref.path === 'string' &&
        typeof ref.line === 'number' &&
        Number.isInteger(ref.line)
      ) {
        result.path = ref.path;
        result.line = ref.line;
      } else {
        keepFallback();
      }
      break;
    case 'plan-section':
      if (typeof ref.section === 'string') {
        result.section = ref.section;
      } else {
        keepFallback();
      }
      break;
    case 'phase-gate':
      if (typeof ref.phase === 'string' && typeof ref.gate === 'string') {
        result.phase = canonicalPhaseId(ref.phase);
        result.gate = ref.gate;
      } else {
        keepFallback();
      }
      break;
    case 'command':
      if (typeof ref.command === 'string') {
        result.command = ref.command;
      } else {
        keepFallback();
      }
      break;
    case 'repository':
      if (typeof ref.repository === 'string') {
        result.repository = ref.repository;
      } else {
        keepFallback();
      }
      break;
    case 'topology':
      if (typeof ref.topology_id === 'string') {
        result.topology_id = ref.topology_id;
      } else {
        keepFallback();
      }
      break;
    default:
      keepFallback();
  }
  return result;
}

function sanitizedEvidenceRefs(value: JsonValue | undefined): JsonValue {
  return Array.isArray(value) ? value.map(sanitizedEvidenceRef) : (value ?? null);
}

function sanitizedSystemicDispositions(value: JsonValue): JsonValue {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((entry) => {
    if (!isJsonObject(entry) || !('evidence_refs' in entry)) {
      return entry;
    }
    return {
      ...entry,
      evidence_refs: sanitizedEvidenceRefs(entry.evidence_refs),
    };
  });
}

function sanitizedCritiqueIssue(issue: JsonObject): JsonObject {
  return {
    ...('id' in issue ? { id: issue.id } : {}),
    ...('addresses' in issue ? { addresses: issue.addresses } : {}),
    ...('severity' in issue ? { severity: issue.severity } : {}),
    ...('category' in issue ? { category: issue.category } : {}),
    ...('claim' in issue ? { claim: issue.claim } : {}),
    ...('evidence' in issue ? { evidence: issue.evidence } : {}),
    ...('suggested_fix' in issue ? { suggested_fix: issue.suggested_fix } : {}),
    ...('confidence' in issue ? { confidence: issue.confidence } : {}),
    ...('duplicate_of' in issue ? { duplicate_of: issue.duplicate_of } : {}),
    ...('evidence_refs' in issue
      ? { evidence_refs: sanitizedEvidenceRefs(issue.evidence_refs) }
      : {}),
    ...('invariant_id' in issue ? { invariant_id: issue.invariant_id } : {}),
    ...('introduced_by_revision' in issue
      ? { introduced_by_revision: issue.introduced_by_revision }
      : {}),
  };
}

function sanitizedCritiqueOpportunity(opportunity: JsonObject): JsonObject {
  return {
    ...('fingerprint' in opportunity ? { fingerprint: opportunity.fingerprint } : {}),
    ...('claim' in opportunity ? { claim: opportunity.claim } : {}),
    ...('evidence' in opportunity ? { evidence: opportunity.evidence } : {}),
    ...('suggested_improvement' in opportunity
      ? { suggested_improvement: opportunity.suggested_improvement }
      : {}),
    ...('evidence_refs' in opportunity
      ? { evidence_refs: sanitizedEvidenceRefs(opportunity.evidence_refs) }
      : {}),
  };
}

export function sanitizeCritiqueJson(file: string, expectedVersion?: number | string): void {
  checkExpectedVersion('sanitize_critique_json', expectedVersion);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  const obj: JsonObject = isJsonObject(parsed) ? parsed : {};

  const extraCount = sortedExtraKeys(obj, [
    'plan_version',
    'summary',
    'issues',
    'review',
    'domain_assessments',
    'boundary_challenges',
    'opportunities',
  ]).length;
  if (extraCount > 0) {
    log(`WARNING: dropping unknown top-level fields from critique (count=${String(extraCount)})`);
  }

  const issues = Array.isArray(obj.issues) ? obj.issues : [];
  const issueObjects = issues.map((issue) => (isJsonObject(issue) ? issue : {}));

  const issueExtraCount = issueObjects.reduce(
    (count, issue) => count + sortedExtraKeys(issue, CRITIQUE_ISSUE_KEYS).length,
    0,
  );
  if (issueExtraCount > 0) {
    log(`WARNING: dropping unknown critique issue fields (count=${String(issueExtraCount)})`);
  }

  const suppliedOpportunities = Array.isArray(obj.opportunities) ? obj.opportunities : [];
  const opportunityObjects = suppliedOpportunities.map((opportunity) =>
    isJsonObject(opportunity) ? opportunity : {},
  );
  const opportunityExtraCount = opportunityObjects.reduce(
    (count, opportunity) => count + sortedExtraKeys(opportunity, CRITIQUE_OPPORTUNITY_KEYS).length,
    0,
  );
  if (opportunityExtraCount > 0) {
    log(
      `WARNING: dropping unknown critique opportunity fields (count=${String(opportunityExtraCount)})`,
    );
  }

  writeJsonInPlace(file, {
    ...('plan_version' in obj ? { plan_version: obj.plan_version } : {}),
    ...('summary' in obj ? { summary: obj.summary } : {}),
    ...('issues' in obj
      ? {
          issues: Array.isArray(obj.issues) ? issueObjects.map(sanitizedCritiqueIssue) : obj.issues,
        }
      : {}),
    ...('domain_assessments' in obj ? { domain_assessments: obj.domain_assessments } : {}),
    ...('boundary_challenges' in obj ? { boundary_challenges: obj.boundary_challenges } : {}),
    ...('opportunities' in obj
      ? {
          opportunities: Array.isArray(obj.opportunities)
            ? opportunityObjects.map(sanitizedCritiqueOpportunity)
            : obj.opportunities,
        }
      : {}),
    ...('review' in obj ? { review: obj.review } : {}),
  });
}

function sanitizedUpdateIssues(issues: JsonValue[]): JsonValue[] {
  return issues
    .map((issue) => (isJsonObject(issue) ? issue : {}))
    .map((issue) => ({
      ...('id' in issue ? { id: issue.id } : {}),
      ...('verdict' in issue ? { verdict: issue.verdict } : {}),
      ...('verdict_reason' in issue ? { verdict_reason: issue.verdict_reason } : {}),
      ...('final_severity' in issue ? { final_severity: issue.final_severity } : {}),
      ...('duplicate_of' in issue ? { duplicate_of: issue.duplicate_of } : {}),
    }));
}

function sanitizedRejectedAppend(entries: JsonValue): JsonValue {
  if (!Array.isArray(entries)) {
    return entries;
  }
  return entries
    .map((entry) => (isJsonObject(entry) ? entry : {}))
    .map((entry) => ({
      ...('id' in entry ? { id: entry.id } : {}),
      ...('claim' in entry ? { claim: entry.claim } : {}),
      ...('reason' in entry ? { reason: entry.reason } : {}),
    }));
}

export function sanitizeUpdateJson(file: string, expectedVersion?: number | string): void {
  checkExpectedVersion('sanitize_update_json', expectedVersion);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  const obj: JsonObject = isJsonObject(parsed) ? parsed : {};

  const extraCount = sortedExtraKeys(obj, [
    'plan_version',
    'plan_markdown',
    'issues',
    'applied',
    'rejected_append',
    'systemic_dispositions',
  ]).length;
  if (extraCount > 0) {
    log(`WARNING: dropping unknown top-level fields from update (count=${String(extraCount)})`);
  }

  writeJsonInPlace(file, {
    ...('plan_version' in obj ? { plan_version: obj.plan_version } : {}),
    ...('plan_markdown' in obj ? { plan_markdown: obj.plan_markdown } : {}),
    ...('issues' in obj
      ? {
          issues: Array.isArray(obj.issues) ? sanitizedUpdateIssues(obj.issues) : obj.issues,
        }
      : {}),
    ...('applied' in obj ? { applied: obj.applied } : {}),
    ...('rejected_append' in obj
      ? { rejected_append: sanitizedRejectedAppend(obj.rejected_append) }
      : {}),
    ...('systemic_dispositions' in obj
      ? { systemic_dispositions: sanitizedSystemicDispositions(obj.systemic_dispositions) }
      : {}),
  });
}

export function sanitizeUpdateMetaJson(file: string, expectedVersion?: number | string): void {
  checkExpectedVersion('sanitize_update_meta_json', expectedVersion);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  const obj: JsonObject = isJsonObject(parsed) ? parsed : {};

  const extraCount = sortedExtraKeys(obj, [
    'plan_version',
    'issues',
    'applied',
    'rejected_append',
    'systemic_dispositions',
  ]).length;
  if (extraCount > 0) {
    log(
      `WARNING: dropping unknown top-level fields from update metadata (count=${String(extraCount)})`,
    );
  }

  writeJsonInPlace(file, {
    ...('plan_version' in obj ? { plan_version: obj.plan_version } : {}),
    ...('issues' in obj
      ? {
          issues: Array.isArray(obj.issues) ? sanitizedUpdateIssues(obj.issues) : obj.issues,
        }
      : {}),
    ...('applied' in obj ? { applied: obj.applied } : {}),
    ...('rejected_append' in obj
      ? { rejected_append: sanitizedRejectedAppend(obj.rejected_append) }
      : {}),
    ...('systemic_dispositions' in obj
      ? { systemic_dispositions: sanitizedSystemicDispositions(obj.systemic_dispositions) }
      : {}),
  });
}

export function combineUpdateJson(metaFile: string, markdownFile: string, outFile: string): void {
  const parsed = JSON.parse(readFileSync(metaFile, 'utf8')) as JsonValue;
  const meta: JsonObject = isJsonObject(parsed) ? parsed : {};
  const combined = {
    plan_version: meta.plan_version ?? null,
    plan_markdown: readFileSync(markdownFile, 'utf8'),
    issues: meta.issues ?? null,
    applied: meta.applied ?? null,
    rejected_append: meta.rejected_append ?? null,
    ...('systemic_dispositions' in meta
      ? { systemic_dispositions: meta.systemic_dispositions }
      : {}),
  };
  writeFileSync(outFile, `${JSON.stringify(combined, null, 2)}\n`);
}
