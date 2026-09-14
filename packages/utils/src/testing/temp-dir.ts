/**
 * The ONE temp-directory helper family.
 *
 * Every shape a suite needs to mint scratch space lives here: a per-call
 * `createTempDir`, a tracker that removes what it minted, and the per-suite
 * sync/async suite helpers with their bounded teardown. The audit counted
 * eleven definitions of "give me a temp dir that cleans itself up" across
 * eight modules, six of them named differently and none of them visible to
 * the duplication gate; this module is where they were collapsed to.
 *
 * ⛔ Framework-free, like everything under `testing/`: nothing here imports
 * `vitest`, so the `./testing` subpath keeps the empty third-party set its
 * purity pin asserts. Each suite owns its own hooks and calls these from
 * inside them.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import fs, { mkdtemp } from 'node:fs/promises';

import { isUnderRoot } from '../path-containment.js';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '../path-utils.js';

/**
 * Mint a fresh temp directory under the host's (short-name-resolved) tmpdir.
 *
 * The one-liner that used to be spelled in three packages as
 * `createTestTempDir`. Pair with {@link removeTempDir}, or let
 * {@link tempDirTracker} pair them for you.
 *
 * @param prefix - `mkdtemp` prefix, so a leaked directory names its own suite
 * @returns Absolute, forward-slashed path of the new directory
 */
export function createTempDir(prefix: string): string {
  return safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), prefix)));
}

/** The async counterpart of {@link createTempDir}, for suites already on `fs/promises`. */
export async function createTempDirAsync(prefix: string): Promise<string> {
  return safePath.resolve(await mkdtemp(safePath.join(normalizedTmpdir(), prefix)));
}

/**
 * Remove a directory {@link createTempDir} minted — and ONLY such a directory.
 *
 * Refuses, by name, to remove anything that is not strictly under the host
 * tmpdir as the filesystem sees it. A teardown is the one place test code
 * runs `rm -rf` on a variable, and a variable that was never assigned (a
 * `beforeAll` that threw), or was assigned a fixture INSIDE the repo, must
 * not become `rm -rf ''` or `rm -rf packages/`. The `dev-tools` copy of this
 * helper carried that guard as a lexical `startsWith`; the guard here asks
 * the filesystem, so a symlinked tmpdir (macOS) still passes.
 *
 * `force: true` tolerates a directory already gone; the retries are Node's
 * own remedy for the transient `EBUSY` / `EPERM` a just-closed handle
 * produces on Windows. Anything left after that is a real teardown failure
 * and stays loud — a teardown that swallows it hides a leaking fixture.
 *
 * @param dir - The directory to remove
 * @throws When `dir` is not strictly under the host tmpdir
 */
