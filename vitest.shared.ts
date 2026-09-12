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
 * Both unit and integration pools are capped at `maxWorkers: 2` on ALL platforms —
 * integration test files load native ML models (onnxruntime, transformers) + LanceDB's Arrow
 * engine, each ~1-3GB resident in NATIVE memory (not the JS heap, so provider.close() can't
 * reclaim it — only worker exit does). Leaving this unbounded on Unix once spawned
 * ~availableParallelism (~10) such workers at once, swapping the machine and OOM-killing
 * workers (surfaces as ERR_IPC_CHANNEL_CLOSED, not a test failure) — see commit 9f7ad9c9.
 *
 * 🚨 **`poolOptions` was REMOVED in vitest 4 — the knobs are top-level now.** Every cap in
 * this file used to live under `poolOptions.forks.maxForks` / `poolOptions.threads.maxThreads`
 * / `poolOptions.forks.execArgv`. Vitest 4 replaced all of them with a single top-level
 * `maxWorkers` and a single top-level `execArgv`, and it does NOT error on the old shape — it
 * prints a DEPRECATED line and ignores it. So carrying the v3 spelling across the bump would
 * have silently uncapped every pool and removed the heap ceiling, which is precisely the
 * unbounded-worker OOM commit 9f7ad9c9 exists to prevent. `singleFork`/`singleThread: false`
 * had no replacement because it was already the default; `fileParallelism: false` is the knob
 * if serial execution is ever wanted.
 */

import { fileURLToPath } from 'node:url';

const setupFilePath = fileURLToPath(new URL('./vitest.setup.js', import.meta.url));

/**
 * Clear every mock's CALL HISTORY before each test, in all three tiers.
 *
 * 🚨 Restores the pre-vitest-4 hygiene these suites were written against. In
 * vitest 3 `vi.restoreAllMocks()` also cleared the call history of mocks made
 * with `vi.fn()`; in vitest 4 it only restores originals for `vi.spyOn` spies,
 * so a module mock's `mock.calls` now ACCUMULATES across tests in one file.
 * Three suites went red on exactly that — counts reading 2 and 3 where they
 * asserted 1, and "expected not to be called, called 6 times".
 *
 * `clearMocks` calls `.mockClear()`, which clears calls WITHOUT touching
 * implementations, so a mock configured in `beforeAll` still works. Set here
 * rather than at the 55 individual `restoreAllMocks()` sites, so the next suite
 * to hit this does not have to rediscover it.
 *
 * ⚠️ One constant rather than the same comment in three factories: the comment
 * IS the reason, and three copies of a reason drift. `duplication-check` caught
 * the first attempt at exactly that.
 */
const CLEAR_MOCKS_BEFORE_EACH_TEST = true;

export const platformTestTimeout = process.platform === 'win32' ? 900_000 : 60_000; // 15min Windows, 1min Unix

export const unitPool = process.platform === 'win32' ? 'forks' : 'threads';

/**
 * Worker cap, shared by every tier.
 *
 * One number now covers both pools. Under vitest 3 this was two knobs
 * (`maxForks` for the Windows fork pool, `maxThreads` for the Unix thread pool)
 * and getting only one of them right left the other silently unbounded — a real
 * defect this file used to carry. `maxWorkers` is pool-agnostic, so that class
 * of mistake is gone.
 */
export const maxTestWorkers = 2;

/**
 * V8 old-space ceiling for a UNIT worker.
 *
 * ⚠️ The unit tier shipped with NO heap ceiling while integration and system
 * both had one, so a unit fork inherited Node's default — which scales with
 * host RAM and therefore never binds on a 16GB CI runner. That is the tier
 * whose worker deaths are hardest to read: a fork that dies takes the run's
 * exit code to 1 while printing no test-level failure, which vibe-validate's
 * extractor then reports as `0 test failure(s)` with an empty error list. A
 * bounded heap turns that into a deterministic, named OOM instead.
 *
 * 🪤 EMPTY on the thread pool, which is not a hedge — `worker_threads` REFUSES
 * this flag outright (`ERR_WORKER_INVALID_EXEC_ARGV`: "Initiated Worker with
 * invalid execArgv flags"), because a thread shares the host process's V8 heap
 * and cannot be given its own. Setting it unconditionally took every Unix unit
 * file to "no tests, 1 error" — which is why this is keyed on `unitPool` rather
 * than on platform: the pool is the thing that decides whether the flag is
 * legal, and a future move of Unix to forks should carry the cap with it.
 *
 * MEASURED, not guessed: `vitest run --pool=forks --logHeapUsage
 * --reporter=verbose` over all 635 unit files on this tree puts the heaviest at
 * **166MB** (`dev-tools/test/local-eslint-rule-enablement.test.ts`), with
 * `utils/test/eslint/rules.test.ts` at 152MB and
 * `cli/test/commands/resources-check-payload.test.ts` at 151MB behind it. 512MB
 * is ~3.1x that, which covers the fork-reuse variance the heap guard's own
 * budget comment describes (a fork is reused across files, so a file's reading
 * depends on what ran before it in the same fork).
 *
 * Deliberately tighter than the 1024MB integration/system cap, because no unit
 * test loads a native ML model — a unit file approaching this ceiling is doing
 * integration-shaped work and should change tier rather than be given more
 * memory.
 */
