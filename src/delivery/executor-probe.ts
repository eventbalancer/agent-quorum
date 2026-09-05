import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionControl } from '../runtime/execution-control.js';
import { repositoryEnvironment, runDeliveryCommand } from './commands.js';
import { dockerExecutorArgs, LOCAL_DOCKER_ARGS } from './confined-executor.js';
import type { Mandate } from './contract.js';
import { dockerProbeProgram } from './executor-probe-program.js';

export async function probeDockerExecutor(
  mandate: Mandate,
  execution: ExecutionControl,
  run = runDeliveryCommand,
): Promise<boolean> {
  const executor = mandate.profile.executor;
  if (executor === undefined) {
    return false;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), 'aq-executor-probe-'));
  const worktree = path.join(root, 'candidate');
  mkdirSync(worktree);
  const forbidden = path.join(root, 'credential-canary');
  writeFileSync(forbidden, 'private host credential canary', { mode: 0o600 });
  const env = repositoryEnvironment(root);
  mkdirSync(env.HOME ?? path.join(root, 'home'), { mode: 0o700 });
  const bounded: ExecutionControl = {
    ...execution,
    env,
    attemptTimeoutMs: mandate.profile.bounds.commandTimeoutMs,
    deadlineEpochMs: Math.min(
      execution.deadlineEpochMs ?? Infinity,
      Date.now() + mandate.profile.bounds.commandTimeoutMs,
    ),
  };
  const observations = { hostReached: false };
  const server = createServer((socket) => {
    observations.hostReached = true;
    socket.destroy();
  });
  try {
    for (const file of ['package.json', 'pnpm-lock.yaml', '.npmrc', 'pnpm-workspace.yaml']) {
      const source = path.join(mandate.runtimeRoot, file);
      const metadata = lstatSync(source, { throwIfNoEntry: false });
      if (metadata === undefined && file !== 'package.json' && file !== 'pnpm-lock.yaml') {
        continue;
      }
      if (metadata?.isFile() !== true) {
        return false;
      }
      copyFileSync(source, path.join(worktree, file));
    }
    const packageValue: unknown = JSON.parse(
      readFileSync(path.join(worktree, 'package.json'), 'utf8'),
    );
    if (
      typeof packageValue !== 'object' ||
      packageValue === null ||
      !('packageManager' in packageValue) ||
      typeof packageValue.packageManager !== 'string' ||
      !/^pnpm@\d+\.\d+\.\d+$/.test(packageValue.packageManager)
    ) {
      return false;
    }
    const expectedPnpm = packageValue.packageManager.slice('pnpm@'.length);
    const inspected = await run({
      command: 'docker',
      args: [
        ...LOCAL_DOCKER_ARGS,
        'image',
        'inspect',
        '--format',
        '{{json .RepoDigests}}',
        executor.image,
      ],
      cwd: root,
      execution: bounded,
      env,
    });
    const digests: unknown = JSON.parse(inspected.stdout);
    if (inspected.exitCode !== 0 || !Array.isArray(digests) || !digests.includes(executor.image)) {
      return false;
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      return false;
    }
    const probeInput = {
      hostPort: address.port,
      commandTimeoutMs: mandate.profile.bounds.commandTimeoutMs,
      expectedPnpm,
      forbiddenFile: forbidden,
      sourceRoot: mandate.sourceRoot,
    };
    const script = dockerProbeProgram(probeInput);
    const result = await run({
      command: 'docker',
      args: dockerExecutorArgs(
        { image: executor.image, worktree, runtimeRoot: mandate.runtimeRoot },
        ['node', '-e', script],
      ),
      cwd: root,
      execution: bounded,
      env,
      keepAlive: true,
    });
    const output: unknown = JSON.parse(result.stdout);
    return (
      result.exitCode === 0 &&
      !observations.hostReached &&
      typeof output === 'object' &&
      output !== null &&
      'passed' in output &&
      output.passed === true
    );
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    rmSync(root, { recursive: true, force: true });
  }
}
