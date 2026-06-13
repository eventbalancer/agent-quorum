import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizePlanDocument,
  planDocumentShapeHealth,
  planFirstTitleLine,
  planHasImpactGraphMermaid,
  planHasTitleHeading,
  requirePlanDocumentShape,
} from '../../src/stages/plan/plan-shape.js';
import { HaltError } from '../../src/runtime/halt.js';
import { captureStderr, writeStructuredPlanFile } from '../helpers/harness.js';

let tmp: string;

function file(name: string): string {
  return path.join(tmp, name);
}

function requireShapeStatus(target: string): number {
  const capture = captureStderr();
  try {
    requirePlanDocumentShape(target);
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

function normalizeQuiet(target: string): void {
  const capture = captureStderr();
  try {
    normalizePlanDocument(target);
  } finally {
    capture.restore();
  }
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-shapetest.'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('plan shape gates', () => {
  it('plan_document_shape_health accepts structured plans', () => {
    const target = file('shape.md');
    writeStructuredPlanFile(target, 'Shape');
    expect(planDocumentShapeHealth(target)).toEqual({ missing: 0, graph: 1 });
  });

  it('exported plan_has_impact_graph_mermaid detects the mermaid block', () => {
    const ok = file('mermaid.md');
    writeStructuredPlanFile(ok, 'Mermaid');
    expect(planHasImpactGraphMermaid(ok)).toBe(true);

    const missing = file('no-mermaid.md');
    writeFileSync(missing, '# Plan\n\n## Impact Graph\n\nProse only, no fenced diagram.\n');
    expect(planHasImpactGraphMermaid(missing)).toBe(false);
  });

  it('require_plan_document_shape rejects incomplete plans', () => {
    const target = file('bad.md');
    writeFileSync(target, '# Summary\n\n## Context\nOnly a summary.\n');
    expect(requireShapeStatus(target)).toBe(4);
  });

  it('require_plan_document_shape rejects wrapped plans', () => {
    const target = file('wrapped.md');
    const body = file('body.md');
    writeStructuredPlanFile(body, 'Wrapped');
    writeFileSync(target, `Wrapper text before the plan.\n\n${readFileSync(body, 'utf8')}`);
    expect(requireShapeStatus(target)).toBe(4);
  });

  it('normalize_plan_document strips preamble and heals the shape gate', () => {
    const target = file('preamble.md');
    const body = file('healed-body.md');
    writeStructuredPlanFile(body, 'Healed');
    writeFileSync(
      target,
      "The Write tool isn't available in this context, resolving R1's bare `package.json:31`.\n\n" +
        "I've verified the three remaining points against the code:\n\n" +
        readFileSync(body, 'utf8'),
    );

    normalizeQuiet(target);

    expect(existsSync(`${target}.raw`)).toBe(true);
    expect(planHasTitleHeading(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).not.toContain('Write tool');
    expect(requireShapeStatus(target)).toBe(0);
  });

  it('normalize_plan_document splits an inline title glued to line 1 preamble', () => {
    const target = file('inline-title.md');
    const body = file('inline-body.md');
    writeStructuredPlanFile(body, 'Inline Title');
    writeFileSync(
      target,
      `Reviewing repository structure before creating the plan.${readFileSync(body, 'utf8')}`,
    );

    normalizeQuiet(target);

    expect(existsSync(`${target}.raw`)).toBe(true);
    expect(planHasTitleHeading(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).not.toContain('Reviewing repository structure');
    expect(readFileSync(`${target}.raw`, 'utf8')).toContain('Reviewing repository structure');
    expect(requireShapeStatus(target)).toBe(0);
  });

  it('normalize_plan_document is a no-op on a clean plan', () => {
    const target = file('clean.md');
    writeStructuredPlanFile(target, 'Clean');
    const before = readFileSync(target, 'utf8');

    normalizeQuiet(target);

    expect(existsSync(`${target}.raw`)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe(before);
  });
});

describe('title and fence detection', () => {
  it('skips a heading inside a code fence', () => {
    const target = file('fenced-heading.md');
    writeFileSync(target, 'Intro prose.\n```\n# Not the title\n```\n# Real Title\n');
    expect(planFirstTitleLine(target)).toBe(5);
  });

  it('ignores a heading that lives only inside a mermaid fence', () => {
    const target = file('mermaid-only.md');
    writeFileSync(target, 'Some prose.\n```mermaid\n# looks-like-a-heading\n```\nMore prose.\n');
    expect(planFirstTitleLine(target)).toBeUndefined();
  });

  it('recognizes a plain four-backtick fence', () => {
    const target = file('four-backtick.md');
    writeFileSync(target, 'Preamble.\n````\n# fenced by four backticks\n````\n# Real Title\n');
    expect(planFirstTitleLine(target)).toBe(5);
  });

  it('matches a CRLF title', () => {
    const target = file('crlf.md');
    writeFileSync(target, '# Title\r\n## Context\r\n');
    expect(planFirstTitleLine(target)).toBe(1);
  });

  it('matches a multibyte UTF-8 title', () => {
    const target = file('utf8.md');
    writeFileSync(target, '# Heading\n## Context\n');
    expect(planFirstTitleLine(target)).toBe(1);
  });

  it('skips quoted and indented pre-title lines', () => {
    const target = file('indented.md');
    writeFileSync(target, '> quoted preamble\n    # indented not-a-title\n# Real Title\n');
    expect(planFirstTitleLine(target)).toBe(3);
  });

  it('overwrites a pre-existing .raw sidecar (F-SHAPE-5)', () => {
    const target = file('raw-overwrite.md');
    const body = file('raw-body.md');
    writeStructuredPlanFile(body, 'Raw Overwrite');
    writeFileSync(target, `Leaked preamble.\n\n${readFileSync(body, 'utf8')}`);
    writeFileSync(`${target}.raw`, 'STALE RAW\n');

    normalizeQuiet(target);

    expect(planHasTitleHeading(target)).toBe(true);
    expect(readFileSync(`${target}.raw`, 'utf8')).not.toContain('STALE RAW');
    expect(readFileSync(`${target}.raw`, 'utf8')).toContain('Leaked preamble');
  });
});

describe('documented current-behavior limitations', () => {
  it('documents the BOM-before-title limitation (F-SHAPE-2)', () => {
    const target = file('bom.md');
    writeFileSync(target, '\ufeff# Title\n## Context\n');
    expect(planFirstTitleLine(target)).toBeUndefined();
    normalizeQuiet(target);
    expect(existsSync(`${target}.raw`)).toBe(false);
  });

  it('documents the unbalanced-preamble-fence limitation (F-SHAPE-3)', () => {
    const target = file('unbalanced-fence.md');
    writeFileSync(target, 'Preamble with a stray fence:\n```\n# Real Title\n## Context\n');
    expect(planFirstTitleLine(target)).toBeUndefined();
  });

  it('documents the tilde-fence limitation (F-SHAPE-4)', () => {
    const target = file('tilde-fence.md');
    writeFileSync(target, 'Intro.\n~~~\n# inside a tilde fence\n~~~\n# Real Title\n');
    expect(planFirstTitleLine(target)).toBe(3);
  });
});
