import { defineConfig } from 'vitest/config';

import { inlineDeps, maxTestWorkers, rootSerialReporters, unitExecArgv, unitPool, unitTestTimeout } from './vitest.shared.js';

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
    testTimeout: unitTestTimeout,
    // Shared with every package's own config — see `inlineDeps`.
    server: { deps: { inline: inlineDeps } },
    // See `createUnitTestConfig` in vitest.shared.ts for why this is set —
    // vitest 4's `restoreAllMocks` no longer clears `vi.fn()` call history.
    clearMocks: true,
    pool: unitPool,
    maxWorkers: maxTestWorkers,
    execArgv: unitExecArgv,
    // The per-file duration ratchet, ceilings only: this config runs serially —
    // see `rootSerialReporters` in vitest.shared.ts.
    reporters: rootSerialReporters,
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
        // ⛔ No blanket `**/index.ts`, `**/schemas/**` or `packages/cli/src/commands/**`
        // exclusion. Each was carried under a reason that had stopped being true:
        // `packages/resources/src/index.ts` is a 1,091-line definition site, not a
        // re-export; 11 of 37 schema files export functions or carry refine/transform
        // logic; and 79 unit files under packages/cli/test import from src/commands/,
        // reaching 73 of its 111 modules — the code was unit-tested and simply not
        // counted. Together they hid 35 % of src (72k of 205k lines) from the number.
        'packages/utils/src/fs.ts', // Re-export barrel (no logic)
        'packages/utils/src/process.ts', // Re-export barrel (no logic)
        '**/types.ts', // Type definitions
        'packages/dev-tools/**', // Exclude dev-tools (infrastructure)
        'packages/cli/src/bin.ts', // CLI entry point (integration test only)
        'packages/cli/src/bin/**', // CLI entry points (integration test only)
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
      // ⛔ A RATCHET: these only go up. They are the measured values of one
      // serial `vitest run --coverage` over the whole unit tier, rounded DOWN
      // to the integer, taken the day the three stale exclusions above were
      // deleted. The previous 70 % was computed over 65 % of src — with
      // `commands/**` (18 % of src, well unit-tested) simply not counted — so
      // the number went UP, not down, when the metric became honest.
      //
      // `autoUpdate` rewrites these four numbers in THIS file whenever a run
      // measures higher, so the ratchet raises itself; commit the rewrite. The
      // ratchet moves in WHOLE points: a bare `true` writes the exact measured
      // `pct` (e.g. 82.17), and the first such rewrite leaves zero headroom —
      // deleting one covered line reds `coverage.yml` with no legal move left.
      // Never lower one by hand: a drop is a coverage regression to fix, or an
      // exclusion to justify file by file above.
      thresholds: {
        statements: 82,
        branches: 77,
        functions: 86,
        lines: 82,
        autoUpdate: (measured: number) => Math.floor(measured),
      },
    },
  },
});
