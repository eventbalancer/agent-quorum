import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codexSandboxProbeArgs,
  supervisedCodexPolicy,
} from '../../src/providers/supervised-policy.js';

const directories: string[] = [];
afterEach(() => {
  directories.splice(0).forEach((directory) => {
    rmSync(directory, { recursive: true });
  });
});

describe('supervised Codex policy', () => {
  it('uses the same named filesystem policy for model commands and positive activation probes', () => {
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'policy-test-')));
    directories.push(directory);
    const forbidden = path.join(directory, 'control');
    const policy = supervisedCodexPolicy(directory, [forbidden]);
    expect(policy.isolatedUserConfig).toBe(true);
    expect(policy.codexConfig).toContain('approval_policy="never"');
    expect(policy.codexConfig).toContain('features.apps=false');
    expect(policy.codexConfig).toContain('features.plugins=false');
    expect(policy.codexConfig).toContain('features.browser_use=false');
    expect(policy.codexConfig).toContain('features.hooks=false');
    expect(policy.codexConfig).toContain('allow_login_shell=false');
    const permissions = policy.codexConfig.find((entry) => entry.startsWith('permissions='));
    expect(permissions).toContain(`${JSON.stringify(directory)}="read"`);
    expect(permissions).toContain(`${JSON.stringify(forbidden)}="deny"`);
    expect(permissions).toContain('network={enabled=false}');
    expect(policy.codexConfig.some((entry) => entry.startsWith('sandbox_'))).toBe(false);
    const args = codexSandboxProbeArgs(policy, ['/bin/cat', path.join(directory, 'source')]);
    expect(args).toContain(policy.codexPermissionProfile);
    expect(args).toContain(permissions);
    expect(args.slice(-3)).toEqual(['--', '/bin/cat', path.join(directory, 'source')]);
  });

  it('rejects ambiguous filesystem rules', () => {
    expect(() => supervisedCodexPolicy('.')).toThrow('absolute');
    expect(() => supervisedCodexPolicy(process.cwd(), ['relative'])).toThrow('absolute');
  });
});
