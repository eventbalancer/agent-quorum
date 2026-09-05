import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('unsupported frozen gate configuration');
  }
  return value as Record<string, unknown>;
}

function rootedPatterns(value: unknown, worktree: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry: unknown) =>
        typeof entry !== 'string' || path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..'),
    )
  ) {
    throw new Error('unsupported frozen gate paths');
  }
  return (value as string[]).map((entry) => path.join(worktree, entry));
}

export interface GateConfigurationPaths {
  readonly types: string;
  readonly build: string;
  readonly eslint: string;
  readonly vitest: string;
}

export function writeGateConfigurations(
  toolchain: string,
  worktree: string,
  directory: string,
): GateConfigurationPaths {
  const base = object(
    JSON.parse(readFileSync(path.join(toolchain, 'tsconfig.json'), 'utf8')) as unknown,
  );
  const build = object(
    JSON.parse(readFileSync(path.join(toolchain, 'tsconfig.build.json'), 'utf8')) as unknown,
  );
  if (
    base.extends !== undefined ||
    build.extends !== './tsconfig.json' ||
    base.references !== undefined ||
    build.references !== undefined
  ) {
    throw new Error('unsupported frozen TypeScript configuration');
  }
  const typesFile = path.join(directory, 'tsconfig.json');
  const buildFile = path.join(directory, 'tsconfig.build.json');
  for (const [file, config, building] of [
    [typesFile, base, false],
    [buildFile, build, true],
  ] as const) {
    const compilerOptions = { ...object(base.compilerOptions), ...object(config.compilerOptions) };
    writeFileSync(
      file,
      JSON.stringify({
        ...base,
        ...config,
        extends: undefined,
        compilerOptions: {
          ...compilerOptions,
          typeRoots: [path.join(toolchain, 'node_modules/@types')],
          ...(building
            ? { rootDir: path.join(worktree, 'src'), outDir: path.join(worktree, 'dist') }
            : {}),
        },
        include: rootedPatterns(config.include ?? base.include, worktree),
        ...(config.exclude === undefined
          ? {}
          : { exclude: rootedPatterns(config.exclude, worktree) }),
      }),
      { flag: 'wx', mode: 0o600 },
    );
  }
  const eslintFile = path.join(directory, 'eslint.config.mjs');
  writeFileSync(
    eslintFile,
    `import config from ${JSON.stringify(pathToFileURL(path.join(toolchain, 'eslint.config.ts')).href)};\nexport default config.map(entry => entry.languageOptions?.parserOptions === undefined ? entry : ({...entry, languageOptions: {...entry.languageOptions, parserOptions: {...entry.languageOptions.parserOptions, projectService: false, project: ${JSON.stringify(typesFile)}, tsconfigRootDir: ${JSON.stringify(worktree)}}}}));\n`,
    { flag: 'wx', mode: 0o600 },
  );
  const vitestFile = path.join(directory, 'vitest.config.mjs');
  writeFileSync(
    vitestFile,
    `import config from ${JSON.stringify(pathToFileURL(path.join(toolchain, 'vitest.config.ts')).href)};\nexport default {...config, root: ${JSON.stringify(worktree)}, cacheDir: ${JSON.stringify(path.join(directory, 'vite'))}, resolve: {...config.resolve, alias: [{find: /^vitest$/, replacement: ${JSON.stringify(path.join(toolchain, 'node_modules/vitest/dist/index.js'))}}, ...(Array.isArray(config.resolve?.alias) ? config.resolve.alias : [])]}, test: {...config.test, setupFiles: [${JSON.stringify(path.join(toolchain, 'tests/helpers/network-guard.mjs'))}]}};\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return { types: typesFile, build: buildFile, eslint: eslintFile, vitest: vitestFile };
}
