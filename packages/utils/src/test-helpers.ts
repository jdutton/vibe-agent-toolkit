import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import fs from 'node:fs/promises';


import { mkdirSyncReal, normalizedTmpdir, safePath } from './path-utils.js';

/**
 * How long a scratch-dir teardown may run before it gives up and warns.
 *
 * The value only has to be comfortably *under* vitest's 10s default hook
 * timeout — that is the whole design. Sizing a teardown budget to beat
 * contention is unprovable (see {@link removeScratchDir}); sizing it below a
 * known constant is arithmetic.
 */
const SCRATCH_REMOVAL_BUDGET_MS = 4000;

/** Knobs for {@link removeScratchDir}; both exist so the behaviour is testable. */
export interface RemoveScratchDirOptions {
  /** Deadline before the removal is abandoned. Default {@link SCRATCH_REMOVAL_BUDGET_MS}. */
  readonly budgetMs?: number;
  /** Where the give-up notice goes. Default `console.warn`. */
  readonly onWarn?: (message: string) => void;
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
 * the path. An abandoned removal keeps running harmlessly in the background;
 * it can never surface as an unhandled rejection because the only rejection
 * handler is installed before the race.
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

  const removal = fs
    .rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
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
export function setupAsyncTempDirSuite(prefix: string): {
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
      await removeScratchDir(suiteDir);
    },
    beforeEach: async () => {
      testCounter++;
      tempDir = safePath.join(suiteDir, `test-${testCounter}`);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtemp
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
export function setupSyncTempDirSuite(prefix: string): {
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
      await removeScratchDir(suiteDir);
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

declare const symlinkCapabilityBrand: unique symbol;

/**
 * Proof that this process can create filesystem symlinks.
 *
 * The only way to obtain one is {@link symlinkCapability}, and it exists at
 * all only when a real probe already succeeded — so a function that requires
 * this as a parameter cannot be reached by code that skipped the check. That
 * is the point of branding it rather than passing a `boolean`: forgetting the
 * check becomes a type error instead of a runtime `EPERM` on a machine you
 * don't control.
 */
export type SymlinkCapability = { readonly [symlinkCapabilityBrand]: true };

let cachedCapability: SymlinkCapability | null | undefined;

/**
 * Whether this PROCESS can create symlinks — probed once and memoized.
 *
 * On Windows, `symlink()` needs either Developer Mode or
 * `SeCreateSymbolicLinkPrivilege`. That privilege lives on the process's
 * security token, not on any one directory: it cannot change between calls
 * within a single run, so probing it once and reusing the result is a
 * memoization, not a shortcut that risks a stale answer. (An exotic
 * filesystem that itself refuses symlinks — some network shares, some FAT
 * variants — is a real exception this does not model; every fixture in this
 * repo creates its roots under {@link normalizedTmpdir}, so it never arises
 * here.)
 *
 * Fixtures that depend on symlinks must ask rather than assume — and, having
 * asked, must SAY they skipped. A symlink case that silently no-ops reads as
 * a passing test for a property nobody exercised.
 *
 * @returns A {@link SymlinkCapability} token when this process can create
 *   symlinks, else `null`. Route the `null` case through vitest's `skip()`
 *   rather than a plain `return`, so the skip is visible in the report.
 */
export function symlinkCapability(): SymlinkCapability | null {
  if (cachedCapability === undefined) {
    const probe = safePath.join(normalizedTmpdir(), `.vat-symlink-probe-${randomBytes(4).toString('hex')}`);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed tmp dir plus a random basename generated here
      symlinkSync('.', probe);
      cachedCapability = {} as SymlinkCapability;
    } catch {
      cachedCapability = null;
    }
    if (cachedCapability !== null) {
      // Best-effort: the capability answer comes from creation succeeding, not
      // from cleanup — a probe left behind by a failed rmSync (e.g. a transient
      // lock on the freshly-created reparse point) must not flip a real "yes"
      // into a memoized, process-wide "no".
      try {
        rmSync(probe, { force: true });
      } catch {
        // Leftover probe file; harmless, and not this function's concern.
      }
    }
  }
  return cachedCapability;
}

/**
 * Create a symlink — the one sanctioned call site for `fs.symlinkSync` in
 * test code. Requires a {@link SymlinkCapability}, which only
 * {@link symlinkCapability} can mint, so a test cannot reach the real
 * syscall without first proving (or explicitly bypassing via `skip()`) that
 * this host supports it.
 *
 * @param _cap - Proof from {@link symlinkCapability} that this host can create symlinks
 * @param target - The existing path the new link should point at
 * @param path - Where to create the link
 * @param type - Windows-only link-type hint (`'file'` \| `'dir'` \| `'junction'`); ignored on POSIX
 */
export function createSymlink(
  _cap: SymlinkCapability,
  target: string,
  path: string,
  type?: 'dir' | 'file' | 'junction',
): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied path; the capability parameter is what proves this call site is sanctioned
  symlinkSync(target, path, type);
}

/**
 * The async counterpart of {@link createSymlink}, for fixtures already using
 * `node:fs/promises`. Same capability requirement, same reasoning.
 *
 * @param _cap - Proof from {@link symlinkCapability} that this host can create symlinks
 * @param target - The existing path the new link should point at
 * @param path - Where to create the link
 * @param type - Windows-only link-type hint (`'file'` \| `'dir'` \| `'junction'`); ignored on POSIX
 */
export async function createSymlinkAsync(
  _cap: SymlinkCapability,
  target: string,
  path: string,
  type?: 'dir' | 'file' | 'junction',
): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied path; the capability parameter is what proves this call site is sanctioned
  await fs.symlink(target, path, type);
}

