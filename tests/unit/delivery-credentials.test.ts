import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { productionDeliveryServices, runDeliveryStep } from '../../src/delivery/controller.js';
import { deliveryFixture } from '../helpers/delivery.js';

const execute = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: execute,
}));
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => {
      cleanup();
    });
});

function fixture(actor = 'fixture-operator') {
  const result = deliveryFixture();
  cleanups.push(() => {
    result.ledger.close();
    rmSync(result.root, { recursive: true, force: true });
  });
  execute.mockImplementation(
    (
      _file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      if (args[0] === 'auth') {
        callback(null, 'fixture-private-stage-token\n');
      } else {
        const value =
          args[4] === 'user'
            ? { login: actor }
            : {
                number: 1,
                node_id: 'I_1',
                title: 'Fixture',
                body: '',
                state: 'open',
                updated_at: '',
                html_url: 'https://example.test/1',
                labels: [],
                assignees: [],
              };
        callback(null, `HTTP/2.0 200 OK\n\n${JSON.stringify(value)}`);
      }
      return { stdin: { on: vi.fn(), end: vi.fn() } };
    },
  );
  return result;
}

describe('stage-local existing GitHub credential', () => {
  it('uses one privately selected credential even when ambient authentication changes between reads and writes', async () => {
    const { ledger } = fixture();
    const services = await productionDeliveryServices(ledger, {});
    vi.stubEnv('GH_TOKEN', 'changed-ambient-token');
    vi.stubEnv('GITHUB_TOKEN', 'other-ambient-token');
    await services.github.updateIssue(1, { body: 'Updated' });
    const calls = execute.mock.calls;
    expect(calls.filter((call) => (call[1] as string[])[0] === 'auth')).toHaveLength(1);
    for (const call of calls.filter((entry) => (entry[1] as string[])[0] === 'api')) {
      expect(call[2]).toMatchObject({
        env: { GH_TOKEN: 'fixture-private-stage-token', GH_HOST: 'github.com' },
      });
      expect(JSON.stringify(call[2])).not.toContain('changed-ambient-token');
      expect(JSON.stringify(call[2])).not.toContain('other-ambient-token');
    }
    expect(JSON.stringify(ledger.events())).not.toContain('fixture-private-stage-token');
    expect(JSON.stringify(ledger.effects())).not.toContain('fixture-private-stage-token');
  });

  it('blocks actor drift before issuing a delivery operation', async () => {
    const { ledger } = fixture('different-actor');
    await runDeliveryStep(ledger, {});
    expect(ledger.mode()).toBe('blocked');
    expect(ledger.get('shared-blocker')).toMatchObject({ reason: 'github-actor-changed' });
    expect(execute.mock.calls).toHaveLength(2);
    expect(ledger.effects()).toEqual([]);
  });

  it('reports unavailable existing credentials without exposing the credential lookup output', async () => {
    const { ledger } = fixture();
    execute.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        callback(new Error('private account diagnostics'), 'private-invalid-token');
        return { stdin: { on: vi.fn(), end: vi.fn() } };
      },
    );
    await runDeliveryStep(ledger, {});
    expect(ledger.get('shared-blocker')).toMatchObject({
      reason: 'github-existing-credential-unavailable',
    });
    expect(JSON.stringify(ledger.events())).not.toContain('private account');
    expect(JSON.stringify(ledger.events())).not.toContain('private-invalid-token');
    expect(execute.mock.calls).toHaveLength(1);
  });
});
