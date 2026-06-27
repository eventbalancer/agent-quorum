import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emitPlanPackage,
  evaluateSplitDecision,
  parsePlanStructure,
  PACKAGE_FINDINGS_FILE,
  PHASE_REQUIRED_HEADINGS,
  resolveSplitMode,
  validatePlanPackage,
  type SplitDecision,
  type SplitDecisionKnobs,
  type SplitMode,
} from '../../src/stages/plan/plan-package.js';
import { planHasHeading } from '../../src/stages/plan/plan-shape.js';
import {
  REPO_ROOT,
  writeLargeStructuredPlanFile,
  writeStructuredPlanFile,
} from '../helpers/harness.js';

let tmp: string;
let work: string;

interface SplitKnobOverrides {
  readonly mode?: SplitMode;
  readonly minPhases?: number;
  readonly maxPlanLines?: number;
}

function file(name: string): string {
  return path.join(tmp, name);
}

function knobs(over: SplitKnobOverrides = {}): SplitDecisionKnobs {
  return {
    mode: over.mode ?? 'auto',
    minPhases: over.minPhases ?? 5,
    maxPlanLines: over.maxPlanLines ?? 900,
  };
}

function writeAndReturn(target: string, title: string): string {
  writeStructuredPlanFile(target, title);
  return target;
}

