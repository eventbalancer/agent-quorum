import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  brokerEnvironment,
  repositoryEnvironment,
  RepositoryBroker,
} from '../../src/delivery/commands.js';
import * as executionControl from '../../src/runtime/execution-control.js';
import { supervisedCodexEnvironment } from '../../src/providers/supervised-policy.js';
import { deliveryFixture } from '../helpers/delivery.js';
import { withEnvAsync } from '../helpers/harness.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stage-local broker credential', () => {
  it('pins trusted Git subprocesses across ambient account drift without exposing the token in output or state', async () => {
    const fixture = deliveryFixture();
    const originalSpawn = executionControl.spawnControlled;
    const observed: boolean[] = [];
    vi.spyOn(executionControl, 'spawnControlled').mockImplementation(
      (command, args, options, control) => {
        expect(command).toBe('/usr/bin/git');
        observed.push(
          control?.env?.GH_TOKEN === 'fixture-pinned-token' &&
            control.env.GITHUB_TOKEN === undefined,
        );
        const code = args.includes('--get-regexp')
          ? 'process.exit(1)'
          : "process.stdout.write(process.env.GH_TOKEN==='fixture-pinned-token' && process.env.GITHUB_TOKEN===undefined ? 'pinned' : 'wrong')";
        return originalSpawn(process.execPath, ['-e', code], options, control);
      },
    );
    try {
      await withEnvAsync(
        { GH_TOKEN: 'ambient-first', GITHUB_TOKEN: 'ambient-second' },
        async () => {
          const credential = { token: 'fixture-pinned-token' };
          const broker = new RepositoryBroker(
            fixture.ledger,
            fixture.mandate,
            { deadlineEpochMs: Date.now() + 5000 },
            credential,
          );
          credential.token = 'caller-mutated-after-construction';
          expect(await broker.git(fixture.worktree, ['status', '--porcelain'], 1)).toBe('pinned');
          process.env.GH_TOKEN = 'ambient-account-changed';
          process.env.GITHUB_TOKEN = 'another-account';
          expect(await broker.git(fixture.worktree, ['status', '--porcelain'], 1)).toBe('pinned');
          expect(JSON.stringify(broker)).not.toContain('fixture-pinned-token');
        },
      );
      expect(observed).toEqual([true, true, true, true]);
    } finally {
      fixture.ledger.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('keeps explicit credentials out of candidate and provider environments', () => {
    const trusted = brokerEnvironment({ token: 'fixture-pinned-token' });
    expect(trusted.GH_TOKEN).toBe('fixture-pinned-token');
    expect(trusted.GITHUB_TOKEN).toBeUndefined();
    expect(repositoryEnvironment('/fixture').GH_TOKEN).toBeUndefined();
    expect(supervisedCodexEnvironment(trusted).GH_TOKEN).toBeUndefined();
    expect(supervisedCodexEnvironment(trusted).GITHUB_TOKEN).toBeUndefined();
  });
});
