import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DAY_LIMIT_MS,
  DeliveryError,
  ISSUE_LIMIT_MS,
  REPAIR_LIMIT,
  digest,
  parseMandate,
  scopeIncludes,
  type DeliveryIssue,
  type DeliveryMode,
  type DeliveryOperation,
  type Mandate,
} from './contract.js';

export interface ProcessOwner {
  readonly id: string;
  readonly pid: number;
  readonly pgid: string;
  readonly startToken: string;
}

export type OperationState = 'intended' | 'unknown' | 'completed' | 'rejected';
export interface EffectRecord {
  readonly key: string;
  readonly kind: DeliveryOperation;
  readonly issue: number;
  readonly state: OperationState;
  readonly input: unknown;
  readonly output?: unknown;
}

export interface BudgetSnapshot {
  readonly day: string;
  readonly dailyMeasuredMs: number;
  readonly dailyReservedMs: number;
  readonly issueMeasuredMs: number;
  readonly issueReservedMs: number;
  readonly availableMs: number;
  readonly repairs: number;
}

export interface ActivePermit {
  readonly id: string;
  readonly issue: number;
  readonly day: string;
  readonly boot: string;
  readonly monotonicStartMs: number;
  readonly wallStartMs: number;
  readonly reservedMs: number;
}

export interface DeliveryEvent {
  readonly sequence: number;
  readonly kind: string;
  readonly detail: unknown;
  readonly notification: boolean;
}

const MODES: readonly DeliveryMode[] = [
  'prepared',
  'blocked',
  'active',
  'pausing',
  'paused',
  'stopped',
  'revoked',
  'daily-limit',
];
const SCHEMA_VERSION = 1;
const PERMIT_MS = 1000;
const MOSCOW_OFFSET_MS = 3 * 60 * 60_000;

export function deliveryDay(wallMs: number): string {
  return new Date(wallMs + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
}

export function nextDeliveryDay(wallMs: number): number {
  const shifted = new Date(wallMs + MOSCOW_OFFSET_MS);
  return (
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1) -
    MOSCOW_OFFSET_MS
  );
}

function decoded(value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new DeliveryError('invalid-delivery-ledger', true);
  }
  return JSON.parse(value) as unknown;
}

function numberCell(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DeliveryError('invalid-delivery-counter', true);
  }
  return value;
}

export class DeliveryLedger {
  private readonly database: DatabaseSync;

