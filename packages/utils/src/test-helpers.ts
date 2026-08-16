import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import fs from 'node:fs/promises';

import { INHERITED_GIT_ENV } from './git-env.js';
import { mkdirSyncReal, normalizedTmpdir, safePath } from './path-utils.js';

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
      if (suiteDir) {
        await fs.rm(suiteDir, { recursive: true, force: true });
      }
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
  afterAll: () => void;
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
    afterAll: () => {
      if (suiteDir) {
        rmSync(suiteDir, { recursive: true, force: true });
      }
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

/**
 * Probe whether this host can create symbolic links inside `dir`.
 *
 * On Windows, `symlink()` needs either Developer Mode or
 * `SeCreateSymbolicLinkPrivilege`; CI agents frequently have neither. Fixtures
 * that depend on symlinks must therefore ask rather than assume — and, having
 * asked, must SAY they skipped. A symlink case that silently no-ops reads as a
 * passing test for a property nobody exercised.
 *
 * The probe creates and removes one link, because the privilege cannot be
 * inferred from `process.platform` alone.
 *
 * @param dir - An existing directory to probe in (the probe cleans up after itself)
 * @returns True when a symlink was created successfully
 */
export function canCreateSymlinks(dir: string): boolean {
  const probe = safePath.join(dir, `.vat-symlink-probe-${randomBytes(4).toString('hex')}`);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied dir plus a random basename generated here
    symlinkSync('.', probe);
  } catch {
    return false;
  }
  rmSync(probe, { force: true });
  return true;
}

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
 * The key list is {@link INHERITED_GIT_ENV}, the same one `cleanGitEnv()`
 * strips — so a variable added there is covered here without a second edit, and
 * the two can never disagree about what "the git environment" means.
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
