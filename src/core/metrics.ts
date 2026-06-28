import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { schemaValidQuiet } from './schema.js';
import { isJsonObject, type JsonValue } from './json.js';

export interface CritiqueHealth {
  total: number;
  addressed: number;
  newIssues: number;
  invalid: number;
  unanchored: number;
  pct: number;
}

const EVIDENCE_FILE_LINE = /[\w./-]+\.[A-Za-z][\w-]*:\d+/;
const EVIDENCE_SECTION = /#{1,6}\s+\S/;
const ADDRESSES_REF = /^v([0-9]+)\.(C[0-9]+)$/;

export function isCritiqueDuplicateIssue(issue: JsonValue): boolean {
  if (!isJsonObject(issue)) {
    return false;
  }
  return issue.duplicate_of !== null && issue.duplicate_of !== undefined;
}

function evidenceIsAnchored(evidence: JsonValue | undefined): boolean {
  return (
    typeof evidence === 'string' &&
    (EVIDENCE_FILE_LINE.test(evidence) || EVIDENCE_SECTION.test(evidence))
  );
}

function toText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function loadIssues(filePath: string): JsonValue[] {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as JsonValue;
  return isJsonObject(parsed) && Array.isArray(parsed.issues) ? parsed.issues : [];
}

function parentRefIsValid(
  parentIter: number,
  parentId: string,
  iter: number,
  work: string,
  criticSchema: string,
): boolean {
  if (parentIter >= iter) {
    return false;
  }
  const parentFile = path.join(work, `critique.v${parentIter}.json`);
  if (!existsSync(parentFile) || statSync(parentFile).size === 0) {
    return false;
  }
  if (!schemaValidQuiet(parentFile, criticSchema)) {
    return false;
  }
  return loadIssues(parentFile).some((p) => isJsonObject(p) && p.id === parentId);
}

type IssueClass = 'new' | 'addressed' | 'invalid';

function classifyRef(ref: string, iter: number, work: string, criticSchema: string): IssueClass {
  if (!ref) {
    return 'new';
  }
  const match = ADDRESSES_REF.exec(ref);
  if (!match) {
    return 'invalid';
  }
  return parentRefIsValid(Number(match[1]), match[2] ?? '', iter, work, criticSchema)
    ? 'addressed'
    : 'invalid';
}

// Classify each issue's `addresses` reference: empty → new, vN.Cn pointing at
// a real issue in an earlier valid critique → addressed, anything else →
// invalid. pct is the integer percentage of valid-addressed issues.
export function critiqueHealth(
  work: string,
  criticSchema: string,
  iter: number,
  critiqueFile: string,
): CritiqueHealth {
  const issues = loadIssues(critiqueFile);
  let total = 0;
  let addressed = 0;
  let newIssues = 0;
  let invalid = 0;
  let unanchored = 0;

  for (const issue of issues) {
    if (isCritiqueDuplicateIssue(issue)) {
      continue;
    }
    const obj = isJsonObject(issue) ? issue : {};
    total += 1;
    if (!evidenceIsAnchored(obj.evidence)) {
      unanchored += 1;
    }
    if (!toText(obj.id)) {
      continue;
    }
    const ref = obj.addresses === false ? '' : toText(obj.addresses);
    const kind = classifyRef(ref, iter, work, criticSchema);
    if (kind === 'new') {
      newIssues += 1;
    } else if (kind === 'addressed') {
      addressed += 1;
    } else {
      invalid += 1;
    }
  }

  const pct = total > 0 ? Math.floor((addressed * 100) / total) : 100;
  return { total, addressed, newIssues, invalid, unanchored, pct };
}
