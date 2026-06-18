import { describe, expect, it } from 'vitest';
import type { DashboardGroup, RunDetailView, RunRow } from '../../src/cli/shell/data.js';
import type { RunRecord, RunState } from '../../src/core/run-store.js';
import { initialState, type ShellState } from '../../src/cli/shell/model.js';
import { DEFAULT_VIEWPORT, render, type Viewport } from '../../src/cli/shell/render.js';
import { ACCENT, GLYPH, STATUS_STYLES } from '../../src/cli/shell/theme.js';

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const VP60: Viewport = { cols: 60, rows: 20 };
const NOW = Date.parse('2026-06-18T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function agoIso(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'r123456789-abcdef0123',
    name: 'demo',
    pid: 4242,
    pgid: '4242',
    procStartToken: 'tok',
    mode: 'plan',
    inputPath: '/tmp/in.md',
    workDir: '/tmp/work/loop-demo',
    logPath: '/tmp/work/loop-demo/run.log',
    plansDir: '/tmp/plans',
    startedAt: '2026-06-13T00:00:00Z',
    effort: 'high',
    state: 'running',
    ...overrides,
  };
}

function row(rec: RunRecord, state: RunState = 'running', isLive = true): RunRow {
  return {
    record: rec,
    state,
    isLive,
    name: rec.name,
    runId: rec.runId,
    shortRunId: rec.runId.slice(0, 12),
    startedAt: rec.startedAt,
    ...(rec.endedAt !== undefined ? { endedAt: rec.endedAt } : {}),
    workDir: rec.workDir,
    logPath: rec.logPath,
  };
}

function group(runs: readonly RunRow[]): DashboardGroup {
  return { store: '/tmp/store/loop/.agents/plans/.runs', label: 'project-local', runs };
}

function dash(runs: readonly RunRow[]): ShellState {
  return { ...initialState, groups: [group(runs)] };
}

function detailView(overrides: Partial<RunDetailView> = {}): RunDetailView {
  return {
    record: record(),
    state: 'running',
    artifacts: { planFinal: true, summary: false },
    iterations: 3,
    interventions: { total: '1', active: '1', migrated: '0', latest: '—' },
    lastEvent: 'iter=2 — critic',
    process: { available: false },
    ...overrides,
  };
}

function detailState(detail: RunDetailView): ShellState {
  return { ...initialState, view: 'detail', detail };
}

function fits(frame: string, viewport: Viewport): void {
  const lines = frame.split('\n');
  expect(lines.length).toBeLessThanOrEqual(viewport.rows);
  for (const line of lines) {
    expect(stripAnsi(line).length).toBeLessThanOrEqual(viewport.cols);
  }
}

describe('render — shared four-region frame (AC-1)', () => {
  const views: readonly (readonly [ShellState['view'], ShellState])[] = [
    ['dashboard', dash([row(record())])],
    ['detail', detailState(detailView())],
    [
      'log',
      { ...detailState(detailView()), view: 'log', log: { ...initialState.log, lines: ['x'] } },
    ],
    ['launch', { ...initialState, view: 'launch' }],
    ['intervene', { ...detailState(detailView()), view: 'intervene' }],
    ['stop', { ...detailState(detailView()), view: 'stop' }],
  ];

  for (const [name, state] of views) {
    it(`renders header, body, status, and footer for ${name}`, () => {
      const frame = render(state, DEFAULT_VIEWPORT, { color: false, now: NOW });
      const lines = frame.split('\n');
      expect(lines).toHaveLength(DEFAULT_VIEWPORT.rows);
      expect(lines[0]?.startsWith('agent-quorum')).toBe(true);
      expect(lines[DEFAULT_VIEWPORT.rows - 1]).not.toBe('');
      expect(lines.slice(1, DEFAULT_VIEWPORT.rows - 2).some((line) => line !== '')).toBe(true);
    });
  }
});

