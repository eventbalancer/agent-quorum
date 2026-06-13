import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveResumeStale, lastStablePlan } from '../../src/stages/plan/resume.js';
import { resolveResumeWorkdir } from '../../src/core/resume.js';
import type { ResumeState } from '../../src/core/run-context.js';
import { HaltError } from '../../src/runtime/halt.js';
import { captureStderr, writeStructuredPlanFile, writeUpdate } from '../helpers/harness.js';

let tmp: string;
let work: string;
let schema: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-resumetest.'));
  work = path.join(tmp, 'work');
  mkdirSync(work);
  schema = path.join(tmp, 'update.schema.json');
  writeFileSync(
    schema,
    `${JSON.stringify({ required: ['plan_version', 'plan_markdown'] }, null, 2)}\n`,
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('last stable plan', () => {
  it('treats v0 as always stable', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    expect(lastStablePlan(work, schema)).toBe(0);
  });

  it('accepts vN only when update.v(N-1) is schema-valid', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
    writeUpdate(path.join(work, 'update.v0.json'), 1);
    expect(lastStablePlan(work, schema)).toBe(1);
  });

  it('falls back past a plan whose update is invalid', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
    writeFileSync(path.join(work, 'update.v0.json'), '{"not": "an update"}\n');
    expect(lastStablePlan(work, schema)).toBe(0);
  });

  it('halts with exit 4 when no stable plan exists', () => {
    const capture = captureStderr();
    try {
      expect(() => lastStablePlan(work, schema)).toThrow(HaltError);
      expect(capture.text()).toContain('resume failed: no stable plan.vN.md found');
    } finally {
      capture.restore();
    }
  });
});

describe('stale artifact archive', () => {
  it('archives artifacts at/after the resume point plus final extras', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
    writeStructuredPlanFile(path.join(work, 'plan.v2.md'), 'V2');
    writeUpdate(path.join(work, 'update.v0.json'), 1);
    writeUpdate(path.join(work, 'update.v1.json'), 2);
    writeFileSync(path.join(work, 'critique.v0.json'), '{}\n');
    writeFileSync(path.join(work, 'critique.v1.json'), '{}\n');
    writeFileSync(path.join(work, 'update-meta.v1.json'), '{}\n');
    writeFileSync(path.join(work, 'plan.revision.v1.md'), '# R1\n');
    writeFileSync(path.join(work, 'plan.final.md'), '# Final\n');
    writeFileSync(path.join(work, 'summary.md'), '# Summary\n');

    const state: ResumeState = { startIter: 1, archivedCount: 0, archiveDir: '' };
    archiveResumeStale(work, state, 1);

    expect(state.archivedCount).toBe(7);
    expect(state.archiveDir.startsWith(path.join(work, 'stale.'))).toBe(true);
    expect(existsSync(path.join(work, 'plan.v0.md'))).toBe(true);
    expect(existsSync(path.join(work, 'plan.v1.md'))).toBe(true);
    expect(existsSync(path.join(work, 'update.v0.json'))).toBe(true);
    expect(existsSync(path.join(work, 'critique.v0.json'))).toBe(true);
    expect(existsSync(path.join(work, 'plan.v2.md'))).toBe(false);
    expect(existsSync(path.join(work, 'critique.v1.json'))).toBe(false);
    expect(existsSync(path.join(work, 'update.v1.json'))).toBe(false);
    expect(existsSync(path.join(work, 'update-meta.v1.json'))).toBe(false);
    expect(existsSync(path.join(work, 'plan.revision.v1.md'))).toBe(false);
    expect(existsSync(path.join(work, 'plan.final.md'))).toBe(false);
    expect(existsSync(path.join(work, 'summary.md'))).toBe(false);
    const archived = readdirSync(state.archiveDir).sort();
    expect(archived).toContain('plan.v2.md');
    expect(archived).toContain('plan.final.md');
  });

  it('archives package artifacts alongside plan.final.md', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    writeFileSync(path.join(work, 'plan.final.md'), '# Final\n');
    writeFileSync(path.join(work, 'plan.split.json'), '{"decision":"split"}\n');
    writeFileSync(path.join(work, 'package-findings.json'), '{"stale_lines":[]}\n');
    const pkg = path.join(work, 'plan.package');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, 'README.md'), '# pack\n');

    const state: ResumeState = { startIter: 0, archivedCount: 0, archiveDir: '' };
    archiveResumeStale(work, state, 0);

    expect(existsSync(path.join(work, 'plan.split.json'))).toBe(false);
    expect(existsSync(path.join(work, 'package-findings.json'))).toBe(false);
    expect(existsSync(pkg)).toBe(false);
    const archived = readdirSync(state.archiveDir).sort();
    expect(archived).toContain('plan.split.json');
    expect(archived).toContain('package-findings.json');
    expect(archived).toContain('plan.package');
    expect(existsSync(path.join(state.archiveDir, 'plan.package', 'README.md'))).toBe(true);
  });

  it('archives nothing on a clean resume', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    const state: ResumeState = { startIter: 0, archivedCount: 0, archiveDir: '' };
    archiveResumeStale(work, state, 0);
    expect(state.archivedCount).toBe(0);
    expect(state.archiveDir).toBe('');
    expect(existsSync(path.join(work, 'plan.v0.md'))).toBe(true);
  });
});

describe('resume workdir resolution', () => {
  function makeRun(name: string): string {
    const dir = path.join(tmp, 'plans', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'plan.v0.md'), '# V0\n');
    return dir;
  }

  it('resolves a single matching workdir', () => {
    const dir = makeRun('loop-feature');
    const result = resolveResumeWorkdir(path.join(tmp, 'plans'), 'feature');
    expect(result).toEqual({ kind: 'resolved', dir });
  });

  it('returns none with guidance when nothing matches', () => {
    mkdirSync(path.join(tmp, 'plans'), { recursive: true });
    const capture = captureStderr();
    try {
      const result = resolveResumeWorkdir(path.join(tmp, 'plans'), 'ghost');
      expect(result).toEqual({ kind: 'none' });
      expect(capture.text()).toContain('resume: no existing workdir with state for ghost');
      expect(capture.text()).toContain('set AGENT_QUORUM_WORK_DIR to override');
    } finally {
      capture.restore();
    }
  });

  it('prefers the effort-suffixed dir among ambiguous candidates', () => {
    makeRun('loop-feature');
    const high = makeRun('loop-feature-high');
    const result = resolveResumeWorkdir(path.join(tmp, 'plans'), 'feature', 'high');
    expect(result).toEqual({ kind: 'resolved', dir: high });
  });

  it('reports ambiguity when no effort disambiguates', () => {
    makeRun('loop-feature');
    makeRun('loop-feature-max');
    const capture = captureStderr();
    try {
      const result = resolveResumeWorkdir(path.join(tmp, 'plans'), 'feature');
      expect(result).toEqual({ kind: 'ambiguous' });
      expect(capture.text()).toContain('resume: ambiguous workdir for feature; candidates:');
    } finally {
      capture.restore();
    }
  });
});
