import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isJsonObject, type JsonValue } from '../../core/json.js';
import { isTelegramFailureKind } from '../../channels/telegram/client.js';
import {
  DEFAULT_TELEGRAM_HTTP_TIMEOUT_SECONDS,
  DEFAULT_TELEGRAM_POLL_TIMEOUT_SECONDS,
  DEFAULT_TELEGRAM_RECEIVE_BACKOFF_SECONDS,
  DEFAULT_TELEGRAM_RECEIVE_FAILURE_WINDOW_SECONDS,
  TELEGRAM_HTTP_TIMEOUT_SLACK_SECONDS,
  telegramGetUpdates,
  type TelegramFailure,
  type TelegramUpdate,
} from '../../channels/telegram/index.js';
import { envNumber } from './env-number.js';

const LEASE_SLACK_SECONDS = 5;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function coerceFailure(value: Record<string, JsonValue>): TelegramFailure | undefined {
  const kind = value.kind;
  if (typeof kind !== 'string' || !isTelegramFailureKind(kind)) {
    return undefined;
  }
  return {
    kind,
    ...(typeof value.status === 'number' ? { status: value.status } : {}),
    ...(typeof value.errorCode === 'number' ? { errorCode: value.errorCode } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
  };
}

export type JournalEntry = TelegramUpdate;

export type BaselineResult =
  | { readonly ok: true; readonly cursor: number }
  | { readonly ok: false; readonly failure: TelegramFailure };

export type PollResult =
  | { readonly polled: true }
  | { readonly peerHeld: true }
  | { readonly failure: TelegramFailure };

export interface HealthSnapshot {
  readonly failing: boolean;
  readonly sinceMs: number;
  readonly lastFailure?: TelegramFailure;
}

export interface ClarifyBroker {
  readonly runId: string;
  ensureBaseline(): Promise<BaselineResult>;
  tryPoll(pollTimeout: number): Promise<PollResult>;
  readJournalSince(cursor: number): JournalEntry[];
  liveSessionCount(): number;
  claimUntargeted(updateId: number): boolean;
  readHealth(): HealthSnapshot;
  refresh(cursor: number): void;
  idle(): Promise<void>;
  close(): void;
}

interface BrokerConfig {
  readonly token: string;
  readonly chatId: string;
  readonly pollTimeout: number;
  readonly httpTimeout: number;
  readonly failureWindowSeconds: number;
  readonly backoffSeconds: number;
  readonly stateRoot: string;
}

interface LockData {
  readonly ts: number;
  readonly token: string;
}

interface SessionData {
  readonly ts: number;
  readonly cursor: number;
}

interface HealthData {
  readonly consecutiveFailures: number;
  readonly firstFailureTs: number;
  readonly lastFailure?: TelegramFailure;
}

type PollLease = { readonly held: true; readonly token: string } | { readonly held: false };

export function isPolledResult(result: PollResult): result is { readonly polled: true } {
  return 'polled' in result;
}

export function isPeerHeldResult(result: PollResult): result is { readonly peerHeld: true } {
  return 'peerHeld' in result;
}

export function isPollFailure(result: PollResult): result is { readonly failure: TelegramFailure } {
  return 'failure' in result;
}

function resolveBrokerConfig(): BrokerConfig {
  return {
    token: process.env.AGENT_QUORUM_TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.AGENT_QUORUM_TELEGRAM_CHAT_ID ?? '',
    pollTimeout: envNumber(
      'AGENT_QUORUM_TELEGRAM_POLL_TIMEOUT',
      DEFAULT_TELEGRAM_POLL_TIMEOUT_SECONDS,
    ),
    httpTimeout: envNumber(
      'AGENT_QUORUM_TELEGRAM_HTTP_TIMEOUT',
      DEFAULT_TELEGRAM_HTTP_TIMEOUT_SECONDS,
    ),
    failureWindowSeconds: envNumber(
      'AGENT_QUORUM_TELEGRAM_RECEIVE_FAILURE_WINDOW_SECONDS',
      DEFAULT_TELEGRAM_RECEIVE_FAILURE_WINDOW_SECONDS,
    ),
    backoffSeconds: envNumber(
      'AGENT_QUORUM_TELEGRAM_RECEIVE_BACKOFF_SECONDS',
      DEFAULT_TELEGRAM_RECEIVE_BACKOFF_SECONDS,
    ),
    stateRoot: process.env.AGENT_QUORUM_TELEGRAM_STATE_DIR ?? os.tmpdir(),
  };
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isEexist(error: unknown): boolean {
  return isErrno(error, 'EEXIST');
}

function isEnoent(error: unknown): boolean {
  return isErrno(error, 'ENOENT');
}

function parseJsonFile(file: string): JsonValue | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  } catch {
    return undefined;
  }
}

