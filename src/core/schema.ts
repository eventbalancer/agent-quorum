import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import ajvModule from 'ajv/dist/2019.js';
import type { ValidateFunction } from 'ajv/dist/2019.js';
import { HaltError } from '../runtime/halt.js';
import { err, log } from '../runtime/log.js';
import { isJsonObject, jqAlt, type JsonObject, type JsonValue } from './json.js';

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
  } catch (error) {
    err(`schema validation failed: ${file} vs ${schemaPath}`);
    const message = error instanceof Error ? error.message : String(error);
    for (const line of message.split('\n')) {
      process.stderr.write(`    ${line}\n`);
    }
    return false;
  }
  if (!validate(data)) {
    err(`schema validation failed: ${file} vs ${schemaPath}`);
    const detail = JSON.stringify(validate.errors, null, 2);
    for (const line of detail.split('\n')) {
      process.stderr.write(`    ${line}\n`);
    }
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
];

export function sanitizeCritiqueJson(file: string, expectedVersion?: number | string): void {
  const expected = checkExpectedVersion('sanitize_critique_json', expectedVersion);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  const obj: JsonObject = isJsonObject(parsed) ? parsed : {};

  const extras = sortedExtraKeys(obj, ['plan_version', 'summary', 'issues']).join(',');
  if (extras) {
    log(`WARNING: dropping unknown top-level fields from critique: ${extras}`);
  }

  const issues = Array.isArray(obj.issues) ? obj.issues : [];
  const issueObjects = issues.map((issue) => (isJsonObject(issue) ? issue : {}));

  const issueExtras = [
    ...new Set(
      issueObjects
        .map((issue) => sortedExtraKeys(issue, CRITIQUE_ISSUE_KEYS).join(','))
        .filter((joined) => joined.length > 0),
    ),
  ]
    .sort()
    .join(';');
  if (issueExtras) {
    log(`WARNING: dropping unknown critique issue fields: ${issueExtras}`);
  }

  const prefixedIds = issueObjects.filter(
    (issue) => typeof issue.id === 'string' && /^v[0-9]+\.C[0-9]+$/.test(issue.id),
  ).length;
  if (prefixedIds > 0) {
    log(
      `WARNING: normalizing ${prefixedIds} critique issue id(s) with a version prefix (vN.Cn -> Cn)`,
    );
  }

  const pv: JsonValue = expected ?? obj.plan_version ?? null;
  writeJsonInPlace(file, {
    plan_version: pv,
    summary: jqAlt(obj.summary, ''),
    issues: issueObjects.map((issue) => ({
      id: typeof issue.id === 'string' ? issue.id.replace(/^v[0-9]+\./, '') : (issue.id ?? null),
      addresses: 'addresses' in issue ? issue.addresses : null,
      severity: issue.severity ?? null,
      category: issue.category ?? null,
      claim: issue.claim ?? null,
      evidence: issue.evidence ?? null,
      suggested_fix: issue.suggested_fix ?? null,
      confidence: 'confidence' in issue ? issue.confidence : null,
      duplicate_of: 'duplicate_of' in issue ? issue.duplicate_of : null,
    })),
  });
}

function sanitizedUpdateIssues(issues: JsonValue[]): JsonValue[] {
  return issues
    .map((issue) => (isJsonObject(issue) ? issue : {}))
    .map((issue) => ({
      id: issue.id ?? null,
      verdict: issue.verdict ?? null,
      verdict_reason: jqAlt(issue.verdict_reason, ''),
      final_severity: issue.final_severity ?? null,
      duplicate_of: 'duplicate_of' in issue ? issue.duplicate_of : null,
    }));
}

function sanitizedRejectedAppend(entries: JsonValue): JsonValue {
  const list = jqAlt(entries, []);
  if (!Array.isArray(list)) {
    return list;
  }
  return list
    .map((entry) => (isJsonObject(entry) ? entry : {}))
    .map((entry) => ({
      id: entry.id ?? null,
      claim: entry.claim ?? null,
      reason: entry.reason ?? null,
    }));
}

export function sanitizeUpdateJson(file: string, expectedVersion?: number | string): void {
  const expected = checkExpectedVersion('sanitize_update_json', expectedVersion);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  const obj: JsonObject = isJsonObject(parsed) ? parsed : {};

  const extras = sortedExtraKeys(obj, [
    'plan_version',
    'plan_markdown',
    'issues',
    'applied',
    'rejected_append',
  ]).join(',');
  if (extras) {
    log(`WARNING: dropping unknown top-level fields from update: ${extras}`);
  }

  const pv: JsonValue = expected ?? obj.plan_version ?? null;
  const issues = jqAlt(obj.issues, []);
  writeJsonInPlace(file, {
    plan_version: pv,
    plan_markdown: obj.plan_markdown ?? null,
    issues: Array.isArray(issues) ? sanitizedUpdateIssues(issues) : issues,
    applied: jqAlt(obj.applied, []),
    rejected_append: sanitizedRejectedAppend(obj.rejected_append ?? null),
  });
}

export function sanitizeUpdateMetaJson(file: string, expectedVersion?: number | string): void {
  const expected = checkExpectedVersion('sanitize_update_meta_json', expectedVersion);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  const obj: JsonObject = isJsonObject(parsed) ? parsed : {};

  const extras = sortedExtraKeys(obj, [
    'plan_version',
    'issues',
    'applied',
    'rejected_append',
  ]).join(',');
  if (extras) {
    log(`WARNING: dropping unknown top-level fields from update metadata: ${extras}`);
  }

  const pv: JsonValue = expected ?? obj.plan_version ?? null;
  const issues = jqAlt(obj.issues, []);
  writeJsonInPlace(file, {
    plan_version: pv,
    issues: Array.isArray(issues) ? sanitizedUpdateIssues(issues) : issues,
    applied: jqAlt(obj.applied, []),
    rejected_append: sanitizedRejectedAppend(obj.rejected_append ?? null),
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
  };
  writeFileSync(outFile, `${JSON.stringify(combined, null, 2)}\n`);
}
