import { defineConfig } from 'vitest/config';

import { platformTestTimeout, unitPool, unitPoolOptions } from './vitest.shared.js';

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
    testTimeout: platformTestTimeout,
    pool: unitPool,
    poolOptions: unitPoolOptions,
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
        'packages/utils/src/fs.ts', // Re-export barrel (no logic)
        'packages/utils/src/process.ts', // Re-export barrel (no logic)
        '**/types.ts', // Type definitions
        '**/schemas/**', // Zod schema definitions (type definitions, not logic)
        'packages/dev-tools/**', // Exclude dev-tools (infrastructure)
        'packages/cli/src/bin.ts', // CLI entry point (integration test only)
        'packages/cli/src/bin/**', // CLI entry points (integration test only)
        'packages/cli/src/commands/**', // CLI commands (integration test only)
        // Test infrastructure that lives in `src/` because integration tests import it.
        // `pipeline-oracles` was explicitly designated test infrastructure when the public
        // `vat pipeline` verb was deleted (119f4d5b) — it has no production callers; `qa-snapshot`
        // is the capture/diff instrument those oracles drive. Same rationale as
        // `packages/dev-tools/**` above.
        //
        // ⚠️ Listed FILE BY FILE, deliberately, and not as `pipeline-oracles/**`. Only the modules
        // that walk a real filesystem are integration-shaped; their pure siblings are unit-tested
        // and well covered (`serialize.ts` 86.6%, `qa-snapshot/diff.ts` 87.9%, plus `normalize.ts`
        // and `store.ts`, 83 unit tests between them). A directory-wide exclusion would delete that
        // real signal and inflate the metric — which is the failure this list exists to avoid, not
        // to commit.
        'packages/cli/src/pipeline-oracles/trap-corpus.ts', // Builds a corpus on disk
        'packages/cli/src/pipeline-oracles/parse-fact-snapshot.ts', // Crawls and parses a tree
        'packages/cli/src/pipeline-oracles/symlink-divergence.ts', // Needs real symlinks
        'packages/cli/src/pipeline-oracles/enumeration-snapshot.ts', // Crawls a tree
        'packages/cli/src/pipeline-oracles/lanes.ts', // Spawns the CLI per lane
        'packages/cli/src/pipeline-oracles/path-facts.ts', // stat/realpath over a real tree
        'packages/cli/src/qa-snapshot/capture.ts', // Spawns commands, writes artifacts
        'packages/lab/src/bin/**', // CLI entry point — same category as packages/cli/src/bin/**
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
