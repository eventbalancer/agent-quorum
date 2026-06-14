import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/helpers/network-guard.mjs'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/cli/main.ts'],
      // Branch coverage sits lower than lines/functions by design: the
      // remaining branches are defensive jq-`//` fallbacks, Linux/macOS
      // platform forks, and CLI paths exercised through subprocesses that V8
      // coverage cannot observe.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 69,
      },
    },
  },
});