export function removeTempDir(dir: string): void {
  if (isUnderRoot(normalizedTmpdir(), dir) === 'outside') {
    throw new Error(`removeTempDir: refusing to remove ${dir} — not inside the host tmpdir ${normalizedTmpdir()}`);
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * A factory that remembers every directory it minted, so one `afterEach`
 * removes them all.
 *
 * @param prefix - `mkdtemp` prefix for every directory this tracker mints
 * @returns `create` to mint one more, `cleanupAll` to remove every one so far
 *
 * @example
 * ```typescript
 * const scratch = tempDirTracker('my-suite-');
 * afterEach(() => scratch.cleanupAll());
 * it('…', () => { const dir = scratch.create(); … });
 * ```
 */
export function tempDirTracker(prefix: string): { create: () => string; cleanupAll: () => void } {
  const minted: string[] = [];
  return {
    create: () => {
      const dir = createTempDir(prefix);
      minted.push(dir);
      return dir;
    },
    cleanupAll: () => {
      for (const dir of minted) removeTempDir(dir);
      minted.length = 0;
    },
  };
}

/**
 * How long a scratch-dir teardown may run before it gives up and warns.
 *
 * The value only has to be comfortably *under* the hook timeout it runs in —
 * that is the whole design. Sizing a teardown budget to beat contention is
 * unprovable (see {@link removeScratchDir}); sizing it below a known constant is
 * arithmetic.
 *
 * ⚠️ **The known constant is the UNIT tier's**, which is the only tier that
 * takes vitest's 10s default (`vitest.shared.ts` declines to override it there
 * on purpose) and the tier where the flake was actually observed. The other two
 * tiers set their own, far larger: integration gets `platformTestTimeout`
 * (60s on Unix, 900s on Windows) and system gets 300s. A suite in those tiers
 * inherits this 4s default and therefore gives up 15x–225x earlier than its hook
 * would have allowed — for a heavy fixture tree that is a leaked directory and a
 * warning bought for nothing, since an abandoned removal does not stop (see
 * {@link removeScratchDir}). Such a suite should pass its own `budgetMs`, which
 * both suite helpers forward.
 */
const SCRATCH_REMOVAL_BUDGET_MS = 4000;

/** Knobs for {@link removeScratchDir}; all three exist so the behaviour is testable. */
export interface RemoveScratchDirOptions {
  /** Deadline before the removal is abandoned. Default {@link SCRATCH_REMOVAL_BUDGET_MS}. */
  readonly budgetMs?: number;
  /** Where the give-up notice goes. Default `console.warn`. */
  readonly onWarn?: (message: string) => void;
  /**
   * The removal itself. Defaults to `fs.rm` with recursive/force/retries.
   *
   * Injectable because the *contract* — a removal that fails must warn rather
   * than throw — cannot otherwise be tested on every platform. Driving a real
   * `fs.rm` failure needs a path the OS refuses, and those diverge: a path
   * whose parent component is a regular file yields `ENOTDIR` on POSIX, and
   * resolves silently on Windows. A test written against the POSIX shape
   * passes locally and fails in CI, which is exactly what it did once.
   */
  readonly remove?: (dir: string) => Promise<void>;
}

/**
 * Delete a scratch directory as *best effort* — never failing the suite that
 * created it, and never taking longer than its own budget to say so.
 *
 * ## Why this is not just `await rm(dir, { recursive: true, force: true })`
 *
 * A teardown hook that can redden a suite whose every assertion passed is a
 * defect in the harness, not a flake. `packages/lab/test/instrument.test.ts`
 * timed out here on two consecutive Windows runs with all 655 assertions
 * green — only the cleanup lost.
 *
 * The measurement is what rules out the obvious fixes: that scratch dir holds
 * 490 files / 378 KiB across 14 fixture git repos, and deletes in **59 ms**
 * idle. Against vitest's 10,000 ms unit-hook budget that is 170x of headroom,
 * and Windows blew through it anyway. No quantity of real work explains that,
 * so the cause is scheduling — contention from a fully parallel `validate`,
 * plus per-unlink antivirus on Windows — which is unbounded by nature. Hence:
 *
 * - **Raising `hookTimeout` cannot be argued.** You would be picking a number
 *   to beat an unbounded quantity, when 10s of 170x headroom already lost. It
 *   also punches a hole in the deliberate policy in `vitest.shared.ts` ("no
 *   hookTimeout override here on purpose") for every unit hook, to fix one.
 * - **`try`/`catch` around the `rm` cannot work.** A vitest hook timeout is a
 *   race decided on the *timer* side; the hook's own catch never sees it. It
 *   addresses a failure mode we did not observe and leaves the one we did.
 * - **`maxRetries` alone makes it worse.** Retries target transient
 *   `EPERM`/`EBUSY`, which fail *fast*; our failure was *slow*, and retry
 *   backoff only adds to it. Kept below as a cheap inner win, not as the fix.
 *
 * So the deadline is taken away from vitest: the removal races a timer of our
 * own, well inside the hook budget, and expiry is a warning rather than a
 * failure. The hook therefore always resolves in time, which makes it
 * *structurally* incapable of reddening a green suite on any machine at any
 * load — rather than merely unlikely to.
 *
 * The cost, stated plainly: under pathological contention the directory
 * survives in the OS temp dir, which the OS reclaims, and the warning names
 * the path. It can never surface as an unhandled rejection, because the only
 * rejection handler is installed before the race.
 *
 * ⚠️ **Abandoning the removal does not stop it, and does not free the worker.**
 * A pending libuv `fs` request is an active handle, so the `rm` runs to
 * completion regardless — measured at 2,407 ms on an 8,000-file tree after the
 * race was decided at 5 ms — and the process cannot exit until it does.
 * `timer.unref()` below unrefs the *timer*, not the removal. So what this buys
 * is bounded: the **hook** always resolves in time, which is what stops a green
 * suite going red. It does **not** shed the work, and under the contention it
 * targets the abandoned removal competes for disk with whatever runs next in
 * the same worker. That is the trade, and it is why the budget wants to be as
 * large as the tier's hook allows rather than as small as possible.
 *
 * @param dir - Directory to remove. An empty string is a no-op, so a suite
 *   whose `beforeAll` never ran can call this unconditionally.
 * @param options - Deadline and warning sink
 *
 * @example
 * ```typescript
 * afterAll(async () => {
 *   await removeScratchDir(scratch);
 * });
 * ```
 */
export async function removeScratchDir(
  dir: string,
  options: RemoveScratchDirOptions = {},
): Promise<void> {
  if (dir === '') return;

  const budgetMs = options.budgetMs ?? SCRATCH_REMOVAL_BUDGET_MS;
  const onWarn =
    options.onWarn ??
    ((message: string): void => {
      console.warn(message);
    });

  // Latches on the first outcome so a removal that finishes (or fails) after
  // the budget expired cannot log a second time into an already-finished suite.
  let settled = false;
  const giveUp = (reason: string): void => {
    if (settled) return;
    settled = true;
    onWarn(`scratch dir left behind at ${dir}: ${reason}`);
  };

  const remove =
    options.remove ??
    ((target: string): Promise<void> =>
      fs.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }));

  const removal = remove(dir)
    .then(() => {
      settled = true;
    })
    .catch((error: unknown) => {
      giveUp(error instanceof Error ? error.message : String(error));
    });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      giveUp(`removal did not finish within ${budgetMs}ms`);
      resolve();
    }, budgetMs);
    // Never hold the process open for a teardown nobody is waiting on.
    timer.unref();
  });

  await Promise.race([removal, deadline]);
  clearTimeout(timer);
}

