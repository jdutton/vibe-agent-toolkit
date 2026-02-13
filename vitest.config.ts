import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.js'],
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
    testTimeout: process.platform === 'win32' ? 900000 : 60000, // 15min Windows, 1min Unix
    // Threads on Mac/Unix: shared module cache = ~20% faster collect phase
    // Forks on Windows: required for process.chdir() compatibility and native module isolation
    pool: process.platform === 'win32' ? 'forks' : 'threads',
    poolOptions: {
      forks: {
        singleFork: false,
        // Limit to 2 workers on Windows (sweet spot per arch analysis)
        maxForks: 2,
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
        'packages/resource-compiler/src/compiler/markdown-compiler.ts', // Orchestrator with comprehensive integration tests
        'packages/vat-development-agents/src/**', // Agent packages (integration test only)
        'packages/vat-example-cat-agents/src/**', // Agent packages (integration test only)
      ],
      thresholds: {
        // Adjusted after moving integration tests to separate test phase
        // Unit tests focus on pure logic; integration tests verify I/O operations
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 70,
      },
    },
  },
});
