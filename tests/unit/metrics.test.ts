import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { critiqueHealth } from '../../src/core/metrics.js';
import { writeCritique } from '../helpers/harness.js';

let tmp: string;
let work: string;
let schema: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-metricstest.'));
  work = path.join(tmp, 'work');
  mkdirSync(work);
  schema = path.join(tmp, 'critique.schema.json');
  writeFileSync(schema, `${JSON.stringify({ required: ['issues'] }, null, 2)}\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('critique_health', () => {
  it('counts valid, new, and invalid addresses', () => {
    writeCritique(path.join(work, 'critique.v0.json'), [{ id: 'C1', addresses: null }]);
    const current = path.join(tmp, 'current.json');
    writeCritique(current, [
      { id: 'C1', addresses: 'v0.C1' },
      { id: 'C2', addresses: null },
      { id: 'C3', addresses: 'v2.C1' },
      { id: 'C4', addresses: 'v0.C404' },
      { id: 'C5', addresses: 'not-a-reference' },
    ]);

    expect(critiqueHealth(work, schema, 1, current)).toEqual({
      total: 5,
      addressed: 1,
      newIssues: 1,
      invalid: 3,
      unanchored: 5,
      pct: 20,
    });
  });

  it('handles empty critiques as fully valid', () => {
    const current = path.join(tmp, 'empty.json');
    writeCritique(current, []);
    expect(critiqueHealth(work, schema, 0, current)).toEqual({
      total: 0,
      addressed: 0,
      newIssues: 0,
      invalid: 0,
      unanchored: 0,
      pct: 100,
    });
  });

  it('excludes duplicate_of issues from all totals (AC-2)', () => {
    writeCritique(path.join(work, 'critique.v0.json'), [{ id: 'C1', addresses: null }]);
    const current = path.join(tmp, 'ac2.json');
    writeCritique(current, [
      { id: 'C1', addresses: 'v0.C1', duplicate_of: 'r1' },
      { id: 'C2', addresses: null, duplicate_of: null },
      { id: 'C3', addresses: 'v0.C1', duplicate_of: null },
    ]);
    expect(critiqueHealth(work, schema, 1, current)).toEqual({
      total: 2,
      addressed: 1,
      newIssues: 1,
      invalid: 0,
      unanchored: 2,
      pct: 50,
    });
  });

  it('reports unanchored=0 when evidence contains file:line anchors (AC-3a)', () => {
    const current = path.join(tmp, 'ac3a.json');
    writeCritique(current, [
      { id: 'C1', addresses: null, duplicate_of: null, evidence: 'src/core/metrics.ts:17' },
      { id: 'C2', addresses: null, duplicate_of: null, evidence: 'loop.ts:79' },
    ]);
    expect(critiqueHealth(work, schema, 0, current)).toEqual({
      total: 2,
      addressed: 0,
      newIssues: 2,
      invalid: 0,
      unanchored: 0,
      pct: 0,
    });
  });

  it('reports unanchored equal to total when evidence has no anchors (AC-3b)', () => {
    const current = path.join(tmp, 'ac3b.json');
    writeCritique(current, [
      { id: 'C1', addresses: null, duplicate_of: null, evidence: 'the plan lacks detail' },
      { id: 'C2', addresses: null, duplicate_of: null, evidence: 'this section is vague' },
    ]);
    const result = critiqueHealth(work, schema, 0, current);
    expect(result.total).toBe(2);
    expect(result.unanchored).toBe(result.total);
  });
});
