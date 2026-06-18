import { describe, expect, it } from 'vitest';
import {
  fitLine,
  middleEllipsis,
  padCell,
  relativeTime,
  statusLine,
  stripAnsi,
  truncateName,
  visibleWidth,
} from '../../src/cli/shell/format.js';
import {
  ACCENT,
  BOLD,
  DIM,
  GLYPH,
  paint,
  RESET,
  REVERSE,
  STATUS_STYLES,
} from '../../src/cli/shell/theme.js';

const ESC = String.fromCharCode(27);
const NOW = Date.parse('2026-06-18T12:00:00Z');

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe('format — padding and width', () => {
  it('measures visible width ignoring ANSI', () => {
    expect(visibleWidth('abc')).toBe(3);
    expect(visibleWidth(`${ESC}[36mabc${ESC}[0m`)).toBe(3);
  });

  it('right-pads short cells and leaves long ones intact', () => {
    expect(padCell('ab', 5)).toBe('ab   ');
    expect(padCell('abcdef', 3)).toBe('abcdef');
  });

  it('right-truncates names with a trailing ellipsis only when over width', () => {
    expect(truncateName('short', 10)).toBe('short');
    expect(truncateName('a-very-long-name', 6)).toBe('a-ver…');
    expect(truncateName('x', 1)).toBe('x');
    expect(truncateName('xyz', 1)).toBe('…');
    expect(truncateName('xyz', 0)).toBe('');
  });
});

describe('format — middleEllipsis (AC-6)', () => {
  it('returns a fitting path unchanged', () => {
    expect(middleEllipsis('/tmp/work', 20)).toBe('/tmp/work');
  });

  it('elides the middle preserving head and tail at exactly the width', () => {
    const path = '/home/user/projects/agent-quorum/work/loop-demo';
    const out = middleEllipsis(path, 21);
    expect(out).toHaveLength(21);
    expect(out).toContain('…');
    expect(out.startsWith('/home/user')).toBe(true);
    expect(out.endsWith('loop-demo')).toBe(true);
  });

  it('degrades gracefully at tiny widths', () => {
    expect(middleEllipsis('abcdef', 1)).toBe('…');
    expect(middleEllipsis('abcdef', 0)).toBe('');
    expect(middleEllipsis('abcdef', 2)).toHaveLength(2);
  });
});

describe('format — relativeTime (AC-7)', () => {
  it('buckets recent ages without seconds or a trailing Z', () => {
    expect(relativeTime(ago(30_000), NOW)).toBe('just now');
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe('5m ago');
    expect(relativeTime(ago(3 * 60 * 60_000), NOW)).toBe('3h ago');
    expect(relativeTime(ago(2 * 24 * 60 * 60_000), NOW)).toBe('2d ago');
  });

  it('falls back to YYYY-MM-DD past seven days', () => {
    const out = relativeTime('2026-06-01T00:00:00Z', NOW);
    expect(out).toBe('2026-06-01');
    expect(out).not.toContain('Z');
    expect(out).not.toContain(':');
  });

  it('maps an unparsable timestamp to the bounded token, never the raw input', () => {
    const huge = 'not-a-timestamp'.repeat(10);
    expect(relativeTime(huge, NOW)).toBe('—');
    expect(relativeTime('', NOW)).toBe('—');
  });

  it('never exceeds ten characters and is stable for a fixed now', () => {
    const inputs = [
      ago(0),
      ago(59_000),
      ago(59 * 60_000),
      ago(23 * 60 * 60_000),
      ago(6 * 24 * 60 * 60_000),
      ago(400 * 24 * 60 * 60_000),
      'garbage',
    ];
    for (const iso of inputs) {
      const out = relativeTime(iso, NOW);
      expect(out.length).toBeLessThanOrEqual(10);
      expect(relativeTime(iso, NOW)).toBe(out);
    }
  });
});

describe('format — statusLine single-line guarantee (AC-11)', () => {
  it('collapses embedded newlines and whitespace runs to one line', () => {
    const message = 'resume: ambiguous workdir\n  candidate a\n\n  candidate b';
    const out = statusLine(message, 80);
    expect(out).not.toContain('\n');
    expect(out).toBe('resume: ambiguous workdir candidate a candidate b');
  });

  it('strips ANSI and fits within the column budget', () => {
    const out = statusLine(`${ESC}[31m${'x'.repeat(120)}${ESC}[0m`, 40);
    expect(out).toHaveLength(40);
    expect(out).not.toContain(ESC);
  });
});

describe('format — fitLine narrow-terminal safety net', () => {
  it('keeps a fitting line and strips a painted overflowing line', () => {
    const painted = `${ESC}[36m${'y'.repeat(100)}${ESC}[0m`;
    expect(fitLine('short', 80)).toBe('short');
    const cut = fitLine(painted, 20);
    expect(cut).toHaveLength(20);
    expect(cut).not.toContain(ESC);
  });
});

describe('theme — palette parameters (AC-15)', () => {
  const COLOR_SLOTS = new Set<number>([
    30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97,
  ]);
  const STYLE_SLOTS = new Set([RESET, BOLD, DIM, REVERSE]);

  it('draws every status and accent color from the 16-color foreground set', () => {
    const codes = [...Object.values(STATUS_STYLES).map((s) => s.code), ACCENT];
    for (const code of codes) {
      expect(/^[0-9]{2}$/.test(code)).toBe(true);
      expect(code).not.toContain('38;5');
      expect(code).not.toContain('38;2');
      expect(COLOR_SLOTS.has(Number(code))).toBe(true);
    }
  });

  it('keeps the running/finished/failed color codes pairwise distinct', () => {
    const trio = [
      STATUS_STYLES.running.code,
      STATUS_STYLES.finished.code,
      STATUS_STYLES.failed.code,
    ];
    expect(new Set(trio).size).toBe(3);
  });

  it('uses only 0/1/2/7 as style parameters', () => {
    expect(STYLE_SLOTS).toEqual(new Set(['0', '1', '2', '7']));
    for (const code of STYLE_SLOTS) {
      expect(['0', '1', '2', '7']).toContain(code);
    }
  });

  it('paints a span only when color is enabled and strips back to the bare text', () => {
    expect(paint('hi', STATUS_STYLES.failed.code, false)).toBe('hi');
    const painted = paint('hi', STATUS_STYLES.failed.code, true);
    expect(painted).toBe(`${ESC}[31mhi${ESC}[0m`);
    expect(stripAnsi(painted)).toBe('hi');
  });

  it('exposes single-BMP-width glyphs for status and markers', () => {
    const glyphs = [...Object.values(STATUS_STYLES).map((s) => s.glyph), ...Object.values(GLYPH)];
    for (const glyph of glyphs) {
      expect(glyph.length).toBe(1);
      expect(glyph.codePointAt(0) ?? 0).toBeLessThanOrEqual(0xffff);
    }
  });
});
