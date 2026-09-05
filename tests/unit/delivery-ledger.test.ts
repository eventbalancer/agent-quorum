import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DAY_LIMIT_MS,
  ISSUE_LIMIT_MS,
  digest,
  parseDeliveryProfile,
  scopeExpands,
} from '../../src/delivery/contract.js';
import { DeliveryLedger, deliveryDay, nextDeliveryDay } from '../../src/delivery/ledger.js';
import { deliveryFixture, deliveryProfile } from '../helpers/delivery.js';

const fixtures: ReturnType<typeof deliveryFixture>[] = [];
function fixture(): ReturnType<typeof deliveryFixture> {
  const result = deliveryFixture();
  fixtures.push(result);
  return result;
}
afterEach(() => {
  for (const value of fixtures.splice(0)) {
    value.ledger.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});

describe('delivery mandate and budget ledger', () => {
  it('rejects nonfinite, overflowed, missing and unbounded profile values', () => {
    const profile = deliveryProfile();
    expect(parseDeliveryProfile(profile)).toEqual(profile);
    for (const providerTimeoutMs of [Infinity, NaN, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        parseDeliveryProfile({ ...profile, bounds: { ...profile.bounds, providerTimeoutMs } }),
      ).toThrow('invalid-delivery-profile');
    }
    expect(() => parseDeliveryProfile({ ...profile, bounds: {} })).toThrow();
    expect(() => parseDeliveryProfile({ ...profile, secret: 'not-a-real-credential' })).toThrow();
    expect(() =>
      parseDeliveryProfile({
        ...profile,
        bounds: { ...profile.bounds, liveScenarioTimeoutMs: ISSUE_LIMIT_MS },
      }),
    ).toThrow('mandatory-live-gate');
  });

  it('distinguishes scope narrowing from permission expansion', () => {
    const initial = { include: [1, 2], exclude: [2], priorities: [] };
    expect(scopeExpands(initial, { include: [1], exclude: [], priorities: [] })).toBe(false);
    expect(scopeExpands(initial, { include: [], exclude: [], priorities: [] })).toBe(true);
    expect(scopeExpands(initial, { include: [1, 2], exclude: [], priorities: [] })).toBe(true);
  });

  it('keeps delivery unauthorized before activation, after pause and after revocation', () => {
    const { ledger, mandate } = fixture();
    for (const mode of [
      'prepared',
      'pausing',
      'paused',
      'stopped',
      'revoked',
      'blocked',
    ] as const) {
      ledger.changeMode(mode, 'fixture control');
      expect(() => ledger.assertAuthorized('merge', 1)).toThrow('delivery-not-active');
    }
    ledger.changeMode('active', 'fixture authorization');
    ledger.set('mandate', { ...mandate, releases: true });
    expect(() => ledger.assertAuthorized('merge', 1)).toThrow('missing-or-changed-mandate');
  });

  it('atomically claims ownership, refuses live owners, and reconciles dead identity', () => {
    const { ledger } = fixture();
    const first = { id: 'first', pid: 1, pgid: '1', startToken: 'one' };
    const second = { id: 'second', pid: 2, pgid: '2', startToken: 'two' };
    ledger.claim('repository', first, () => true);
    expect(() => {
      ledger.claim('repository', second, () => true);
    }).toThrow('live-delivery-owner');
    ledger.claim('repository', second, () => false);
    expect(() => {
      ledger.release('repository', first.id);
    }).toThrow('delivery-owner-mismatch');
    ledger.release('repository', second.id);
    expect(ledger.owner('repository')).toBeUndefined();
  });

  it('preserves uncertain operations and forbids changing their identity', () => {
    const { ledger } = fixture();
    const input = {
      key: 'create-one',
      kind: 'issue' as const,
      issue: 1,
      state: 'intended' as const,
      input: { title: 'One' },
    };
    ledger.intendEffect(input);
    ledger.finishEffect(input.key, 'unknown');
    expect(ledger.intendEffect(input).state).toBe('unknown');
    expect(() => ledger.intendEffect({ ...input, input: { title: 'Two' } })).toThrow(
      'effect-identity-conflict',
    );
    ledger.finishEffect(input.key, 'completed', { number: 42 });
    expect(ledger.effects()).toHaveLength(1);
    expect(() => {
      ledger.finishEffect(input.key, 'unknown');
    }).toThrow('completed-effect-regression');
  });

  it('counts nested provider starts once by reservation identity and stops at finite limits', () => {
    const { ledger, mandate } = fixture();
    const now = Date.parse('2026-09-05T10:00:00Z');
    for (let index = 0; index < mandate.profile.bounds.providerStartsPerIssue; index += 1) {
      ledger.reserveProvider(1, now, String(index));
      ledger.reserveProvider(1, now, String(index));
    }
    expect(ledger.counter('provider:1')).toBe(20);
    expect(() => {
      ledger.reserveProvider(1, now, 'extra');
    }).toThrow('provider-issue-attempt-limit');
    expect(() => {
      ledger.reserveProvider(1, now + 86_400_000, 'tomorrow');
    }).toThrow('provider-issue-attempt-limit');
    ledger.reserveProvider(2, now, 'independent');
  });

  it('defines a repair cycle cumulatively and only accepts explicitly granted additions', () => {
    const { ledger } = fixture();
    ledger.reserveRepair(1, 'first');
    ledger.reserveRepair(1, 'first');
    ledger.reserveRepair(1, 'second');
    expect(() => ledger.reserveRepair(1, 'third')).toThrow('repair-limit');
    ledger.grantIssue(1, 60_000, 1, 'operator-reopening');
    ledger.grantIssue(1, 60_000, 1, 'operator-reopening');
    expect(ledger.reserveRepair(1, 'third')).toBe(3);
    expect(ledger.counter('time-grant:1')).toBe(60_000);
  });

  it('splits Moscow midnight and never resets issue usage', () => {
    const { ledger } = fixture();
    const before = Date.parse('2026-09-05T20:59:59.700Z');
    const permit = ledger.reserveActive(1, 10_000, before, 'boot');
    expect(permit.reservedMs).toBe(300);
    ledger.settleActive(permit.id, 10_300, 'boot');
    const tomorrow = ledger.reserveActive(1, 10_300, before + 300, 'boot');
    ledger.settleActive(tomorrow.id, 10_500, 'boot');
    expect(deliveryDay(before)).toBe('2026-09-05');
    expect(nextDeliveryDay(before)).toBe(before + 300);
    expect(ledger.budget(1, before + 300)).toMatchObject({
      dailyMeasuredMs: 200,
      issueMeasuredMs: 500,
    });
  });

  it('does not double-count overlapping activity or restore uncertain allowance after restart', () => {
    const { ledger, root } = fixture();
    const now = Date.parse('2026-09-05T10:00:00Z');
    const permit = ledger.reserveActive(1, 100, now, 'boot');
    expect(() => ledger.reserveActive(1, 200, now + 100, 'boot')).toThrow(
      'unsettled-active-permit',
    );
    ledger.retainInterruptedPermit();
    const observer = new DeliveryLedger(`${root}/state`);
    expect(observer.budget(1, now + 3_600_000)).toMatchObject({
      issueReservedMs: 1000,
      issueMeasuredMs: 0,
    });
    observer.close();
    ledger.settleActive(permit.id, 600, 'boot');
    ledger.settleActive(permit.id, 600, 'boot');
    expect(ledger.budget(1, now + 3_600_000)).toMatchObject({
      issueReservedMs: 0,
      issueMeasuredMs: 500,
    });
  });

  it('keeps passive CI waiting outside active intervals and preserves daily exhaustion', () => {
    const { ledger } = fixture();
    const now = Date.parse('2026-09-05T00:00:00Z');
    const permit = ledger.reserveActive(0, 0, now, 'boot');
    ledger.settleActive(permit.id, DAY_LIMIT_MS, 'boot');
    expect(ledger.budget(1, now + DAY_LIMIT_MS)).toMatchObject({
      dailyMeasuredMs: DAY_LIMIT_MS,
      availableMs: 0,
    });
    expect(() => ledger.reserveActive(1, DAY_LIMIT_MS, now + DAY_LIMIT_MS, 'boot')).toThrow(
      'daily-active-limit',
    );
    expect(ledger.budget(1, nextDeliveryDay(now)).availableMs).toBe(ISSUE_LIMIT_MS);
  });

  it('meters authorized activation probes without authorizing delivery', () => {
    const { ledger, mandate } = fixture();
    ledger.changeMode('prepared', 'fixture');
    const permit = ledger.reserveActive(0, 0, Date.now(), 'boot', digest(mandate));
    ledger.reserveProvider(0, Date.now(), 'probe', digest(mandate));
    ledger.settleActive(permit.id, 20, 'boot');
    expect(() => ledger.assertAuthorized('push', 1)).toThrow('delivery-not-active');
    expect(() => ledger.reserveActive(1, 20, Date.now(), 'boot', digest(mandate))).toThrow(
      'invalid-preflight-authorization',
    );
  });

  it('meters only narrowly authorized shared-main reconciliation while delivery remains blocked', () => {
    const { ledger, mandate } = fixture();
    const authorization = digest(mandate);
    ledger.changeMode('blocked', 'integrated-main-check-failed');
    ledger.set('activation-probes', { digest: authorization, passed: true });
    ledger.set('shared-blocker', { reason: 'integrated-main-check-failed', currentIssue: 1 });
    const permit = ledger.reserveActive(1, 0, Date.now(), 'boot', undefined, authorization);
    ledger.settleActive(permit.id, 200, 'boot');
    expect(ledger.budget(1, Date.now()).issueMeasuredMs).toBe(200);
    expect(() => {
      ledger.reserveProvider(1, Date.now(), 'forbidden');
    }).toThrow('delivery-not-active');
    expect(() => ledger.assertAuthorized('merge', 1)).toThrow('delivery-not-active');
    expect(() =>
      ledger.reserveActive(0, 200, Date.now(), 'boot', undefined, authorization),
    ).toThrow('shared-main-recovery-not-authorized');
    ledger.set('shared-blocker', { reason: 'changed-authority-policy', currentIssue: 1 });
    expect(() =>
      ledger.reserveActive(1, 200, Date.now(), 'boot', undefined, authorization),
    ).toThrow('shared-main-recovery-not-authorized');
  });

  it('rejects invalid clocks without consuming reservations and retains failed settlements', () => {
    const { ledger } = fixture();
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(() => ledger.reserveActive(1, invalid, Date.now(), 'boot')).toThrow(
        'active-clock-discontinuity',
      );
      expect(() => ledger.reserveActive(1, 0, invalid, 'boot')).toThrow(
        'active-clock-discontinuity',
      );
    }
    const permit = ledger.reserveActive(1, 0, Date.now(), 'boot');
    expect(() => {
      ledger.settleActive(permit.id, Infinity, 'boot');
    }).toThrow('active-clock-discontinuity');
    expect(ledger.budget(1, Date.now()).issueReservedMs).toBe(1000);
    ledger.settleActive(permit.id, 200, 'boot');
    expect(ledger.budget(1, Date.now()).issueReservedMs).toBe(0);
  });

  it('keeps finite historical attempt grants idempotent and rejects overflowing issue allowances', () => {
    const { ledger, mandate } = fixture();
    const now = Date.now();
    for (let index = 0; index < mandate.profile.bounds.providerStartsPerIssue; index += 1) {
      ledger.reserveProvider(1, now, `start-${index}`);
    }
    ledger.grantAttempts(1, 'provider', 1, 'explicit-reopen');
    ledger.grantAttempts(1, 'provider', 1, 'explicit-reopen');
    ledger.reserveProvider(1, now, 'one-additional');
    expect(() => {
      ledger.reserveProvider(1, now, 'two-additional');
    }).toThrow('provider-issue-attempt-limit');
    expect(ledger.counter('provider:1')).toBe(21);
    expect(() => {
      ledger.grantIssue(1, Number.MAX_SAFE_INTEGER, 0, 'overflow');
    }).toThrow('issue-allowance-overflow');
    expect(ledger.counter('time-grant:1')).toBe(0);
  });

  it('deduplicates unchanged notifications, preserves event cursors and acknowledgments', () => {
    const { ledger } = fixture();
    ledger.event('blocker', { reason: 'same' }, true);
    ledger.event('blocker', { reason: 'same' }, true);
    const notifications = ledger.events(0, true);
    expect(notifications.filter((event) => event.kind === 'blocker')).toHaveLength(1);
    ledger.acknowledge(notifications.at(-1)?.sequence ?? 0);
    expect(ledger.events(0, true)).toHaveLength(0);
    ledger.event('blocker', { reason: 'changed' }, true);
    expect(ledger.events(0, true)).toHaveLength(1);
  });
});
