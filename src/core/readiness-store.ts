import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isJsonObject, type JsonValue } from './json.js';
import {
  READINESS_PROOF_SCHEMA_VERSION,
  parseReadinessProofState,
  type ReadinessProofState,
} from './readiness-proof.js';

export type ReadinessStoreErrorKind = 'missing' | 'unsupported-schema' | 'corrupt';

export abstract class ReadinessStoreError extends Error {
  protected constructor(
    message: string,
    readonly kind: ReadinessStoreErrorKind,
    readonly file: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class MissingReadinessProofStateError extends ReadinessStoreError {
  override readonly name = 'MissingReadinessProofStateError';

  constructor(file: string, options?: ErrorOptions) {
    super(`readiness proof state is missing: ${file}`, 'missing', file, options);
  }
}

export class UnsupportedReadinessProofSchemaError extends ReadinessStoreError {
  override readonly name = 'UnsupportedReadinessProofSchemaError';

  constructor(
    file: string,
    readonly schemaVersion: number,
  ) {
    super(
      `readiness proof state schema ${schemaVersion} is unsupported; expected ${READINESS_PROOF_SCHEMA_VERSION}: ${file}`,
      'unsupported-schema',
      file,
    );
  }
}

export class CorruptReadinessProofStateError extends ReadinessStoreError {
  override readonly name = 'CorruptReadinessProofStateError';

  constructor(file: string, detail: string, options?: ErrorOptions) {
    super(`readiness proof state is corrupt (${detail}): ${file}`, 'corrupt', file, options);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function parseSerializedState(file: string, serialized: string): ReadinessProofState {
  let value: JsonValue;
  try {
    value = JSON.parse(serialized) as JsonValue;
  } catch (error) {
    throw new CorruptReadinessProofStateError(file, 'invalid JSON', { cause: error });
  }

  const schemaVersion = isJsonObject(value) ? value.schemaVersion : undefined;
  if (
    typeof schemaVersion === 'number' &&
    Number.isSafeInteger(schemaVersion) &&
    schemaVersion > 0 &&
    schemaVersion !== READINESS_PROOF_SCHEMA_VERSION
  ) {
    throw new UnsupportedReadinessProofSchemaError(file, schemaVersion);
  }

  try {
    return parseReadinessProofState(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid current-schema state';
    throw new CorruptReadinessProofStateError(file, detail, { cause: error });
  }
}

export function readReadinessProofState(file: string): ReadinessProofState {
  let serialized: string;
  try {
    serialized = readFileSync(file, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      throw new MissingReadinessProofStateError(file, { cause: error });
    }
    throw error;
  }
  return parseSerializedState(file, serialized);
}

export function readReadinessProofStateIfPresent(file: string): ReadinessProofState | undefined {
  try {
    return readReadinessProofState(file);
  } catch (error) {
    if (error instanceof MissingReadinessProofStateError) {
      return undefined;
    }
    throw error;
  }
}

export function readReadinessProofStateForTelemetry(file: string): ReadinessProofState | undefined {
  try {
    return readReadinessProofState(file);
  } catch {
    return undefined;
  }
}

function validateForSerialization(file: string, state: ReadinessProofState): ReadinessProofState {
  let serialized: string;
  try {
    serialized = JSON.stringify(state);
  } catch (error) {
    throw new CorruptReadinessProofStateError(file, 'state is not JSON-serializable', {
      cause: error,
    });
  }
  return parseSerializedState(file, serialized);
}

export function writeReadinessProofState(file: string, state: ReadinessProofState): string {
  const validated = validateForSerialization(file, state);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, serialized, { flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return file;
}
