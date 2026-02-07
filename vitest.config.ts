import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      // Integration tests run separately via vitest.integration.config.ts
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.integration.test.ts', // Integration tests run separately
      '**/*.system.test.ts', // System tests run separately (e2e, longer running)
    ],
    // Enable parallelization for fast unit test execution
    testTimeout: 60000, // Increased for Windows CI (fork pool is 3x slower on Windows)
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
        // Limit to 1 worker on Windows (fork is expensive), unlimited on Unix
        maxForks: process.platform === 'win32' ? 1 : undefined,
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
        'packages/cli/src/bin.ts', // CLI entry point (integration test only)
        'packages/cli/src/bin/**', // CLI entry points (integration test only)
        'packages/cli/src/commands/**', // CLI commands (integration test only)
        'packages/resource-compiler/src/cli/**', // CLI commands (integration test only)
        'packages/resource-compiler/src/language-service/**', // VSCode integration (not unit testable)
        'packages/vat-development-agents/src/**', // Agent packages (integration test only)
        'packages/vat-example-cat-agents/src/**', // Agent packages (integration test only)
      ],
      thresholds: {
        statements: 79,
        branches: 79,
        functions: 79,
        lines: 79,
      },
    },
  },
});
