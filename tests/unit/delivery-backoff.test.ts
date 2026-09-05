import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { productionDeliveryServices, runDeliveryStep } from '../../src/delivery/controller.js';
import { GitHubOperationError } from '../../src/delivery/github.js';
import { runGuardianStep } from '../../src/delivery/guardian.js';
import { deliveryFixture } from '../helpers/delivery.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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

describe('durable delivery API backoff', () => {
  it('holds guardian dispatch without opening active permits or starting processes', async () => {
    const { ledger } = fixture();
    ledger.set('github-backoff-until', Date.now() + 120_000);
    const reserve = vi.spyOn(ledger, 'reserveActive');
    await expect(
      runGuardianStep(ledger, {
        command: { bin: process.execPath, args: ['-e', 'process.exit(99)'] },
      }),
    ).resolves.toBe(0);
    expect(reserve).not.toHaveBeenCalled();
    expect(ledger.owner('step')).toBeUndefined();
    expect(ledger.budget(0, Date.now()).dailyMeasuredMs).toBe(0);
    expect(ledger.get<number>('next-wait-ms')).toBeGreaterThan(100_000);
    expect(ledger.mode()).toBe('active');
  });

  it('keeps selection active while a rate-limited read awaits its durable reset time', async () => {
    const { ledger } = fixture();
    const services = await productionDeliveryServices(
      ledger,
      {},
      {
        readToken: () => Promise.resolve('fixture-token'),
        actor: () => Promise.resolve('fixture-operator'),
      },
    );
    const retryAtMs = Date.now() + 120_000;
    const read = vi
      .spyOn(services.github, 'getMain')
      .mockRejectedValue(new GitHubOperationError('Throttled', 'rejected', retryAtMs));
    expect((await runDeliveryStep(ledger, {}, services)).waitMs).toBeGreaterThan(100_000);
    expect(ledger.mode()).toBe('active');
    expect(ledger.get('github-backoff-until')).toBe(retryAtMs);
    await runDeliveryStep(ledger, {}, services);
    expect(read).toHaveBeenCalledOnce();
    expect(ledger.issues()).toEqual([]);
  });

  it('retains an ambiguous write and reconciles it after backoff without replaying it', async () => {
    const { ledger, root } = fixture();
    ledger.saveIssue({
      number: 1,
      nodeId: 'I_1',
      title: 'Fixture',
      originalBody: '',
      fingerprint: 'fixture',
      stage: 'reconcile',
      baseSha: 'base',
      acceptance: [],
      decisions: [],
      dependencies: [],
      findingKeys: [],
      worktree: root,
      mergedSha: 'merged',
    });
    ledger.set('current-issue', 1);
    const services = await productionDeliveryServices(
      ledger,
      {},
      {
        readToken: () => Promise.resolve('fixture-token'),
        actor: () => Promise.resolve('fixture-operator'),
      },
    );
    const close = vi
      .spyOn(services.github, 'closeIssue')
      .mockRejectedValue(
        new GitHubOperationError('Response unavailable', 'unknown', Date.now() + 120_000),
      );
    const read = vi.spyOn(services.github, 'getIssue').mockResolvedValue({
      number: 1,
      nodeId: 'I_1',
      title: 'Fixture',
      body: '',
      state: 'closed',
      updatedAt: '',
      url: 'https://example.test/1',
      labels: [],
      assignees: [],
    });
    vi.spyOn(services.repository, 'finalizeWorktree').mockResolvedValue();
    await runDeliveryStep(ledger, {}, services);
    expect(ledger.issue(1)?.stage).toBe('reconcile');
    expect(ledger.effect('close-merged:1:merged')?.state).toBe('unknown');
    expect(ledger.mode()).toBe('active');
    ledger.set('github-backoff-until', 0);
    await runDeliveryStep(ledger, {}, services);
    expect(close).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(ledger.issue(1)?.stage).toBe('done');
    expect(ledger.effect('close-merged:1:merged')?.state).toBe('completed');
  });
});
