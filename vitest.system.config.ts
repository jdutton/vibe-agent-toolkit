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
      // Windows: Skip tests that require symlinks (--dev install) or full-project scans (10-20x slower)
      // skills-list-fixture.system.test.ts and skills-validate-fixture.system.test.ts provide Windows coverage
      ...(process.platform === 'win32'
        ? [
            'packages/cli/test/system/skills-install-dev.system.test.ts',
            'packages/cli/test/system/skills-list.system.test.ts',
            'packages/cli/test/system/skills-validate.system.test.ts',
          ]
        : []),
    ],
    testTimeout: 120000, // System tests may take even longer
    pool: 'forks',
    poolOptions: {
      forks: {
        // Windows CI: Use singleFork to eliminate worker communication overhead
        // This prevents "Timeout calling onTaskUpdate" errors on slow Windows VMs
        singleFork: process.platform === 'win32',
        // Parallel execution for 2x speedup (~25s vs ~57s on dev machines)
        // Conservative setting for CI compatibility (especially Windows VMs)
        // Tests are fully isolated - could safely use maxForks: 4+ on fast machines
        maxForks: process.platform === 'win32' ? undefined : 2,
      },
    },
  },
});
