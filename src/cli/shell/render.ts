import type { RunDetailView } from './data.js';
import type { ShellState } from './model.js';

export interface Viewport {
  readonly cols: number;
  readonly rows: number;
}

export interface RenderOptions {
  readonly color: boolean;
}

export const DEFAULT_VIEWPORT: Viewport = { cols: 80, rows: 24 };

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const REVERSE = '7';
const DIM = '2';
const BOLD = '1';

const VIEW_TITLES: Record<ShellState['view'], string> = {
  dashboard: 'Dashboard',
  detail: 'Run detail',
  log: 'Logs',
  launch: 'Launch',
  intervene: 'Intervene',
  stop: 'Stop run',
};

const FOOTERS: Record<ShellState['view'], string> = {
  dashboard: 'j/k move · enter detail · n new · r refresh · q quit · ? help',
  detail: 'l logs · i intervene · s stop · r refresh · b back · q quit',
  log: 'b back · q quit',
  launch: 'tab/↑↓ field · space/←→ toggle · enter launch · esc cancel',
  intervene: 'tab field · space/←→ target · type message · enter send · esc cancel',
  stop: 'type the run name · enter confirm · esc cancel',
};

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function clip(text: string, width: number): string {
  const plain = stripAnsi(text);
  return plain.length <= width ? plain : plain.slice(0, Math.max(0, width));
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function style(text: string, code: string, color: boolean): string {
  return color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

interface LineOptions {
  readonly selected?: boolean;
  readonly dim?: boolean;
}

function bodyLine(text: string, cols: number, color: boolean, options: LineOptions = {}): string {
  if (options.selected === true) {
    return style(padRight(clip(text, cols), cols), REVERSE, color);
  }
  const clipped = clip(text, cols);
  return options.dim === true ? style(clipped, DIM, color) : clipped;
}

function dashboardBody(state: ShellState, cols: number, color: boolean): string[] {
  const lines: string[] = [];
  const rows = state.groups.flatMap((group) => group.runs);
  if (rows.length === 0) {
    lines.push('no agent-quorum runs found — press n to launch one');
    return lines;
  }
  let index = 0;
  for (const group of state.groups) {
    lines.push(bodyLine(`▸ ${group.label}  ${group.store}`, cols, color, { dim: true }));
    for (const row of group.runs) {
      const mark = index === state.cursor ? '❯' : ' ';
      const time = row.isLive
        ? `started ${row.startedAt}`
        : `ended ${row.endedAt ?? row.startedAt}`;
      const text = `  ${mark} ${row.name}  [${row.state}]  ${row.shortRunId}  ${time}  ${row.workDir}`;
      lines.push(bodyLine(text, cols, color, { selected: index === state.cursor }));
      index += 1;
    }
  }
  return lines;
}

function detailBody(detail: RunDetailView, cols: number, color: boolean): string[] {
  const { record } = detail;
  const lines: string[] = [];
  lines.push(bodyLine(`${record.name}  [${detail.state}]`, cols, color));
  lines.push(bodyLine(`  runId: ${record.runId}`, cols, color, { dim: true }));
  lines.push(bodyLine(`  work:  ${record.workDir}`, cols, color, { dim: true }));
  lines.push(bodyLine(`  log:   ${record.logPath}`, cols, color, { dim: true }));
  const timing = record.endedAt !== undefined ? `  ended: ${record.endedAt}` : '';
  lines.push(bodyLine(`  started: ${record.startedAt}${timing}`, cols, color, { dim: true }));
  lines.push(
    bodyLine(
      `  artifacts: plan.final=${detail.artifacts.planFinal ? '✓' : '—'}  summary=${detail.artifacts.summary ? '✓' : '—'}  iterations=${detail.iterations}`,
      cols,
      color,
    ),
  );
  lines.push(
    bodyLine(
      `  interventions: total=${detail.interventions.total} active=${detail.interventions.active} migrated=${detail.interventions.migrated}`,
      cols,
      color,
    ),
  );
  lines.push(
    bodyLine(`  last event: ${detail.lastEvent === '' ? '—' : detail.lastEvent}`, cols, color),
  );
  lines.push('');
  if (detail.process.available) {
    lines.push(bodyLine('  process:', cols, color));
    for (const raw of detail.process.captured.split('\n')) {
      if (stripAnsi(raw).trim() === '') {
        continue;
      }
      lines.push(bodyLine(`  ${stripAnsi(raw)}`, cols, color, { dim: true }));
    }
  } else {
    lines.push(bodyLine('  process info unavailable', cols, color, { dim: true }));
  }
  return lines;
}

function logBody(state: ShellState, cols: number, color: boolean, bodyHeight: number): string[] {
  const name = state.detail?.record.name ?? 'run';
  if (!state.log.available) {
    return [
      bodyLine(`log: ${name}`, cols, color),
      bodyLine('  no run.log — streamed to its console or not started yet', cols, color, {
        dim: true,
      }),
    ];
  }
  const marker = state.log.following ? 'following' : 'stopped (terminal)';
  const header = bodyLine(`log: ${name}  (${marker})`, cols, color);
  const room = Math.max(0, bodyHeight - 1);
  const tail = state.log.lines.slice(-room).map((line) => bodyLine(`  ${line}`, cols, color));
  return [header, ...tail];
}

interface FormRow {
  readonly label: string;
  readonly value: string;
}

function formBody(rows: readonly FormRow[], field: number, cols: number, color: boolean): string[] {
  return rows.map((row, index) => {
    const mark = index === field ? '❯' : ' ';
    const text = `  ${mark} ${padRight(row.label, 10)} ${row.value}`;
    return bodyLine(text, cols, color, { selected: index === field });
  });
}

function launchBody(state: ShellState, cols: number, color: boolean): string[] {
  const form = state.launch;
  const rows: FormRow[] = [
    { label: 'input', value: form.input === '' ? '(required)' : form.input },
    { label: 'mode', value: form.promptMode ? 'prompt' : 'plan' },
    { label: 'resume', value: form.resume ? 'on' : 'off' },
    { label: 'iters', value: form.iters === '' ? '(default)' : form.iters },
    { label: 'effort', value: form.effort },
    { label: 'fix', value: form.fix },
    { label: 'locale', value: form.locale === '' ? '(default)' : form.locale },
    { label: 'translate', value: form.translate },
  ];
  return [bodyLine('launch a new run', cols, color), ...formBody(rows, form.field, cols, color)];
}

function interveneBody(state: ShellState, cols: number, color: boolean): string[] {
  const form = state.intervene;
  const name = state.detail?.record.name ?? 'run';
  const rows: FormRow[] = [
    { label: 'target', value: form.target },
    { label: 'message', value: form.message === '' ? '(type a message)' : form.message },
  ];
  return [
    bodyLine(`intervene in ${name}`, cols, color),
    ...formBody(rows, form.field, cols, color),
  ];
}

function stopBody(state: ShellState, cols: number, color: boolean): string[] {
  const record = state.detail?.record;
  if (record === undefined) {
    return [bodyLine('no run selected', cols, color)];
  }
  return [
    bodyLine(`stop run: ${record.name}  [${state.detail?.state ?? '?'}]`, cols, color),
    bodyLine(`  affordance: kill -TERM -${record.pgid}`, cols, color, { dim: true }),
    bodyLine('  liveness is re-checked immediately before signaling', cols, color, { dim: true }),
    bodyLine(`  type the run name to confirm: ${state.stop.typed}`, cols, color, {
      selected: true,
    }),
  ];
}

function buildBody(state: ShellState, cols: number, color: boolean, bodyHeight: number): string[] {
  switch (state.view) {
    case 'dashboard':
      return dashboardBody(state, cols, color);
    case 'detail':
      return state.detail === undefined
        ? [bodyLine('loading…', cols, color)]
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

// Pure full-frame renderer. The palette is built from the `color` argument only —
// `render` never reads `process.stdout`. When `color` is false the whole composed
// frame (including any embedded captured engine block) is stripped of ANSI, so the
// shell's color flag is authoritative over engine output colored from stdout.
export function render(
  state: ShellState,
  viewport: Viewport = DEFAULT_VIEWPORT,
  options: RenderOptions = { color: false },
): string {
  const { cols, rows } = viewport;
  const { color } = options;
  const bodyHeight = Math.max(0, rows - 3);
  const header = style(
    padRight(clip(`agent-quorum  ·  ${VIEW_TITLES[state.view]}`, cols), cols),
    BOLD,
    color,
  );
  const body = buildBody(state, cols, color, bodyHeight);
  const lines: string[] = [header];
  for (let i = 0; i < bodyHeight; i += 1) {
    lines.push(body[i] ?? '');
  }
  lines.push(clip(state.statusMessage, cols));
  lines.push(style(clip(FOOTERS[state.view], cols), DIM, color));
  const frame = lines.slice(0, rows).join('\n');
  return color ? frame : stripAnsi(frame);
}
