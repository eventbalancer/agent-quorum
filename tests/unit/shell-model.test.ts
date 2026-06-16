import { describe, expect, it } from 'vitest';
import type { DashboardGroup, RunDetailView, RunRow } from '../../src/cli/shell/data.js';
import type { KeyEvent } from '../../src/cli/shell/keys.js';
import type { RunRecord } from '../../src/core/run-store.js';
import {
  initialState,
  reduce,
  type ShellState,
  type ShellEvent,
} from '../../src/cli/shell/model.js';

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'r123456789-abcdef',
    name: 'demo',
    pid: 4242,
    pgid: '4242',
    procStartToken: 'tok',
    mode: 'plan',
    inputPath: '/tmp/in.md',
    workDir: '/tmp/work',
    logPath: '/tmp/work/run.log',
    plansDir: '/tmp/plans',
    startedAt: '2026-06-13T00:00:00Z',
    effort: 'high',
    state: 'running',
    ...overrides,
  };
}

function row(rec: RunRecord, isLive = true): RunRow {
  return {
    record: rec,
    state: isLive ? 'running' : 'finished',
    isLive,
    name: rec.name,
    runId: rec.runId,
    shortRunId: rec.runId.slice(0, 12),
    startedAt: rec.startedAt,
    workDir: rec.workDir,
    logPath: rec.logPath,
  };
}

function group(runs: readonly RunRow[]): DashboardGroup {
  return { store: '/tmp/store', label: 'ambient', runs };
}

function detailView(rec: RunRecord): RunDetailView {
  return {
    record: rec,
    state: 'running',
    artifacts: { planFinal: false, summary: false },
    iterations: 0,
    interventions: { total: '0', active: '0', migrated: '0', latest: '—' },
    lastEvent: '',
    process: { available: false },
  };
}

function key(k: KeyEvent): ShellEvent {
  return { type: 'key', key: k };
}

function withDashboard(rows: readonly RunRow[]): ShellState {
  return { ...initialState, groups: [group(rows)] };
}

function withDetail(rec: RunRecord): ShellState {
  return { ...initialState, view: 'detail', detail: detailView(rec) };
}

describe('reduce — dashboard navigation', () => {
  it('moves the cursor and opens detail via a load-detail effect', () => {
    const a = record({ runId: 'r1-a', name: 'one' });
    const b = record({ runId: 'r2-b', name: 'two' });
    const state = withDashboard([row(a), row(b)]);

    const down = reduce(state, key({ kind: 'down' }));
    expect(down.state.cursor).toBe(1);

    const enter = reduce(down.state, key({ kind: 'enter' }));
    expect(enter.state.selectedRunId).toBe('r2-b');
    expect(enter.effect).toEqual({ kind: 'load-detail', record: b });
  });

  it('clamps the cursor at the list bounds', () => {
    const state = withDashboard([row(record())]);
    expect(reduce(state, key({ kind: 'up' })).state.cursor).toBe(0);
    expect(reduce(state, key({ kind: 'char', value: 'j' })).state.cursor).toBe(0);
  });

  it('quits on q outside text editing and on ctrl-c', () => {
    const state = withDashboard([row(record())]);
    expect(reduce(state, key({ kind: 'char', value: 'q' })).effect).toEqual({ kind: 'quit' });
    expect(reduce(state, key({ kind: 'ctrl-c' })).effect).toEqual({ kind: 'quit' });
  });

  it('refreshes on r and opens the launch form on n', () => {
    const state = withDashboard([row(record())]);
    expect(reduce(state, key({ kind: 'char', value: 'r' })).effect).toEqual({ kind: 'reload' });
    expect(reduce(state, key({ kind: 'char', value: 'n' })).state.view).toBe('launch');
  });
});

describe('reduce — detail and log navigation', () => {
  it('walks dashboard → detail → log → back with the right effects', () => {
    const rec = record();
    const opened = reduce(withDashboard([row(rec)]), key({ kind: 'enter' }));
    expect(opened.effect).toEqual({ kind: 'load-detail', record: rec });

    const detail = reduce(opened.state, { type: 'detail', detail: detailView(rec) });
    expect(detail.state.view).toBe('detail');

    const log = reduce(detail.state, key({ kind: 'char', value: 'l' }));
    expect(log.state.view).toBe('log');
    expect(log.state.log.following).toBe(true);
    expect(log.effect).toEqual({ kind: 'follow-log', record: rec });

    const back = reduce(log.state, key({ kind: 'char', value: 'b' }));
    expect(back.state.view).toBe('detail');
    expect(back.effect).toEqual({ kind: 'stop-follow' });
  });

  it('opens intervene and stop forms and returns to dashboard on back', () => {
    const rec = record();
    expect(reduce(withDetail(rec), key({ kind: 'char', value: 'i' })).state.view).toBe('intervene');
    expect(reduce(withDetail(rec), key({ kind: 'char', value: 's' })).state.view).toBe('stop');
    expect(reduce(withDetail(rec), key({ kind: 'escape' })).state.view).toBe('dashboard');
  });
});

