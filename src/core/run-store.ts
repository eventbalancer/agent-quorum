import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { HaltError } from '../runtime/halt.js';

export type RunState = 'running' | 'finished' | 'failed' | 'blocked';

export interface RunRecord {
  readonly runId: string;
  readonly name: string;
  readonly pid: number;
  readonly pgid: string;
  readonly procStartToken: string;
  readonly mode: string;
  readonly inputPath: string;
  readonly workDir: string;
  readonly logPath: string;
  readonly plansDir: string;
  readonly startedAt: string;
  readonly quality: string;
  readonly state: RunState;
  readonly endedAt?: string;
  readonly exitCode?: number;
  readonly finalStatus?: string;
}

export type RunRecordDraft = Omit<RunRecord, 'runId'>;

export type RunRecordPatch = Partial<
  Pick<RunRecord, 'state' | 'endedAt' | 'exitCode' | 'finalStatus'>
>;

export interface WriteRunRecordOptions {
  readonly fixedRunId?: string;
}

// Process probes the store depends on for live-state inference. Injected so the
// store never spawns processes and stays unit-testable; the CLI passes the real
// implementations from `runtime/proc.ts`.
export interface RunStateProbes {
  readonly isAlive: (pid: number) => boolean;
  readonly pgidOf: (pid: number) => string | undefined;
  readonly procStartToken: (pid: number) => string | undefined;
}

const RUN_ID_TS_WIDTH = 9;
const RUN_ID_RANDOM_BYTES = 10;

// `r<ts36>-<hex>`: a constant non-digit prefix keeps every id from ever starting
// with a digit (so a bare all-digits selector is unambiguously a pid), while the
// zero-padded base36 epoch-millisecond segment keeps ids lexicographically
// sortable by start time.
export function generateRunId(): string {
  const ts = Date.now().toString(36).padStart(RUN_ID_TS_WIDTH, '0');
  const rand = randomBytes(RUN_ID_RANDOM_BYTES).toString('hex');
  return `r${ts}-${rand}`;
}