/**
 * Get isolated test output directory for current test run
 *
 * Creates a unique directory under `packages/{packageName}/.test-output/{testType}/{runId}`
 * where runId is `{timestamp}-{randomId}` to ensure isolation across parallel test runs.
 *
 * @param packageName - Name of package (e.g., 'rag-lancedb')
 * @param testType - Type of test ('unit', 'integration', 'system')
 * @param subdirs - Optional subdirectories to create within the test output directory
 * @returns Absolute path to the created directory
 *
 * @example
 * ```typescript
 * // Create isolated database directory for system tests
 * const dbPath = getTestOutputDir('rag-lancedb', 'system', 'databases', 'test-db');
 * // Result: packages/rag-lancedb/.test-output/system/20260105-143022-abc123/databases/test-db
 *
 * // Create temporary file directory for integration tests
 * const tempDir = getTestOutputDir('agent-skills', 'integration', 'temp-files');
 * // Result: packages/agent-skills/.test-output/integration/20260105-143022-def456/temp-files
 * ```
 */
export function getTestOutputDir(
  packageName: string,
  testType: 'unit' | 'integration' | 'system',
  ...subdirs: string[]
): string {
  // Generate unique run ID: timestamp + random hex
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19);
  const randomId = randomBytes(4).toString('hex');
  const runId = `${timestamp}-${randomId}`;

  // Find project root (assuming we're always in packages/*/test/*)
  const projectRoot = safePath.resolve(process.cwd());

  // Build path: packages/{packageName}/.test-output/{testType}/{runId}/{...subdirs}
  const testOutputDir = safePath.join(
    projectRoot,
    'packages',
    packageName,
    '.test-output',
    testType,
    runId,
    ...subdirs,
  );

  // Create directory structure and return normalized path
   
  return mkdirSyncReal(testOutputDir, { recursive: true });
}

/**
 * Get the base test output directory for a package
 * Useful for cleanup operations that need to remove all test output
 *
 * @param packageName - Name of package (e.g., 'rag-lancedb')
 * @returns Absolute path to packages/{packageName}/.test-output
 *
 * @example
 * ```typescript
 * const baseDir = getTestOutputBase('rag-lancedb');
 * // Result: packages/rag-lancedb/.test-output
 * ```
 */
export function getTestOutputBase(packageName: string): string {
  const projectRoot = safePath.resolve(process.cwd());
  return safePath.join(projectRoot, 'packages', packageName, '.test-output');
}

