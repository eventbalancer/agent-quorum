import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJsonSha256 } from '../../src/core/digest.js';
import { isAlive, procStartToken } from '../../src/runtime/proc.js';
import type { PlanningSmokeSentinelResult } from './model.js';

export const SMOKE_ATTEMPTS_FILE = 'smoke-attempts.json';
const LOCK_FILE = '.smoke-owner.json';

export interface SmokeAttempt {
  readonly scenarioId: string;
  readonly attemptNumber: number;
  readonly identity: string;
  readonly workspaceRevision: string;
  readonly candidateRevision: string;
  readonly workDir: string;
  readonly startedAt: number;
  readonly pid?: number;
  readonly processStartToken?: string;
  readonly finishedAt?: number;
  readonly exitCode?: number;
  readonly artifactBundleSha256?: string;
  readonly result?: PlanningSmokeSentinelResult;
}

export interface SmokeAttemptState {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly attempts: readonly SmokeAttempt[];
}

interface SmokeOwner {
  readonly pid: number;
  readonly processStartToken: string;
  readonly token: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isDigest(value: unknown, length: number): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${String(length)}}$`).test(value);
}

function parseOwner(file: string): SmokeOwner {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    !isObject(value) ||
    !isPositiveInteger(value.pid) ||
    typeof value.processStartToken !== 'string' ||
    typeof value.token !== 'string'
  ) {
    throw new Error('planning smoke ownership is corrupt; explicit recovery is required');
  }
  return { pid: value.pid, processStartToken: value.processStartToken, token: value.token };
}

function ownerAlive(owner: SmokeOwner): boolean {
  if (!isAlive(owner.pid)) {
    return false;
  }
  const currentToken = procStartToken(owner.pid);
  return currentToken === undefined || currentToken === owner.processStartToken;
}

export function acquireSmokeOwnership(outputDir: string): () => void {
  mkdirSync(outputDir, { recursive: true });
  const lockFile = path.join(outputDir, LOCK_FILE);
  const processStart = procStartToken(process.pid);
  if (processStart === undefined) {
    throw new Error('planning smoke cannot establish process ownership');
  }
  const owner: SmokeOwner = {
    pid: process.pid,
    processStartToken: processStart,
    token: randomUUID(),
  };
  const claim = () => {
    writeFileSync(lockFile, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
  };
  try {
    claim();
  } catch (error) {
    if (!existsSync(lockFile)) {
      throw error;
    }
    const recoveryLock = path.join(outputDir, '.smoke-recovery');
    mkdirSync(recoveryLock);
    try {
      if (existsSync(lockFile)) {
        if (ownerAlive(parseOwner(lockFile))) {
          throw new Error('planning smoke output is owned by a live process', { cause: error });
        }
        rmSync(lockFile);
      }
      claim();
    } finally {
      rmSync(recoveryLock, { recursive: true });
    }
  }
  return () => {
    if (existsSync(lockFile) && parseOwner(lockFile).token === owner.token) {
      rmSync(lockFile);
    }
  };
}

function parseAttempt(value: unknown, outputDir: string): SmokeAttempt {
  if (
    !isObject(value) ||
    typeof value.scenarioId !== 'string' ||
    !/^[a-z0-9-]+$/.test(value.scenarioId) ||
    !isPositiveInteger(value.attemptNumber) ||
    !isDigest(value.identity, 64) ||
    !isDigest(value.workspaceRevision, 40) ||
    !isDigest(value.candidateRevision, 40) ||
    typeof value.workDir !== 'string' ||
    !isPositiveInteger(value.startedAt)
  ) {
    throw new Error('planning smoke attempt receipt is corrupt or incompatible');
  }
  const expectedWorkDir = path.join(
    outputDir,
    value.scenarioId,
    `attempt-${String(value.attemptNumber)}`,
    'run',
  );
  if (
    value.workDir !== expectedWorkDir ||
    (value.pid !== undefined && !isPositiveInteger(value.pid)) ||
    (value.processStartToken !== undefined && typeof value.processStartToken !== 'string') ||
    (value.finishedAt !== undefined &&
      (!isPositiveInteger(value.finishedAt) || value.finishedAt < value.startedAt)) ||
    (value.artifactBundleSha256 !== undefined && !isDigest(value.artifactBundleSha256, 64)) ||
    (value.exitCode !== undefined &&
      (typeof value.exitCode !== 'number' ||
        !Number.isSafeInteger(value.exitCode) ||
        value.exitCode < 0))
  ) {
    throw new Error('planning smoke attempt provenance is invalid');
  }
  return {
    scenarioId: value.scenarioId,
    attemptNumber: value.attemptNumber,
    identity: value.identity,
    workspaceRevision: value.workspaceRevision,
    candidateRevision: value.candidateRevision,
    workDir: value.workDir,
    startedAt: value.startedAt,
    ...(typeof value.pid === 'number' ? { pid: value.pid } : {}),
    ...(typeof value.processStartToken === 'string'
      ? { processStartToken: value.processStartToken }
      : {}),
    ...(typeof value.finishedAt === 'number' ? { finishedAt: value.finishedAt } : {}),
    ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
    ...(typeof value.artifactBundleSha256 === 'string'
      ? { artifactBundleSha256: value.artifactBundleSha256 }
      : {}),
  };
}

export function readSmokeAttempts(outputDir: string, suiteId: string): SmokeAttemptState {
  const file = path.join(outputDir, SMOKE_ATTEMPTS_FILE);
  if (!existsSync(file)) {
    return { schemaVersion: 1, suiteId, attempts: [] };
  }
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.suiteId !== suiteId ||
    !Array.isArray(value.attempts)
  ) {
    throw new Error('planning smoke attempts are corrupt or incompatible');
  }
  const attempts = value.attempts.map((attempt: unknown) => parseAttempt(attempt, outputDir));
  const expectedNumbers = new Map<string, number>();
  for (const attempt of attempts) {
    const expected = (expectedNumbers.get(attempt.scenarioId) ?? 0) + 1;
    if (attempt.attemptNumber !== expected) {
      throw new Error('planning smoke attempt history is incomplete or duplicated');
    }
    expectedNumbers.set(attempt.scenarioId, expected);
  }
  return { schemaVersion: 1, suiteId, attempts };
}

export function writeSmokeJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, file);
}

export function writeSmokeAttempts(outputDir: string, state: SmokeAttemptState): void {
  writeSmokeJson(path.join(outputDir, SMOKE_ATTEMPTS_FILE), state);
}

export function smokeAttemptIdentity(value: unknown): string {
  return canonicalJsonSha256(value);
}

export function smokeAttemptAlive(attempt: SmokeAttempt): boolean {
  if (attempt.pid === undefined || !isAlive(attempt.pid)) {
    return false;
  }
  const currentToken = procStartToken(attempt.pid);
  return (
    attempt.processStartToken === undefined ||
    currentToken === undefined ||
    currentToken === attempt.processStartToken
  );
}
