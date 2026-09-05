import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { frozenRuntimeEntries } from '../../src/delivery/activation.js';
import { DeliveryError, digest } from '../../src/delivery/contract.js';
import { admitGuardianRequest } from '../../src/delivery/guardian.js';
import {
  checkSharedMainRecovery,
  restoreSharedMainHealth,
  sharedMainRecoveryIssue,
  type MainRecoveryHost,
} from '../../src/delivery/main-recovery.js';
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
function fixture(integrated = false) {
  const result = deliveryFixture();
  cleanups.push(() => {
    result.ledger.close();
    rmSync(result.root, { recursive: true, force: true });
  });
  const mandate = {
    ...result.ledger.mandate(),
    controllerDigest: digest(frozenRuntimeEntries(result.root)),
    profileDigest: digest(result.ledger.mandate().profile),
  };
  result.ledger.changeMode('prepared', 'fixture');
  const authorized = result.ledger.prepare(mandate);
  result.ledger.set('activation-probes', { digest: authorized, passed: true });
  result.ledger.changeMode('blocked', 'fixture failed main checks');
  result.ledger.set('shared-blocker', {
    reason: integrated ? 'integrated-main-check-failed' : 'main-required-checks-unhealthy',
    currentIssue: integrated ? 1 : 0,
  });
  if (integrated) {
    result.ledger.saveIssue({
      number: 1,
      nodeId: 'I_1',
      title: 'Fixture',
      originalBody: '',
      fingerprint: 'f',
      stage: 'main-ci',
      baseSha: 'base',
      acceptance: [],
      decisions: [],
      dependencies: [],
      findingKeys: [],
      mergedSha: 'integrated',
    });
  }
  return { ...result, mandate, authorized };
}
function host(healthy: boolean): MainRecoveryHost & {
  readonly github: NonNullable<MainRecoveryHost['github']>;
} {
  return {
    actor: () => Promise.resolve('fixture-operator'),
    verifyPolicy: () => Promise.resolve(),
    github: {
      getMain: () => Promise.resolve('current'),
      inspectPrerequisites: () =>
        Promise.resolve({
          allowed: true,
          blockers: [],
          requiredChecks: [{ context: 'check', appId: 1 }],
          mainSha: 'current',
        }),
      getChecks: (sha) =>
        Promise.resolve([
          {
            id: 1,
            context: 'check',
            appId: 1,
            sha,
            status: 'completed',
            conclusion: healthy ? 'success' : 'failure',
            url: 'https://example.test/check',
          },
        ]),
    },
  };
}

describe('conditional shared main recovery', () => {
  it('keeps unchanged unhealthy checks blocked without notification churn', async () => {
    const { ledger, authorized } = fixture();
    const before = ledger.events().length;
    await checkSharedMainRecovery(ledger, {}, host(false));
    expect(restoreSharedMainHealth(ledger, authorized)).toBe(false);
    await checkSharedMainRecovery(ledger, {}, host(false));
    expect(ledger.mode()).toBe('blocked');
    expect(ledger.events()).toHaveLength(before);
    expect(ledger.effects()).toEqual([]);
  });

  it('requires both the integrated revision and current main to be healthy before resuming', async () => {
    const { ledger, authorized } = fixture(true);
    const services = host(true);
    const checks = vi.spyOn(services.github, 'getChecks');
    await checkSharedMainRecovery(ledger, {}, services);
    expect(checks.mock.calls.map(([sha]) => sha)).toEqual(['integrated', 'current']);
    expect(ledger.mode()).toBe('blocked');
    expect(restoreSharedMainHealth(ledger, authorized)).toBe(true);
    expect(ledger.mode()).toBe('active');
    expect(ledger.get('shared-blocker')).toBeUndefined();
  });

  it('checks current main for an issue blocked before it has a merged revision', async () => {
    const { ledger, authorized } = fixture(true);
    ledger.set('shared-blocker', { reason: 'main-required-checks-unhealthy', currentIssue: 1 });
    const issue = ledger.issue(1);
    if (issue === undefined) {
      throw new Error('Fixture issue missing');
    }
    const { mergedSha, ...unmergedIssue } = issue;
    expect(mergedSha).toBe('integrated');
    ledger.saveIssue({ ...unmergedIssue, stage: 'refine' });
    const services = host(true);
    const checks = vi.spyOn(services.github, 'getChecks');
    await checkSharedMainRecovery(ledger, {}, services);
    expect(checks.mock.calls.map(([sha]) => sha)).toEqual(['current']);
    expect(restoreSharedMainHealth(ledger, authorized)).toBe(true);
  });

  it('rejects policy/authentication blockers and revoked recovery authority', async () => {
    const { ledger, authorized } = fixture();
    ledger.set('shared-blocker', { reason: 'managed-tool-configuration-changed', currentIssue: 0 });
    expect(() => sharedMainRecoveryIssue(ledger, authorized)).toThrow(
      'shared-main-recovery-not-authorized',
    );
    ledger.set('shared-blocker', { reason: 'main-required-checks-unhealthy', currentIssue: 0 });
    ledger.changeMode('revoked', 'operator revoke');
    await expect(checkSharedMainRecovery(ledger, {}, host(true))).rejects.toThrow(
      'shared-main-recovery-not-authorized',
    );
  });

  it('requires operator reconciliation after policy or identity drift instead of retrying automatically', async () => {
    const { ledger, authorized } = fixture();
    const services = host(true);
    await expect(
      checkSharedMainRecovery(
        ledger,
        {},
        {
          ...services,
          verifyPolicy: () =>
            Promise.reject(new DeliveryError('managed-tool-configuration-changed')),
        },
      ),
    ).rejects.toThrow('managed-tool-configuration-changed');
    expect(() => sharedMainRecoveryIssue(ledger, authorized)).toThrow(
      'shared-main-recovery-not-authorized',
    );
    ledger.set('shared-blocker', { reason: 'main-required-checks-unhealthy', currentIssue: 0 });
    await checkSharedMainRecovery(
      ledger,
      {},
      { ...services, actor: () => Promise.resolve('other') },
    );
    expect(ledger.get('shared-blocker')).toEqual({
      reason: 'github-actor-changed',
      currentIssue: 0,
    });
    expect(ledger.mode()).toBe('blocked');
  });

  it('permits bounded read processes while prohibiting a model provider in recovery', () => {
    const { ledger, authorized } = fixture();
    const options = {
      ledger,
      issue: 0,
      nonce: 'n'.repeat(48),
      deadlineEpochMs: Date.now() + 1000,
      processGroup: () => '1',
      blockedRecoveryDigest: authorized,
    };
    const message = {
      version: 1,
      requestId: 'recovery-fixture-request',
      nonce: options.nonce,
      type: 'before-spawn',
      attempt: { command: '/usr/bin/git', cwd: '/fixture' },
    };
    expect(admitGuardianRequest(options, message)).toBe(false);
    expect(() =>
      admitGuardianRequest(options, {
        ...message,
        attempt: { ...message.attempt, command: 'codex' },
      }),
    ).toThrow('model-provider-forbidden-during-main-recovery');
    const permit = ledger.reserveActive(0, 0, Date.now(), 'fixture', undefined, authorized);
    ledger.settleActive(permit.id, 100, 'fixture');
    expect(ledger.budget(0, Date.now()).dailyMeasuredMs).toBe(100);
    expect(ledger.mode()).toBe('blocked');
  });
});
