import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateDelivery,
  frozenRuntimeEntries,
  planningProbeProfiles,
  prepareDelivery,
  readMcpConfiguration,
  verifyFrozenRuntime,
} from '../../src/delivery/activation.js';
import { digest } from '../../src/delivery/contract.js';
import type { GitHubTransport } from '../../src/delivery/github.js';
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
function fixture() {
  const result = deliveryFixture();
  cleanups.push(() => {
    result.ledger.close();
    rmSync(result.root, { recursive: true, force: true });
  });
  const mandate = {
    ...result.ledger.mandate(),
    controllerDigest: digest(frozenRuntimeEntries(result.root)),
    workflowTreeSha: 'workflow-tree',
    profileDigest: digest(result.ledger.mandate().profile),
  };
  result.ledger.changeMode('prepared', 'fixture');
  result.ledger.prepare(mandate);
  return { ...result, mandate: result.ledger.mandate() };
}

function transport(strict = true): GitHubTransport {
  return {
    request: ({ path: requestPath }) =>
      Promise.resolve().then(() => {
        if (requestPath === 'user') {
          return { login: 'fixture-operator' };
        }
        if (requestPath.endsWith('/git/ref/heads/main')) {
          return { object: { sha: 'base' } };
        }
        if (requestPath.endsWith('/git/trees/base')) {
          return {
            truncated: false,
            tree: [{ path: '.github', type: 'tree', sha: 'workflow-tree' }],
          };
        }
        if (requestPath.endsWith('/git/trees/workflow-tree?recursive=1')) {
          return {
            truncated: false,
            tree: [{ path: 'workflows/check.yml', type: 'blob', sha: 'workflow-blob' }],
          };
        }
        if (requestPath.endsWith('/git/blobs/workflow-blob')) {
          return {
            encoding: 'base64',
            content: Buffer.from(
              'jobs:\n  check:\n    steps:\n      - run: pnpm run check\n',
            ).toString('base64'),
          };
        }
        if (requestPath.endsWith('/rules/branches/main')) {
          return [
            { type: 'pull_request', ruleset_id: 1 },
            {
              type: 'required_status_checks',
              ruleset_id: 1,
              parameters: {
                strict_required_status_checks_policy: strict,
                required_status_checks: [{ context: 'check', integration_id: 1 }],
              },
            },
          ];
        }
        if (requestPath.endsWith('/rulesets/1')) {
          return { enforcement: 'active', current_user_can_bypass: 'never' };
        }
        if (requestPath === 'repos/eventbalancer/agent-quorum') {
          return { permissions: { push: true }, allow_merge_commit: true };
        }
        throw new Error(`Unexpected fixture request ${requestPath}`);
      }),
  };
}