function writeSecure(file: string, data: string): void {
  writeFileSync(file, data, { mode: FILE_MODE });
  chmodSync(file, FILE_MODE);
}

function serializeJournalLine(entry: JournalEntry, ts: number): string {
  return JSON.stringify({
    update_id: entry.updateId,
    text: entry.text,
    reply_to_message_id: entry.replyToMessageId ?? null,
    ts,
  });
}

// A cooperative file-based broker that funnels every getUpdates for one
// bot+chat through a single poll lease, journals fetched chat messages to an
// append-only log, and advances a bot-global offset. The shared coordination
// directory holds operator reply text, so it is created 0700 with 0600 files,
// compacted below the minimum live cursor, and removed when the last run exits.
export function openClarifyBroker(): ClarifyBroker {
  const config = resolveBrokerConfig();
  const leaseWindowMs = (config.pollTimeout + config.httpTimeout + LEASE_SLACK_SECONDS) * 1000;
  const failureWindowMs = config.failureWindowSeconds * 1000;
  const runId = randomUUID();

  const hash = createHash('sha256').update(`${config.token}\0${config.chatId}`).digest('hex');
  const dir = path.join(config.stateRoot, 'agent-quorum', 'telegram', hash);
  const lockFile = path.join(dir, 'poll.lock');
  const journalFile = path.join(dir, 'updates.jsonl');
  const offsetFile = path.join(dir, 'offset');
  const healthFile = path.join(dir, 'health.json');
  const sessionsDir = path.join(dir, 'sessions');
  const claimsDir = path.join(dir, 'claims');

  function ensureDirs(): void {
    mkdirSync(sessionsDir, { recursive: true, mode: DIR_MODE });
    mkdirSync(claimsDir, { recursive: true, mode: DIR_MODE });
    chmodSync(dir, DIR_MODE);
    chmodSync(sessionsDir, DIR_MODE);
    chmodSync(claimsDir, DIR_MODE);
  }

  ensureDirs();

  let lastCursor = 0;

  function nowMs(): number {
    return Date.now();
  }

  function readLock(): LockData | undefined {
    const parsed = parseJsonFile(lockFile);
    if (isJsonObject(parsed) && typeof parsed.ts === 'number' && typeof parsed.token === 'string') {
      return { ts: parsed.ts, token: parsed.token };
    }
    return undefined;
  }

  // Exclusive-create the lock, recreating the coordination dir if a peer tore it
  // down (its teardown removed our stale session, so we wake into a missing dir).
  function createLockExclusive(payload: string): 'created' | 'exists' {
    for (let attempt = 0; ; attempt += 1) {
      try {
        writeFileSync(lockFile, payload, { flag: 'wx', mode: FILE_MODE });
        chmodSync(lockFile, FILE_MODE);
        return 'created';
      } catch (error) {
        if (isEexist(error)) {
          return 'exists';
        }
        if (isEnoent(error) && attempt === 0) {
          ensureDirs();
          continue;
        }
        throw error;
      }
    }
  }

  function acquireLease(): PollLease {
    const token = randomUUID();
    const payload = JSON.stringify({ pid: process.pid, ts: nowMs(), token });
    if (createLockExclusive(payload) === 'created') {
      return { held: true, token };
    }
    const existing = readLock();
    if (existing !== undefined && nowMs() - existing.ts <= leaseWindowMs) {
      return { held: false };
    }
    // Stale (or unreadable) lock: steal it, then confirm our token won the race
    // so two simultaneous stealers cannot both believe they hold the lease.
    writeSecure(lockFile, payload);
    return readLock()?.token === token ? { held: true, token } : { held: false };
  }

  function releaseLease(token: string): void {
    if (readLock()?.token === token) {
      rmSync(lockFile, { force: true });
    }
  }

  function readOffset(): number {
    try {
      const value = Number(readFileSync(offsetFile, 'utf8'));
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  function writeOffset(value: number): void {
    writeSecure(offsetFile, String(value));
  }

  function appendJournal(updates: readonly TelegramUpdate[], sharedOffset: number): void {
    const lines = updates
      .filter((update) => update.updateId >= sharedOffset)
      .map((update) => serializeJournalLine(update, nowMs()));
    if (lines.length === 0) {
      return;
    }
    appendFileSync(journalFile, `${lines.join('\n')}\n`, { mode: FILE_MODE });
    chmodSync(journalFile, FILE_MODE);
  }

  function readJournalRaw(): JournalEntry[] {
    let raw: string;
    try {
      raw = readFileSync(journalFile, 'utf8');
    } catch {
      return [];
    }
    const entries: JournalEntry[] = [];
    const seen = new Set<number>();
    for (const line of raw.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      let parsed: JsonValue;
      try {
        parsed = JSON.parse(line) as JsonValue;
      } catch {
        continue;
      }
      if (!isJsonObject(parsed) || typeof parsed.update_id !== 'number') {
        continue;
      }
      if (seen.has(parsed.update_id)) {
        continue;
      }
      seen.add(parsed.update_id);
      const replyTo = parsed.reply_to_message_id;
      entries.push({
        updateId: parsed.update_id,
        text: typeof parsed.text === 'string' ? parsed.text : '',
        ...(typeof replyTo === 'number' ? { replyToMessageId: replyTo } : {}),
      });
    }
    return entries;
  }

  function readJournalSince(cursor: number): JournalEntry[] {
    return readJournalRaw()
      .filter((entry) => entry.updateId >= cursor)
      .sort((a, b) => a.updateId - b.updateId);
  }

  function journalMax(): number {
    let max = -1;
    for (const entry of readJournalRaw()) {
      max = Math.max(max, entry.updateId);
    }
    return max;
  }

  function sessionFile(id: string): string {
    return path.join(sessionsDir, id);
  }

  function readSession(id: string): SessionData | undefined {
    const parsed = parseJsonFile(sessionFile(id));
    if (
      isJsonObject(parsed) &&
      typeof parsed.ts === 'number' &&
      typeof parsed.cursor === 'number'
    ) {
      return { ts: parsed.ts, cursor: parsed.cursor };
    }
    return undefined;
  }

  function writeSession(cursor: number): void {
    mkdirSync(sessionsDir, { recursive: true, mode: DIR_MODE });
    writeSecure(sessionFile(runId), JSON.stringify({ ts: nowMs(), cursor }));
  }

  function refresh(cursor: number): void {
    lastCursor = cursor;
    writeSession(cursor);
  }

  function heartbeat(): void {
    writeSession(lastCursor);
  }

  function liveSessions(): SessionData[] {
    let names: string[];
    try {
      names = readdirSync(sessionsDir);
    } catch {
      return [];
    }
    const live: SessionData[] = [];
    for (const name of names) {
      const session = readSession(name);
      if (session === undefined || nowMs() - session.ts > leaseWindowMs) {
        rmSync(sessionFile(name), { force: true });
        continue;
      }
      live.push(session);
    }
    return live;
  }

  function liveSessionCount(): number {
    return liveSessions().length;
  }

  function compact(): void {
    const cursors = liveSessions().map((session) => session.cursor);
    if (cursors.length === 0) {
      return;
    }
    const min = Math.min(...cursors);
    const kept = readJournalRaw().filter((entry) => entry.updateId >= min);
    const tmp = `${journalFile}.tmp`;
    const body = kept.map((entry) => serializeJournalLine(entry, nowMs())).join('\n');
    writeSecure(tmp, kept.length === 0 ? '' : `${body}\n`);
    renameSync(tmp, journalFile);
  }

  function claimUntargeted(updateId: number): boolean {
    mkdirSync(claimsDir, { recursive: true, mode: DIR_MODE });
    try {
      writeFileSync(path.join(claimsDir, String(updateId)), '', { flag: 'wx', mode: FILE_MODE });
      return true;
    } catch (error) {
      if (isEexist(error)) {
        return false;
      }
      throw error;
    }
  }

  function readHealthData(): HealthData {
    const parsed = parseJsonFile(healthFile);
    if (
      isJsonObject(parsed) &&
      typeof parsed.consecutiveFailures === 'number' &&
      typeof parsed.firstFailureTs === 'number'
    ) {
      const lastFailure = isJsonObject(parsed.lastFailure)
        ? coerceFailure(parsed.lastFailure)
        : undefined;
      return {
        consecutiveFailures: parsed.consecutiveFailures,
        firstFailureTs: parsed.firstFailureTs,
        ...(lastFailure !== undefined ? { lastFailure } : {}),
      };
    }
    return { consecutiveFailures: 0, firstFailureTs: 0 };
  }

  function recordFailure(failure: TelegramFailure, attemptStartMs: number): void {
    const current = readHealthData();
    const firstFailureTs =
      current.consecutiveFailures > 0 && current.firstFailureTs > 0
        ? current.firstFailureTs
        : attemptStartMs;
    writeSecure(
      healthFile,
      JSON.stringify({
        consecutiveFailures: current.consecutiveFailures + 1,
        firstFailureTs,
        lastFailure: failure,
        ts: nowMs(),
      }),
    );
  }

  function recordHealthy(): void {
    writeSecure(
      healthFile,
      JSON.stringify({ consecutiveFailures: 0, firstFailureTs: 0, ts: nowMs() }),
    );
  }

  function readHealth(): HealthSnapshot {
    const data = readHealthData();
    const failing = data.consecutiveFailures > 0;
    const sinceMs = failing && data.firstFailureTs > 0 ? nowMs() - data.firstFailureTs : 0;
    return {
      failing,
      sinceMs,
      ...(data.lastFailure !== undefined ? { lastFailure: data.lastFailure } : {}),
    };
  }

  function receiveHttpTimeout(pollSeconds: number): number {
    return Math.min(pollSeconds + TELEGRAM_HTTP_TIMEOUT_SLACK_SECONDS, config.failureWindowSeconds);
  }

  async function drainOrPoll(longPoll: number, httpTimeoutSeconds: number): Promise<PollResult> {
    const lease = acquireLease();
    if (!lease.held) {
      return { peerHeld: true };
    }
    const attemptStart = nowMs();
    try {
      heartbeat();
      const sharedOffset = readOffset();
      const fetch = await telegramGetUpdates(sharedOffset, longPoll, { httpTimeoutSeconds });
      if (fetch.ok) {
        appendJournal(fetch.updates, sharedOffset);
        writeOffset(Math.max(sharedOffset, fetch.nextOffset));
        recordHealthy();
        compact();
        return { polled: true };
      }
      recordFailure(fetch.failure, attemptStart);
      return { failure: fetch.failure };
    } finally {
      releaseLease(lease.token);
    }
  }

  function nextJournalCursor(): number {
    return journalMax() + 1;
  }

  async function ensureBaseline(): Promise<BaselineResult> {
    for (;;) {
      const result = await drainOrPoll(0, receiveHttpTimeout(config.pollTimeout));
      if (isPolledResult(result)) {
        return { ok: true, cursor: nextJournalCursor() };
      }
      if (isPeerHeldResult(result)) {
        // A live peer already holds the poll lease (it may stay there for a full
        // long-poll), so it is the active consumer maintaining the shared journal
        // and offset. Adopt the current cursor instead of starving on the lease;
        // under concurrency this run records only replies to its own question, so
        // re-reading any pre-gate chatter above this cursor stays held, not stored.
        heartbeat();
        return { ok: true, cursor: Math.max(readOffset(), nextJournalCursor()) };
      }
      const health = readHealth();
      if (health.failing && health.sinceMs >= failureWindowMs && isPollFailure(result)) {
        return { ok: false, failure: result.failure };
      }
      await sleep(config.backoffSeconds * 1000);
    }
  }

  async function tryPoll(pollTimeout: number): Promise<PollResult> {
    const inStreak = readHealthData().consecutiveFailures > 0;
    const longPoll = inStreak ? 0 : pollTimeout;
    const httpTimeoutSeconds = inStreak
      ? Math.max(1, config.backoffSeconds)
      : receiveHttpTimeout(pollTimeout);
    return drainOrPoll(longPoll, httpTimeoutSeconds);
  }

  async function idle(): Promise<void> {
    const base = (0.25 + Math.random() * 0.25) * config.pollTimeout * 1000;
    const bounded = Math.max(50, Math.min(leaseWindowMs, base));
    await sleep(bounded);
  }

  // Remove the shared dir only while holding the poll lease, so a peer that is
  // mid-poll (writing the journal/offset/health) never has it pulled out from
  // under it. A peer that holds the lease leaves teardown to whoever closes last.
  function close(): void {
    rmSync(sessionFile(runId), { force: true });
    const lease = acquireLease();
    if (!lease.held) {
      return;
    }
    if (liveSessions().length === 0) {
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    releaseLease(lease.token);
  }

  refresh(0);

  return {
    runId,
    ensureBaseline,
    tryPoll,
    readJournalSince,
    liveSessionCount,
    claimUntargeted,
    readHealth,
    refresh,
    idle,
    close,
  };
}
