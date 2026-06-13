import { appendFileSync, readFileSync } from 'node:fs';
import { nonEmptyFile } from '../../runtime/files.js';
import path from 'node:path';
import { isJsonObject, type JsonValue } from '../../core/json.js';
import { nowUtcStamp } from '../../core/artifacts.js';

export function operatorInterventionsFile(work: string): string {
  return path.join(work, 'operator-interventions.jsonl');
}

function operatorInterventionMigrationsFile(work: string): string {
  return path.join(work, 'operator-intervention-migrations.jsonl');
}

function jqToString(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseJsonl(file: string): JsonValue[] | undefined {
  const entries: JsonValue[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as JsonValue);
    } catch {
      return undefined;
    }
  }
  return entries;
}

function loadMigratedIds(work: string): string[] {
  const file = operatorInterventionMigrationsFile(work);
  if (!nonEmptyFile(file)) {
    return [];
  }
  const entries = parseJsonl(file);
  if (entries === undefined) {
    return [];
  }
  const ids = new Set<string>();
  for (const entry of entries) {
    if (isJsonObject(entry) && typeof entry.intervention_id === 'string') {
      ids.add(entry.intervention_id);
    }
  }
  return [...ids];
}

interface InterventionItem {
  id: string;
  ts: string;
  target: string;
  message: string;
}

function interventionItems(entries: JsonValue[]): InterventionItem[] {
  return entries.map((entry, index) => {
    const obj = isJsonObject(entry) ? entry : {};
    const id = typeof obj.id === 'string' && obj.id !== '' ? obj.id : `I${index + 1}`;
    const tsValue = obj.ts;
    const targetValue = obj.target;
    const messageValue = obj.message;
    return {
      id,
      ts:
        tsValue === null || tsValue === undefined || tsValue === false
          ? 'unknown-time'
          : jqToString(tsValue),
      target:
        targetValue === null || targetValue === undefined || targetValue === false
          ? 'all'
          : jqToString(targetValue),
      message:
        messageValue === null || messageValue === undefined || messageValue === false
          ? ''
          : jqToString(messageValue),
    };
  });
}

export function operatorInterventionsContext(work: string, role = 'all'): string {
  const file = operatorInterventionsFile(work);
  if (!nonEmptyFile(file)) {
    return '';
  }

  const entries = parseJsonl(file);
  if (entries === undefined) {
    const numbered = readFileSync(file, 'utf8')
      .replace(/\n$/, '')
      .split('\n')
      .map((line, index) => `${String(index + 1).padStart(6)}\t${line}`)
      .join('\n');
    return (
      '## Operator interventions\n' +
      'The operator intervention ledger exists but contains invalid JSONL. Treat the raw entries below as current-loop operator guidance.\n' +
      '\n' +
      numbered
    );
  }

  const migrated = new Set(loadMigratedIds(work));
  const items = interventionItems(entries).filter(
    (item) => !migrated.has(item.id) && (item.target === 'all' || item.target === role),
  );
  if (items.length === 0) {
    return '';
  }

  const lines = items
    .map((item) => {
      const message = item.message.replaceAll('\n', '\n  ');
      return `- ${item.id} [${item.ts}, target=${item.target}]\n  ${message}`;
    })
    .join('\n');
  return (
    '## Operator interventions\n' +
    'These active instructions were added after this agent-quorum was launched. Fold relevant entries into the next plan revision or fix-pass output. Once a revision is written, the loop records the target plan version and stops injecting the full text.\n' +
    '\n' +
    lines
  );
}

export function markOperatorInterventionsMigrated(
  work: string,
  role: string,
  planRef: string,
): void {
  const file = operatorInterventionsFile(work);
  if (!nonEmptyFile(file)) {
    return;
  }
  const entries = parseJsonl(file);
  if (entries === undefined) {
    return;
  }
  const migrated = new Set(loadMigratedIds(work));
  const ts = nowUtcStamp();
  let appended = '';
  for (const item of interventionItems(entries)) {
    if (migrated.has(item.id)) {
      continue;
    }
    if (!(item.target === 'all' || item.target === role)) {
      continue;
    }
    const sourceTs = item.ts === 'unknown-time' ? null : item.ts;
    appended += `${JSON.stringify({
      ts,
      role,
      plan_ref: planRef,
      intervention_id: item.id,
      intervention_ts: sourceTs,
      target: item.target,
    })}\n`;
  }
  if (appended !== '') {
    appendFileSync(operatorInterventionMigrationsFile(work), appended);
  }
}

export interface InterventionsState {
  total: number | 'invalid';
  active: number | 'invalid';
  migrated: number | 'invalid';
}

export function operatorInterventionsState(work: string): InterventionsState {
  const file = operatorInterventionsFile(work);
  if (!nonEmptyFile(file)) {
    return { total: 0, active: 0, migrated: 0 };
  }
  const entries = parseJsonl(file);
  if (entries === undefined) {
    return { total: 'invalid', active: 'invalid', migrated: 'invalid' };
  }
  const migrated = new Set(loadMigratedIds(work));
  const all = interventionItems(entries).map((item) => item.id);
  const done = all.filter((id) => migrated.has(id)).length;
  return { total: all.length, active: all.length - done, migrated: done };
}
