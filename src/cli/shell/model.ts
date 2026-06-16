import type { RunRecord } from '../../core/run-store.js';
import type { DashboardGroup, LogTail, RunDetailView, RunRow } from './data.js';
import type { KeyEvent } from './keys.js';

export type ShellView = 'dashboard' | 'detail' | 'log' | 'launch' | 'intervene' | 'stop';

export const INTERVENE_TARGETS = ['all', 'critic', 'creator', 'fixer', 'reviewer'] as const;
export type InterveneTarget = (typeof INTERVENE_TARGETS)[number];

export const EFFORT_CYCLE = ['default', 'low', 'high', 'max'] as const;
export type EffortChoice = (typeof EFFORT_CYCLE)[number];

const TRI_CYCLE = ['default', 'on', 'off'] as const;
export type TriState = (typeof TRI_CYCLE)[number];

const LAUNCH_FIELD = {
  input: 0,
  mode: 1,
  resume: 2,
  iters: 3,
  effort: 4,
  fix: 5,
  locale: 6,
  translate: 7,
} as const;
const LAUNCH_FIELD_COUNT = 8;
const LAUNCH_TEXT_FIELDS = new Set<number>([
  LAUNCH_FIELD.input,
  LAUNCH_FIELD.iters,
  LAUNCH_FIELD.locale,
]);
const MAX_LOG_LINES = 1000;

export interface LaunchForm {
  readonly input: string;
  readonly promptMode: boolean;
  readonly resume: boolean;
  readonly iters: string;
  readonly effort: EffortChoice;
  readonly fix: TriState;
  readonly locale: string;
  readonly translate: TriState;
  readonly field: number;
}

export interface InterveneForm {
  readonly target: InterveneTarget;
  readonly message: string;
  readonly field: number;
}

export interface StopForm {
  readonly typed: string;
}

export interface LogState {
  readonly lines: readonly string[];
  readonly offset: number;
  readonly following: boolean;
  readonly available: boolean;
}

export interface ShellState {
  readonly view: ShellView;
  readonly groups: readonly DashboardGroup[];
  readonly cursor: number;
  readonly selectedRunId?: string;
  readonly detail?: RunDetailView;
  readonly log: LogState;
  readonly launch: LaunchForm;
  readonly intervene: InterveneForm;
  readonly stop: StopForm;
  readonly statusMessage: string;
}

export type ActionResult =
  | { readonly kind: 'launch'; readonly ok: boolean; readonly message: string }
  | { readonly kind: 'intervene'; readonly ok: boolean; readonly message: string }
  | { readonly kind: 'stop'; readonly ok: boolean; readonly message: string };

export type ShellEvent =
  | { readonly type: 'key'; readonly key: KeyEvent }
  | { readonly type: 'data'; readonly groups: readonly DashboardGroup[] }
  | { readonly type: 'detail'; readonly detail: RunDetailView }
  | { readonly type: 'log-open'; readonly tail: LogTail }
  | {
      readonly type: 'log-append';
      readonly appended: string;
      readonly size: number;
      readonly terminal?: boolean;
    }
  | { readonly type: 'action-result'; readonly result: ActionResult; readonly captured?: string }
  | { readonly type: 'tick' };

export type ShellEffect =
  | { readonly kind: 'quit' }
  | { readonly kind: 'reload' }
  | { readonly kind: 'load-detail'; readonly record: RunRecord }
  | { readonly kind: 'follow-log'; readonly record: RunRecord }
  | { readonly kind: 'stop-follow' }
  | { readonly kind: 'launch'; readonly form: LaunchForm }
  | {
      readonly kind: 'intervene';
      readonly record: RunRecord;
      readonly target: InterveneTarget;
      readonly message: string;
    }
  | { readonly kind: 'stop'; readonly record: RunRecord };

export interface ReduceResult {
  readonly state: ShellState;
  readonly effect?: ShellEffect;
}

export const DEFAULT_LAUNCH_FORM: LaunchForm = {
  input: '',
  promptMode: false,
  resume: false,
  iters: '',
  effort: 'default',
  fix: 'default',
  locale: '',
  translate: 'default',
  field: 0,
};

