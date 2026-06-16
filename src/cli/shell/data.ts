import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import {
  compareRunsByRecency,
  readRunRecords,
  resolveRunState,
  retentionKeepCount,
  type RunRecord,
  type RunState,
} from '../../core/run-store.js';
import { AGENT_QUORUM_PREFIX } from '../../runtime/log.js';
import { knownStateDirs } from '../../runtime/paths.js';
import { systemProbes } from '../probes.js';
import { operatorInterventionsStatus, runStatusCli } from '../status.js';

const SHORT_RUN_ID_LENGTH = 12;
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const CRITIQUE_FILE = /^critique\.v[0-9]+\.json$/;

export interface RunRow {
  readonly record: RunRecord;
  readonly state: RunState;
  readonly isLive: boolean;
  readonly name: string;
  readonly runId: string;
  readonly shortRunId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly workDir: string;
  readonly logPath: string;
}

export interface DashboardGroup {
  readonly store: string;
  readonly label: string;
  readonly runs: readonly RunRow[];
}

export type ProcessInfo =
  | { readonly available: false }
  | { readonly available: true; readonly captured: string };

export interface RunDetailView {
  readonly record: RunRecord;
  readonly state: RunState;
  readonly artifacts: { readonly planFinal: boolean; readonly summary: boolean };
  readonly iterations: number;
  readonly interventions: ReturnType<typeof operatorInterventionsStatus>;
  readonly lastEvent: string;
  readonly process: ProcessInfo;
}

export interface LogTail {
  readonly lines: readonly string[];
  readonly size: number;
  readonly available: boolean;
}

export interface LogAppend {
  readonly appended: string;
  readonly size: number;
  readonly available: boolean;
}

export interface RunDetailDeps {
  readonly runStatus: (args: readonly string[], out: (text: string) => void) => number;
}

const defaultDetailDeps: RunDetailDeps = { runStatus: runStatusCli };

interface OriginRecord {
  readonly store: string;
  readonly record: RunRecord;
  readonly state: RunState;
  readonly isLive: boolean;
}

function canonicalStoreDir(stateDir: string): string | undefined {
  try {
    if (!statSync(stateDir).isDirectory()) {
      return undefined;
    }
    return realpathSync(stateDir);
  } catch {
    return undefined;
  }
}

function storeLabel(rawDir: string): string {
  if (rawDir.endsWith(path.join('.agents', 'plans', '.runs'))) {
    return 'project-local';
  }
  if (path.basename(rawDir) === 'state') {
    return 'home';
  }
  if (path.basename(rawDir) === '.runs') {
    return 'legacy plans';
  }
  return 'ambient';
}

function toRow(origin: OriginRecord): RunRow {
  const { record } = origin;
  return {
    record,
    state: origin.state,
    isLive: origin.isLive,
    name: record.name,
    runId: record.runId,
    shortRunId:
      record.runId.length > SHORT_RUN_ID_LENGTH
        ? record.runId.slice(0, SHORT_RUN_ID_LENGTH)
        : record.runId,
    startedAt: record.startedAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    workDir: record.workDir,
    logPath: record.logPath,
  };
}

function sortRows(rows: RunRow[]): RunRow[] {
  return rows.sort((a, b) => {
    if (a.isLive !== b.isLive) {
      return a.isLive ? -1 : 1;
    }
    return compareRunsByRecency(a.record, b.record);
  });
}

