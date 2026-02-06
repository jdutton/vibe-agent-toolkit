import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/*/test/**/*.integration.test.ts',
      'packages/*/src/**/*.integration.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    testTimeout: 60000, // Integration tests may take longer
    passWithNoTests: true, // Allow passing when no integration tests exist yet
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
        // Enable parallelization for integration tests (use half of available cores)
      },
    },
  },
});