export const initialState: ShellState = {
  view: 'dashboard',
  groups: [],
  cursor: 0,
  log: { lines: [], offset: 0, following: false, available: true },
  launch: DEFAULT_LAUNCH_FORM,
  intervene: { target: 'all', message: '', field: 0 },
  stop: { typed: '' },
  statusMessage: '',
};

export function visibleRows(state: ShellState): RunRow[] {
  return state.groups.flatMap((group) => group.runs);
}

export function rowAtCursor(state: ShellState): RunRow | undefined {
  return visibleRows(state)[state.cursor];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cycle<T>(values: readonly T[], current: T, dir: 1 | -1): T {
  const length = values.length;
  const index = values.indexOf(current);
  const next = (((index + dir) % length) + length) % length;
  return values[next] as T;
}

function composeStatus(message: string, captured?: string): string {
  const tail = (captured ?? '').trim();
  if (tail === '') {
    return message;
  }
  return message === '' ? tail : `${message} — ${tail}`;
}

function isLaunchTextField(field: number): boolean {
  return LAUNCH_TEXT_FIELDS.has(field);
}

function launchTextValue(form: LaunchForm, field: number): string {
  if (field === LAUNCH_FIELD.input) {
    return form.input;
  }
  if (field === LAUNCH_FIELD.iters) {
    return form.iters;
  }
  return form.locale;
}

// True only when a free-text field is focused; in that context every printable
// key edits and only Ctrl-C / Esc act as controls. Outside it (lists, detail,
// logs, and toggle/cycle form fields) the single-letter shortcuts apply.
function isTextEditing(state: ShellState): boolean {
  switch (state.view) {
    case 'launch':
      return isLaunchTextField(state.launch.field);
    case 'intervene':
      return state.intervene.field === 1;
    case 'stop':
      return true;
    default:
      return false;
  }
}

function quit(state: ShellState): ReduceResult {
  return { state, effect: { kind: 'quit' } };
}

function appendChar(value: string, key: KeyEvent): string | undefined {
  if (key.kind === 'char') {
    return value + key.value;
  }
  if (key.kind === 'space') {
    return `${value} `;
  }
  if (key.kind === 'backspace') {
    return value.slice(0, -1);
  }
  return undefined;
}

function reduceDashboard(state: ShellState, key: KeyEvent): ReduceResult {
  const rows = visibleRows(state);
  const lastIndex = Math.max(0, rows.length - 1);
  if (key.kind === 'up' || (key.kind === 'char' && key.value === 'k')) {
    return { state: { ...state, cursor: clamp(state.cursor - 1, 0, lastIndex) } };
  }
  if (key.kind === 'down' || (key.kind === 'char' && key.value === 'j')) {
    return { state: { ...state, cursor: clamp(state.cursor + 1, 0, lastIndex) } };
  }
  if (key.kind === 'enter') {
    const row = rows[state.cursor];
    if (row === undefined) {
      return { state };
    }
    return {
      state: { ...state, selectedRunId: row.runId },
      effect: { kind: 'load-detail', record: row.record },
    };
  }
  if (key.kind === 'char' && key.value === 'n') {
    return { state: { ...state, view: 'launch', launch: DEFAULT_LAUNCH_FORM, statusMessage: '' } };
  }
  if (key.kind === 'char' && key.value === 'r') {
    return { state, effect: { kind: 'reload' } };
  }
  if (key.kind === 'char' && key.value === '?') {
    return {
      state: {
        ...state,
        statusMessage: 'keys: j/k move · enter detail · n new · r refresh · q quit',
      },
    };
  }
  if (key.kind === 'char' && key.value === 'q') {
    return quit(state);
  }
  return { state };
}

function reduceDetail(state: ShellState, key: KeyEvent): ReduceResult {
  const record = state.detail?.record;
  if (key.kind === 'escape' || (key.kind === 'char' && key.value === 'b')) {
    return { state: { ...state, view: 'dashboard' } };
  }
  if (key.kind === 'char' && key.value === 'q') {
    return quit(state);
  }
  if (record === undefined) {
    return { state };
  }
  if (key.kind === 'char' && key.value === 'l') {
    return {
      state: {
        ...state,
        view: 'log',
        log: { lines: [], offset: 0, following: true, available: true },
      },
      effect: { kind: 'follow-log', record },
    };
  }
  if (key.kind === 'char' && key.value === 'i') {
    return {
      state: { ...state, view: 'intervene', intervene: { target: 'all', message: '', field: 0 } },
    };
  }
  if (key.kind === 'char' && key.value === 's') {
    return { state: { ...state, view: 'stop', stop: { typed: '' } } };
  }
  if (key.kind === 'char' && key.value === 'r') {
    return { state, effect: { kind: 'load-detail', record } };
  }
  return { state };
}

function reduceLog(state: ShellState, key: KeyEvent): ReduceResult {
  if (key.kind === 'escape' || (key.kind === 'char' && key.value === 'b')) {
    return { state: { ...state, view: 'detail' }, effect: { kind: 'stop-follow' } };
  }
  if (key.kind === 'char' && key.value === 'q') {
    return quit(state);
  }
  return { state };
}

function moveFormField(field: number, count: number, key: KeyEvent): number | undefined {
  if (key.kind === 'tab') {
    return (field + 1) % count;
  }
  if (key.kind === 'down') {
    return clamp(field + 1, 0, count - 1);
  }
  if (key.kind === 'up') {
    return clamp(field - 1, 0, count - 1);
  }
  return undefined;
}

function isCancel(state: ShellState, key: KeyEvent): boolean {
  if (key.kind === 'escape') {
    return true;
  }
  return !isTextEditing(state) && key.kind === 'char' && key.value === 'b';
}

function cycleDir(key: KeyEvent): 1 | -1 | undefined {
  if (key.kind === 'space' || key.kind === 'right') {
    return 1;
  }
  if (key.kind === 'left') {
    return -1;
  }
  return undefined;
}

function reduceLaunch(state: ShellState, key: KeyEvent): ReduceResult {
  const form = state.launch;
  if (isCancel(state, key)) {
    return { state: { ...state, view: 'dashboard', launch: DEFAULT_LAUNCH_FORM } };
  }
  const moved = moveFormField(form.field, LAUNCH_FIELD_COUNT, key);
  if (moved !== undefined) {
    return { state: { ...state, launch: { ...form, field: moved } } };
  }
  if (key.kind === 'enter') {
    return { state, effect: { kind: 'launch', form } };
  }
  if (isLaunchTextField(form.field)) {
    const next = appendChar(launchTextValue(form, form.field), key);
    if (next === undefined) {
      return { state };
    }
    if (form.field === LAUNCH_FIELD.input) {
      return { state: { ...state, launch: { ...form, input: next } } };
    }
    if (form.field === LAUNCH_FIELD.iters) {
      return { state: { ...state, launch: { ...form, iters: next.replace(/[^0-9]/g, '') } } };
    }
    return { state: { ...state, launch: { ...form, locale: next } } };
  }
  const dir = cycleDir(key);
  if (dir === undefined) {
    return { state };
  }
  switch (form.field) {
    case LAUNCH_FIELD.mode:
      return { state: { ...state, launch: { ...form, promptMode: !form.promptMode } } };
    case LAUNCH_FIELD.resume:
      return { state: { ...state, launch: { ...form, resume: !form.resume } } };
    case LAUNCH_FIELD.effort:
      return {
        state: { ...state, launch: { ...form, effort: cycle(EFFORT_CYCLE, form.effort, dir) } },
      };
    case LAUNCH_FIELD.fix:
      return { state: { ...state, launch: { ...form, fix: cycle(TRI_CYCLE, form.fix, dir) } } };
    case LAUNCH_FIELD.translate:
      return {
        state: { ...state, launch: { ...form, translate: cycle(TRI_CYCLE, form.translate, dir) } },
      };
    default:
      return { state };
  }
}

function reduceIntervene(state: ShellState, key: KeyEvent): ReduceResult {
  const form = state.intervene;
  const record = state.detail?.record;
  if (isCancel(state, key)) {
    return { state: { ...state, view: 'detail' } };
  }
  const moved = moveFormField(form.field, 2, key);
  if (moved !== undefined) {
    return { state: { ...state, intervene: { ...form, field: moved } } };
  }
  if (key.kind === 'enter' && record !== undefined) {
    return {
      state,
      effect: { kind: 'intervene', record, target: form.target, message: form.message },
    };
  }
  if (form.field === 1) {
    const next = appendChar(form.message, key);
    return next === undefined
      ? { state }
      : { state: { ...state, intervene: { ...form, message: next } } };
  }
  const dir = cycleDir(key);
  if (dir === undefined) {
    return { state };
  }
  return {
    state: { ...state, intervene: { ...form, target: cycle(INTERVENE_TARGETS, form.target, dir) } },
  };
}

function reduceStop(state: ShellState, key: KeyEvent): ReduceResult {
  const form = state.stop;
  const record = state.detail?.record;
  if (key.kind === 'escape') {
    return { state: { ...state, view: 'detail', stop: { typed: '' } } };
  }
  if (key.kind === 'enter') {
    if (record === undefined) {
      return { state };
    }
    if (form.typed === record.name) {
      return { state, effect: { kind: 'stop', record } };
    }
    return {
      state: { ...state, statusMessage: 'typed name does not match — stop aborted' },
    };
  }
  const next = appendChar(form.typed, key);
  return next === undefined ? { state } : { state: { ...state, stop: { typed: next } } };
}

function reduceKey(state: ShellState, key: KeyEvent): ReduceResult {
  if (key.kind === 'ctrl-c') {
    return quit(state);
  }
  switch (state.view) {
    case 'dashboard':
      return reduceDashboard(state, key);
    case 'detail':
      return reduceDetail(state, key);
    case 'log':
      return reduceLog(state, key);
    case 'launch':
      return reduceLaunch(state, key);
    case 'intervene':
      return reduceIntervene(state, key);
    case 'stop':
      return reduceStop(state, key);
    default: {
      state.view satisfies never;
      return { state };
    }
  }
}

function applyData(state: ShellState, groups: readonly DashboardGroup[]): ShellState {
  const total = groups.flatMap((group) => group.runs).length;
  const lastIndex = Math.max(0, total - 1);
  return { ...state, groups, cursor: clamp(state.cursor, 0, lastIndex) };
}

function splitAppended(appended: string): string[] {
  const parts = appended.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

function applyActionResult(
  state: ShellState,
  result: ActionResult,
  captured?: string,
): ReduceResult {
  const statusMessage = composeStatus(result.message, captured);
  if (result.ok) {
    return { state: { ...state, view: 'dashboard', statusMessage }, effect: { kind: 'reload' } };
  }
  return { state: { ...state, statusMessage } };
}

// Pure transition. The optional `effect` is the only channel by which the reducer
// asks the driver to perform I/O or to tear down (`{kind:'quit'}`); it is produced
// fresh per transition and consumed immediately, so there is no mutable pending
// state.
export function reduce(state: ShellState, event: ShellEvent): ReduceResult {
  switch (event.type) {
    case 'key':
      return reduceKey(state, event.key);
    case 'data':
      return { state: applyData(state, event.groups) };
    case 'detail':
      return { state: { ...state, view: 'detail', detail: event.detail } };
    case 'log-open':
      return {
        state: {
          ...state,
          log: {
            lines: event.tail.lines.slice(-MAX_LOG_LINES),
            offset: event.tail.size,
            available: event.tail.available,
            following: event.tail.available,
          },
        },
      };
    case 'log-append': {
      const merged = [...state.log.lines, ...splitAppended(event.appended)].slice(-MAX_LOG_LINES);
      return {
        state: {
          ...state,
          log: {
            ...state.log,
            lines: merged,
            offset: event.size,
            following: event.terminal === true ? false : state.log.following,
          },
        },
      };
    }
    case 'action-result':
      return applyActionResult(state, event.result, event.captured);
    case 'tick':
      return { state, effect: { kind: 'reload' } };
    default: {
      event satisfies never;
      return { state };
    }
  }
}