// Re-derives the per-store attribution `listCandidates` flattens away, while
// reproducing its exact selection: all live runs plus a globally retention-capped
// slice of recent finished runs. Survivors are only then bucketed into store
// groups, so the flattened union matches `listCandidates` (parity) and the
// dashboard never grows past what retention keeps.
export function loadDashboard(): DashboardGroup[] {
  const seen = new Set<string>();
  const labels = new Map<string, string>();
  const order: string[] = [];
  const live: OriginRecord[] = [];
  const finished: OriginRecord[] = [];
  for (const rawDir of knownStateDirs()) {
    const canonical = canonicalStoreDir(rawDir);
    if (canonical === undefined || seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    labels.set(canonical, storeLabel(rawDir));
    order.push(canonical);
    for (const record of readRunRecords(canonical)) {
      const state = resolveRunState(record, systemProbes);
      const origin: OriginRecord = { store: canonical, record, state, isLive: state === 'running' };
      (origin.isLive ? live : finished).push(origin);
    }
  }
  live.sort((a, b) => compareRunsByRecency(a.record, b.record));
  finished.sort((a, b) => compareRunsByRecency(a.record, b.record));
  const selected = [...live, ...finished.slice(0, retentionKeepCount())];

  const byStore = new Map<string, RunRow[]>();
  for (const origin of selected) {
    const rows = byStore.get(origin.store) ?? [];
    rows.push(toRow(origin));
    byStore.set(origin.store, rows);
  }
  const groups: DashboardGroup[] = [];
  for (const store of order) {
    const rows = byStore.get(store);
    if (rows === undefined || rows.length === 0) {
      continue;
    }
    groups.push({ store, label: labels.get(store) ?? 'ambient', runs: sortRows(rows) });
  }
  return groups;
}

function countCritiques(workDir: string): number {
  try {
    return readdirSync(workDir).filter((name) => CRITIQUE_FILE.test(name)).length;
  } catch {
    return 0;
  }
}

function latestLogEvent(logPath: string): string {
  if (!existsSync(logPath)) {
    return '';
  }
  const lines = readFileSync(logPath, 'utf8')
    .split('\n')
    .map((line) => line.replace(ANSI_PATTERN, ''))
    .filter((line) => line.startsWith(AGENT_QUORUM_PREFIX));
  const last = lines[lines.length - 1] ?? '';
  const marker = `${AGENT_QUORUM_PREFIX} `;
  return last.startsWith(marker) ? last.slice(marker.length) : last;
}

// Composes a run's detail from records and artifacts (always read-only). A live
// run additionally captures `runStatusCli`'s process tree/iteration table; a
// dead-pid race (the pid vanishes between the liveness check and the status call)
// makes `renderStatusPid` throw, so the capture is guarded and falls back to the
// record/artifact view with process info marked unavailable. The captured block
// is stored raw — it may carry ANSI derived from `process.stdout`, and the
// renderer's color flag is authoritative.
export function loadRunDetail(
  record: RunRecord,
  deps: RunDetailDeps = defaultDetailDeps,
): RunDetailView {
  const state = resolveRunState(record, systemProbes);
  let processInfo: ProcessInfo = { available: false };
  if (state === 'running') {
    try {
      let captured = '';
      deps.runStatus([String(record.pid)], (text) => {
        captured += text;
      });
      processInfo = { available: true, captured };
    } catch {
      processInfo = { available: false };
    }
  }
  return {
    record,
    state,
    artifacts: {
      planFinal: existsSync(path.join(record.workDir, 'plan.final.md')),
      summary: existsSync(path.join(record.workDir, 'summary.md')),
    },
    iterations: countCritiques(record.workDir),
    interventions: operatorInterventionsStatus(record.workDir),
    lastEvent: latestLogEvent(record.logPath),
    process: processInfo,
  };
}

// Read the last `maxLines` lines of run.log. A missing/unreadable log is a valid
// non-error state (the run streamed to its console or has not started), reported
// as `available: false`. `size` is the byte length, the offset basis `readLogSince`
// resumes from.
export function readLogTail(logPath: string, maxLines: number): LogTail {
  try {
    const size = statSync(logPath).size;
    const lines = readFileSync(logPath, 'utf8').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return { lines: lines.slice(-maxLines), size, available: true };
  } catch {
    return { lines: [], size: 0, available: false };
  }
}

// Drain bytes appended past `offset` (mirrors `drainFrom` in runs.ts). No follow
// loop here — the driver owns the cancellable, terminal-aware poll.
export function readLogSince(logPath: string, offset: number): LogAppend {
  let fd: number | undefined;
  try {
    const size = statSync(logPath).size;
    if (size <= offset) {
      return { appended: '', size, available: true };
    }
    fd = openSync(logPath, 'r');
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    return { appended: buffer.toString('utf8'), size, available: true };
  } catch {
    return { appended: '', size: 0, available: false };
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}