  constructor(
    readonly directory: string,
    readonly readOnly = false,
  ) {
    if (!readOnly) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    this.database = new DatabaseSync(path.join(directory, 'delivery.sqlite'), { readOnly });
    this.database.exec('PRAGMA busy_timeout = 5000');
    const version = numberCell(this.database.prepare('PRAGMA user_version').get()?.user_version);
    if (version !== 0 && version !== SCHEMA_VERSION) {
      this.database.close();
      throw new DeliveryError('unsupported-delivery-ledger-version', true);
    }
    if (readOnly && version !== SCHEMA_VERSION) {
      this.database.close();
      throw new DeliveryError('uninitialized-delivery-ledger', true);
    }
    if (!readOnly) {
      this.database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS issues (number INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS claims (resource TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS effects (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS permits (
          id TEXT PRIMARY KEY, issue INTEGER NOT NULL, day TEXT NOT NULL, value TEXT NOT NULL,
          measured REAL NOT NULL DEFAULT 0, reserved REAL NOT NULL, settled INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT UNIQUE NOT NULL,
          kind TEXT NOT NULL, detail TEXT NOT NULL, notification INTEGER NOT NULL,
          acknowledged INTEGER NOT NULL DEFAULT 0
        );
        PRAGMA user_version = 1;
      `);
      chmodSync(path.join(directory, 'delivery.sqlite'), 0o600);
    }
  }

  close(): void {
    this.database.close();
  }

  transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  get<T>(key: string, fallback?: T): T | undefined {
    const row = this.database.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
    return row === undefined ? fallback : (decoded(row.value) as T);
  }

  set(key: string, value: unknown): void {
    this.database
      .prepare(
        'INSERT INTO metadata VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  unset(key: string): void {
    this.database.prepare('DELETE FROM metadata WHERE key=?').run(key);
  }

  mandate(): Mandate {
    const mandate = this.get<Mandate>('mandate');
    if (mandate === undefined || digest(mandate) !== this.get<string>('mandate-digest')) {
      throw new DeliveryError('missing-or-changed-mandate', true);
    }
    return parseMandate(mandate);
  }

  prepare(mandate: Mandate): string {
    return this.transaction(() => {
      const current = this.mode();
      if (
        current !== 'prepared' &&
        current !== 'stopped' &&
        current !== 'revoked' &&
        current !== 'blocked'
      ) {
        throw new DeliveryError('stop-before-preparing-mandate', true);
      }
      parseMandate(mandate);
      const mandateDigest = digest(mandate);
      this.set('mandate', mandate);
      this.set('mandate-digest', mandateDigest);
      this.set('mode', 'prepared');
      this.event('mandate-prepared', { digest: mandateDigest }, true);
      return mandateDigest;
    });
  }

  mode(): DeliveryMode {
    const mode = this.get<DeliveryMode>('mode') ?? 'prepared';
    if (!MODES.includes(mode)) {
      throw new DeliveryError('invalid-delivery-mode', true);
    }
    return mode;
  }

  modeReason(): string | undefined {
    const row = this.database
      .prepare("SELECT detail FROM events WHERE kind='mode' ORDER BY sequence DESC LIMIT 1")
      .get();
    const detail = row === undefined ? undefined : decoded(row.detail);
    if (
      typeof detail !== 'object' ||
      detail === null ||
      !('mode' in detail) ||
      detail.mode !== this.mode() ||
      !('reason' in detail) ||
      typeof detail.reason !== 'string'
    ) {
      return undefined;
    }
    return detail.reason;
  }

  changeMode(mode: DeliveryMode, reason: string): void {
    if (this.mode() === mode) {
      return;
    }
    this.transaction(() => {
      this.set('mode', mode);
      this.event('mode', { mode, reason }, true, `mode:${this.increment('mode-generation')}`);
    });
  }

  assertAuthorized(operation: DeliveryOperation, issue = 0): Mandate {
    const mandate = this.mandate();
    if (this.mode() !== 'active') {
      throw new DeliveryError('delivery-not-active', true);
    }
    if (mandate.requiredChecks.length === 0) {
      throw new DeliveryError('required-checks-not-pinned', true);
    }
    if (!mandate.operations.includes(operation)) {
      throw new DeliveryError('operation-outside-mandate', true);
    }
    if (issue !== 0 && !scopeIncludes(mandate.profile.scope, issue)) {
      throw new DeliveryError('issue-outside-mandate');
    }
    return mandate;
  }

  issue(number: number): DeliveryIssue | undefined {
    const row = this.database.prepare('SELECT value FROM issues WHERE number = ?').get(number);
    return row === undefined ? undefined : (decoded(row.value) as DeliveryIssue);
  }

  issues(): DeliveryIssue[] {
    return this.database
      .prepare('SELECT value FROM issues ORDER BY number')
      .all()
      .map((row) => decoded(row.value) as DeliveryIssue);
  }

  saveIssue(issue: DeliveryIssue): void {
    this.database
      .prepare(
        'INSERT INTO issues VALUES (?, ?) ON CONFLICT(number) DO UPDATE SET value=excluded.value',
      )
      .run(issue.number, JSON.stringify(issue));
  }

  claim(resource: string, owner: ProcessOwner, isLive: (owner: ProcessOwner) => boolean): void {
    this.transaction(() => {
      const previous = this.owner(resource);
      if (previous !== undefined && previous.id !== owner.id && isLive(previous)) {
        throw new DeliveryError('live-delivery-owner', true);
      }
      this.database
        .prepare(
          'INSERT INTO claims VALUES (?, ?) ON CONFLICT(resource) DO UPDATE SET value=excluded.value',
        )
        .run(resource, JSON.stringify(owner));
    });
  }

  owner(resource: string): ProcessOwner | undefined {
    const row = this.database.prepare('SELECT value FROM claims WHERE resource = ?').get(resource);
    return row === undefined ? undefined : (decoded(row.value) as ProcessOwner);
  }

  release(resource: string, ownerId: string): void {
    this.transaction(() => {
      if (this.owner(resource)?.id !== ownerId) {
        throw new DeliveryError('delivery-owner-mismatch', true);
      }
      this.database.prepare('DELETE FROM claims WHERE resource = ?').run(resource);
    });
  }

  effect(key: string): EffectRecord | undefined {
    const row = this.database.prepare('SELECT value FROM effects WHERE key = ?').get(key);
    return row === undefined ? undefined : (decoded(row.value) as EffectRecord);
  }

  effects(): EffectRecord[] {
    return this.database
      .prepare('SELECT value FROM effects')
      .all()
      .map((row) => decoded(row.value) as EffectRecord);
  }

  intendEffect(effect: EffectRecord): EffectRecord {
    return this.transaction(() => {
      this.assertAuthorized(effect.kind, effect.issue);
      const previous = this.effect(effect.key);
      if (previous !== undefined) {
        if (digest(previous.input) !== digest(effect.input) || previous.kind !== effect.kind) {
          throw new DeliveryError('effect-identity-conflict', true);
        }
        return previous;
      }
      this.database
        .prepare('INSERT INTO effects VALUES (?, ?)')
        .run(effect.key, JSON.stringify(effect));
      return effect;
    });
  }

  finishEffect(key: string, state: OperationState, output?: unknown): void {
    const effect = this.effect(key);
    if (effect === undefined) {
      throw new DeliveryError('missing-effect-intent', true);
    }
    if (effect.state === 'completed' && state !== 'completed') {
      throw new DeliveryError('completed-effect-regression', true);
    }
    this.database
      .prepare('UPDATE effects SET value = ? WHERE key = ?')
      .run(JSON.stringify({ ...effect, state, output }), key);
  }

  counter(key: string): number {
    const row = this.database.prepare('SELECT value FROM counters WHERE key = ?').get(key);
    return row === undefined ? 0 : numberCell(row.value);
  }

  private increment(key: string, amount = 1): number {
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(this.counter(key) + amount)) {
      throw new DeliveryError('delivery-counter-overflow', true);
    }
    this.database
      .prepare(
        'INSERT INTO counters VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value',
      )
      .run(key, amount);
    return this.counter(key);
  }

  reserveAttempt(issue: number, kind: string, limit: number, identity: string): number {
    return this.transaction(() => {
      this.assertAuthorized(kind === 'review' ? 'review' : 'plan', issue);
      const reservation = this.get<number>(`attempt:${identity}`);
      if (reservation !== undefined) {
        return reservation;
      }
      const key = `${kind}:${issue}`;
      const effectiveLimit = limit + this.counter(`attempt-grant:${kind}:${issue}`);
      if (
        !Number.isSafeInteger(effectiveLimit) ||
        limit <= 0 ||
        this.counter(key) >= effectiveLimit
      ) {
        throw new DeliveryError(`${kind}-attempt-limit`);
      }
      const count = this.increment(key);
      this.set(`attempt:${identity}`, count);
      return count;
    });
  }

  private authorizeConsumption(issue: number, preflightDigest?: string): Mandate {
    if (preflightDigest !== undefined) {
      const mandate = this.mandate();
      if (
        issue !== 0 ||
        digest(mandate) !== preflightDigest ||
        !['prepared', 'blocked'].includes(this.mode())
      ) {
        throw new DeliveryError('invalid-preflight-authorization', true);
      }
      return mandate;
    }
    return this.assertAuthorized('verify', issue);
  }

  reserveProvider(issue: number, wallMs: number, identity: string, preflightDigest?: string): void {
    this.transaction(() => {
      const mandate = this.authorizeConsumption(issue, preflightDigest);
      if (this.get<boolean>(`provider:${identity}`) === true) {
        return;
      }
      const issueKey = `provider:${issue}`;
      const dayKey = `provider-day:${deliveryDay(wallMs)}`;
      if (this.counter(dayKey) >= mandate.profile.bounds.providerStartsPerDay) {
        throw new DeliveryError('provider-daily-attempt-limit', true);
      }
      if (
        issue !== 0 &&
        this.counter(issueKey) >=
          mandate.profile.bounds.providerStartsPerIssue +
            this.counter(`attempt-grant:provider:${issue}`)
      ) {
        throw new DeliveryError('provider-issue-attempt-limit');
      }
      this.increment(issueKey);
      this.increment(dayKey);
      this.set(`provider:${identity}`, true);
    });
  }

  reserveRepair(issue: number, identity: string): number {
    return this.transaction(() => {
      this.assertAuthorized('edit', issue);
      const previous = this.get<number>(`repair:${identity}`);
      if (previous !== undefined) {
        return previous;
      }
      const key = `repairs:${issue}`;
      const limit = REPAIR_LIMIT + this.counter(`repair-grant:${issue}`);
      if (this.counter(key) >= limit) {
        throw new DeliveryError('repair-limit');
      }
      const count = this.increment(key);
      this.set(`repair:${identity}`, count);
      return count;
    });
  }

  grantAttempts(
    issue: number,
    kind: 'provider' | 'design' | 'live',
    amount: number,
    authorizationId: string,
  ): void {
    if (
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      !Number.isSafeInteger(issue) ||
      issue <= 0 ||
      authorizationId === ''
    ) {
      throw new DeliveryError('invalid-explicit-attempt-allowance', true);
    }
    this.transaction(() => {
      if (this.get<boolean>(`grant-attempt:${authorizationId}:${kind}`) === true) {
        return;
      }
      const key = `attempt-grant:${kind}:${issue}`;
      const profile = this.mandate().profile;
      const baseLimit =
        kind === 'provider'
          ? profile.bounds.providerStartsPerIssue
          : kind === 'design'
            ? profile.planning.maxRuns
            : profile.bounds.liveStartsPerScenario;
      if (!Number.isSafeInteger(baseLimit + this.counter(key) + amount)) {
        throw new DeliveryError('attempt-allowance-overflow', true);
      }
      this.increment(key, amount);
      this.set(`grant-attempt:${authorizationId}:${kind}`, true);
      this.event('attempt-allowance', { issue, kind, amount, authorizationId }, true);
    });
  }

  grantIssue(issue: number, activeMs: number, repairs: number, authorization: string): void {
    const isValidGrant =
      Number.isSafeInteger(issue) &&
      issue > 0 &&
      Number.isSafeInteger(activeMs) &&
      activeMs >= 0 &&
      Number.isSafeInteger(repairs) &&
      repairs >= 0 &&
      authorization.length > 0;
    if (!isValidGrant || activeMs + repairs === 0) {
      throw new DeliveryError('invalid-explicit-issue-allowance', true);
    }
    this.transaction(() => {
      if (this.get<boolean>(`grant:${authorization}`) === true) {
        return;
      }
      if (
        !Number.isSafeInteger(ISSUE_LIMIT_MS + this.counter(`time-grant:${issue}`) + activeMs) ||
        !Number.isSafeInteger(REPAIR_LIMIT + this.counter(`repair-grant:${issue}`) + repairs)
      ) {
        throw new DeliveryError('issue-allowance-overflow', true);
      }
      this.increment(`time-grant:${issue}`, activeMs);
      this.increment(`repair-grant:${issue}`, repairs);
      this.set(`grant:${authorization}`, true);
      this.event('issue-allowance', { issue, activeMs, repairs, authorization }, true);
    });
  }

  budget(issue: number, wallMs: number): BudgetSnapshot {
    const day = deliveryDay(wallMs);
    const daily = this.database
      .prepare(
        'SELECT COALESCE(SUM(measured),0) AS measured, COALESCE(SUM(reserved),0) AS reserved FROM permits WHERE day=?',
      )
      .get(day);
    const local = this.database
      .prepare(
        'SELECT COALESCE(SUM(measured),0) AS measured, COALESCE(SUM(reserved),0) AS reserved FROM permits WHERE issue=?',
      )
      .get(issue);
    const dailyMeasuredMs = numberCell(daily?.measured);
    const dailyReservedMs = numberCell(daily?.reserved);
    const issueMeasuredMs = numberCell(local?.measured);
    const issueReservedMs = numberCell(local?.reserved);
    const dailyAvailable = DAY_LIMIT_MS - dailyMeasuredMs - dailyReservedMs;
    const localAvailable =
      issue === 0
        ? dailyAvailable
        : ISSUE_LIMIT_MS + this.counter(`time-grant:${issue}`) - issueMeasuredMs - issueReservedMs;
    return {
      day,
      dailyMeasuredMs,
      dailyReservedMs,
      issueMeasuredMs,
      issueReservedMs,
      availableMs: Math.max(0, Math.min(dailyAvailable, localAvailable)),
      repairs: this.counter(`repairs:${issue}`),
    };
  }

  reserveActive(
    issue: number,
    monotonicMs: number,
    wallMs: number,
    boot: string,
    preflightDigest?: string,
    blockedRecoveryDigest?: string,
  ): ActivePermit {
    if (
      !Number.isFinite(monotonicMs) ||
      monotonicMs < 0 ||
      !Number.isFinite(wallMs) ||
      !Number.isFinite(new Date(wallMs).getTime()) ||
      boot === ''
    ) {
      throw new DeliveryError('active-clock-discontinuity', true);
    }
    return this.transaction(() => {
      if (blockedRecoveryDigest !== undefined) {
        const blocker = this.get<{ reason: string; currentIssue: number }>('shared-blocker');
        const receipt = this.get<{ digest: string; passed: boolean }>('activation-probes');
        if (
          preflightDigest !== undefined ||
          this.mode() !== 'blocked' ||
          digest(this.mandate()) !== blockedRecoveryDigest ||
          receipt?.digest !== blockedRecoveryDigest ||
          !receipt.passed ||
          blocker === undefined ||
          !['main-required-checks-unhealthy', 'integrated-main-check-failed'].includes(
            blocker.reason,
          ) ||
          blocker.currentIssue !== issue ||
          !Number.isSafeInteger(issue) ||
          issue < 0
        ) {
          throw new DeliveryError('shared-main-recovery-not-authorized', true);
        }
      } else {
        this.authorizeConsumption(issue, preflightDigest);
      }
      if (this.get<string>('open-permit') !== undefined) {
        throw new DeliveryError('unsettled-active-permit', true);
      }
      const budget = this.budget(issue, wallMs);
      if (budget.availableMs <= 0) {
        const isDaily = budget.dailyMeasuredMs + budget.dailyReservedMs >= DAY_LIMIT_MS;
        throw new DeliveryError(isDaily ? 'daily-active-limit' : 'issue-active-limit', isDaily);
      }
      const permit: ActivePermit = {
        id: randomUUID(),
        issue,
        day: budget.day,
        boot,
        monotonicStartMs: monotonicMs,
        wallStartMs: wallMs,
        reservedMs: Math.min(PERMIT_MS, budget.availableMs, nextDeliveryDay(wallMs) - wallMs),
      };
      this.database
        .prepare('INSERT INTO permits(id,issue,day,value,reserved) VALUES (?,?,?,?,?)')
        .run(permit.id, issue, permit.day, JSON.stringify(permit), permit.reservedMs);
      this.set('open-permit', permit.id);
      return permit;
    });
  }

  settleActive(id: string, monotonicMs: number, boot: string): void {
    this.transaction(() => {
      const row = this.database.prepare('SELECT value,settled FROM permits WHERE id=?').get(id);
      if (row === undefined) {
        throw new DeliveryError('missing-active-permit', true);
      }
      if (row.settled === 1) {
        return;
      }
      const permit = decoded(row.value) as ActivePermit;
      if (
        !Number.isFinite(monotonicMs) ||
        permit.boot !== boot ||
        monotonicMs < permit.monotonicStartMs
      ) {
        throw new DeliveryError('active-clock-discontinuity', true);
      }
      const measured = monotonicMs - permit.monotonicStartMs;
      const firstSegment = Math.min(
        measured,
        nextDeliveryDay(permit.wallStartMs) - permit.wallStartMs,
      );
      this.database
        .prepare('UPDATE permits SET measured=?,reserved=0,settled=1 WHERE id=?')
        .run(firstSegment, id);
      let remainder = measured - firstSegment;
      let nextWall = permit.wallStartMs + firstSegment;
      while (remainder > 0) {
        const segment = Math.min(remainder, nextDeliveryDay(nextWall) - nextWall);
        this.database
          .prepare(
            'INSERT INTO permits(id,issue,day,value,measured,reserved,settled) VALUES (?,?,?,?,?,0,1)',
          )
          .run(
            `${id}:${deliveryDay(nextWall)}`,
            permit.issue,
            deliveryDay(nextWall),
            JSON.stringify(permit),
            segment,
          );
        remainder -= segment;
        nextWall += segment;
      }
      if (this.get<string>('open-permit') === id) {
        this.database.prepare('DELETE FROM metadata WHERE key=?').run('open-permit');
      }
      if (measured > permit.reservedMs + 100) {
        this.set('clock-blocker', 'active-permit-overrun');
      }
    });
  }

  retainInterruptedPermit(): void {
    this.transaction(() => {
      const id = this.get<string>('open-permit');
      if (id !== undefined) {
        this.database.prepare('DELETE FROM metadata WHERE key=?').run('open-permit');
        this.event('uncertain-active-reservation', { permit: id }, true);
      }
    });
  }

  event(
    kind: string,
    detail: unknown,
    notification = false,
    identity = digest({ kind, detail }),
  ): void {
    this.database
      .prepare('INSERT OR IGNORE INTO events(identity,kind,detail,notification) VALUES (?,?,?,?)')
      .run(identity, kind, JSON.stringify(detail), Number(notification));
  }

  events(after = 0, notificationsOnly = false): DeliveryEvent[] {
    const query = notificationsOnly
      ? 'SELECT * FROM events WHERE sequence>? AND notification=1 AND acknowledged=0 ORDER BY sequence'
      : 'SELECT * FROM events WHERE sequence>? ORDER BY sequence';
    return this.database
      .prepare(query)
      .all(after)
      .map((row) => ({
        sequence: numberCell(row.sequence),
        kind: String(row.kind),
        detail: decoded(row.detail),
        notification: row.notification === 1,
      }));
  }

  acknowledge(sequence: number): void {
    this.database.prepare('UPDATE events SET acknowledged=1 WHERE sequence<=?').run(sequence);
  }
}
