import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runFrozenGate } from '../../src/delivery/gate-runner.js';
import {
  assertToolchainSnapshot,
  frozenGateArgs,
  gateCommands,
  TOOLCHAIN_SNAPSHOT_FILES,
  TOOL_ENTRYPOINTS,
  toolEntrypoint,
} from '../../src/delivery/gate-toolchain.js';
import { writeGateConfigurations } from '../../src/delivery/gate-configurations.js';
import { REPO_ROOT } from '../helpers/harness.js';

const directories: string[] = [];
function temporary(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'delivery-toolchain-'));
  directories.push(root);
  return root;
}
afterEach(() => {
  directories.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});

function snapshot(root: string): void {
  for (const file of TOOLCHAIN_SNAPSHOT_FILES) {
    const source = path.join(REPO_ROOT, file);
    if (existsSync(source)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      copyFileSync(source, path.join(root, file));
    }
  }
  for (const entry of Object.values(TOOL_ENTRYPOINTS)) {
    const file = path.join(root, 'node_modules', entry);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'process.exit(0);');
  }
}

describe('frozen verification toolchain', () => {
  it('attests exact package, lock and configuration provenance and rejects escaping tool links', () => {
    const root = temporary();
    snapshot(root);
    expect(() => {
      assertToolchainSnapshot(REPO_ROOT, root);
    }).not.toThrow();
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'changed lock provenance');
    expect(() => {
      assertToolchainSnapshot(REPO_ROOT, root);
    }).toThrow('differs');
    copyFileSync(path.join(REPO_ROOT, 'pnpm-lock.yaml'), path.join(root, 'pnpm-lock.yaml'));
    const entry = path.join(root, 'node_modules', TOOL_ENTRYPOINTS.vitest);
    rmSync(entry);
    symlinkSync(process.execPath, entry);
    expect(() => toolEntrypoint(root, 'vitest')).toThrow('escapes');
  });

  it('compiles the repository gates using explicit immutable tools and configurations', () => {
    const root = temporary();
    const configs = writeGateConfigurations(REPO_ROOT, '/candidate', root);
    const commands = gateCommands(['run', 'check'], REPO_ROOT, configs, '/candidate');
    expect(commands.map((command) => command.tool)).toEqual([
      'tsc',
      'prettier',
      'prettier',
      'eslint',
      'eslint',
      'tsc',
    ]);
    expect(commands[3]?.args).toContain('--no-config-lookup');
    expect(commands[1]?.args).toContain(path.join(REPO_ROOT, '.prettierrc'));
    expect(
      gateCommands(['run', 'test', 'tests/owned.test.ts'], REPO_ROOT, configs, '/candidate')[0]
        ?.args,
    ).toContain('/candidate');
    expect(readFileSync(configs.eslint, 'utf8')).toContain('projectService: false');
    expect(readFileSync(configs.vitest, 'utf8')).toContain(
      path.join(REPO_ROOT, 'node_modules/vitest/dist/index.js'),
    );
    expect(readFileSync(configs.types, 'utf8')).toContain('/candidate/src');
    expect(frozenGateArgs('/aq-harness', '/aq-toolchain', '/candidate', ['run', 'test'])).toEqual([
      'node',
      '/aq-harness/dist/delivery/gate-runner.js',
      '/aq-toolchain',
      '/aq-harness',
      '/candidate',
      'run',
      'test',
    ]);
    expect(() =>
      gateCommands(['run', 'test', '--passWithNoTests'], REPO_ROOT, configs, '/candidate'),
    ).toThrow('unsupported');
  });

  it('ignores poisoned candidate Vitest and tsx executable paths during actual dispatch', async () => {
    const root = temporary();
    const toolchain = path.join(root, 'toolchain');
    const candidate = path.join(root, 'candidate');
    mkdirSync(toolchain);
    mkdirSync(candidate);
    snapshot(toolchain);
    for (const entry of [
      'node_modules/.bin/vitest',
      'node_modules/.bin/tsx',
      'node_modules/vitest/vitest.mjs',
      'node_modules/tsx/dist/cli.mjs',
    ]) {
      const file = path.join(candidate, entry);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'process.exit(99);', { mode: 0o700 });
    }
    expect(await runFrozenGate(toolchain, REPO_ROOT, candidate, ['run', 'test'])).toBe(0);
    expect(
      await runFrozenGate(toolchain, REPO_ROOT, candidate, [
        'live',
        path.join(candidate, 'fixture.ts'),
      ]),
    ).toBe(0);
  });

  it('runs actual frozen Vitest assertions despite a poisoned candidate vitest package', async () => {
    const candidate = temporary();
    mkdirSync(path.join(candidate, 'tests'));
    mkdirSync(path.join(candidate, 'node_modules/vitest'), { recursive: true });
    writeFileSync(path.join(candidate, 'package.json'), '{"type":"module"}');
    writeFileSync(
      path.join(candidate, 'node_modules/vitest/package.json'),
      '{"name":"vitest","type":"module","exports":"./index.js"}',
    );
    writeFileSync(
      path.join(candidate, 'node_modules/vitest/index.js'),
      'throw new Error("candidate Vitest poisoned")',
    );
    writeFileSync(
      path.join(candidate, 'tests/fixture.test.ts'),
      'import { expect, test } from "vitest"; test("frozen assertions", () => { expect(1).toBe(2); });',
    );
    expect(await runFrozenGate(REPO_ROOT, REPO_ROOT, candidate, ['run', 'test'])).toBe(1);
    writeFileSync(
      path.join(candidate, 'tests/fixture.test.ts'),
      'import { expect, test } from "vitest"; test("frozen assertions", () => { expect(1).toBe(1); });',
    );
    expect(await runFrozenGate(REPO_ROOT, REPO_ROOT, candidate, ['run', 'test'])).toBe(0);
  });
});