// `base`, suffixed only when a still-tracked record already holds the bare name.
// `name` is a convenience handle; name resolution returns the most recent match,
// so an older same-base run stays addressable by its `runId`/`--last`.
export function deriveRunName(existing: readonly RunRecord[], base: string): string {
  const taken = new Set(existing.map((record) => record.name));
  if (!taken.has(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

// The inverse of the default `loop-<name>` workdir convention: recover a run's
// name from an explicit `--work` directory so a relocated run stays addressable.
export function runNameFromWorkdir(dir: string): string {
  const baseName = path.basename(dir);
  return baseName.startsWith('loop-') ? baseName.slice('loop-'.length) : baseName;
}

// Orders records most-recent-first: newer startedAt wins, ties broken by the
// (sortable) runId. Used by selector resolution and the run listing.
export function compareRunsByRecency(a: RunRecord, b: RunRecord): number {
  if (a.startedAt !== b.startedAt) {
    return a.startedAt < b.startedAt ? 1 : -1;
  }
  if (a.runId === b.runId) {
    return 0;
  }
  return a.runId < b.runId ? 1 : -1;
}

function runsDirOf(stateDir: string): string {
  return path.join(stateDir, 'runs');
}

export function runRecordPath(stateDir: string, runId: string): string {
  return path.join(runsDirOf(stateDir), `${runId}.json`);
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isEexist(error: unknown): boolean {
  return hasErrnoCode(error, 'EEXIST');
}

function serializeRecord(record: RunRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

// Sole owner of record creation. The exclusive `wx` open is the atomic create
// and the only collision check. Without a fixed id it regenerates on collision
// and retries internally; with the launch parent's pre-minted id a collision is
// fatal so the parent-printed id can never desync from the written record.
export function writeRunRecord(
  stateDir: string,
  draft: RunRecordDraft,
  options: WriteRunRecordOptions = {},
): RunRecord {
  const runsDir = runsDirOf(stateDir);
  mkdirSync(runsDir, { recursive: true });
  const fixedRunId = options.fixedRunId;
  for (;;) {
    const runId = fixedRunId ?? generateRunId();
    const record: RunRecord = { runId, ...draft };
    try {
      writeFileSync(path.join(runsDir, `${runId}.json`), serializeRecord(record), { flag: 'wx' });
      return record;
    } catch (error) {
      if (!isEexist(error)) {
        throw error;
      }
      if (fixedRunId !== undefined) {
        throw new HaltError(`run record already exists for id ${runId}`, 1, false);
      }
    }
  }
}

// Update of the already-reserved record: merge the patch and atomically replace
// the file via a temp + rename. No collision check — the path was reserved at
// create time. A missing record is a no-op (best-effort, like registry cleanup).
export function finalizeRunRecord(stateDir: string, runId: string, patch: RunRecordPatch): void {
  const target = runRecordPath(stateDir, runId);
  let current: RunRecord;
  try {
    current = JSON.parse(readFileSync(target, 'utf8')) as RunRecord;
  } catch {
    return;
  }
  const merged: RunRecord = { ...current, ...patch };
  const tmp = `${target}.${process.pid}`;
  writeFileSync(tmp, serializeRecord(merged));
  renameSync(tmp, target);
}

export function readRunRecords(stateDir: string): RunRecord[] {
  let entries: string[];
  try {
    entries = readdirSync(runsDirOf(stateDir));
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    try {
      records.push(
        JSON.parse(readFileSync(runRecordPath(stateDir, entry.slice(0, -5)), 'utf8')) as RunRecord,
      );
    } catch {
      continue;
    }
  }
  return records;
}

function canonicalExistingStoreDir(stateDir: string): string | undefined {
  try {
    if (!statSync(stateDir).isDirectory()) {
      return undefined;
    }
    return realpathSync(stateDir);
  } catch {
    return undefined;
  }
}

// Read-only union across stores: missing stores are skipped, and aliases read once.
export function readRunRecordsAcross(stateDirs: readonly string[]): RunRecord[] {
  const seen = new Set<string>();
  const records: RunRecord[] = [];
  for (const stateDir of stateDirs) {
    const canonical = canonicalExistingStoreDir(stateDir);
    if (canonical === undefined || seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    records.push(...readRunRecords(canonical));
  }
  return records;
}

// A `running` record is live only when its pid is alive AND still carries the
// recorded pgid and start token — the start token rejects a record whose pid was
// recycled by an unrelated process that happens to share the pgid. A stale
// `running` record is inferred `finished` when its plan landed, else `failed`.
export function resolveRunState(record: RunRecord, probes: RunStateProbes): RunState {
  if (record.state !== 'running') {
    return record.state;
  }
  const live =
    probes.isAlive(record.pid) &&
    probes.pgidOf(record.pid) === record.pgid &&
    probes.procStartToken(record.pid) === record.procStartToken;
  if (live) {
    return 'running';
  }
  return existsSync(path.join(record.workDir, 'plan.final.md')) ? 'finished' : 'failed';
}

export interface RetentionPolicy {
  readonly keepCount?: number;
  readonly maxAgeDays?: number;
  readonly dryRun?: boolean;
}

export interface PruneResult {
  readonly removed: string[];
  readonly kept: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RetentionDefaults {
  readonly keepCount: number;
  readonly maxAgeDays: number;
}

interface ResolvedRetention {
  readonly keepCount: number;
  readonly maxAgeDays: number;
  readonly dryRun: boolean;
}

function resolveRetention(policy: RetentionPolicy, defaults: RetentionDefaults): ResolvedRetention {
  return {
    keepCount: policy.keepCount ?? defaults.keepCount,
    maxAgeDays: policy.maxAgeDays ?? defaults.maxAgeDays,
    dryRun: policy.dryRun === true,
  };
}

// The count bound the run listing shares with prune so "recent finished" never
// shows more than retention keeps.
export function retentionKeepCount(defaults: RetentionDefaults): number {
  return defaults.keepCount;
}

// Bound the ledger by removing only terminal records (state on disk is not
// `running`) beyond `keepCount` most-recent, or older than `maxAgeDays`.
// Functional workdirs are never touched; prune removes records only.
export function pruneRuns(
  stateDir: string,
  policy: RetentionPolicy,
  defaults: RetentionDefaults,
): PruneResult {
  const { keepCount, maxAgeDays, dryRun } = resolveRetention(policy, defaults);
  const records = readRunRecords(stateDir);
  const terminal = records
    .filter((record) => record.state !== 'running')
    .sort(compareRunsByRecency);
  const nowMs = Date.now();
  const removed: string[] = [];
  for (const [index, record] of terminal.entries()) {
    const endedMs = Date.parse(record.endedAt ?? record.startedAt);
    const tooOld =
      maxAgeDays > 0 && Number.isFinite(endedMs) && nowMs - endedMs > maxAgeDays * MS_PER_DAY;
    if (index >= keepCount || tooOld) {
      removed.push(record.runId);
      if (!dryRun) {
        rmSync(runRecordPath(stateDir, record.runId), { force: true });
      }
    }
  }
  return { removed, kept: records.length - removed.length };
}
