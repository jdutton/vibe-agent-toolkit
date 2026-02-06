import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/*/test/**/*.system.test.ts',
      'packages/*/src/**/*.system.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    testTimeout: 120000, // System tests may take even longer
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
        // CI: Serial execution for reliability (system tests spawn processes)
        // Local: Adaptive parallelism for speed (up to 4 cores)
        maxForks: process.env['CI'] ? 1 : Math.min(availableParallelism(), 4),
      },
    },
  },
});
