import type { ExecutionControl } from '../runtime/execution-control.js';
import { verifyFrozenRuntime, verifyMcpConfiguration } from './activation.js';
import { DeliveryError, digest, type Mandate } from './contract.js';
import { assessRequiredChecks, createGhTransport, DeliveryGitHub } from './github.js';
import type { DeliveryLedger } from './ledger.js';

export function sharedMainRecoveryIssue(ledger: DeliveryLedger, authorizedDigest: string): number {
  const blocker = ledger.get<{ reason: string; currentIssue: number }>('shared-blocker');
  const receipt = ledger.get<{ digest: string; passed: boolean }>('activation-probes');
  if (
    ledger.mode() !== 'blocked' ||
    digest(ledger.mandate()) !== authorizedDigest ||
    receipt?.digest !== authorizedDigest ||
    !receipt.passed ||
    blocker === undefined ||
    !['main-required-checks-unhealthy', 'integrated-main-check-failed'].includes(blocker.reason) ||
    !Number.isSafeInteger(blocker.currentIssue) ||
    blocker.currentIssue < 0
  ) {
    throw new DeliveryError('shared-main-recovery-not-authorized', true);
  }
  return blocker.currentIssue;
}

export interface MainRecoveryHost {
  readonly github?: Pick<DeliveryGitHub, 'getMain' | 'getChecks' | 'inspectPrerequisites'>;
  readonly actor?: () => Promise<string>;
  readonly verifyPolicy?: (mandate: Mandate, execution: ExecutionControl) => Promise<void>;
}

function requireRecoveryReauthorization(
  ledger: DeliveryLedger,
  issue: number,
  reason: string,
): void {
  ledger.set('shared-blocker', { reason, currentIssue: issue });
  ledger.event('shared-main-recovery-requires-operator', { issue, reason }, true);
}

export async function checkSharedMainRecovery(
  ledger: DeliveryLedger,
  execution: ExecutionControl,
  host: MainRecoveryHost = {},
): Promise<void> {
  const mandate = ledger.mandate();
  const authorizedDigest = digest(mandate);
  const issue = sharedMainRecoveryIssue(ledger, authorizedDigest);
  ledger.set('main-recovery-result', { digest: authorizedDigest, issue, healthy: false });
  try {
    verifyFrozenRuntime(mandate);
  } catch (error) {
    requireRecoveryReauthorization(ledger, issue, 'frozen-runtime-changed');
    throw error;
  }
  await execution.beforeSpawn?.({ command: process.execPath, cwd: mandate.runtimeRoot });
  const metadataExecution: ExecutionControl = {
    processGroup: 'shared',
    terminateGraceMs: 0,
    ...(execution.signal === undefined ? {} : { signal: execution.signal }),
    ...(execution.deadlineEpochMs === undefined
      ? {}
      : { deadlineEpochMs: execution.deadlineEpochMs }),
  };
  try {
    await (host.verifyPolicy ?? verifyMcpConfiguration)(mandate, metadataExecution);
  } catch (error) {
    if (error instanceof DeliveryError && error.code === 'managed-tool-configuration-changed') {
      requireRecoveryReauthorization(ledger, issue, error.code);
    }
    throw error;
  }
  const transport = createGhTransport({
    cwd: mandate.sourceRoot,
    timeoutMs: Math.min(mandate.profile.bounds.commandTimeoutMs, 10_000),
    beforeRequest: () => {
      sharedMainRecoveryIssue(ledger, authorizedDigest);
    },
    readBackoffUntil: () => ledger.get<number>('github-backoff-until'),
    writeBackoffUntil: (retryAtMs) => {
      ledger.set('github-backoff-until', retryAtMs);
    },
  });
  const github = host.github ?? new DeliveryGitHub({ repository: mandate.repository, transport });
  const actor =
    host.actor ??
    (async () => {
      const value = await transport.request({ method: 'GET', path: 'user' });
      return typeof value === 'object' &&
        value !== null &&
        'login' in value &&
        typeof value.login === 'string'
        ? value.login
        : '';
    });
  const prerequisites = await github.inspectPrerequisites(
    mandate.requiredChecks,
    mandate.workflowTreeSha,
  );
  if (!prerequisites.allowed) {
    requireRecoveryReauthorization(ledger, issue, 'github-prerequisites-changed');
    return;
  }
  if ((await actor()) !== mandate.actor) {
    requireRecoveryReauthorization(ledger, issue, 'github-actor-changed');
    return;
  }
  const current = await github.getMain();
  const blocker = ledger.get<{ reason: string }>('shared-blocker');
  const requiredRevision =
    blocker?.reason === 'integrated-main-check-failed' ? ledger.issue(issue)?.mergedSha : current;
  if (
    requiredRevision === undefined ||
    assessRequiredChecks(
      requiredRevision,
      prerequisites.requiredChecks,
      await github.getChecks(requiredRevision),
    ).length > 0
  ) {
    return;
  }
  if (
    current !== requiredRevision &&
    assessRequiredChecks(current, prerequisites.requiredChecks, await github.getChecks(current))
      .length > 0
  ) {
    return;
  }
  sharedMainRecoveryIssue(ledger, authorizedDigest);
  ledger.set('main-recovery-result', {
    digest: authorizedDigest,
    issue,
    healthy: true,
    requiredRevision,
    currentRevision: current,
  });
}

export function restoreSharedMainHealth(ledger: DeliveryLedger, authorizedDigest: string): boolean {
  const issue = sharedMainRecoveryIssue(ledger, authorizedDigest);
  const result = ledger.get<{ digest: string; issue: number; healthy: boolean }>(
    'main-recovery-result',
  );
  if (result?.digest !== authorizedDigest || result.issue !== issue || !result.healthy) {
    return false;
  }
  verifyFrozenRuntime(ledger.mandate());
  ledger.changeMode('active', 'shared-main-checks-recovered');
  ledger.unset('shared-blocker');
  return true;
}
