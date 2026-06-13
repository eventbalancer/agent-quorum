import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countNewlines } from '../../src/runtime/files.js';
import { planHasHeading } from '../../src/stages/plan/plan-shape.js';
import { validatePlanPackage } from '../../src/stages/plan/plan-package.js';
import { REPO_ROOT } from '../helpers/harness.js';

const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'plan-package');

let tmp: string;
let findingsFile: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-packfixture.'));
  findingsFile = path.join(tmp, 'package-findings.json');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function validateFixture() {
  return validatePlanPackage(REPO_ROOT, FIXTURE, { findingsFile });
}

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURE, name), 'utf8');
}

interface ProgressRow {
  readonly phase: string;
  readonly status: string;
}

function progressRows(journal: string): ProgressRow[] {
  const lines = journal.split('\n');
  const start = lines.findIndex((line) => line.startsWith('## Progress'));
  const rows: ProgressRow[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('## ') && i > start + 1) {
      break;
    }
    if (!line.trim().startsWith('|')) {
      continue;
    }
    const cells = line
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell !== '');
    if (cells.length < 4 || cells[0] === '#' || /^-+$/.test(cells[0] ?? '')) {
      continue;
    }
    rows.push({ phase: cells[1] ?? '', status: cells[3] ?? '' });
  }
  return rows;
}

describe('committed split-package fixture contract', () => {
  it('is a structurally valid package', () => {
    expect(validateFixture().ok).toBe(true);
  });

  it('makes the current and next phase identifiable from the journal progress table', () => {
    const rows = progressRows(fixture('journal.md'));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const currentIndex = rows.findIndex((row) => row.status === 'pending');
    expect(currentIndex).toBeGreaterThanOrEqual(0);
    expect(rows[currentIndex]?.phase).toBe('P1');
    expect(rows[currentIndex + 1]?.phase).toBe('P2');
  });

  it('resolves every README route P# to an existing phase doc', () => {
    const readme = fixture('README.md');
    const fileNames = [...readme.matchAll(/phase-\d+-[a-z0-9-]+\.md/g)].map((m) => m[0]);
    expect(fileNames.length).toBeGreaterThan(0);
    for (const name of new Set(fileNames)) {
      expect(existsSync(path.join(FIXTURE, name)), name).toBe(true);
    }
  });

  it('keeps the README + journal + one-phase bootstrap read at or under 500 lines', () => {
    const phase = [...fixture('README.md').matchAll(/phase-\d+-[a-z0-9-]+\.md/g)][0]?.[0] ?? '';
    const bootstrap =
      countNewlines(fixture('README.md')) +
      countNewlines(fixture('journal.md')) +
      countNewlines(fixture(phase));
    expect(bootstrap).toBeLessThanOrEqual(500);
  });

  it('carries the runbook sections the execute skill consumes', () => {
    const runbook = path.join(FIXTURE, 'run.md');
    expect(planHasHeading(runbook, 'Step 0 - Position')).toBe(true);
    expect(planHasHeading(runbook, 'Stop Report Format')).toBe(true);
  });

  it('phase docs are self-contained and never tell the reader to read the full plan', () => {
    const readme = fixture('README.md');
    const fileNames = new Set([...readme.matchAll(/phase-\d+-[a-z0-9-]+\.md/g)].map((m) => m[0]));
    for (const name of fileNames) {
      const doc = fixture(name).toLowerCase();
      expect(doc).not.toContain('read the full plan');
      expect(doc).not.toContain('read the master plan');
      expect(doc).not.toContain('plan.md end to end');
    }
  });
});