describe('frozen activation evidence', () => {
  it('detects changed runtime content and escaping symbolic links', () => {
    const { root, mandate } = fixture();
    verifyFrozenRuntime(mandate);
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src/policy.ts'), 'changed');
    expect(() => {
      verifyFrozenRuntime(mandate);
    }).toThrow('frozen-runtime-changed');
    symlinkSync(os.tmpdir(), path.join(root, 'src/external'));
    expect(() => frozenRuntimeEntries(root)).toThrow('frozen-runtime-symlink-escapes');
  });

  it('deduplicates identical planning roles and rejects unsupported confinement', () => {
    const role = { runner: 'codex', model: 'm', reasoning: 'high' } as const;
    expect(planningProbeProfiles([role, role, { ...role, reasoning: 'medium' }])).toHaveLength(2);
    expect(() => planningProbeProfiles([{ ...role, runner: 'claude' }])).toThrow(
      'planning-provider-confinement-unsupported',
    );
  });

  it('freezes metadata without retaining credentials and detects unknown MCP shape', async () => {
    const { root } = fixture();
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([
        { name: 'a', enabled: true, transport: { secret: 'private-value' } },
      ]),
      stderr: '',
    });
    const evidence = await readMcpConfiguration(
      root,
      {
        env: {
          HOME: root,
          CODEX_HOME: path.join(root, '.codex'),
          GH_TOKEN: 'private-github-credential',
          AGENT_QUORUM_EXECUTION_CONTROL_FILE: '/private/guardian-control',
          NODE_OPTIONS: '--import=untrusted-code',
        },
      },
      run,
      () => Promise.resolve('fixture-configuration'),
    );
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      execution: {
        env: {
          HOME: root,
          CODEX_HOME: path.join(root, '.codex'),
        },
      },
    });
    expect(JSON.stringify(run.mock.calls[0])).not.toContain('private-github-credential');
    expect(JSON.stringify(run.mock.calls[0])).not.toContain('guardian-control');
    expect(JSON.stringify(run.mock.calls[0])).not.toContain('untrusted-code');
    const changed = await readMcpConfiguration(root, {}, run, () =>
      Promise.resolve('changed-configuration'),
    );
    expect(changed.configurationDigest).not.toBe(evidence.configurationDigest);
    expect(evidence.names).toEqual(['a']);
    expect(JSON.stringify(evidence)).not.toContain('private-value');
    run.mockResolvedValue({ exitCode: 0, stdout: '[{"name":"a"}]', stderr: '' });
    await expect(
      readMcpConfiguration(root, {}, run, () => Promise.resolve('fixture-configuration')),
    ).rejects.toThrow('mcp-configuration-unavailable');
  });

  it('leaves dirty-source preparation visibly blocked without provider or GitHub calls', async () => {
    const { root, ledger, mandate } = fixture();
    const profileFile = path.join(root, 'profile.json');
    writeFileSync(profileFile, JSON.stringify(mandate.profile));
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: ' M src/file.ts', stderr: '' });
    const request = vi.fn();
    await expect(
      prepareDelivery(ledger, { root, profileFile }, { run, transport: { request } }),
    ).rejects.toThrow('prepare-requires-clean-committed-source');
    expect(ledger.mode()).toBe('blocked');
    expect(run).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('explicit activation transitions', () => {
  it('does not probe or install with a mismatched mandate digest', async () => {
    const { ledger } = fixture();
    const probe = vi.fn();
    const install = vi.fn();
    await expect(activateDelivery(ledger, 'stale', { probe, install })).rejects.toThrow(
      'activation-digest-or-mode-mismatch',
    );
    expect(probe).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(ledger.mode()).toBe('prepared');
  });

  it('blocks insufficient server protection before bounded paid probes', async () => {
    const { ledger } = fixture();
    const probe = vi.fn();
    await expect(
      activateDelivery(ledger, digest(ledger.mandate()), { transport: transport(false), probe }),
    ).rejects.toThrow('activation-prerequisites-unavailable');
    expect(probe).not.toHaveBeenCalled();
    expect(ledger.mode()).toBe('blocked');
  });

  it('requires positive probe receipt and blocks an installation failure', async () => {
    const { ledger } = fixture();
    const authorized = digest(ledger.mandate());
    const probe = vi.fn(() => {
      ledger.set('activation-probes', { digest: authorized, passed: true });
      return Promise.resolve(0);
    });
    const install = vi.fn(() => Promise.reject(new Error('fixture installation failure')));
    await expect(
      activateDelivery(ledger, authorized, { transport: transport(), probe, install }),
    ).rejects.toThrow('guardian-installation-failed');
    expect(probe).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
    expect(ledger.mode()).toBe('blocked');
  });

  it('preserves revocation received during an authorized capability probe', async () => {
    const { ledger } = fixture();
    const install = vi.fn();
    const probe = () => {
      ledger.changeMode('revoked', 'fixture concurrent revocation');
      return Promise.resolve(1);
    };
    await expect(
      activateDelivery(ledger, digest(ledger.mandate()), {
        transport: transport(),
        probe,
        install,
      }),
    ).rejects.toThrow('activation-probes-failed');
    expect(ledger.mode()).toBe('revoked');
    expect(install).not.toHaveBeenCalled();
  });

  it('makes a failed probe visibly blocked and does not install a guardian', async () => {
    const { ledger } = fixture();
    const install = vi.fn();
    await expect(
      activateDelivery(ledger, digest(ledger.mandate()), {
        transport: transport(),
        probe: () => Promise.resolve(1),
        install,
      }),
    ).rejects.toThrow('activation-probes-failed');
    expect(install).not.toHaveBeenCalled();
    expect(ledger.mode()).toBe('blocked');
  });

  it('keeps activation inactive through service replacement and preserves concurrent revocation', async () => {
    const { ledger } = fixture();
    const authorization = digest(ledger.mandate());
    await expect(
      activateDelivery(ledger, authorization, {
        transport: transport(),
        probe: () => {
          ledger.set('activation-probes', { digest: authorization, passed: true });
          return Promise.resolve(0);
        },
        install: async (_mandate, _directory, beforeBootstrap) => {
          expect(ledger.mode()).toBe('prepared');
          ledger.changeMode('revoked', 'Operator revoked during service replacement');
          await beforeBootstrap();
        },
      }),
    ).rejects.toThrow('guardian-installation-failed');
    expect(ledger.mode()).toBe('revoked');
  });

  it('resumes only after service replacement and rejects revocation before bootstrap', async () => {
    const { ledger } = fixture();
    const authorization = digest(ledger.mandate());
    ledger.set('activation-probes', { digest: authorization, passed: true });
    ledger.changeMode('paused', 'Fixture pause');
    const { runDeliveryCli } = await import('../../src/delivery/main.js');
    await runDeliveryCli(['resume', '--state-dir', ledger.directory], {
      output: () => undefined,
      install: async (_mandate, _directory, beforeBootstrap) => {
        expect(ledger.mode()).toBe('paused');
        await beforeBootstrap();
        expect(ledger.mode()).toBe('active');
      },
    });
    ledger.changeMode('paused', 'Fixture pause');
    await expect(
      runDeliveryCli(['resume', '--state-dir', ledger.directory], {
        install: async (_mandate, _directory, beforeBootstrap) => {
          ledger.changeMode('revoked', 'Operator revoked during service replacement');
          await beforeBootstrap();
        },
      }),
    ).rejects.toThrow('guardian-installation-failed');
    expect(ledger.mode()).toBe('revoked');
  });
});

