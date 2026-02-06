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
        // Parallel execution for 2x speedup (~25s vs ~57s on dev machines)
        // Conservative setting for CI compatibility (especially Windows VMs)
        // Tests are fully isolated - could safely use maxForks: 4+ on fast machines
        maxForks: 2,
      },
    },
  },
});
