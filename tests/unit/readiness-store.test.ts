import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isJsonObject, type JsonValue } from '../../src/core/json.js';
import {
  createReadinessProofCatalog,
  createReadinessProofState,
  replaceOccurrenceCoverageSnapshot,
  type OccurrenceSourceBinding,
  type ReadinessProofState,
} from '../../src/core/readiness-proof.js';
import {
  CorruptReadinessProofStateError,
  MissingReadinessProofStateError,
  UnsupportedReadinessProofSchemaError,
  readReadinessProofState,
  readReadinessProofStateForTelemetry,
  readReadinessProofStateIfPresent,
  writeReadinessProofState,
} from '../../src/core/readiness-store.js';

function criticBinding(): OccurrenceSourceBinding {
  return {
    candidate: {
      kind: 'versioned-plan',
      planVersion: 2,
      contentDigest: 'a'.repeat(64),
    },
    lineage: {
      evaluationStage: 'review',
      lineageDigest: 'b'.repeat(64),
    },
  };
}

function proofState(): ReadinessProofState {
  const catalog = createReadinessProofCatalog({
    expectedPlanVersion: 2,
    invariants: [{ invariantId: 'I-1', occurrenceIds: ['O-1'] }],
    materialIssueIds: ['C1'],
  });
  const binding = criticBinding();
  const state = createReadinessProofState(catalog, {
    critic: {
      required: true,
      reason: 'independent-critic-required',
      expectedBinding: binding,
    },
  });
  return replaceOccurrenceCoverageSnapshot(state, {
    source: 'critic',
    catalogDigest: catalog.digest,
    binding,
    occurrences: [
      {
        invariantId: 'I-1',
        occurrenceId: 'O-1',
        disposition: 'satisfied',
        evidenceGrounded: true,
      },
    ],
  });
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  Object.freeze(value);
}

function jsonObject(value: ReadinessProofState): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function requiredObject(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (!isJsonObject(value)) {
    throw new TypeError(`${label} fixture must be an object`);
  }
  return value;
}

