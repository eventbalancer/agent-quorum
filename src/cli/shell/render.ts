import type { RunState } from '../../core/run-store.js';
import type { RunDetailView, RunRow } from './data.js';
import type { ShellState } from './model.js';
import {
  fitLine,
  middleEllipsis,
  padCell,
  relativeTime,
  statusLine,
  stripAnsi,
  truncateName,
  visibleWidth,
} from './format.js';
import { ACCENT, bold, dim, GLYPH, paint, reverse, STATUS_STYLES } from './theme.js';

export interface Viewport {
  readonly cols: number;
  readonly rows: number;
}

export interface RenderOptions {
  readonly color: boolean;
  readonly now: number;
}

export const DEFAULT_VIEWPORT: Viewport = { cols: 80, rows: 24 };

const FOOTERS: Record<ShellState['view'], string> = {
  dashboard: 'j/k move · enter detail · n new · r refresh · q quit · ? help',
  detail: 'l logs · i intervene · s stop · r refresh · b back · q quit',
  log: 'b back · q quit',
  launch: 'tab/↑↓ field · space/←→ toggle · enter launch · esc cancel',
  intervene: 'tab field · space/←→ target · type message · enter send · esc cancel',
  stop: 'type the run name · enter confirm · esc cancel',
};

// Dashboard column model. FIXED is every fixed-width slot except the name and
// time columns; reserving TIME_W for the widest relative form (YYYY-MM-DD) keeps
// the trailing time column from ever overflowing the line (NFR-4).
const INDENT = 2;
const STATUS_LABEL_W = 8;
const STATUS_W = 1 + 1 + STATUS_LABEL_W;
const RUNID_W = 12;
const TIME_W = 10;
const NAME_MIN = 6;
const NAME_MAX = 28;
const FIXED = INDENT + 1 + 1 + STATUS_W + 1 + 1 + RUNID_W + 1;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function nameWidth(maxName: number, cols: number): number {
  return Math.min(NAME_MAX, clamp(maxName, NAME_MIN, cols - FIXED - TIME_W));
}

function breadcrumb(state: ShellState): readonly string[] {
  const name = state.detail?.record.name ?? 'run';
  switch (state.view) {
    case 'dashboard':
      return ['Dashboard'];
    case 'detail':
      return ['Dashboard', name];
    case 'log':
      return ['Dashboard', name, 'Logs'];
    case 'launch':
      return ['Dashboard', 'Launch'];
    case 'intervene':
      return ['Dashboard', name, 'Intervene'];
    case 'stop':
      return ['Dashboard', name, 'Stop'];
    default: {
      state.view satisfies never;
      return ['Dashboard'];
    }
  }
}

function headerLine(state: ShellState, cols: number, color: boolean): string {
  const left = ['agent-quorum', ...breadcrumb(state)].join(` ${GLYPH.crumb} `);
  const painted = bold(paint(left, ACCENT, color), color);
  if (!state.refreshing) {
    return painted;
  }
  const gap = Math.max(1, cols - visibleWidth(left) - 1);
  return `${painted}${' '.repeat(gap)}${paint(GLYPH.refresh, ACCENT, color)}`;
}

function statusArea(state: ShellState, cols: number, color: boolean): string {
  const normalized = statusLine(state.statusMessage, cols);
  if (normalized === '') {
    return state.refreshing ? paint(`${GLYPH.refresh} refreshing…`, ACCENT, color) : '';
  }
  return paint(normalized, ACCENT, color);
}

function statusCell(state: RunState, color: boolean): string {
  const style = STATUS_STYLES[state];
  return paint(`${style.glyph} ${padCell(style.label, STATUS_LABEL_W)}`, style.code, color);
}

