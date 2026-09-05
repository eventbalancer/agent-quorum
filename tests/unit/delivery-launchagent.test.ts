import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installDeliveryLaunchAgent } from '../../src/delivery/activation.js';
import type { CommandInput } from '../../src/delivery/commands.js';
import { deliveryLaunchArguments, launchAgentDocument } from '../../src/delivery/guardian.js';
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

function fixture(loaded: boolean, failure?: string) {
  const result = deliveryFixture();
  cleanups.push(() => {
    result.ledger.close();
    rmSync(result.root, { recursive: true, force: true });
  });
  const mandate = {
    ...result.ledger.mandate(),
    runtimeRoot: path.join(result.root, 'new-runtime'),
  };
  const directory = path.join(result.root, 'LaunchAgents');
  mkdirSync(directory);
  const file = path.join(directory, 'com.agent-quorum.delivery.plist');
  writeFileSync(
    file,
    launchAgentDocument({ ...mandate, runtimeRoot: '/old-runtime' }, result.ledger.directory),
  );
  let registration: { args: string[]; directory: string } | undefined = loaded
    ? { args: ['old-node', '/old-runtime/main.js'], directory: '/old-runtime' }
    : undefined;
  const calls: CommandInput[] = [];
  const run = (input: CommandInput) =>
    Promise.resolve().then(() => {
      calls.push(input);
      const command = input.args[0];
      if (command === failure) {
        return { exitCode: 1, stdout: '', stderr: 'Fixture launchctl failure' };
      }
      if (command === 'print') {
        return registration === undefined
          ? { exitCode: 113, stdout: '', stderr: 'Service not found' }
          : {
              exitCode: 0,
              stdout: `service = {\n\targuments = {\n${registration.args.map((arg) => `\t\t${arg}`).join('\n')}\n\t}\n\tworking directory = ${registration.directory}\n}\n`,
              stderr: '',
            };
      }
      if (command === 'bootout') {
        registration = undefined;
      } else if (command === 'bootstrap') {
        expect(registration).toBeUndefined();
        expect(readFileSync(file, 'utf8')).toBe(
          launchAgentDocument(mandate, result.ledger.directory),
        );
        registration = {
          args:
            failure === 'stale-registration'
              ? ['old-node']
              : deliveryLaunchArguments(mandate, result.ledger.directory),
          directory: mandate.runtimeRoot,
        };
      } else {
        throw new Error(`Unexpected launchctl command ${command}`);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
  let authorized = false;
  const install = () =>
    installDeliveryLaunchAgent(
      mandate,
      result.ledger.directory,
      () => {
        expect(registration).toBeUndefined();
        authorized = true;
      },
      { run, directory, platform: 'darwin', uid: 501 },
    );
  return {
    ...result,
    calls,
    file,
    install,
    wasAuthorized: () => authorized,
    registration: () => registration,
    mandate,
  };
}

describe('LaunchAgent runtime registration', () => {
  it.each([true, false])(
    'loads the exact runtime after safely removing loaded=$0 registration',
    async (loaded) => {
      const result = fixture(loaded);
      await result.install();
      expect(result.calls.map((call) => call.args[0])).toEqual(
        loaded ? ['print', 'bootout', 'bootstrap', 'print'] : ['print', 'bootstrap', 'print'],
      );
      expect(result.wasAuthorized()).toBe(true);
      expect(result.registration()?.args).toEqual(
        deliveryLaunchArguments(result.mandate, result.ledger.directory),
      );
      expect(new Set(result.calls.map((call) => call.execution.deadlineEpochMs)).size).toBe(1);
    },
  );

  it.each(['bootout', 'bootstrap'])(
    'rejects a failed %s instead of continuing with stale service state',
    async (failure) => {
      const result = fixture(true, failure);
      await expect(result.install()).rejects.toThrow('activation-command-failed');
      expect(result.calls.at(-1)?.args[0]).toBe(failure);
      expect(result.wasAuthorized()).toBe(failure === 'bootstrap');
    },
  );

  it('rejects an effective registration that differs from the requested runtime', async () => {
    const result = fixture(true, 'stale-registration');
    await expect(result.install()).rejects.toThrow('launchagent-registration-mismatch');
  });

  it('does not replace a plist owned by another state directory', async () => {
    const result = fixture(true);
    const previous = launchAgentDocument(result.mandate, '/another-state-directory');
    writeFileSync(result.file, previous);
    await expect(result.install()).rejects.toThrow('existing-launchagent-target-mismatch');
    expect(result.calls).toEqual([]);
    expect(result.wasAuthorized()).toBe(false);
    expect(existsSync(result.file)).toBe(true);
    expect(readFileSync(result.file, 'utf8')).toBe(previous);
  });
});
