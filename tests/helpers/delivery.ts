import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DELIVERY_OPERATIONS,
  DAY_LIMIT_MS,
  ISSUE_LIMIT_MS,
  type DeliveryProfile,
  type Mandate,
} from '../../src/delivery/contract.js';
import { DeliveryLedger } from '../../src/delivery/ledger.js';

export function deliveryProfile(): DeliveryProfile {
  return {
    worker: { model: 'fixture-codex', reasoning: 'medium' },
    reviewer: { model: 'fixture-codex', reasoning: 'high' },
    planning: {
      configFile: '/fixture/planning.json',
      quality: 'balanced',
      maxIterations: 5,
      maxRuns: 2,
    },
    bounds: {
      providerStartsPerIssue: 20,
      providerStartsPerDay: 60,
      providerTimeoutMs: 60_000,
      providerRetries: 1,
      providerRetryDelayMs: 10,
      commandTimeoutMs: 60_000,
      liveStartsPerScenario: 2,
      liveScenarioTimeoutMs: 60_000,
    },
    scope: { include: [], exclude: [], priorities: [] },
  };
}

export function deliveryMandate(root: string): Mandate {
  return {
    version: 1,
    repository: 'eventbalancer/agent-quorum',
    base: 'main',
    sourceRoot: root,
    runtimeRoot: root,
    controllerDigest: 'fixture-controller',
    profileDigest: 'fixture-profile',
    policyVersion: 1,
    profile: deliveryProfile(),
    requiredChecks: [{ context: 'check', appId: 1 }],
    actor: 'fixture-operator',
    mcpServerNames: [],
    mcpConfigurationDigest: 'fixture-mcp',
    workflowTreeSha: 'fixture-workflows',
    issueLimitMs: ISSUE_LIMIT_MS,
    dailyLimitMs: DAY_LIMIT_MS,
    repairLimit: 2,
    timezone: 'Europe/Moscow',
    operations: DELIVERY_OPERATIONS,
    releases: false,
    createdAt: '2026-09-05T00:00:00Z',
  };
}

interface DeliveryFixture {
  readonly root: string;
  readonly ledger: DeliveryLedger;
  readonly mandate: Mandate;
  readonly worktree: string;
}

export function deliveryFixture(): DeliveryFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'delivery-test-'));
  const worktree = path.join(root, 'worktree');
  mkdirSync(worktree);
  const ledger = new DeliveryLedger(path.join(root, 'state'));
  const mandate = deliveryMandate(root);
  ledger.prepare(mandate);
  ledger.changeMode('active', 'explicit fixture mandate');
  return { root, ledger, mandate, worktree };
}
