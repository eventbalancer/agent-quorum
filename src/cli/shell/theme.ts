import type { RunState } from '../../core/run-store.js';

// SGR style parameters (non-color): reset, bold, dim, and the reverse-video used
// by focused single-color form fields. Color parameters are drawn only from the
// 16-color foreground set (30-37, 90-97), never 256-color or truecolor, so the
// frame stays within the AC-15 palette.
export const RESET = '0';
export const BOLD = '1';
export const DIM = '2';
export const REVERSE = '7';

// Accent foreground (blue), a 16-color slot used for the header/breadcrumb and the
// refresh indicator.
export const ACCENT = '34';

export interface StatusStyle {
  readonly glyph: string;
  readonly label: string;
  readonly code: string;
}

// One style per RunState. Glyph and label both carry the status meaning so a
// mono terminal stays legible (FR-3). Color codes are pairwise distinct for the
// running/finished/failed trio asserted by AC-2.
export const STATUS_STYLES: Record<RunState, StatusStyle> = {
  running: { glyph: '●', label: 'running', code: '36' },
  finished: { glyph: '✓', label: 'finished', code: '32' },
  failed: { glyph: '✗', label: 'failed', code: '31' },
  blocked: { glyph: '⏸', label: 'blocked', code: '33' },
};

export const GLYPH = {
  cursor: '❯',
  crumb: '›',
  group: '▸',
  refresh: '⟳',
  ellipsis: '…',
  present: '✓',
  absent: '—',
} as const;

export function paint(text: string, code: string, color: boolean): string {
  return color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export function bold(text: string, color: boolean): string {
  return paint(text, BOLD, color);
}

export function dim(text: string, color: boolean): string {
  return paint(text, DIM, color);
}

export function reverse(text: string, color: boolean): string {
  return paint(text, REVERSE, color);
}

const OSC8 = '\x1b]8;;';
const OSC8_ST = '\x1b\\';
const OSC8_CLOSE = `${OSC8}${OSC8_ST}`;

export function link(text: string, target: string, color: boolean): string {
  if (!color) {
    return text;
  }
  return `${OSC8}${target}${OSC8_ST}${text}${OSC8_CLOSE}`;
}