function dashboardRow(
  row: RunRow,
  selected: boolean,
  nameW: number,
  now: number,
  color: boolean,
): string {
  const mark = selected ? GLYPH.cursor : ' ';
  const status = statusCell(row.state, color);
  const namePlain = padCell(truncateName(row.name, nameW), nameW);
  const name = selected ? bold(namePlain, color) : namePlain;
  const runId = dim(padCell(row.shortRunId, RUNID_W), color);
  const iso = row.isLive ? row.startedAt : (row.endedAt ?? row.startedAt);
  const time = padCell(relativeTime(iso, now).slice(0, TIME_W), TIME_W);
  return `${' '.repeat(INDENT)}${mark} ${status} ${name} ${runId} ${time}`;
}

function emptyDashboard(color: boolean): string[] {
  return [
    paint('No agent-quorum runs yet.', ACCENT, color),
    dim('Press n to launch your first run.', color),
  ];
}

function dashboardBody(state: ShellState, cols: number, color: boolean, now: number): string[] {
  const rows = state.groups.flatMap((group) => group.runs);
  if (rows.length === 0) {
    return emptyDashboard(color);
  }
  const maxName = Math.max(...rows.map((row) => row.name.length));
  const nameW = nameWidth(maxName, cols);
  const lines: string[] = [];
  let index = 0;
  for (const group of state.groups) {
    lines.push(dim(`${GLYPH.group} ${group.label}`, color));
    for (const row of group.runs) {
      lines.push(dashboardRow(row, index === state.cursor, nameW, now, color));
      index += 1;
    }
  }
  return lines;
}

function detailBody(detail: RunDetailView, cols: number, color: boolean): string[] {
  const { record } = detail;
  const style = STATUS_STYLES[detail.state];
  const badge = paint(`${style.glyph} ${style.label}`, style.code, color);
  const workPrefix = 'work: ';
  const logPrefix = 'log:  ';
  const workRoom = Math.max(0, cols - workPrefix.length);
  const logRoom = Math.max(0, cols - logPrefix.length);
  const timing =
    record.endedAt !== undefined
      ? `started ${record.startedAt}  ended ${record.endedAt}`
      : `started ${record.startedAt}`;
  const eventText = `Last event: ${detail.lastEvent === '' ? GLYPH.absent : detail.lastEvent}`;
  const isFailureState = detail.state === 'failed' || detail.state === 'blocked';
  const lines: string[] = [
    `${bold(record.name, color)}  ${badge}`,
    dim(`runId: ${record.runId}`, color),
    dim(`${workPrefix}${middleEllipsis(record.workDir, workRoom)}`, color),
    dim(`${logPrefix}${middleEllipsis(record.logPath, logRoom)}`, color),
    dim(timing, color),
    `artifacts: plan.final=${detail.artifacts.planFinal ? GLYPH.present : GLYPH.absent}  summary=${detail.artifacts.summary ? GLYPH.present : GLYPH.absent}  iterations=${detail.iterations}`,
    `interventions: total=${detail.interventions.total} active=${detail.interventions.active} migrated=${detail.interventions.migrated}`,
    isFailureState ? paint(eventText, style.code, color) : eventText,
    '',
    bold('Process', color),
  ];
  if (detail.process.available) {
    for (const raw of detail.process.captured.split('\n')) {
      const plain = stripAnsi(raw);
      if (plain.trim() !== '') {
        lines.push(dim(`  ${plain}`, color));
      }
    }
  } else {
    lines.push(dim('  process info unavailable — run is not live or status is unreachable', color));
  }
  return lines;
}

function logBody(state: ShellState, cols: number, color: boolean, bodyHeight: number): string[] {
  const name = state.detail?.record.name ?? 'run';
  if (!state.log.available) {
    return [
      bold(`log: ${name}`, color),
      dim('no run.log — streamed to its console or not started yet', color),
    ];
  }
  const marker = state.log.following ? 'following' : 'stopped (terminal)';
  const header = `${bold(`log: ${name}`, color)}  ${dim(`(${marker})`, color)}`;
  const room = Math.max(0, bodyHeight - 1);
  const tail = state.log.lines.slice(-room).map((line) => `  ${line}`);
  return [header, ...tail];
}

const FORM_LABEL_W = 10;

type FormField = readonly [label: string, value: string];