describe('render — dashboard status coloring (AC-2, AC-3)', () => {
  const rows = [
    row(record({ name: 'r-run', runId: 'r1-aaaaaaaaaa' }), 'running', true),
    row(record({ name: 'r-fin', runId: 'r2-bbbbbbbbbb' }), 'finished', false),
    row(record({ name: 'r-fail', runId: 'r3-cccccccccc' }), 'failed', false),
  ];

  it('paints a distinct color on the running/finished/failed status tokens', () => {
    const frame = render(dash(rows), DEFAULT_VIEWPORT, { color: true, now: NOW });
    const trio = [
      STATUS_STYLES.running.code,
      STATUS_STYLES.finished.code,
      STATUS_STYLES.failed.code,
    ];
    for (const code of trio) {
      expect(frame).toContain(`${ESC}[${code}m`);
    }
    expect(new Set(trio).size).toBe(3);
  });

  it('drops all ANSI and marks the selection with a cursor glyph when color is off', () => {
    const frame = render(dash(rows), DEFAULT_VIEWPORT, { color: false, now: NOW });
    expect(frame.includes(ESC)).toBe(false);
    expect(frame).toContain(GLYPH.cursor);
    expect(frame).toContain('running');
    expect(frame).toContain('finished');
    expect(frame).toContain('failed');
  });
});

describe('render — dashboard column alignment and path omission (AC-4, AC-5)', () => {
  it('aligns the status, run-id, and time columns across run rows', () => {
    const rows = [
      row(record({ name: 'a', runId: 'rAAAAAAAAAA-1' }), 'running', true),
      row(record({ name: 'a-much-longer-name', runId: 'rBBBBBBBBBB-2' }), 'running', true),
    ];
    const frame = render(dash(rows), DEFAULT_VIEWPORT, { color: false, now: NOW });
    const runRows = frame.split('\n').filter((line) => line.includes(STATUS_STYLES.running.glyph));
    expect(runRows).toHaveLength(2);
    const glyphOffsets = runRows.map((line) => line.indexOf(STATUS_STYLES.running.glyph));
    const runIdOffsets = runRows.map((line, i) => line.indexOf(rows[i]?.shortRunId ?? ''));
    expect(new Set(glyphOffsets)).toEqual(new Set([4]));
    expect(new Set(runIdOffsets).size).toBe(1);
    expect(runIdOffsets[0]).toBeGreaterThan(0);
  });

  it('omits the work path from the dashboard list', () => {
    const frame = render(dash([row(record())]), DEFAULT_VIEWPORT, { color: false, now: NOW });
    expect(frame).not.toContain('/tmp/work/loop-demo');
  });
});

describe('render — relative list time and absolute detail time (AC-7)', () => {
  it('renders relative buckets in the list and the bounded token for unparsable input', () => {
    const rows = [
      row(record({ name: 'recent', runId: 'r1-x', startedAt: agoIso(2 * DAY) }), 'running', true),
      row(record({ name: 'broken', runId: 'r2-y', startedAt: 'not-a-date' }), 'running', true),
    ];
    const frame = render(dash(rows), DEFAULT_VIEWPORT, { color: false, now: NOW });
    expect(frame).toContain('2d ago');
    expect(frame).not.toContain(agoIso(2 * DAY));
    expect(frame).toContain(GLYPH.absent);
  });

  it('shows the full ISO timestamp in detail', () => {
    const frame = render(detailState(detailView()), DEFAULT_VIEWPORT, { color: false, now: NOW });
    expect(frame).toContain('2026-06-13T00:00:00Z');
  });
});

