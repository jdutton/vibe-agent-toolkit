import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.js'],
    include: [
      'packages/*/test/**/*.system.test.ts',
      'packages/*/src/**/*.system.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Windows: Skip tests that require symlinks (elevated privileges), bun wrapper
      // (null exit status), MCP package resolution, or full-project scans (10-20x slower).
      // skills-list-fixture.system.test.ts and skills-validate-fixture.system.test.ts provide Windows coverage
      ...(process.platform === 'win32'
        ? [
            'packages/cli/test/system/bin-wrapper.system.test.ts',
            'packages/cli/test/system/mcp-stdio-protocol.system.test.ts',
            'packages/cli/test/system/skills-install-dev.system.test.ts',
            'packages/cli/test/system/skills-list.system.test.ts',
            'packages/cli/test/system/skills-uninstall.system.test.ts',
            'packages/cli/test/system/skills-validate.system.test.ts',
          ]
        : []),
    ],
    testTimeout: 120000, // System tests may take even longer
    // Hooks run expensive setup (vat build, git init, fixture hydration). Default
    // 10s is far too short; raise across platforms so slow VMs and fast dev boxes
    // share the same ceiling.
    hookTimeout: 300_000,
    // Windows rmSync on large fixture trees can take significant time.
    teardownTimeout: 120_000,
    // ['default', { summary: false }] is the vitest v3 replacement for the
    // deprecated 'basic' reporter. Skipping the per-test streaming summary
    // reduces main<->worker RPC pressure, which is what trips vitest's hardcoded
    // 60s onTaskUpdate timeout on slow VMs.
    reporters: [['default', { summary: false }]],
    // Tests like rag-lancedb and claude-marketplace emit verbose console output
    // ("Indexed 240 chunks", ASCII tables, etc.). By default vitest intercepts
    // worker console output and ships each line back over RPC to be re-printed
    // by the main process — on a slow VM this piles onto the same RPC channel
    // that the onTaskUpdate heartbeat uses. Writing worker stdout directly
    // bypasses that channel entirely.
    disableConsoleIntercept: true,
    pool: 'forks',
    poolOptions: {
      forks: {
        // Historically we used singleFork on Windows to eliminate cross-worker
        // communication overhead. In practice it made things worse: when a single
        // worker processes all 44 files serially, RPC backpressure from one slow
        // file (spawnSync blocks the worker event loop) carries into the next
        // file and trips the hardcoded 60s onTaskUpdate timeout, killing the
        // entire run. Using a fresh worker per file (singleFork:false, maxForks:1)
        // still runs files serially on Windows (no parallelism risk on slow VMs)
        // but resets RPC state between files — so one slow file can't poison the
        // rest of the suite.
        singleFork: false,
        // Windows: one worker at a time (serial) for reliability on constrained
        // VMs. Unix: 2 workers for ~2x speedup; system tests are fully isolated.
        maxForks: process.platform === 'win32' ? 1 : 2,
      },
    },
  },
});
