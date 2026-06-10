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
  tmp = mkdtempSync(path.join(os.tmpdir(), 'plan-loop-metricstest.'));
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
      pct: 100,
    });
  });
});