function splitFor(plan: string): SplitDecision {
  const structure = parsePlanStructure(plan);
  return evaluateSplitDecision(structure, { mode: 'always', minPhases: 5, maxPlanLines: 900 });
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-packagetest.'));
  work = path.join(tmp, 'work');
  mkdirSync(work, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('parsePlanStructure', () => {
  it('parses a Phase table keyed by stable P# ids', () => {
    const plan = file('large.md');
    writeLargeStructuredPlanFile(plan, 'Large Plan', 6);
    const structure = parsePlanStructure(plan);
    expect(structure.phases.map((phase) => phase.id)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
    expect(structure.phases[0]?.name).toBe('Phase 1 work');
    expect(structure.phases[0]?.touches).toContain('src/core/mod-1.ts');
    expect(structure.phases[0]?.acceptanceGate).toContain('Phase 1 gate observable');
    expect(structure.phases[1]?.dependsOn).toBe('P1');
    expect(structure.phases[0]?.detail.join('\n')).toContain('phase 1 behavior');
    expect(structure.phases[0]?.verification.join('\n')).toContain('proves phase 1 gate');
    expect(structure.workPlanPresent).toBe(true);
    expect(structure.nonGoals.join('\n')).toContain('out-of-scope');
  });

  it('parses a numbered Work Plan as one phase per item', () => {
    const plan = file('numbered.md');
    writeStructuredPlanFile(plan, 'Numbered Plan', { frontmatter: false });
    const structure = parsePlanStructure(plan);
    expect(structure.phases).toHaveLength(1);
    expect(structure.phases[0]?.id).toBe('P1');
    expect(structure.phases[0]?.name).toBe('Fixture step.');
  });

  it('parses a prose Work Plan as a single synthetic P1 phase', () => {
    const plan = file('synthetic.md');
    writeStructuredPlanFile(plan, 'Synthetic Plan', { frontmatter: false });
    const content = readFileSync(plan, 'utf8').replace(
      '1. Fixture step.',
      'Do the work as one prose block.',
    );
    writeFileSync(plan, content);
    const structure = parsePlanStructure(plan);
    expect(structure.phases).toHaveLength(1);
    expect(structure.phases[0]?.id).toBe('P1');
    expect(structure.workPlanPresent).toBe(true);
  });

  it('reports zero phases for an empty Work Plan', () => {
    const plan = file('empty-wp.md');
    writeStructuredPlanFile(plan, 'Empty WP', { frontmatter: false });
    const content = readFileSync(plan, 'utf8').replace('1. Fixture step.', '');
    writeFileSync(plan, content);
    const structure = parsePlanStructure(plan);
    expect(structure.phases).toHaveLength(0);
    expect(structure.workPlanPresent).toBe(false);
  });

  it('5-column Work Plan table: Effort column does not shift acceptanceGate extraction', () => {
    const plan = file('five-col.md');
    writeLargeStructuredPlanFile(plan, 'Five Col Plan', 3);
    const structure = parsePlanStructure(plan);
    expect(structure.phases).toHaveLength(3);
    expect(structure.phases[0]?.acceptanceGate).toContain('Phase 1 gate observable');
    expect(structure.phases[1]?.acceptanceGate).toContain('Phase 2 gate observable');
    expect(structure.phases[2]?.acceptanceGate).toContain('Phase 3 gate observable');
  });
});

describe('evaluateSplitDecision', () => {
  it('does not split a small plan under the size signal in auto mode', () => {
    const structure = parsePlanStructure(writeAndReturn(file('small.md'), 'Small'));
    const decision = evaluateSplitDecision(structure, knobs());
    expect(decision.split).toBe(false);
    expect(decision.signals.phaseCount).toBe(1);
  });

  it('splits when the size signal is exceeded in auto mode', () => {
    const structure = parsePlanStructure(writeAndReturn(file('over.md'), 'Over'));
    const decision = evaluateSplitDecision(structure, knobs({ maxPlanLines: 5 }));
    expect(decision.split).toBe(true);
    expect(decision.rationale).toContain('size signal');
  });

  it('splits a structurally complex plan in auto mode', () => {
    const plan = file('complex.md');
    writeLargeStructuredPlanFile(plan, 'Complex', 6);
    const decision = evaluateSplitDecision(
      parsePlanStructure(plan),
      knobs({ maxPlanLines: 100000 }),
    );
    expect(decision.split).toBe(true);
    expect(decision.rationale).toContain('phases');
  });

  it('always-override splits regardless of size', () => {
    const structure = parsePlanStructure(writeAndReturn(file('always.md'), 'Always'));
    const decision = evaluateSplitDecision(structure, knobs({ mode: 'always' }));
    expect(decision.split).toBe(true);
    expect(decision.rationale).toContain('always');
  });

  it('never-override keeps an over-size plan single-document with a recorded rationale', () => {
    const structure = parsePlanStructure(writeAndReturn(file('never.md'), 'Never'));
    const decision = evaluateSplitDecision(structure, knobs({ mode: 'never', maxPlanLines: 5 }));
    expect(decision.split).toBe(false);
    expect(decision.rationale).toContain('never');
    expect(decision.rationale).toContain('exceeds');
  });

  it('resolveSplitMode falls back to auto for unknown values', () => {
    expect(resolveSplitMode('always')).toBe('always');
    expect(resolveSplitMode('never')).toBe('never');
    expect(resolveSplitMode('auto')).toBe('auto');
    expect(resolveSplitMode(undefined)).toBe('auto');
    expect(resolveSplitMode('garbage')).toBe('auto');
  });
});

describe('emitPlanPackage', () => {
  it('emits a self-contained package from a Phase-table plan', () => {
    const plan = file('large.md');
    writeLargeStructuredPlanFile(plan, 'Large Plan', 6);
    const structure = parsePlanStructure(plan);
    const result = emitPlanPackage(work, plan, structure, splitFor(plan));
    expect(result.kind).toBe('emitted');
    if (result.kind !== 'emitted') {
      return;
    }
    for (const name of ['README.md', 'plan.md', 'run.md', 'journal.md', 'remaining-debt.md']) {
      expect(existsSync(path.join(result.paths.dir, name)), name).toBe(true);
    }
    expect(result.paths.phases).toHaveLength(6);
    // The package keeps plan.md byte-identical to the source final plan.
    expect(readFileSync(result.paths.plan).equals(readFileSync(plan))).toBe(true);
    for (const phaseFile of result.paths.phases) {
      const doc = readFileSync(phaseFile, 'utf8');
      for (const heading of PHASE_REQUIRED_HEADINGS) {
        expect(planHasHeading(phaseFile, heading), `${path.basename(phaseFile)} ${heading}`).toBe(
          true,
        );
      }
      expect(doc.toLowerCase()).not.toContain('read the full plan');
      expect(doc.toLowerCase()).not.toContain('read the master plan');
      expect(doc.toLowerCase()).not.toContain('plan.md end to end');
    }
    const readme = readFileSync(result.paths.readme, 'utf8');
    expect(readme).toContain('phase-1-phase-1-work.md');
    expect(readme).toContain('## Split Rationale');
  });

  it('keeps cross-refs intact for a P0-starting plan', () => {
    const plan = file('p0.md');
    writeLargeStructuredPlanFile(plan, 'P0 Plan', 3, 0);
    const structure = parsePlanStructure(plan);
    // Labels are preserved verbatim, never renumbered to 1-based.
    expect(structure.phases.map((phase) => phase.id)).toEqual(['P0', 'P1', 'P2']);
    const result = emitPlanPackage(work, plan, structure, splitFor(plan));
    expect(result.kind).toBe('emitted');
    if (result.kind !== 'emitted') {
      return;
    }
    // The label number drives the filename ordinal, so P0 -> phase-0-*.
    expect(readdirSync(result.paths.dir).some((name) => /^phase-0-.+\.md$/.test(name))).toBe(true);
    const health = validatePlanPackage(REPO_ROOT, result.paths.dir);
    expect(health.brokenCrossRefs).toBe(0);
    expect(health.ok).toBe(true);
    // Every README route resolves to a phase doc that exists on disk.
    const readme = readFileSync(result.paths.readme, 'utf8');
    const routed = [...readme.matchAll(/phase-\d+-[a-z0-9-]+\.md/g)].map((m) => m[0]);
    expect(routed.length).toBeGreaterThan(0);
    for (const name of routed) {
      expect(existsSync(path.join(result.paths.dir, name)), name).toBe(true);
    }
  });

  it('disambiguates colliding phase filenames instead of overwriting a doc', () => {
    const plan = file('dupe.md');
    writeFileSync(
      plan,
      [
        '# Dupe Plan',
        '',
        '## Work Plan',
        '',
        '| Phase | Touches | Depends on | Acceptance gate |',
        '| --- | --- | --- | --- |',
        '| P1 Same work | `src/a.ts` | requirements | gate |',
        '| P1 Same work | `src/b.ts` | requirements | gate |',
        '',
      ].join('\n'),
    );
    const structure = parsePlanStructure(plan);
    expect(structure.phases).toHaveLength(2);
    const result = emitPlanPackage(work, plan, structure, splitFor(plan));
    expect(result.kind).toBe('emitted');
    if (result.kind !== 'emitted') {
      return;
    }
    expect(result.paths.phases).toHaveLength(2);
    expect(new Set(result.paths.phases).size).toBe(2);
    for (const phaseFile of result.paths.phases) {
      expect(existsSync(phaseFile), phaseFile).toBe(true);
    }
  });

  it('emits a valid one-phase package when forcing a split of a numbered Work Plan', () => {
    const plan = file('numbered.md');
    writeStructuredPlanFile(plan, 'Numbered', { frontmatter: false });
    const structure = parsePlanStructure(plan);
    const result = emitPlanPackage(work, plan, structure, splitFor(plan));
    expect(result.kind).toBe('emitted');
    if (result.kind !== 'emitted') {
      return;
    }
    expect(result.paths.phases).toHaveLength(1);
    expect(validatePlanPackage(REPO_ROOT, result.paths.dir).ok).toBe(true);
  });

  it('writes no package for an empty Work Plan forced split', () => {
    const plan = file('empty.md');
    writeStructuredPlanFile(plan, 'Empty', { frontmatter: false });
    writeFileSync(plan, readFileSync(plan, 'utf8').replace('1. Fixture step.', ''));
    const structure = parsePlanStructure(plan);
    const result = emitPlanPackage(work, plan, structure, splitFor(plan));
    expect(result.kind).toBe('empty-work-plan');
    expect(existsSync(path.join(work, 'plan.package'))).toBe(false);
  });
});

describe('validatePlanPackage', () => {
  function emitValidPackage(): string {
    const plan = file('large.md');
    writeLargeStructuredPlanFile(plan, 'Validate Plan', 6);
    const structure = parsePlanStructure(plan);
    const result = emitPlanPackage(work, plan, structure, splitFor(plan));
    if (result.kind !== 'emitted') {
      throw new Error('expected emitted package');
    }
    return result.paths.dir;
  }

  it('accepts a well-formed package and writes package-findings.json separately', () => {
    writeFileSync(path.join(work, 'findings.json'), '{"sentinel":true}\n');
    const dir = emitValidPackage();
    const health = validatePlanPackage(REPO_ROOT, dir);
    expect(health.ok).toBe(true);
    expect(health.references).toEqual({ stale: 0, ambiguous: 0, unresolved: 0 });
    expect(existsSync(path.join(work, PACKAGE_FINDINGS_FILE))).toBe(true);
    // final-plan findings.json is never overwritten by package validation.
    expect(readFileSync(path.join(work, 'findings.json'), 'utf8')).toContain('sentinel');
  });

  it('flags a missing required file', () => {
    const dir = emitValidPackage();
    rmSync(path.join(dir, 'remaining-debt.md'));
    expect(validatePlanPackage(REPO_ROOT, dir).missingFiles).toBeGreaterThan(0);
  });

  it('flags a missing required heading', () => {
    const dir = emitValidPackage();
    writeFileSync(
      path.join(dir, 'journal.md'),
      '# Journal\n\n## Current State\n- only this heading.\n',
    );
    expect(validatePlanPackage(REPO_ROOT, dir).missingHeadings).toBeGreaterThan(0);
  });

  it('flags a broken cross-reference', () => {
    const dir = emitValidPackage();
    appendFileSync(path.join(dir, 'README.md'), '\nDangling route to P99.\n');
    expect(validatePlanPackage(REPO_ROOT, dir).brokenCrossRefs).toBeGreaterThan(0);
  });

  it('flags a destructive-git shell block in a phase doc', () => {
    const dir = emitValidPackage();
    const phase = readdirSync(dir).find((name) => name.startsWith('phase-1-'));
    appendFileSync(path.join(dir, phase ?? ''), '\n```bash\ngit reset --hard HEAD~1\n```\n');
    expect(validatePlanPackage(REPO_ROOT, dir).forbiddenShell).toBeGreaterThan(0);
  });

  it('mines a stale phase-doc reference into package-findings.json', () => {
    const dir = emitValidPackage();
    const phase = readdirSync(dir).find((name) => name.startsWith('phase-1-'));
    appendFileSync(path.join(dir, phase ?? ''), '\n- Stale anchor: `package.json:99999`.\n');
    const health = validatePlanPackage(REPO_ROOT, dir);
    expect(health.references.stale).toBeGreaterThan(0);
    const findings = JSON.parse(readFileSync(path.join(work, PACKAGE_FINDINGS_FILE), 'utf8')) as {
      stale_lines: unknown[];
    };
    expect(findings.stale_lines.length).toBeGreaterThan(0);
  });

  it('reports a blocking empty-work-plan health when the package directory is absent', () => {
    const health = validatePlanPackage(REPO_ROOT, path.join(work, 'plan.package'));
    expect(health.ok).toBe(false);
    expect(health.emptyWorkPlan).toBe(true);
  });
});