describe('render — detail path shortening and failure surfacing (AC-6, AC-9)', () => {
  it('middle-elides a long path and leaves a fitting one intact', () => {
    const longWork = `${'/very/long/path'.repeat(8)}/end`;
    const frame = render(
      detailState(detailView({ record: record({ workDir: longWork }) })),
      DEFAULT_VIEWPORT,
      { color: false, now: NOW },
    );
    const workLine = frame.split('\n').find((line) => line.startsWith('work: '));
    expect(workLine).toBeDefined();
    expect(workLine).toContain('…');
    expect(workLine?.startsWith('work: /very/long')).toBe(true);
    expect(workLine?.endsWith('/end')).toBe(true);

    const fitFrame = render(
      detailState(detailView({ record: record({ workDir: '/tmp/w' }) })),
      DEFAULT_VIEWPORT,
      { color: false, now: NOW },
    );
    const fitLineText = fitFrame.split('\n').find((line) => line.startsWith('work: '));
    expect(fitLineText).toContain('/tmp/w');
    expect(fitLineText).not.toContain('…');
  });

  it('paints the last event in the status color and keeps process info inside the Process block', () => {
    const frame = render(
      detailState(
        detailView({
          state: 'failed',
          lastEvent: 'iter=3 — aborted',
          process: { available: false },
        }),
      ),
      DEFAULT_VIEWPORT,
      { color: true, now: NOW },
    );
    expect(frame).toContain(`${ESC}[${STATUS_STYLES.failed.code}mLast event:`);
    const lines = stripAnsi(frame).split('\n');
    const processIdx = lines.findIndex((line) => line.trim() === 'Process');
    const unavailableIdx = lines.findIndex((line) => line.includes('process info unavailable'));
    expect(processIdx).toBeGreaterThanOrEqual(0);
    expect(unavailableIdx).toBeGreaterThan(processIdx);
  });
});

describe('render — empty, refresh, and status states (AC-8, AC-10, AC-11)', () => {
  it('shows the empty-state hint instead of a blank body', () => {
    const frame = render({ ...initialState, groups: [] }, DEFAULT_VIEWPORT, {
      color: false,
      now: NOW,
    });
    expect(frame).toContain('Press n to launch');
  });

  it('shows a refresh indicator when refreshing with no message', () => {
    const frame = render({ ...dash([row(record())]), refreshing: true }, DEFAULT_VIEWPORT, {
      color: false,
      now: NOW,
    });
    expect(frame).toContain('refreshing');
  });

  it('surfaces a status message in the single status row', () => {
    const frame = render(
      { ...initialState, view: 'launch', statusMessage: 'input is required' },
      DEFAULT_VIEWPORT,
      { color: false, now: NOW },
    );
    expect(frame).toContain('input is required');
  });

  it('collapses a multiline status message to one row without growing the frame', () => {
    const base = dash([row(record())]);
    const baseline = render(base, DEFAULT_VIEWPORT, { color: false, now: NOW });
    const multiline = render(
      { ...base, statusMessage: 'launch failed: resume\n  candidate a\n  candidate b' },
      DEFAULT_VIEWPORT,
      { color: false, now: NOW },
    );
    expect(multiline.split('\n')).toHaveLength(baseline.split('\n').length);
    expect(multiline.split('\n')).toHaveLength(DEFAULT_VIEWPORT.rows);
    const statusRow = multiline.split('\n')[DEFAULT_VIEWPORT.rows - 2];
    expect(statusRow).toContain('launch failed: resume candidate a candidate b');
  });
});

