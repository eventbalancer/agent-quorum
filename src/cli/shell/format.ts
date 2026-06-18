const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
// OSC 8 hyperlink wrapper, terminated by BEL or ST (ESC \). Stripped so width
// math counts only the visible link text, never the URI bytes.
const OSC8_PATTERN = new RegExp(`${ESC}\\]8;[^${ESC}${BEL}]*(?:${BEL}|${ESC}\\\\)`, 'g');

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const RELATIVE_DAYS = 7;
const ISO_DATE_LENGTH = 10;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '').replace(OSC8_PATTERN, '');
}

// Width in terminal cells, assuming each post-strip code unit is a single BMP
// glyph; all shell content and glyphs satisfy that.
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

export function padCell(plain: string, width: number): string {
  return plain.length >= width ? plain : plain + ' '.repeat(width - plain.length);
}

export function truncateName(plain: string, width: number): string {
  if (plain.length <= width) {
    return plain;
  }
  if (width <= 0) {
    return '';
  }
  if (width === 1) {
    return '…';
  }
  return `${plain.slice(0, width - 1)}…`;
}

// Keeps the leading and trailing segments visible, eliding the middle, so long
// paths stay recognizable head and tail (AC-6). The result is exactly `width`
// when elision happens.
export function middleEllipsis(text: string, width: number): string {
  if (text.length <= width) {
    return text;
  }
  if (width <= 0) {
    return '';
  }
  if (width === 1) {
    return '…';
  }
  const head = Math.ceil((width - 1) / 2);
  const tail = Math.floor((width - 1) / 2);
  const tailPart = tail === 0 ? '' : text.slice(text.length - tail);
  return `${text.slice(0, head)}…${tailPart}`;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, ISO_DATE_LENGTH);
}

// Compact relative form for the dashboard time column: never seconds, never a
// trailing `Z`, never longer than 10 chars, and an unparsable input maps to the
// bounded token `—` rather than the raw value (AC-7). `nowMs` is injected so the
// result is deterministic.
export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return '—';
  }
  const delta = nowMs - then;
  if (delta < MINUTE_MS) {
    return 'just now';
  }
  if (delta < HOUR_MS) {
    return `${Math.floor(delta / MINUTE_MS)}m ago`;
  }
  if (delta < DAY_MS) {
    return `${Math.floor(delta / HOUR_MS)}h ago`;
  }
  if (delta < RELATIVE_DAYS * DAY_MS) {
    return `${Math.floor(delta / DAY_MS)}d ago`;
  }
  return isoDate(then);
}

// Collapses interior whitespace and newline runs to single spaces before fitting,
// guaranteeing one physical line so a multiline captured stderr folded into the
// status message can never spill into extra frame rows (NFR-4).
export function statusLine(message: string, cols: number): string {
  const plain = stripAnsi(message).replace(/\s+/g, ' ').trim();
  return plain.length <= cols ? plain : plain.slice(0, Math.max(0, cols));
}

// Narrow-terminal safety net: when a composed (possibly painted) line exceeds
// `cols`, fall back to a plain slice so a truncation never splits an ANSI escape.
export function fitLine(line: string, cols: number): string {
  return visibleWidth(line) > cols ? stripAnsi(line).slice(0, Math.max(0, cols)) : line;
}
