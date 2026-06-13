import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractPlanCodeSpans, validateFinalPlan } from '../../src/stages/plan/validate-plan.js';
import { HaltError } from '../../src/runtime/halt.js';
import { captureStderr } from '../helpers/harness.js';

let tmp: string;
let projectRoot: string;

interface Findings {
  stale_lines: StaleLineFinding[];
  ambiguous: AmbiguousFinding[];
  unresolved: UnresolvedFinding[];
}

interface StaleLineFinding {
  file: string;
  line: number;
  actual_lines: number;
}

interface AmbiguousFinding {
  file: string;
  line: number;
  candidates: string[];
}

interface UnresolvedFinding {
  file: string;
  line: number;
}

function setupProject(): void {
  projectRoot = path.join(tmp, 'project');
  mkdirSync(path.join(projectRoot, 'nested', 'sub'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'a'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'b'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'direct.md'), 'one\n');
  writeFileSync(path.join(projectRoot, 'nested', 'sub', 'suffix.md'), 'one\n');
  writeFileSync(path.join(projectRoot, 'nested', 'only.md'), 'one\n');
  writeFileSync(path.join(projectRoot, 'a', 'dupe.ts'), 'one\n');
  writeFileSync(path.join(projectRoot, 'b', 'dupe.ts'), 'one\n');
  writeFileSync(path.join(projectRoot, 'stale.md'), 'one\n');
}

function runValidate(plan: string): number {
  const capture = captureStderr();
  try {
    validateFinalPlan(projectRoot, plan);
    return 0;
  } catch (error) {
    if (error instanceof HaltError) {
      return error.exitCode;
    }
    throw error;
  } finally {
    capture.restore();
  }
}

function readFindings(): Findings {
  return JSON.parse(readFileSync(path.join(tmp, 'findings.json'), 'utf8')) as Findings;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-validatetest.'));
  setupProject();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('validate_final_plan', () => {
  it('writes grouped reference findings', () => {
    const plan = path.join(tmp, 'plan.final.md');
    writeFileSync(
      plan,
      '# Plan\n\nReferences: `direct.md:1`, `sub/suffix.md:1`, `only.md:1`, `dupe.ts:1`, `missing.md:4`, `stale.md:9`, `src/*.ts:1`.\n',
    );

    expect(runValidate(plan)).toBe(0);

    const findings = readFindings();
    expect(findings.stale_lines).toHaveLength(1);
    expect(findings.stale_lines[0]).toEqual({ file: 'stale.md', line: 9, actual_lines: 1 });
    expect(findings.ambiguous).toHaveLength(1);
    expect(findings.ambiguous[0]?.file).toBe('dupe.ts');
    expect(findings.ambiguous[0]?.candidates).toHaveLength(2);
    expect(findings.unresolved).toHaveLength(1);
    expect(findings.unresolved[0]?.file).toBe('missing.md');
  });

  it('exits 5 on workspace-rule violations', () => {
    const plan = path.join(tmp, 'violating.final.md');
    writeFileSync(plan, '# Plan\n\n```sh\npnpm -r test\n```\n');
    expect(runValidate(plan)).toBe(5);
  });

  it('exits 5 on the tightened destructive-git patterns', () => {
    const reset = path.join(tmp, 'reset.final.md');
    writeFileSync(reset, '# Plan\n\n```bash\ngit reset --hard HEAD~1\n```\n');
    expect(runValidate(reset)).toBe(5);

    const checkout = path.join(tmp, 'checkout.final.md');
    writeFileSync(checkout, '# Plan\n\n```bash\ngit checkout -- src/index.ts\n```\n');
    expect(runValidate(checkout)).toBe(5);
  });

  it('ignores prose-only references', () => {
    const plan = path.join(tmp, 'prose.final.md');
    writeFileSync(
      plan,
      '# Plan\n\nThe reviewer flagged a stale stale.md:9 reference in prose, but the real\nreference lives in code: `direct.md:1`.\n',
    );

    expect(runValidate(plan)).toBe(0);

    const findings = readFindings();
    expect(findings.stale_lines).toHaveLength(0);
    expect(findings.ambiguous).toHaveLength(0);
    expect(findings.unresolved).toHaveLength(0);
  });

  it('walks adjacent spans and drops the unbalanced tail', () => {
    const file = path.join(tmp, 'spans.md');
    writeFileSync(
      file,
      '# Plan\n\nAdjacent: `a.md:1``b.md:2`. Unbalanced: `c.md:3`d.md:4`e.md:5.\n',
    );
    const spans = extractPlanCodeSpans(file).sort();
    expect(spans.filter((span) => span !== '')).toEqual(['a.md:1', 'b.md:2', 'c.md:3']);
  });

  it('documents the variable-length-fence limitation (F-SHAPE-4)', () => {
    const file = path.join(tmp, 'varfence.md');
    writeFileSync(
      file,
      '# Plan\n\n````\nfenced.ts:1 stays code\n```\nafter.ts:2 is prose with `inline.ts:3`\n````\n',
    );
    expect(extractPlanCodeSpans(file)).toContain('inline.ts:3');
  });

  it('tolerates zero-padded and zero line numbers (F-VAL-1)', () => {
    const plan = path.join(tmp, 'padded.final.md');
    writeFileSync(plan, '# Plan\n\nRefs: `missing.md:08`, `stale.md:0`, `stale.md:00`.\n');

    expect(runValidate(plan)).toBe(0);

    const findings = readFindings();
    expect(findings.unresolved).toHaveLength(1);
    expect(findings.unresolved[0]).toEqual({ file: 'missing.md', line: 8 });
    expect(findings.stale_lines.map((entry) => entry.line).sort()).toEqual([0, 0]);
  });
});
