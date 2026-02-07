import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { mkdirSyncReal, normalizedTmpdir } from './path-utils.js';

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
  const projectRoot = resolve(process.cwd());

  // Build path: packages/{packageName}/.test-output/{testType}/{runId}/{...subdirs}
  const testOutputDir = join(
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
  const projectRoot = resolve(process.cwd());
  return join(projectRoot, 'packages', packageName, '.test-output');
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
      suiteDir = await fs.mkdtemp(join(normalizedTmpdir(), `${prefix}-suite-`));
    },
    afterAll: async () => {
      if (suiteDir) {
        await fs.rm(suiteDir, { recursive: true, force: true });
      }
    },
    beforeEach: async () => {
      testCounter++;
      tempDir = join(suiteDir, `test-${testCounter}`);
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
      suiteDir = mkdtempSync(join(normalizedTmpdir(), `${prefix}-suite-`));
    },
    afterAll: () => {
      if (suiteDir) {
        rmSync(suiteDir, { recursive: true, force: true });
      }
    },
    beforeEach: () => {
      testCounter++;
      tempDir = join(suiteDir, `test-${testCounter}`);
      mkdirSyncReal(tempDir);
    },
    afterEach: () => {
      // Per-test cleanup handled by suite cleanup
    },
    getTempDir: () => tempDir,
  };
}
