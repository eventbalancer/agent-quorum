import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readDeliverySmokeRequest,
  type DeliverySmokeRequest,
} from '../../scripts/delivery-smoke.js';
import * as commands from '../../src/delivery/commands.js';
import { productionDeliveryServices, runDeliveryStep } from '../../src/delivery/controller.js';
import { ISSUE_LIMIT_MS, type DeliveryIssue } from '../../src/delivery/contract.js';
import { nextDeliveryDay } from '../../src/delivery/ledger.js';
import { deliveryFixture } from '../helpers/delivery.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

async function fixture() {
  const result = deliveryFixture();
  cleanups.push(() => {
    result.ledger.close();
    rmSync(result.root, { recursive: true, force: true });
  });
  const { ledger, mandate, worktree, root } = result;
  ledger.changeMode('stopped', 'fixture configuration');
  ledger.prepare({ ...mandate, controllerDigest: 'c'.repeat(64) });
  ledger.changeMode('active', 'explicit fixture mandate');
  const issue: DeliveryIssue = {
    number: 1,
    nodeId: 'I_1',
    title: 'Fixture',
    originalBody: '',
    fingerprint: 'fixture',
    stage: 'live',
    baseSha: 'a'.repeat(40),
    candidateSha: 'b'.repeat(40),
    worktree,
    acceptance: [],
    decisions: [],
    dependencies: [],
    findingKeys: [],
  };
  ledger.saveIssue(issue);
  ledger.set('current-issue', issue.number);
  ledger.set('live-implementation:1', issue.candidateSha);
  vi.stubEnv('AGENT_QUORUM_EXECUTION_CONTROL_FILE', path.join(root, 'control.json'));
  const services = await productionDeliveryServices(
    ledger,
    {},
    {
      readToken: () => Promise.resolve('fixture-token'),
      actor: () => Promise.resolve('fixture-operator'),
    },
  );
  return { ...result, issue, services };
}

describe('live request active allowance', () => {
  it.each(['measured', 'reserved'] as const)(
    'admits the production request after fractional %s time without restoring allowance',
    async (accounting) => {
      const { ledger, issue, services, root } = await fixture();
      const permit = ledger.reserveActive(
        issue.number,
        0,
        accounting === 'measured' ? Date.now() : nextDeliveryDay(Date.now()) - 0.25,
        'fixture',
      );
      if (accounting === 'measured') {
        ledger.settleActive(permit.id, 0.25, 'fixture');
      } else {
        ledger.retainInterruptedPermit();
      }
      const original = ledger.budget(issue.number, Date.now());
      expect(original.issueMeasuredMs + original.issueReservedMs).toBe(0.25);
      let admitted: DeliverySmokeRequest | undefined;
      const command = vi.spyOn(commands, 'runDeliveryCommand').mockImplementation((input) => {
        admitted = readDeliverySmokeRequest(input.args.at(-1) ?? '');
        const fractionalRequest = path.join(root, 'fractional-request.json');
        writeFileSync(
          fractionalRequest,
          JSON.stringify({ ...admitted, remainingActiveMs: original.availableMs }),
          { mode: 0o600 },
        );
        expect(() => readDeliverySmokeRequest(fractionalRequest)).toThrow(
          'unsupported fields or invalid explicit bounds',
        );
        return Promise.resolve({
          exitCode: 1,
          stdout: JSON.stringify({ reason: 'live-attempt-limit' }),
          stderr: '',
        });
      });
      const execution = { deadlineEpochMs: Date.now() + 5000 };
      await expect(services.live(issue, path.join(root, 'live'), execution)).rejects.toThrow(
        'live-attempt-limit',
      );
      expect(admitted?.remainingActiveMs).toBe(Math.floor(original.availableMs));
      expect(admitted?.remainingActiveMs).toBeLessThan(original.availableMs);
      expect(command).toHaveBeenCalledOnce();
      expect(command.mock.calls[0]?.[0].execution).toBe(execution);
      expect(ledger.budget(issue.number, Date.now())).toEqual(original);
      expect(ledger.get('live:1')).toBeUndefined();
      expect(ledger.get('live-execution:1')).toBeUndefined();
      expect(ledger.get('open-permit')).toBeUndefined();
    },
  );

  it('defers an unmet live gate when less than one millisecond remains without starting smoke', async () => {
    const { ledger, services, issue, worktree } = await fixture();
    const permit = ledger.reserveActive(issue.number, 0, Date.now(), 'fixture');
    ledger.settleActive(permit.id, ISSUE_LIMIT_MS - 0.75, 'fixture');
    const original = ledger.budget(issue.number, Date.now());
    expect(original.availableMs).toBe(0.75);
    const manifestRoot = path.join(worktree, 'benchmarks/planning');
    mkdirSync(manifestRoot, { recursive: true });
    writeFileSync(
      path.join(manifestRoot, 'smoke-manifest.json'),
      JSON.stringify({ workspaceRevision: issue.candidateSha }),
    );
    vi.spyOn(services.github, 'getIssue')
      .mockRejectedValue(new Error('Fixture status reconciliation unavailable'))
      .mockResolvedValueOnce({
        number: issue.number,
        nodeId: issue.nodeId,
        title: issue.title,
        body: issue.originalBody,
        state: 'open',
        updatedAt: '',
        url: 'https://example.test/1',
        labels: [],
        assignees: [],
      });
    vi.spyOn(services.repository, 'changedPaths').mockResolvedValue(['src/delivery/guardian.ts']);
    vi.spyOn(services.repository, 'treeDigest').mockResolvedValue('candidate');
    vi.spyOn(services.repository, 'git').mockResolvedValue('');
    const command = vi
      .spyOn(commands, 'runDeliveryCommand')
      .mockRejectedValue(new Error('Unexpected smoke process'));
    const worker = vi.spyOn(services.worker, 'work');
    const review = vi.spyOn(services.worker, 'review');
    await runDeliveryStep(ledger, {}, services);
    expect(ledger.mode()).toBe('active');
    expect(ledger.issue(issue.number)).toMatchObject({
      stage: 'deferred',
      blocker: 'live-budget-insufficient',
    });
    expect(ledger.get('resume-stage:1')).toBe('live');
    expect(ledger.get('pending-status:1')).toMatchObject({ blocker: 'live-budget-insufficient' });
    expect(ledger.get('live:1')).toBeUndefined();
    expect(ledger.get('live-execution:1')).toBeUndefined();
    expect(ledger.budget(issue.number, Date.now())).toEqual(original);
    expect(command).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });
});
