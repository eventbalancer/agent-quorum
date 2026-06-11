import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { schemaValidQuiet } from './schema.js';
import { isJsonObject, type JsonValue } from './json.js';

export interface CritiqueHealth {
  total: number;
  addressed: number;
  newIssues: number;
  invalid: number;
  pct: number;
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
  const parsed = JSON.parse(readFileSync(critiqueFile, 'utf8')) as JsonValue;
  const issues = isJsonObject(parsed) && Array.isArray(parsed.issues) ? parsed.issues : [];
  const total = issues.length;
  let addressed = 0;
  let newIssues = 0;
  let invalid = 0;

  for (const issue of issues) {
    const obj = isJsonObject(issue) ? issue : {};
    const id = obj.id;
    const idText =
      id === null || id === undefined ? '' : typeof id === 'string' ? id : JSON.stringify(id);
    if (idText === '') {
      continue;
    }
    const addresses = obj.addresses;
    const ref =
      addresses === null || addresses === undefined || addresses === false
        ? ''
        : typeof addresses === 'string'
          ? addresses
          : JSON.stringify(addresses);
    if (ref === '') {
      newIssues += 1;
      continue;
    }
    const match = /^v([0-9]+)\.(C[0-9]+)$/.exec(ref);
    if (!match) {
      invalid += 1;
      continue;
    }
    const parentIter = Number(match[1]);
    const parentId = match[2];
    const parentFile = path.join(work, `critique.v${parentIter}.json`);
    if (parentIter >= iter) {
      invalid += 1;
    } else if (!existsSync(parentFile) || statSync(parentFile).size === 0) {
      invalid += 1;
    } else if (!schemaValidQuiet(parentFile, criticSchema)) {
      invalid += 1;
    } else {
      const parent = JSON.parse(readFileSync(parentFile, 'utf8')) as JsonValue;
      const parentIssues =
        isJsonObject(parent) && Array.isArray(parent.issues) ? parent.issues : [];
      const found = parentIssues.some((p) => isJsonObject(p) && p.id === parentId);
      if (found) {
        addressed += 1;
      } else {
        invalid += 1;
      }
    }
  }

  const pct = total > 0 ? Math.floor((addressed * 100) / total) : 100;
  return { total, addressed, newIssues, invalid, pct };
}