export const unitExecArgv = unitPool === 'forks' ? ['--max-old-space-size=512'] : [];

/**
 * Dependencies vitest must TRANSFORM rather than externalize.
 *
 * `@vibe-validate/git` owns the `git` spawn that `runGit` wraps. Vitest
 * externalizes `node_modules` by default, and an externalized module never sees
 * `vi.mock('node:child_process')` — so a test that stubs the spawn to inspect
 * what reaches git keeps passing while REAL git runs underneath it. Measured:
 * `git-clone-env.test.ts` (which asserts that a clone of a *shorthand* URL
 * cannot block on a credential prompt) went 2-of-8 green that way, and
 * `git-utils.test.ts` 7-of-10 — in both cases only the call-count assertions
 * noticed, and a suite asserting return values alone would have been fully green
 * while testing a live subprocess.
 *
 * This belongs in all three tiers AND in the root config: a package-level run
 * (`cd packages/x && vitest`) uses the package's own config, so setting it only
 * at the root makes the same test pass from the repo root and fail from the
 * package directory.
 */
export const inlineDeps = ['@vibe-validate/git'];

export const integrationPool = 'forks' as const;
/**
 * V8 old-space cap — bounds JS-HEAP blowups only. This does NOT bound the
 * native-memory risk (LanceDB's Arrow engine, onnxruntime models each
 * ~1-3GB resident OUTSIDE V8's heap) that `maxTestWorkers` already guards
 * via concurrency. 1024MB gives ~2.5x headroom over the heaviest measured
 * integration file (resource-compiler's language-service/transformer
 * suites, 231-382MB across repeated runs) while staying tight enough to
 * actually terminate a future JS-heap regression — unlike Node's default,
 * which scales with host RAM and never binds.
 */
export const integrationExecArgv = ['--max-old-space-size=1024'];

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
    server: { deps: { inline: inlineDeps } },
    testTimeout: platformTestTimeout,
    // NOTE: no hookTimeout override here on purpose. Unit hooks should fail
    // fast at vitest's 10s default — a unit hook that needs longer is doing
    // real I/O and belongs in the integration or system tier instead.
    clearMocks: CLEAR_MOCKS_BEFORE_EACH_TEST,
    pool: unitPool,
    maxWorkers: maxTestWorkers,
    execArgv: unitExecArgv,
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
    server: { deps: { inline: inlineDeps } },
    testTimeout: platformTestTimeout,
    // Integration hooks legitimately do real I/O (git subprocesses, fixture
    // hydration, temp-tree setup), so vitest's 10s default is too tight —
    // especially on slow Windows CI runners. Share the same platform-aware
    // ceiling testTimeout already uses.
    hookTimeout: platformTestTimeout,
    passWithNoTests: true,
    clearMocks: CLEAR_MOCKS_BEFORE_EACH_TEST,
    pool: integrationPool,
    maxWorkers: maxTestWorkers,
    execArgv: integrationExecArgv,
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
    server: { deps: { inline: inlineDeps } },
    // Windows rmSync on large fixture trees can take significant time.
    teardownTimeout: 120_000,
    // ['default', { summary: false }] is the vitest v3 replacement for the
    // deprecated 'basic' reporter. Skipping the per-test streaming summary
    // reduces main<->worker RPC pressure.
    reporters: [['default', { summary: false }]] as const,
    // Tests emitting verbose console output pile RPC pressure onto the same
    // channel the onTaskUpdate heartbeat uses; write worker stdout directly instead.
    disableConsoleIntercept: true,
    clearMocks: CLEAR_MOCKS_BEFORE_EACH_TEST,
    pool: 'forks' as const,
    // Windows: one worker at a time (serial) for reliability on constrained
    // VMs. Unix: 2 workers for ~2x speedup; system tests are fully isolated.
    maxWorkers: process.platform === 'win32' ? 1 : maxTestWorkers,
    // Same V8 old-space cap as `integrationExecArgv` — see its comment.
    // Heaviest measured system-test file: cli/inventory-parity.system.test.ts, ~196MB.
    execArgv: integrationExecArgv,
  };
}
