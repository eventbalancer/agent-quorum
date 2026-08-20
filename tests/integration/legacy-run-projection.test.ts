import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRun, listRuns } from '../../src/index.js';
import { runRecordPath, writeRunRecord, type RunRecordDraft } from '../../src/core/run-store.js';

let root: string;
let store: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-legacy-run-projection.'));
  store = path.join(root, 'state');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('legacy run readiness projection', () => {
  it('returns the same conservative report through listRuns and getRun', () => {
    const draft: RunRecordDraft = {
      name: 'legacy',
      pid: 999_999,
      pgid: '0',
      procStartToken: 'legacy',
      mode: 'plan',
      inputPath: path.join(root, 'input.md'),
      workDir: path.join(root, 'work'),
      logPath: path.join(root, 'work', 'run.log'),
      plansDir: path.join(root, 'plans'),
      startedAt: '2026-08-20T00:00:00Z',
      quality: 'balanced',
      state: 'finished',
      finalStatus: 'clean',
    };
    const written = writeRunRecord(store, draft);
    const file = runRecordPath(store, written.runId);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    stored.finalConvergence = {
      promise: 'cumulative',
      satisfied: true,
      artifactPath: path.join(root, 'work', 'convergence.final.json'),
      exhaustedLimits: [],
      unresolvedCoverage: [],
    };
    writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);

    const listed = listRuns({ store }).find((record) => record.runId === written.runId);
    const selected = getRun(written.runId, { store });

    for (const record of [listed, selected]) {
      expect(record?.finalConvergence).toMatchObject({
        promise: 'cumulative',
        satisfied: false,
        decision: 'unable-to-decide',
        reasonCodes: ['legacy-state-requires-review'],
        applicableRiskDomains: [],
        highRiskDomains: [],
        opportunityCount: 0,
      });
    }
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as {
      finalConvergence: Record<string, unknown>;
    };
    expect(persisted.finalConvergence).not.toHaveProperty('decision');
  });
});
