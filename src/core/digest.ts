import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { JsonValue } from './json.js';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function fileSha256(file: string): string {
  return sha256(readFileSync(file));
}

export function stableTupleId(prefix: string, tuple: readonly JsonValue[]): string {
  return `${prefix}-${sha256(JSON.stringify(tuple))}`;
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
  throw new TypeError('canonical JSON digest input contains a non-JSON value');
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}
