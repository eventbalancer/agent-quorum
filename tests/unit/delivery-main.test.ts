import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { digest, type DeliveryIssue } from '../../src/delivery/contract.js';
import {
  changeDeliveryScope,
  parseDeliveryArguments,
  reopenDeliveryIssue,
  runDeliveryCli,
} from '../../src/delivery/main.js';
import { deliveryFixture } from '../helpers/delivery.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => {
      cleanup();
    });
});
function fixture() {
  const result = deliveryFixture();
  cleanups.push(() => {
    result.ledger.close();
    rmSync(result.root, { recursive: true, force: true });
  });
  return result;
}
function issue(number: number, stage: DeliveryIssue['stage']): DeliveryIssue {
  return {
    number,
    nodeId: `I_${number}`,
    title: 'Fixture',
    originalBody: '',
    fingerprint: 'fixture',
    stage,
    baseSha: 'base',
    acceptance: [],
    decisions: [],
    dependencies: [],
    findingKeys: [],
  };
}

describe('delivery operator controls', () => {
  it('rejects duplicate, unknown, and missing argument values', () => {
    expect(parseDeliveryArguments([]).command).toBe('help');
    expect(parseDeliveryArguments(['--', '--help']).command).toBe('--help');
    expect(() => parseDeliveryArguments(['activate', '--digest'])).toThrow();
    expect(() => parseDeliveryArguments(['activate', '--digest', 'a', '--digest', 'b'])).toThrow();
    expect(() => parseDeliveryArguments(['release'])).toThrow();
    expect(() => parseDeliveryArguments(['status', '--admin', 'true'])).toThrow();
  });

  it('narrows scope immediately and requires the current digest to expand', () => {
    const { ledger } = fixture();
    ledger.saveIssue(issue(1, 'implement'));
    ledger.set('current-issue', 1);
    const before = digest(ledger.mandate());
    const narrowed = changeDeliveryScope(ledger, { include: [], exclude: [1], priorities: [] });
    expect(narrowed).not.toBe(before);
    expect(ledger.issue(1)?.blocker).toBe('scope-excluded');
    expect(ledger.get('current-issue')).toBe(0);
    expect(() =>
      changeDeliveryScope(ledger, { include: [], exclude: [], priorities: [] }, before),
    ).toThrow('scope-expansion-requires-current-authorization');
    changeDeliveryScope(ledger, { include: [], exclude: [], priorities: [] }, narrowed);
    expect(ledger.get('queued-reopen:1')).toBe('implement');
  });

  it('queues a reopened issue behind existing work and preserves charged budgets', () => {
    const { ledger } = fixture();
    ledger.saveIssue(issue(1, 'implement'));
    ledger.saveIssue(issue(2, 'deferred'));
    ledger.set('current-issue', 1);
    ledger.set('resume-stage:2', 'review');
    const authorization = digest(ledger.mandate());
    reopenDeliveryIssue(ledger, 2, 10, 1, authorization, { operationId: 'first' });
    expect(ledger.issue(2)?.stage).toBe('deferred');
    expect(ledger.get('queued-reopen:2')).toBe('review');
    expect(ledger.counter('time-grant:2')).toBe(600_000);
    reopenDeliveryIssue(ledger, 2, 10, 1, authorization, { operationId: 'first' });
    expect(ledger.counter('time-grant:2')).toBe(600_000);
    reopenDeliveryIssue(ledger, 2, 10, 1, authorization, { operationId: 'second' });
    expect(ledger.counter('time-grant:2')).toBe(1_200_000);
  });

  it('revokes authority and reports inspectable status without activating', async () => {
    const { ledger } = fixture();
    const output: unknown[] = [];
    await runDeliveryCli(['revoke', '--state-dir', ledger.directory], {
      output: (value) => {
        output.push(value);
      },
    });
    expect(ledger.mode()).toBe('revoked');
    await runDeliveryCli(['status', '--state-dir', ledger.directory], {
      output: (value) => {
        output.push(value);
      },
    });
    expect(output[1]).toMatchObject({ mode: 'revoked', pendingEffects: [], currentIssue: 0 });
  });

  it('reports pending effect identities and digests without exposing private payloads', async () => {
    const { ledger } = fixture();
    const secret = 'sentinel-private-worker-text';
    const input = { title: 'Private finding', body: secret, files: [{ content: secret }] };
    ledger.intendEffect({
      key: 'issue-fixture',
      kind: 'issue',
      issue: 1,
      state: 'intended',
      input,
    });
    ledger.finishEffect('issue-fixture', 'unknown', { response: secret });
    const output: unknown[] = [];
    await runDeliveryCli(['status', '--state-dir', ledger.directory], {
      output: (value) => {
        output.push(value);
      },
    });
    expect(output[0]).toMatchObject({
      pendingEffects: [
        {
          key: 'issue-fixture',
          kind: 'issue',
          issue: 1,
          state: 'unknown',
          inputDigest: digest(input),
        },
      ],
    });
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(JSON.stringify(output)).not.toContain('Private finding');
  });
});
