import { rmSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { completeDeliveryWorktree } from '../../src/delivery/worktree-finalization.js';
import { deliveryFixture } from '../helpers/delivery.js';

describe('verified session worktree completion', () => {
  it('marks only the exact integrated owned worktree done and retains its files', async () => {
    const { root, ledger, worktree } = deliveryFixture();
    try {
      const issue = {
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
        worktree,
        branch: 'session/fixture',
        mergedSha: 'merged',
      } as const;
      ledger.saveIssue(issue);
      const run = vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'session/fixture\n', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'done', stderr: '' });
      await completeDeliveryWorktree(ledger, ledger.mandate(), {}, worktree, 1, run);
      expect(run.mock.calls[1]?.[0]).toMatchObject({
        args: ['run', 'worktree:done', worktree],
        cwd: root,
      });
      expect(ledger.events().some((event) => event.kind === 'worktree-finalized')).toBe(true);
      ledger.saveIssue({ ...issue, stage: 'verify' });
      await expect(
        completeDeliveryWorktree(ledger, ledger.mandate(), {}, worktree, 1, run),
      ).rejects.toThrow('worktree-finalization-requires-verified-integration');
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      ledger.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