/**
 * Per-suite temp directory pattern (async version)
 * Creates a single temp directory for the entire test suite,
 * with subdirectories for each test. This is 3-5x faster on Windows
 * than creating a new mkdtemp for each test.
 *
 * @param prefix - Prefix for the suite temp directory name
 * @param teardown - Forwarded to {@link removeScratchDir}. Raise `budgetMs` for a
 *   suite whose fixture tree is heavy or whose tier allows a longer hook than the
 *   unit tier this default is sized against — see {@link SCRATCH_REMOVAL_BUDGET_MS}.
 * @returns Suite helper with beforeAll, afterAll, beforeEach, afterEach, and getTempDir
 *
 * @example
 * ```typescript
 * const suite = setupAsyncTempDirSuite('my-test');
 *
 * describe('my tests', () => {
 *   beforeAll(suite.beforeAll);
 *   afterAll(suite.afterAll);
 *   beforeEach(suite.beforeEach);
 *
 *   it('test 1', async () => {
 *     const tempDir = suite.getTempDir();
 *     // Use tempDir...
 *   });
 * });
 * ```
 */
export function setupAsyncTempDirSuite(prefix: string, teardown: RemoveScratchDirOptions = {}): {
  beforeAll: () => Promise<void>;
  afterAll: () => Promise<void>;
  beforeEach: () => Promise<void>;
  afterEach: () => Promise<void>;
  getTempDir: () => string;
} {
  let suiteDir = '';
  let tempDir = '';
  let testCounter = 0;

  return {
    beforeAll: async () => {
      suiteDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), `${prefix}-suite-`));
    },
    afterAll: async () => {
      await removeScratchDir(suiteDir, teardown);
    },
    beforeEach: async () => {
      testCounter++;
      tempDir = safePath.join(suiteDir, `test-${testCounter}`);
      await fs.mkdir(tempDir, { recursive: true });
    },
    afterEach: async () => {
      // Per-test cleanup handled by suite cleanup
    },
    getTempDir: () => tempDir,
  };
}

/**
 * Per-suite temp directory pattern (sync version)
 * Creates a single temp directory for the entire test suite,
 * with subdirectories for each test. This is 3-5x faster on Windows
 * than creating a new mkdtemp for each test.
 *
 * @param prefix - Prefix for the suite temp directory name
 * @param teardown - Forwarded to {@link removeScratchDir}. Raise `budgetMs` for a
 *   suite whose fixture tree is heavy or whose tier allows a longer hook than the
 *   unit tier this default is sized against — see {@link SCRATCH_REMOVAL_BUDGET_MS}.
 * @returns Suite helper with beforeAll, afterAll, beforeEach, afterEach, and getTempDir
 *
 * @example
 * ```typescript
 * const suite = setupSyncTempDirSuite('my-test');
 *
 * describe('my tests', () => {
 *   beforeAll(suite.beforeAll);
 *   afterAll(suite.afterAll);
 *   beforeEach(suite.beforeEach);
 *
 *   it('test 1', () => {
 *     const tempDir = suite.getTempDir();
 *     // Use tempDir...
 *   });
 * });
 * ```
 */
export function setupSyncTempDirSuite(prefix: string, teardown: RemoveScratchDirOptions = {}): {
  beforeAll: () => void;
  // Async despite the "sync suite" name, deliberately: only the teardown is,
  // because bounding a removal needs a race and `rmSync` cannot be raced. The
  // parts a sync `it()` actually calls — `beforeEach`, `getTempDir` — stay sync.
  afterAll: () => Promise<void>;
  beforeEach: () => void;
  afterEach: () => void;
  getTempDir: () => string;
} {
  let suiteDir = '';
  let tempDir = '';
  let testCounter = 0;

  return {
    beforeAll: () => {
      suiteDir = mkdtempSync(safePath.join(normalizedTmpdir(), `${prefix}-suite-`));
    },
    afterAll: async () => {
      await removeScratchDir(suiteDir, teardown);
    },
    beforeEach: () => {
      testCounter++;
      tempDir = safePath.join(suiteDir, `test-${testCounter}`);
      mkdirSyncReal(tempDir);
    },
    afterEach: () => {
      // Per-test cleanup handled by suite cleanup
    },
    getTempDir: () => tempDir,
  };
}

