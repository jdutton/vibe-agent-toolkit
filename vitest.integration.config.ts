import { defineConfig } from 'vitest/config';

import { integrationPool, integrationPoolOptions, platformTestTimeout } from './vitest.shared.js';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.js'],
    include: [
      'packages/*/test/**/*.integration.test.ts',
      'packages/*/src/**/*.integration.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    testTimeout: platformTestTimeout,
    passWithNoTests: true, // Allow passing when no integration tests exist yet
    pool: integrationPool,
    poolOptions: integrationPoolOptions,
  },
});
