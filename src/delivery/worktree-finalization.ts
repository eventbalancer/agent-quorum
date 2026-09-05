import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionControl } from '../runtime/execution-control.js';
import { DeliveryError, type Mandate } from './contract.js';
import { runDeliveryCommand } from './commands.js';
import type { DeliveryLedger } from './ledger.js';

export async function completeDeliveryWorktree(
  ledger: DeliveryLedger,
  mandate: Mandate,
  execution: ExecutionControl,
  worktree: string,
  issueNumber: number,
  run = runDeliveryCommand,
): Promise<void> {
  ledger.assertAuthorized('branch', issueNumber);
  const issue = ledger.issue(issueNumber);
  if (
    issue?.worktree === undefined ||
    issue.branch === undefined ||
    issue.mergedSha === undefined ||
    !['reconcile', 'done'].includes(issue.stage) ||
    realpathSync(issue.worktree) !== realpathSync(worktree)
  ) {
    throw new DeliveryError('worktree-finalization-requires-verified-integration');
  }
  const env = {
    PATH: [
      path.dirname(process.execPath),
      '/usr/bin',
      '/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ].join(path.delimiter),
    HOME: os.homedir(),
    GH_TOKEN: execution.env?.GH_TOKEN ?? execution.env?.GITHUB_TOKEN,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
    AGENT_QUORUM_WORKTREE_REPOSITORY_ROOT: mandate.sourceRoot,
  };
  const branch = await run({
    command: '/usr/bin/git',
    args: ['branch', '--show-current'],
    cwd: worktree,
    env,
    execution: { ...execution, env },
  });
  if (branch.exitCode !== 0 || branch.stdout.trim() !== issue.branch) {
    throw new DeliveryError('worktree-finalization-branch-mismatch');
  }
  ledger.assertAuthorized('branch', issueNumber);
  ledger.event('worktree-finalization-intended', {
    issue: issueNumber,
    worktree,
    branch: issue.branch,
    mergedSha: issue.mergedSha,
  });
  const result = await run({
    command: 'pnpm',
    args: ['run', 'worktree:done', worktree],
    cwd: mandate.runtimeRoot,
    env,
    execution: { ...execution, env },
  });
  if (result.exitCode !== 0) {
    throw new DeliveryError('worktree-finalization-failed');
  }
  ledger.event('worktree-finalized', {
    issue: issueNumber,
    worktree,
    branch: issue.branch,
    mergedSha: issue.mergedSha,
  });
}
