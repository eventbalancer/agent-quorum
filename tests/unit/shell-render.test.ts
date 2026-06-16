import { describe, expect, it } from 'vitest';
import type { DashboardGroup, RunDetailView, RunRow } from '../../src/cli/shell/data.js';
import type { RunRecord } from '../../src/core/run-store.js';
import { initialState, type ShellState } from '../../src/cli/shell/model.js';
import { DEFAULT_VIEWPORT, render } from '../../src/cli/shell/render.js';

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
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

function row(rec: RunRecord): RunRow {
  return {
    record: rec,
    state: 'running',
    isLive: true,
    name: rec.name,
    runId: rec.runId,
    shortRunId: rec.runId.slice(0, 12),
    startedAt: rec.startedAt,
    workDir: rec.workDir,
    logPath: rec.logPath,
  };
}

function group(runs: readonly RunRow[]): DashboardGroup {
  return { store: '/tmp/store/loop/.agents/plans/.runs', label: 'project-local', runs };
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

function fits(frame: string): void {
  const lines = frame.split('\n');
  expect(lines.length).toBeLessThanOrEqual(DEFAULT_VIEWPORT.rows);
  for (const line of lines) {
    expect(stripAnsi(line).length).toBeLessThanOrEqual(DEFAULT_VIEWPORT.cols);
  }
}

describe('render — 80x24 fit and color flag', () => {
  it('fits a dashboard frame within the viewport and honors the color flag', () => {
    const state: ShellState = {
      ...initialState,
      groups: [
        group([row(record({ name: 'alpha' })), row(record({ name: 'beta', runId: 'r2-xyz' }))]),
      ],
    };
    const plain = render(state, DEFAULT_VIEWPORT, { color: false });
    fits(plain);
    expect(plain.includes(ESC)).toBe(false);
    expect(render(state, DEFAULT_VIEWPORT, { color: true }).includes(ESC)).toBe(true);
  });

  it('clips and strips an embedded captured status block when color is off', () => {
    const captured = `${ESC}[1mPROCESS TREE${ESC}[0m\n${'x'.repeat(200)}\n  child 4242\n`;
    const state: ShellState = {
      ...initialState,
      view: 'detail',
      detail: detailView({ process: { available: true, captured } }),
    };
    const plain = render(state, DEFAULT_VIEWPORT, { color: false });
    fits(plain);
    expect(plain.includes(ESC)).toBe(false);
    expect(plain).toContain('PROCESS TREE');
  });

  it('fits a focused launch form', () => {
    const state: ShellState = {
      ...initialState,
      view: 'launch',
      launch: { ...initialState.launch, input: '/tmp/task.md', field: 4, effort: 'max' },
    };
    const frame = render(state, DEFAULT_VIEWPORT, { color: false });
    fits(frame);
    expect(frame).toContain('effort');
    expect(frame).toContain('max');
  });
});

describe('render — log view states', () => {
  function logState(overrides: Partial<ShellState['log']>): ShellState {
    return {
      ...initialState,
      view: 'log',
      detail: detailView(),
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
    const frame = render(logState({ following: true }), DEFAULT_VIEWPORT, { color: false });
    expect(frame).toContain('following');
    expect(frame).toContain('line two');
    fits(frame);
  });

  it('shows a terminal marker once the run stops', () => {
    const frame = render(logState({ following: false }), DEFAULT_VIEWPORT, { color: false });
    expect(frame).toContain('stopped (terminal)');
    fits(frame);
  });

  it('shows the unavailable marker when there is no run.log', () => {
    const frame = render(logState({ available: false, lines: [] }), DEFAULT_VIEWPORT, {
      color: false,
    });
    expect(frame).toContain('no run.log');
    fits(frame);
  });
});
