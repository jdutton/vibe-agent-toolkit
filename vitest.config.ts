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
    // One file at a time, by construction: this config is the per-file duration
    // ratchet's judge, and a duration is only a measurement when nothing else is
    // running — see `rootSerialReporters` in vitest.shared.ts.
    fileParallelism: false,
    reporters: rootSerialReporters(['default']),
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
        // The real-filesystem test infrastructure under `utils/src/testing`: it ships in `src/`
        // because every package's integration tests import it, and it can only be exercised
        // against a real tree. FILE BY FILE, as above: `temp-dir.ts`, `executables.ts`,
        // `platform-gates.ts` and `fault-spec.ts` (the harness's vocabulary and its `VAT_FAULT_FS`
        // spec parser, unit-tested) beside them stay measured.
        'packages/utils/src/testing/fault-fs.ts', // The half that patches node:fs; it holds no parser and is exercised only by the integration tier's reach tests
        'packages/utils/src/testing/tree-snapshot.ts', // Walks and hashes a real tree
        'packages/utils/src/testing/hostile-tree.ts', // Builds FIFOs, sockets and links on disk
        // The tree-change primitive's syscall modules: every function in them is a filesystem
        // call path, and their tests are the fault matrix and the `tree-change-*` files of the
        // uninstrumented integration tier. FILE BY FILE: the primitive's decisions stay measured
        // and unit-tested — `plan.ts`, `staging-names.ts` (the names), `identity-compare.ts`
        // (sameness, containment and the once-per-entry memo over identities already read),
        // `rollback-error.ts`, and the two modules that hold what the excluded ones decide:
        // `apply-decisions.ts` (whose fault a failed fill is, whether a destination changed since
        // the plan, thrown-versus-warning at finalize, the made-parents bound, the rename retry
        // policy, the temp-directory guard) and `copy-decisions.ts` (fresh / merge, the two-names
        // refusal). A decision added to an excluded file belongs in one of those two instead.
        'packages/utils/src/tree-change/apply.ts', // stage / park / swap / rollback: mkdir, rename, rm — its decisions are apply-decisions.ts's
        'packages/utils/src/tree-change/files.ts', // rename with retry, removal, whole-file replace, temp-dir disposal — its decisions are apply-decisions.ts's
        'packages/utils/src/tree-change/identity.ts', // lstat / stat / realpath of an entry; what it decides from them is in identity-compare.ts
        'packages/utils/src/tree-change/tree-walk.ts', // opendir / open / fstat over a tree
        'packages/utils/src/tree-change/copy-tree.ts', // Reads and writes every file of a tree
        'packages/utils/src/tree-change/readable-tree.ts', // Opens every file of a tree
        'packages/utils/src/errors/path-present.ts', // One stat / lstat wrapper; its tests need a real path and a refused one
        'packages/lab/src/bin/**', // CLI entry point — same category as packages/cli/src/bin/**
        'packages/resource-compiler/src/cli/**', // CLI commands (integration test only)
        'packages/resource-compiler/src/language-service/**', // VSCode integration (not unit testable)
        'packages/resource-compiler/src/compiler/markdown-compiler.ts', // Orchestrator with comprehensive integration tests
        'packages/vat-development-agents/src/**', // Agent packages (integration test only)
        'packages/vat-example-cat-agents/src/**', // Agent packages (integration test only)
      ],
      // ⛔ A RATCHET: these only go up, and ONE measurement seeds them — the
      // coverage job in `coverage.yml` (Linux, the exact Node floor). A run on
      // another platform or Node counts different branches: the 77 % a macOS
      // run once wrote for branches was 76.99 % on the floor, and CI could not
      // meet it. So `autoUpdate` — which rewrites these four numbers in THIS
      // file, in WHOLE points, whenever the run measures higher — is armed only
      // where `COVERAGE_RATCHET=write`, which is that job and nothing else; the
      // job then fails on the diff it produced, printing the numbers to commit.
      // A local run never writes here. (A bare `autoUpdate: true` would write
      // the exact `pct`, e.g. 82.17, and leave zero headroom.)
      //
      // They are measured over the whole unit tier with the exclusions above
      // justified file by file. Never lower one by hand: a drop is a coverage
      // regression to fix, or an exclusion to justify in place.
      thresholds: {
        statements: 84,
        branches: 78,
        functions: 87,
        lines: 84,
        autoUpdate: process.env['COVERAGE_RATCHET'] === 'write' ? (measured: number) => Math.floor(measured) : false,
      },
    },
  },
});
