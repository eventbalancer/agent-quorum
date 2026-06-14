import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  // Inward-only layer boundary (cli -> core -> {providers, channels} -> runtime).
  // Each per-layer block forbids importing outward layers; runtime, the innermost
  // layer, forbids every other layer. providers/channels may reach core only
  // through core/json (any import) and core/config (type-only, for the RoleMatrix
  // type). The stages boundary holds for every layer: only the composition roots
  // (src/cli/main.ts, src/stages/registry.ts, src/index.ts) may import
  // src/stages/**, and they fall outside these globs (main.ts is ignored below).
  {
    files: ['src/runtime/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/core/**', '**/core'],
              message: 'Inward-only: runtime is the innermost layer and must not import core.',
            },
            {
              group: ['**/providers/**', '**/providers'],
              message: 'Inward-only: runtime is the innermost layer and must not import providers.',
            },
            {
              group: ['**/channels/**', '**/channels'],
              message: 'Inward-only: runtime is the innermost layer and must not import channels.',
            },
            {
              group: ['**/cli/**', '**/cli'],
              message: 'Inward-only: runtime is the innermost layer and must not import cli.',
            },
            {
              group: ['**/stages/**', '**/stages'],
              message:
                'Shared layers must not import src/stages/**; wire stages through main.ts, registry.ts, or index.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/providers/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/cli/**', '**/cli'],
              message: 'Inward-only: providers must not import cli.',
            },
            {
              group: ['**/stages/**', '**/stages'],
              message:
                'Shared layers must not import src/stages/**; wire stages through main.ts, registry.ts, or index.ts.',
            },
            {
              group: ['**/core/**', '!**/core/json.js', '!**/core/config.js'],
              message:
                'Inward-only: providers may import core only via core/json (any) or core/config (type-only).',
            },
            {
              group: ['**/core/config.js'],
              allowTypeImports: true,
              message:
                'Inward-only: providers may import only the type from core/config (import type), not its values.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/channels/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/cli/**', '**/cli'],
              message: 'Inward-only: channels must not import cli.',
            },
            {
              group: ['**/stages/**', '**/stages'],
              message:
                'Shared layers must not import src/stages/**; wire stages through main.ts, registry.ts, or index.ts.',
            },
            {
              group: ['**/core/**', '!**/core/json.js', '!**/core/config.js'],
              message:
                'Inward-only: channels may import core only via core/json (any) or core/config (type-only).',
            },
            {
              group: ['**/core/config.js'],
              allowTypeImports: true,
              message:
                'Inward-only: channels may import only the type from core/config (import type), not its values.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/cli/**', '**/cli'],
              message: 'Inward-only: core must not import cli.',
            },
            {
              group: ['**/stages/**', '**/stages'],
              message:
                'Shared layers must not import src/stages/**; wire stages through main.ts, registry.ts, or index.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/cli/**/*.ts'],
    ignores: ['src/cli/main.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/stages/**', '**/stages'],
              message:
                'Shared layers must not import src/stages/**; wire stages through main.ts, registry.ts, or index.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.ts', 'src/providers/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: [
      'src/**/{helpers,common,misc,utils}.ts',
      'src/{helpers,common,misc,utils}.ts',
      'src/**/{helpers,common,misc,utils}/**/*.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Program',
          message:
            'Generic catch-all module names (helpers/common/misc/utils) are banned under src/; use a precise domain name. See docs/development/conventions.md.',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  prettier,
  // Re-enable curly after prettier: eslint-config-prettier sets curly: 0, but
  // brace presence is a structural rule the linter owns, not formatting.
  {
    files: ['src/**/*.ts'],
    rules: {
      curly: ['error', 'all'],
    },
  },
);
