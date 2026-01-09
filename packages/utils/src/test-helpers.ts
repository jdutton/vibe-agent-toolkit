import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

import { mkdirSyncReal } from './path-utils.js';

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
 * const tempDir = getTestOutputDir('runtime-claude-skills', 'integration', 'temp-files');
 * // Result: packages/runtime-claude-skills/.test-output/integration/20260105-143022-def456/temp-files
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
