import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { GateConfigurationPaths } from './gate-configurations.js';

export const VERIFICATION_POLICY_FILES = [
  'eslint.config.ts',
  'vitest.config.ts',
  'tsconfig.json',
  'tsconfig.build.json',
  '.prettierrc',
  '.prettierignore',
  '.editorconfig',
  '.npmrc',
  'pnpm-workspace.yaml',
  '.pnpmfile.cjs',
  '.pnpmfile.js',
  'tests/helpers/network-guard.mjs',
] as const;
export const TOOLCHAIN_SNAPSHOT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  ...VERIFICATION_POLICY_FILES,
] as const;
export const TOOL_ENTRYPOINTS = {
  tsc: 'typescript/bin/tsc',
  eslint: 'eslint/bin/eslint.js',
  prettier: 'prettier/bin/prettier.cjs',
  vitest: 'vitest/vitest.mjs',
  tsx: 'tsx/dist/cli.mjs',
} as const;
export type GateTool = keyof typeof TOOL_ENTRYPOINTS;

const SUPPORTED_SCRIPTS: Readonly<Record<string, string>> = {
  check:
    'pnpm run build && pnpm run format:write && pnpm run format:check && pnpm run lint:fix && pnpm run lint:check && pnpm run types:check',
  build: 'pnpm run build:clean && tsc -p tsconfig.build.json',
  'build:clean': 'rm -rf dist',
  'types:check': 'tsc --noEmit',
  'lint:check': 'eslint .',
  'lint:fix': 'eslint . --fix',
  'format:check': 'prettier --check .',
  'format:write': 'prettier --write .',
  test: 'vitest run',
  'test:coverage': 'vitest run --coverage',
};

function fileDigest(file: string): string | null {
  const metadata = lstatSync(file, { throwIfNoEntry: false });
  if (metadata === undefined) {
    return null;
  }
  if (!metadata.isFile()) {
    throw new Error('toolchain snapshot must contain regular files');
  }
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function toolEntrypoint(toolchain: string, tool: GateTool): string {
  const root = realpathSync(toolchain);
  const file = realpathSync(path.join(root, 'node_modules', TOOL_ENTRYPOINTS[tool]));
  if (!file.startsWith(`${root}${path.sep}`) || !lstatSync(file).isFile()) {
    throw new Error('gate tool escapes frozen toolchain');
  }
  return file;
}

export function assertToolchainSnapshot(frozenRoot: string, toolchain: string): void {
  const scripts = object(
    object(JSON.parse(readFileSync(path.join(frozenRoot, 'package.json'), 'utf8')) as unknown)
      .scripts,
  );
  if (Object.entries(SUPPORTED_SCRIPTS).some(([name, command]) => scripts[name] !== command)) {
    throw new Error('unsupported frozen repository gate profile');
  }
  for (const file of TOOLCHAIN_SNAPSHOT_FILES) {
    const expected = fileDigest(path.join(frozenRoot, file));
    if (
      (expected === null && ['package.json', 'pnpm-lock.yaml'].includes(file)) ||
      expected !== fileDigest(path.join(toolchain, file))
    ) {
      throw new Error('gate toolchain snapshot differs from frozen mandate');
    }
  }
  for (const tool of Object.keys(TOOL_ENTRYPOINTS) as GateTool[]) {
    toolEntrypoint(toolchain, tool);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('unsupported frozen gate configuration');
  }
  return value as Record<string, unknown>;
}

export interface GateCommand {
  readonly tool: GateTool;
  readonly args: readonly string[];
  readonly cleanBuild?: boolean;
}
export function gateCommands(
  args: readonly string[],
  toolchain: string,
  configs: GateConfigurationPaths,
  worktree: string,
): readonly GateCommand[] {
  const script = args[1];
  if (
    args[0] !== 'run' ||
    script === undefined ||
    (args.length > 2 && !['test', 'test:coverage'].includes(script)) ||
    args.slice(2).some((entry) => !/^tests\/[a-zA-Z0-9/_.-]+\.test\.[cm]?[jt]s$/.test(entry))
  ) {
    throw new Error('unsupported frozen gate command');
  }
  const build: GateCommand = { tool: 'tsc', args: ['-p', configs.build], cleanBuild: true };
  const types: GateCommand = { tool: 'tsc', args: ['-p', configs.types, '--noEmit'] };
  const prettier = (mode: string): GateCommand => ({
    tool: 'prettier',
    args: [
      mode,
      '--config',
      path.join(toolchain, '.prettierrc'),
      '--ignore-path',
      path.join(toolchain, '.prettierignore'),
      '--no-editorconfig',
      '.',
    ],
  });
  const eslint = (fix: boolean): GateCommand => ({
    tool: 'eslint',
    args: ['--no-config-lookup', '--config', configs.eslint, ...(fix ? ['--fix'] : []), '.'],
  });
  switch (script) {
    case 'check':
      return [build, prettier('--write'), prettier('--check'), eslint(true), eslint(false), types];
    case 'build':
      return [build];
    case 'types:check':
      return [types];
    case 'format:check':
      return [prettier('--check')];
    case 'lint:check':
      return [eslint(false)];
    case 'test':
    case 'test:coverage':
      return [
        {
          tool: 'vitest',
          args: [
            'run',
            '--config',
            configs.vitest,
            '--root',
            worktree,
            ...(script === 'test:coverage' ? ['--coverage'] : []),
            ...args.slice(2),
          ],
        },
      ];
    default:
      throw new Error('unsupported frozen gate command');
  }
}

export function frozenGateArgs(
  frozenRoot: string,
  toolchain: string,
  worktree: string,
  args: readonly string[],
): string[] {
  return [
    'node',
    path.join(frozenRoot, 'dist/delivery/gate-runner.js'),
    toolchain,
    frozenRoot,
    worktree,
    ...args,
  ];
}