/**
 * The variables git exports into a hook, which a fixture must clear before it
 * can fabricate its own.
 *
 * These are the ones git sets *for* you. Deliberately **not** the operator's own
 * `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`/`GLOBAL`/`SYSTEM` channel — a test may be
 * using that on purpose to point a clone at a local path, and clearing it sends
 * the clone to the network instead.
 */
export const INHERITED_GIT_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_INDEX_VERSION',
  'GIT_NAMESPACE',
  'GIT_NOTES_REF',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
] as const;

/**
 * Remove every inherited git redirection from `process.env`, and hand back the
 * undo.
 *
 * A test that fabricates a hook environment has to start from a known-clean one,
 * or it inherits whatever the *outer* runner exported and can no longer tell its
 * own fixture apart from the ambient state — it then passes or fails for reasons
 * it never set up. Restoring afterwards matters just as much: these are
 * process-global, so a test that leaks `GIT_DIR` silently redirects every later
 * test sharing the worker.
 *
 * ⚠️ **The key list is restated here on purpose, not by oversight.** Deriving it
 * from `@vibe-validate/git`'s `stripGitEnv()` would be tidier, and it is exactly
 * what this function did for one revision — but this module is the `./testing`
 * subpath, which `subpath-purity.test.ts` pins as reaching **no third-party
 * package at all** so it stays importable with zero dependencies installed. One
 * import cost that property. The drift risk the derivation was avoiding is
 * handled instead by {@link "../test/test-helpers-git-env.test".default}, which
 * asserts this list equals what the shipped scrub removes.
 *
 * @returns A function restoring every variable to its prior value, putting back
 *   "was not set" as unset rather than as an empty string
 *
 * @example
 * ```typescript
 * let restoreGitEnv: () => void;
 * beforeEach(() => { restoreGitEnv = detachGitEnv(); });
 * afterEach(() => { restoreGitEnv(); });
 * ```
 */
export function detachGitEnv(): () => void {
  const saved = new Map<string, string | undefined>();

  const forget = (name: string): void => {
    saved.set(name, process.env[name]);
    delete process.env[name];
  };

  for (const name of INHERITED_GIT_ENV) {
    forget(name);
  }

  return () => {
    for (const [name, value] of saved) {
      // Deleted first so an absent variable is restored as absent: assigning
      // `undefined` would leave the literal string 'undefined' behind.
      delete process.env[name];
      if (value !== undefined) process.env[name] = value;
    }
  };
}
