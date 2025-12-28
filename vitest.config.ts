import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'packages/*/test/**/*.integration.test.ts', // Include integration tests for coverage
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.system.test.ts', // System tests run separately (e2e, longer running)
    ],
    // Prevent worker timeouts by limiting concurrency
    maxConcurrency: 1,
    fileParallelism: false,
    testTimeout: 30000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
        maxForks: 1,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        '**/dist/**',
        '**/node_modules/**',
        '**/test/**',
        '**/tests/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/index.ts', // Re-exports
        '**/types.ts', // Type definitions
        '**/schemas/**', // Zod schema definitions (type definitions, not logic)
        'packages/dev-tools/**', // Exclude dev-tools (infrastructure)
        'packages/cli/src/bin/**', // CLI entry points (integration test only)
        'packages/cli/src/commands/**', // CLI commands (integration test only)
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