describe('inactive operator rehearsal', () => {
  it('prepares a frozen snapshot, reports a blocker, requires the digest, and stops after fake probes', async () => {
    const { root, ledger, mandate } = fixture();
    const planningFile = path.join(root, 'planning.json');
    const profileFile = path.join(root, 'delivery-profile.json');
    writeFileSync(planningFile, '{}');
    writeFileSync(
      profileFile,
      JSON.stringify({
        ...mandate.profile,
        planning: { ...mandate.profile.planning, configFile: planningFile },
      }),
    );
    const commands: string[][] = [];
    const run: NonNullable<import('../../src/delivery/activation.js').ActivationHost['run']> = (
      input,
    ) => {
      commands.push([input.command, ...input.args]);
      let stdout = '';
      if (input.command === 'git') {
        if (input.args[0] === 'remote') {
          stdout = 'https://github.com/eventbalancer/agent-quorum.git';
        }
        if (input.args[0] === 'rev-parse') {
          stdout = 'a'.repeat(40);
        }
      } else if (input.command === 'pnpm' && input.args[0] === 'run') {
        mkdirSync(path.join(input.cwd, 'dist/delivery'), { recursive: true });
        writeFileSync(path.join(input.cwd, 'dist/delivery/main.js'), 'export {};');
      } else if (input.command === 'codex') {
        stdout = '[]';
      }
      return Promise.resolve({ exitCode: 0, stdout, stderr: '' });
    };
    const requests: string[] = [];
    const base = transport(false);
    const github: GitHubTransport = {
      request: (request) => {
        requests.push(request.method);
        if (request.path.includes('/check-runs')) {
          return Promise.resolve({ check_runs: [] });
        }
        return base.request(request);
      },
    };
    const output: unknown[] = [];
    const { runDeliveryCli } = await import('../../src/delivery/main.js');
    await runDeliveryCli(
      ['prepare', '--profile', profileFile, '--root', root, '--state-dir', ledger.directory],
      {
        output: (value) => {
          output.push(value);
        },
        prepare: (current, input) =>
          prepareDelivery(current, input, {
            run,
            transport: github,
            runtimeParent: path.join(root, '..', `${path.basename(root)}-runtime`),
            readConfiguration: () => Promise.resolve('fixed-managed-config'),
          }),
      },
    );
    const prepared = ledger.mandate();
    cleanups.push(() => {
      rmSync(path.dirname(prepared.runtimeRoot), { recursive: true, force: true });
    });
    expect(ledger.mode()).toBe('blocked');
    verifyFrozenRuntime(prepared);
    expect(output[0]).toMatchObject({ mode: 'blocked', digest: digest(prepared) });
    let installs = 0;
    const activation = (current: typeof ledger, authorization: string) =>
      activateDelivery(current, authorization, {
        transport: transport(),
        probe: () => {
          current.set('activation-probes', { digest: authorization, passed: true });
          return Promise.resolve(0);
        },
        install: async (_mandate, _directory, beforeBootstrap) => {
          installs += 1;
          await beforeBootstrap();
        },
      });
    await expect(
      runDeliveryCli(['activate', '--digest', 'wrong', '--state-dir', ledger.directory], {
        activate: activation,
      }),
    ).rejects.toThrow('activation-digest-or-mode-mismatch');
    await runDeliveryCli(
      ['activate', '--digest', digest(prepared), '--state-dir', ledger.directory],
      {
        activate: activation,
        output: (value) => {
          output.push(value);
        },
      },
    );
    expect(ledger.mode()).toBe('active');
    expect(installs).toBe(1);
    await runDeliveryCli(['stop', '--state-dir', ledger.directory], {
      output: (value) => {
        output.push(value);
      },
    });
    expect(ledger.mode()).toBe('stopped');
    expect(ledger.issues()).toEqual([]);
    expect(ledger.effects()).toEqual([]);
    expect(requests.every((method) => method === 'GET')).toBe(true);
    expect(commands.some((args) => args.includes('exec') || args.includes('daemon'))).toBe(false);
  });
});