describe('reduce — log following', () => {
  it('appends lines and clears following on a terminal append', () => {
    const opened = reduce(
      { ...initialState, view: 'log' },
      { type: 'log-open', tail: { lines: ['a'], size: 2, available: true } },
    );
    expect(opened.state.log.lines).toEqual(['a']);
    expect(opened.state.log.following).toBe(true);

    const appended = reduce(opened.state, { type: 'log-append', appended: 'b\nc\n', size: 6 });
    expect(appended.state.log.lines).toEqual(['a', 'b', 'c']);
    expect(appended.state.log.following).toBe(true);

    const terminal = reduce(appended.state, {
      type: 'log-append',
      appended: 'd\n',
      size: 8,
      terminal: true,
    });
    expect(terminal.state.log.lines).toEqual(['a', 'b', 'c', 'd']);
    expect(terminal.state.log.following).toBe(false);
  });
});

describe('reduce — launch form and key precedence', () => {
  it('edits text fields with printable keys (including q/b/r) while focused', () => {
    const launching = reduce(withDashboard([row(record())]), key({ kind: 'char', value: 'n' }));
    let state = launching.state;
    for (const ch of ['q', 'b', 'r']) {
      state = reduce(state, key({ kind: 'char', value: ch })).state;
    }
    expect(state.view).toBe('launch');
    expect(state.launch.input).toBe('qbr');
  });

  it('still quits on ctrl-c while editing a text field', () => {
    const launching = reduce(withDashboard([row(record())]), key({ kind: 'char', value: 'n' }));
    expect(reduce(launching.state, key({ kind: 'ctrl-c' })).effect).toEqual({ kind: 'quit' });
  });

  it('moves focus, toggles, cycles effort, and submits a launch effect', () => {
    let state: ShellState = { ...initialState, view: 'launch' };
    state = reduce(state, key({ kind: 'char', value: 'p' })).state; // input = 'p'
    state = reduce(state, key({ kind: 'tab' })).state; // field 1 = mode
    state = reduce(state, key({ kind: 'space' })).state; // promptMode = true
    expect(state.launch.promptMode).toBe(true);

    state = { ...state, launch: { ...state.launch, field: 4 } };
    state = reduce(state, key({ kind: 'space' })).state; // effort default → low
    expect(state.launch.effort).toBe('low');

    const submit = reduce(state, key({ kind: 'enter' }));
    expect(submit.effect).toEqual({ kind: 'launch', form: state.launch });
  });

  it('cancels back to the dashboard discarding the draft', () => {
    let state: ShellState = { ...initialState, view: 'launch' };
    state = reduce(state, key({ kind: 'char', value: 'x' })).state;
    const cancelled = reduce(state, key({ kind: 'escape' }));
    expect(cancelled.state.view).toBe('dashboard');
    expect(cancelled.state.launch.input).toBe('');
  });
});

describe('reduce — stop confirmation', () => {
  it('emits a stop effect only on an exact typed-name match', () => {
    const rec = record({ name: 'target' });
    const base: ShellState = { ...withDetail(rec), view: 'stop' };

    const mismatch = reduce({ ...base, stop: { typed: 'wrong' } }, key({ kind: 'enter' }));
    expect(mismatch.effect).toBeUndefined();
    expect(mismatch.state.statusMessage).toContain('does not match');

    const match = reduce({ ...base, stop: { typed: 'target' } }, key({ kind: 'enter' }));
    expect(match.effect).toEqual({ kind: 'stop', record: rec });
  });
});

describe('reduce — action results', () => {
  it('folds captured text into the status and reloads on success', () => {
    const state: ShellState = { ...initialState, view: 'launch' };
    const result = reduce(state, {
      type: 'action-result',
      result: { kind: 'launch', ok: true, message: 'started demo' },
      captured: 'resume: attaching',
    });
    expect(result.state.view).toBe('dashboard');
    expect(result.state.statusMessage).toContain('started demo');
    expect(result.state.statusMessage).toContain('resume: attaching');
    expect(result.effect).toEqual({ kind: 'reload' });
  });

  it('keeps the form open with a status on failure', () => {
    const state: ShellState = { ...initialState, view: 'launch' };
    const result = reduce(state, {
      type: 'action-result',
      result: { kind: 'launch', ok: false, message: 'input is required' },
    });
    expect(result.state.view).toBe('launch');
    expect(result.state.statusMessage).toBe('input is required');
    expect(result.effect).toBeUndefined();
  });
});

describe('reduce — refresh tick', () => {
  it('asks for a reload without leaving the current view', () => {
    const state = withDetail(record());
    const ticked = reduce(state, { type: 'tick' });
    expect(ticked.state.view).toBe('detail');
    expect(ticked.effect).toEqual({ kind: 'reload' });
  });
});