describe('readiness proof store', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-readiness-store.'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('atomically round-trips exact current state without mutating its input', () => {
    const state = proofState();
    const before = JSON.stringify(state);
    const file = path.join(root, 'nested', 'convergence.v2.json');
    deepFreeze(state);

    expect(writeReadinessProofState(file, state)).toBe(file);
    expect(readReadinessProofState(file)).toEqual(state);
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify(state, null, 2)}\n`);
    expect(JSON.stringify(state)).toBe(before);
    expect(readdirSync(path.dirname(file))).toEqual(['convergence.v2.json']);

    const firstBytes = readFileSync(file, 'utf8');
    writeReadinessProofState(file, state);
    expect(readFileSync(file, 'utf8')).toBe(firstBytes);
    expect(readdirSync(path.dirname(file))).toEqual(['convergence.v2.json']);
  });

  it('distinguishes a missing strict read from the explicit optional read', () => {
    const file = path.join(root, 'missing.json');

    expect(() => readReadinessProofState(file)).toThrow(MissingReadinessProofStateError);
    expect(readReadinessProofStateIfPresent(file)).toBeUndefined();
    expect(readReadinessProofStateForTelemetry(file)).toBeUndefined();
  });

  it.each([1, 2])('rejects unsupported schema version %i without legacy migration', (version) => {
    const file = path.join(root, `schema-${version}.json`);
    writeFileSync(file, `${JSON.stringify({ schemaVersion: version })}\n`);

    expect(() => readReadinessProofState(file)).toThrow(UnsupportedReadinessProofSchemaError);
    expect(() => readReadinessProofStateIfPresent(file)).toThrow(
      UnsupportedReadinessProofSchemaError,
    );
    expect(readReadinessProofStateForTelemetry(file)).toBeUndefined();
  });

  it.each([
    ['invalid JSON', '{ not-json'],
    ['malformed current state', '{"schemaVersion":3}'],
    ['malformed schema value', '{"schemaVersion":"3"}'],
  ])('rejects %s as corrupt current state', (_label, serialized) => {
    const file = path.join(root, 'corrupt.json');
    writeFileSync(file, serialized);

    expect(() => readReadinessProofState(file)).toThrow(CorruptReadinessProofStateError);
    expect(() => readReadinessProofStateIfPresent(file)).toThrow(CorruptReadinessProofStateError);
    expect(readReadinessProofStateForTelemetry(file)).toBeUndefined();
  });

  it('rejects a malformed persisted ledger instead of trusting its aggregate fields', () => {
    const file = path.join(root, 'malformed-ledger.json');
    const malformed = jsonObject(proofState());
    if (!isJsonObject(malformed) || !isJsonObject(malformed.occurrenceCoverage)) {
      throw new TypeError('test fixture must contain an occurrence coverage object');
    }
    malformed.occurrenceCoverage.proofSatisfied = false;
    writeFileSync(file, `${JSON.stringify(malformed, null, 2)}\n`);

    expect(() => readReadinessProofState(file)).toThrow(CorruptReadinessProofStateError);
  });

  it.each([
    {
      label: 'plan SHA-256',
      mutate: (root: Record<string, JsonValue>): void => {
        root.planSha256 = 'not-a-digest';
      },
    },
    {
      label: 'canonical plan SHA-256',
      mutate: (root: Record<string, JsonValue>): void => {
        root.canonicalPlanSha256 = 'not-a-digest';
      },
    },
    {
      label: 'system plan SHA-256',
      mutate: (root: Record<string, JsonValue>): void => {
        root.systemProofBinding = {
          planVersion: 2,
          planSha256: 'not-a-digest',
          authoritativeDigest: 'c'.repeat(64),
        };
      },
    },
    {
      label: 'source digest',
      mutate: (root: Record<string, JsonValue>): void => {
        root.sourceDigest = 'A'.repeat(64);
      },
    },
    {
      label: 'authoritative digest',
      mutate: (root: Record<string, JsonValue>): void => {
        root.authoritativeDigest = 'not-a-digest';
      },
    },
    {
      label: 'readiness contract digest',
      mutate: (root: Record<string, JsonValue>): void => {
        root.readinessContractDigest = 'd'.repeat(63);
      },
    },
    {
      label: 'system authoritative digest',
      mutate: (root: Record<string, JsonValue>): void => {
        root.systemProofBinding = {
          planVersion: 2,
          planSha256: 'c'.repeat(64),
          authoritativeDigest: 'C'.repeat(64),
        };
      },
    },
    {
      label: 'catalog digest',
      mutate: (root: Record<string, JsonValue>): void => {
        const catalog = requiredObject(root.catalog, 'catalog');
        catalog.digest = 'A'.repeat(64);
      },
    },
    {
      label: 'snapshot catalog digest',
      mutate: (root: Record<string, JsonValue>): void => {
        const sources = root.sources;
        if (!Array.isArray(sources)) {
          throw new TypeError('sources fixture must be an array');
        }
        const critic = requiredObject(sources[0], 'critic');
        const snapshot = requiredObject(critic.snapshot, 'critic snapshot');
        snapshot.catalogDigest = 'not-a-digest';
      },
    },
    {
      label: 'occurrence candidate digest',
      mutate: (root: Record<string, JsonValue>): void => {
        const sources = root.sources;
        if (!Array.isArray(sources)) {
          throw new TypeError('sources fixture must be an array');
        }
        const critic = requiredObject(sources[0], 'critic');
        const snapshot = requiredObject(critic.snapshot, 'critic snapshot');
        const binding = requiredObject(snapshot.binding, 'critic snapshot binding');
        const candidate = requiredObject(binding.candidate, 'critic snapshot candidate');
        candidate.contentDigest = 'not-a-digest';
      },
    },
    {
      label: 'occurrence lineage digest',
      mutate: (root: Record<string, JsonValue>): void => {
        const sources = root.sources;
        if (!Array.isArray(sources)) {
          throw new TypeError('sources fixture must be an array');
        }
        const critic = requiredObject(sources[0], 'critic');
        const snapshot = requiredObject(critic.snapshot, 'critic snapshot');
        const binding = requiredObject(snapshot.binding, 'critic snapshot binding');
        const lineage = requiredObject(binding.lineage, 'critic snapshot lineage');
        lineage.lineageDigest = 'not-a-digest';
      },
    },
  ])('rejects malformed persisted $label on read and write', ({ mutate }) => {
    const malformed = requiredObject(jsonObject(proofState()), 'proof state');
    mutate(malformed);
    const readFile = path.join(root, 'malformed-digest.json');
    const writeFile = path.join(root, 'rejected-digest.json');
    writeFileSync(readFile, `${JSON.stringify(malformed, null, 2)}\n`);

    expect(() => readReadinessProofState(readFile)).toThrow(CorruptReadinessProofStateError);
    expect(() =>
      writeReadinessProofState(writeFile, malformed as unknown as ReadinessProofState),
    ).toThrow(CorruptReadinessProofStateError);
    expect(existsSync(writeFile)).toBe(false);
  });

  it('validates before writing and does not mutate or persist malformed caller state', () => {
    const file = path.join(root, 'rejected.json');
    const malformed = jsonObject(proofState());
    if (!isJsonObject(malformed) || !isJsonObject(malformed.occurrenceCoverage)) {
      throw new TypeError('test fixture must contain an occurrence coverage object');
    }
    malformed.occurrenceCoverage.resolvedOccurrenceIds = [];
    const before = JSON.stringify(malformed);

    expect(() =>
      writeReadinessProofState(file, malformed as unknown as ReadinessProofState),
    ).toThrow(CorruptReadinessProofStateError);
    expect(JSON.stringify(malformed)).toBe(before);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});
