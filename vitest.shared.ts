/**
 * Shared platform-aware vitest settings, and factory functions that build
 * each package's own vitest.config.ts / vitest.integration.config.ts /
 * vitest.system.config.ts `test` block.
 *
 * Unit vs. integration configs have different pool requirements:
 *   - Unit: threads on Mac/Unix (~20% faster collect); forks on Windows (process.chdir + native modules).
 *   - Integration: forks on ALL platforms (native modules like lancedb + process.chdir() don't
 *     survive the threads pool — teardown SIGABRTs on Unix).
 *
 * Both unit and integration pools are capped at maxForks/maxThreads: 2 on ALL platforms —
 * integration test files load native ML models (onnxruntime, transformers) + LanceDB's Arrow
 * engine, each ~1-3GB resident in NATIVE memory (not the JS heap, so provider.close() can't
 * reclaim it — only worker exit does). Leaving this unbounded on Unix once spawned
 * ~availableParallelism (~10) such workers at once, swapping the machine and OOM-killing
 * workers (surfaces as ERR_IPC_CHANNEL_CLOSED, not a test failure) — see commit 9f7ad9c9.
 */

import { fileURLToPath } from 'node:url';

const setupFilePath = fileURLToPath(new URL('./vitest.setup.js', import.meta.url));

export const platformTestTimeout = process.platform === 'win32' ? 900_000 : 60_000; // 15min Windows, 1min Unix

export const unitPool = process.platform === 'win32' ? 'forks' : 'threads';
export const unitPoolOptions = {
  forks: { singleFork: false, maxForks: 2 },
  // Unix unit pool is 'threads', whose cap knob is maxThreads (singleFork is forks-only).
  // Without this the intended 2-way cap was silently ignored and threads ran unbounded.
  threads: { singleThread: false, maxThreads: 2 },
};

export const integrationPool = 'forks' as const;
export const integrationPoolOptions = {
  forks: {
    singleFork: false,
    maxForks: 2,
    // V8 old-space cap — bounds JS-HEAP blowups only. This does NOT bound the
    // native-memory risk (LanceDB's Arrow engine, onnxruntime models each
    // ~1-3GB resident OUTSIDE V8's heap) that maxForks above already guards
    // via concurrency. 1024MB gives ~2.5x headroom over the heaviest measured
    // integration file (resource-compiler's language-service/transformer
    // suites, 231-382MB across repeated runs) while staying tight enough to
    // actually terminate a future JS-heap regression — unlike Node's default,
    // which scales with host RAM and never binds.
    execArgv: ['--max-old-space-size=1024'],
  },
};

export interface UnitTestConfigOverrides {
  coverageExclude?: string[];
}

/** Builds the `test` block for a package's own vitest.config.ts (unit tests). */
export function createUnitTestConfig(overrides: UnitTestConfigOverrides = {}) {
  return {
    globals: true,
    environment: 'node' as const,
    setupFiles: [setupFilePath],
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.integration.test.ts',
      '**/*.system.test.ts',
    ],
    testTimeout: platformTestTimeout,
    // NOTE: no hookTimeout override here on purpose. Unit hooks should fail
    // fast at vitest's 10s default — a unit hook that needs longer is doing
    // real I/O and belongs in the integration or system tier instead.
    pool: unitPool,
    poolOptions: unitPoolOptions,
    coverage: {
      provider: 'v8' as const,
      reporter: ['text', 'json', 'html'] as const,
      exclude: [
        '**/*.d.ts',
        '**/dist/**',
        '**/node_modules/**',
        '**/test/**',
        '**/tests/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/index.ts',
        '**/types.ts',
        ...(overrides.coverageExclude ?? []),
      ],
    },
  };
}

export interface IntegrationTestConfigOverrides {
  exclude?: string[];
}

/** Builds the `test` block for a package's own vitest.integration.config.ts. */
export function createIntegrationTestConfig(overrides: IntegrationTestConfigOverrides = {}) {
  return {
    globals: true,
    environment: 'node' as const,
    setupFiles: [setupFilePath],
    include: ['test/**/*.integration.test.ts', 'src/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', ...(overrides.exclude ?? [])],
    testTimeout: platformTestTimeout,
    // Integration hooks legitimately do real I/O (git subprocesses, fixture
    // hydration, temp-tree setup), so vitest's 10s default is too tight —
    // especially on slow Windows CI runners. Share the same platform-aware
    // ceiling testTimeout already uses.
    hookTimeout: platformTestTimeout,
    passWithNoTests: true,
    pool: integrationPool,
    poolOptions: integrationPoolOptions,
  };
}

export interface SystemTestConfigOverrides {
  exclude?: string[];
}

/** Builds the `test` block for a package's own vitest.system.config.ts. */
export function createSystemTestConfig(overrides: SystemTestConfigOverrides = {}) {
  return {
    globals: true,
    environment: 'node' as const,
    setupFiles: [setupFilePath],
    include: ['test/**/*.system.test.ts', 'src/**/*.system.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', ...(overrides.exclude ?? [])],
    testTimeout: 120000, // System tests may take even longer
    // Hooks run expensive setup (vat build, git init, fixture hydration). Default
    // 10s is far too short; raise across platforms so slow VMs and fast dev boxes
    // share the same ceiling.
    hookTimeout: 300_000,
    // Windows rmSync on large fixture trees can take significant time.
    teardownTimeout: 120_000,
    // ['default', { summary: false }] is the vitest v3 replacement for the
    // deprecated 'basic' reporter. Skipping the per-test streaming summary
    // reduces main<->worker RPC pressure.
    reporters: [['default', { summary: false }]] as const,
    // Tests emitting verbose console output pile RPC pressure onto the same
    // channel the onTaskUpdate heartbeat uses; write worker stdout directly instead.
    disableConsoleIntercept: true,
    pool: 'forks' as const,
    poolOptions: {
      forks: {
        singleFork: false,
        // Windows: one worker at a time (serial) for reliability on constrained
        // VMs. Unix: 2 workers for ~2x speedup; system tests are fully isolated.
        maxForks: process.platform === 'win32' ? 1 : 2,
        // Same V8 old-space cap as integrationPoolOptions — see its comment.
        // Heaviest measured system-test file: cli/inventory-parity.system.test.ts, ~196MB.
        execArgv: ['--max-old-space-size=1024'],
      },
    },
  };
}
