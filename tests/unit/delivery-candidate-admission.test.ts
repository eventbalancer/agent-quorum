import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { productionDeliveryServices, runDeliveryStep } from '../../src/delivery/controller.js';
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

describe('candidate denial classification', () => {
  it.each([
    { blocker: 'The delivery GitHub actor changed.', code: 'github-actor-changed', shared: true },
    { blocker: 'Changed enforcement.', code: 'github-enforcement-drift', shared: true },
    {
      blocker: 'The candidate changed trusted workflow producer definitions.',
      code: 'candidate-workflow-producers-changed',
      shared: false,
    },
    {
      blocker: 'The pull request head changed after verification.',
      code: 'candidate-head-changed',
      shared: false,
    },
  ])('stops $code instead of waiting indefinitely for CI', async ({ blocker, code, shared }) => {
    const { ledger, root } = deliveryFixture();
    cleanups.push(() => {
      ledger.close();
      rmSync(root, { recursive: true, force: true });
    });
    ledger.saveIssue({
      number: 1,
      nodeId: 'I_1',
      title: 'Fixture',
      originalBody: '',
      fingerprint: 'fixture',
      stage: 'ci',
      baseSha: 'base',
      candidateSha: 'head',
      pullRequest: 1,
      acceptance: [],
      decisions: [],
      dependencies: [],
      findingKeys: [],
      worktree: root,
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
    const pullRequest = {
      number: 1,
      nodeId: 'P_1',
      title: 'Fixture',
      body: '',
      state: 'open',
      draft: false,
      url: 'https://example.test/1',
      headSha: code === 'candidate-head-changed' ? 'other' : 'head',
      headRef: 'branch',
      baseSha: 'base',
      baseRef: 'main',
      merged: false,
      mergeCommitSha: null,
    };
    vi.spyOn(services.github, 'inspectPrerequisites').mockResolvedValue({
      allowed: true,
      blockers: [],
      requiredChecks: ledger.mandate().requiredChecks,
      mainSha: 'base',
    });
    vi.spyOn(services.github, 'getPullRequest').mockResolvedValue(pullRequest);
    vi.spyOn(services.github, 'getMain').mockResolvedValue('base');
    vi.spyOn(services.github, 'getChecks').mockResolvedValue([]);
    vi.spyOn(services.github, 'assessCandidate').mockResolvedValue({
      allowed: false,
      prerequisitesAllowed: code !== 'github-enforcement-drift',
      blockers: [blocker],
      pullRequest,
      checks: [],
      mainSha: 'base',
    });
    vi.spyOn(services.github, 'getIssue')
      .mockRejectedValue(new Error('Fixture reconciliation unavailable'))
      .mockResolvedValueOnce({
        number: 1,
        nodeId: 'I_1',
        title: 'Fixture',
        body: '',
        state: 'open',
        updatedAt: '',
        url: 'https://example.test/1',
        labels: [],
        assignees: [],
      });
    await runDeliveryStep(ledger, {}, services);
    expect(ledger.mode()).toBe(shared ? 'blocked' : 'active');
    if (shared) {
      expect(ledger.get('shared-blocker')).toMatchObject({ reason: code, currentIssue: 1 });
      expect(ledger.issue(1)?.stage).toBe('ci');
    } else {
      expect(ledger.issue(1)).toMatchObject({ blocker: code, stage: 'deferred' });
    }
  });
});