function formField(
  label: string,
  value: string,
  focused: boolean,
  cols: number,
  color: boolean,
): string {
  const mark = focused ? GLYPH.cursor : ' ';
  const line = `${' '.repeat(INDENT)}${mark} ${padCell(label, FORM_LABEL_W)} ${value}`;
  const clipped = line.length > cols ? line.slice(0, cols) : line;
  return focused ? reverse(padCell(clipped, cols), color) : clipped;
}

function launchBody(state: ShellState, cols: number, color: boolean): string[] {
  const form = state.launch;
  const fields: readonly FormField[] = [
    ['input', form.input === '' ? '(required)' : form.input],
    ['mode', form.promptMode ? 'prompt' : 'plan'],
    ['resume', form.resume ? 'on' : 'off'],
    ['iters', form.iters === '' ? '(default)' : form.iters],
    ['effort', form.effort],
    ['fix', form.fix],
    ['locale', form.locale === '' ? '(default)' : form.locale],
    ['translate', form.translate],
  ];
  return [
    dim('Launch a new run', color),
    ...fields.map(([label, value], index) =>
      formField(label, value, index === form.field, cols, color),
    ),
  ];
}

function interveneBody(state: ShellState, cols: number, color: boolean): string[] {
  const form = state.intervene;
  const name = state.detail?.record.name ?? 'run';
  const fields: readonly FormField[] = [
    ['target', form.target],
    ['message', form.message === '' ? '(type a message)' : form.message],
  ];
  return [
    dim(`Intervene in ${name}`, color),
    ...fields.map(([label, value], index) =>
      formField(label, value, index === form.field, cols, color),
    ),
  ];
}

function stopBody(state: ShellState, cols: number, color: boolean): string[] {
  const record = state.detail?.record;
  if (record === undefined) {
    return [dim('No run selected', color)];
  }
  const style = STATUS_STYLES[state.detail?.state ?? 'running'];
  return [
    `${bold(`Stop ${record.name}`, color)}  ${paint(`${style.glyph} ${style.label}`, style.code, color)}`,
    dim(`affordance: kill -TERM -${record.pgid}`, color),
    dim('liveness is re-checked immediately before signaling', color),
    formField('name', state.stop.typed, true, cols, color),
  ];
}

function buildBody(
  state: ShellState,
  cols: number,
  color: boolean,
  now: number,
  bodyHeight: number,
): string[] {
  switch (state.view) {
    case 'dashboard':
      return dashboardBody(state, cols, color, now);
    case 'detail':
      return state.detail === undefined
        ? [dim('loading…', color)]
        : detailBody(state.detail, cols, color);
    case 'log':
      return logBody(state, cols, color, bodyHeight);
    case 'launch':
      return launchBody(state, cols, color);
    case 'intervene':
      return interveneBody(state, cols, color);
    case 'stop':
      return stopBody(state, cols, color);
    default: {
      state.view satisfies never;
      return [];
    }
  }
}

// Pure full-frame renderer. Both the palette (`color`) and the relative-time
// clock (`now`) are parameters — `render` never reads `process.stdout` or the
// system clock, so the same state always yields the same frame. When `color` is
// false the whole composed frame (including any embedded captured engine block)
// is stripped of ANSI, so the shell's color flag is authoritative.
export function render(
  state: ShellState,
  viewport: Viewport = DEFAULT_VIEWPORT,
  options: RenderOptions,
): string {
  const { cols, rows } = viewport;
  const { color, now } = options;
  const bodyHeight = Math.max(0, rows - 3);
  const body = buildBody(state, cols, color, now, bodyHeight).map((line) => fitLine(line, cols));
  const lines: string[] = [fitLine(headerLine(state, cols, color), cols)];
  for (let i = 0; i < bodyHeight; i += 1) {
    lines.push(body[i] ?? '');
  }
  lines.push(fitLine(statusArea(state, cols, color), cols));
  lines.push(fitLine(dim(FOOTERS[state.view], color), cols));
  const frame = lines.slice(0, rows).join('\n');
  return color ? frame : stripAnsi(frame);
}
