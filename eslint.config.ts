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
  // Stage boundary: shared layers stay stage-agnostic. Only the
  // composition roots (src/cli/main.ts, src/stages/registry.ts,
  // src/index.ts) may import src/stages/**. main.ts is excluded below;
  // registry.ts and src/index.ts fall outside this block's files entirely.
  {
    files: ['src/runtime/**/*.ts', 'src/providers/**/*.ts', 'src/core/**/*.ts', 'src/cli/**/*.ts'],
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
  prettier,
);