describe('render — fit invariant (AC-14)', () => {
  const rows = [
    row(record({ name: 'alpha', runId: 'r1-aaaa' }), 'running', true),
    row(record({ name: 'beta', runId: 'r2-bbbb' }), 'finished', false),
  ];

  it('fits a dashboard within 80x24 in both color modes', () => {
    fits(render(dash(rows), DEFAULT_VIEWPORT, { color: true, now: NOW }), DEFAULT_VIEWPORT);
    fits(render(dash(rows), DEFAULT_VIEWPORT, { color: false, now: NOW }), DEFAULT_VIEWPORT);
  });

  it('fits a 60x20 frame with a 28-char name and a date older than seven days', () => {
    const longRows = [
      row(
        record({ name: 'x'.repeat(28), runId: 'rZ-1', startedAt: agoIso(10 * DAY) }),
        'finished',
        false,
      ),
    ];
    const colored = render(dash(longRows), VP60, { color: true, now: NOW });
    const mono = render(dash(longRows), VP60, { color: false, now: NOW });
    fits(colored, VP60);
    fits(mono, VP60);
    expect(mono).toContain('2026-06-08');
  });

  it('keeps a multiline status message to one row at 60x20', () => {
    const frame = render({ ...dash(rows), statusMessage: 'a\nb\nc\nd\ne' }, VP60, {
      color: false,
      now: NOW,
    });
    fits(frame, VP60);
    expect(frame.split('\n')).toHaveLength(VP60.rows);
  });

  it('clips a captured engine block and strips ANSI when color is off', () => {
    const captured = `${ESC}[1mPROCESS TREE${ESC}[0m\n${'x'.repeat(200)}\n  child 4242\n`;
    const frame = render(
      detailState(detailView({ process: { available: true, captured } })),
      DEFAULT_VIEWPORT,
      { color: false, now: NOW },
    );
    fits(frame, DEFAULT_VIEWPORT);
    expect(frame.includes(ESC)).toBe(false);
    expect(frame).toContain('PROCESS TREE');
  });
});

describe('render — palette parameters in a colored frame (AC-15)', () => {
  const COLOR_SLOTS = new Set([30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97]);
  const STYLE_SLOTS = new Set([0, 1, 2, 7]);

  function assertPalette(frame: string): void {
    expect(frame).not.toContain('38;5');
    expect(frame).not.toContain('38;2');
    const sequences = frame.match(new RegExp(`${ESC}\\[[0-9;]*m`, 'g')) ?? [];
    expect(sequences.length).toBeGreaterThan(0);
    for (const sequence of sequences) {
      const params = sequence
        .slice(2, -1)
        .split(';')
        .filter((part) => part !== '')
        .map(Number);
      for (const param of params) {
        expect(COLOR_SLOTS.has(param) || STYLE_SLOTS.has(param)).toBe(true);
      }
    }
  }

  it('uses only 16-color and basic style parameters across views', () => {
    const dashboard = render(
      dash([
        row(record({ name: 'run', runId: 'r1-a' }), 'running', true),
        row(record({ name: 'done', runId: 'r2-b' }), 'finished', false),
      ]),
      DEFAULT_VIEWPORT,
      { color: true, now: NOW },
    );
    assertPalette(dashboard);
    const launch = render(
      { ...initialState, view: 'launch', launch: { ...initialState.launch, field: 4 } },
      DEFAULT_VIEWPORT,
      { color: true, now: NOW },
    );
    assertPalette(launch);
    expect(ACCENT).toBe('34');
  });
});

describe('render — log view states', () => {
  function logState(overrides: Partial<ShellState['log']>): ShellState {
    return {
      ...detailState(detailView()),
      view: 'log',
      log: {
        lines: ['line one', 'line two'],
        offset: 10,
        following: true,
        available: true,
        ...overrides,
      },
    };
  }

  it('shows a following marker while streaming', () => {
    const frame = render(logState({ following: true }), DEFAULT_VIEWPORT, {
      color: false,
      now: NOW,
    });
    expect(frame).toContain('following');
    expect(frame).toContain('line two');
    fits(frame, DEFAULT_VIEWPORT);
  });

  it('shows a terminal marker once the run stops', () => {
    const frame = render(logState({ following: false }), DEFAULT_VIEWPORT, {
      color: false,
      now: NOW,
    });
    expect(frame).toContain('stopped (terminal)');
    fits(frame, DEFAULT_VIEWPORT);
  });

  it('shows the unavailable marker when there is no run.log', () => {
    const frame = render(logState({ available: false, lines: [] }), DEFAULT_VIEWPORT, {
      color: false,
      now: NOW,
    });
    expect(frame).toContain('no run.log');
    fits(frame, DEFAULT_VIEWPORT);
  });
});
