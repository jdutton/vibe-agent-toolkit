/* eslint-disable security/detect-non-literal-fs-filename */
// Test helpers legitimately use dynamic paths

/**
 * RAG test setup helpers for system tests
 */

import * as fs from 'node:fs';
import { join } from 'node:path';

import type { CliResult } from './cli-runner.js';
import { executeAndParseYaml } from './cli-runner.js';
import { createTestTempDir, setupTestProject } from './project-setup.js';

/**
 * Setup RAG test project with markdown files
 * Creates project with docs directory and sample markdown files
 */
export function setupRagTestProject(
  baseTempDir: string,
  projectName: string
): string {
  const projectDir = setupTestProject(baseTempDir, {
    name: projectName,
    withDocs: true,
  });

  // Create test markdown files
  const docsDir = join(projectDir, 'docs');
  fs.writeFileSync(
    join(docsDir, 'README.md'),
    '# Documentation\n\n## Getting Started\n\nWelcome to the documentation.\n\n## API Reference\n\nAPI docs here.'
  );

  fs.writeFileSync(
    join(docsDir, 'guide.md'),
    '# User Guide\n\n## Installation\n\nInstall the package.\n\n## Usage\n\nUse it like this.'
  );

  return projectDir;
}

/**
 * Test helper: Executes a RAG command in an empty project and returns result
 * Used for testing "database does not exist" scenarios
 */
export function executeRagCommandInEmptyProject(
  baseTempDir: string,
  binPath: string,
  command: string[]
): { result: CliResult; parsed: Record<string, unknown> } {
  // Create a new project without indexing
  const emptyProjectDir = setupTestProject(baseTempDir, {
    name: 'empty-project-rag-db-test',
    withDocs: true,
  });

  return executeAndParseYaml(binPath, command, { cwd: emptyProjectDir });
}

/**
 * Setup test environment for RAG commands with indexed database
 * Creates temp dir, sets up project, creates markdown files, and indexes them
 * @param testPrefix - Prefix for temp directory name
 * @param projectName - Name of test project to create
 * @param binPath - Path to CLI binary
 * @param dbPath - Optional isolated database path (recommended for parallel test execution)
 * @returns Object with tempDir, projectDir, and binPath for use in tests
 */
export function setupIndexedRagTest(
  testPrefix: string,
  projectName: string,
  binPath: string,
  dbPath?: string
): { tempDir: string; projectDir: string } {
  const tempDir = createTestTempDir(testPrefix);
  const projectDir = setupRagTestProject(tempDir, projectName);

  // Index the files with optional isolated database path
  const indexArgs = dbPath
    ? ['rag', 'index', projectDir, '--db', dbPath]
    : ['rag', 'index', projectDir];

  const { result } = executeAndParseYaml(
    binPath,
    indexArgs,
    { cwd: projectDir }
  );

  // Ensure indexing succeeded
  if (result.status !== 0) {
    throw new Error(`Failed to index files for ${testPrefix} tests`);
  }

  return { tempDir, projectDir };
}

/**
 * Setup RAG test suite with standard lifecycle hooks
 * Eliminates duplication of beforeAll/afterAll setup across RAG system tests
 *
 * @param testName - Name of the test suite (e.g., 'stats', 'query', 'clear')
 * @param binPath - Path to CLI binary
 * @param getTestOutputDir - Function from @vibe-agent-toolkit/utils
 * @returns Object with refs that will be populated during beforeAll
 *
 * @example
 * ```typescript
 * import { getTestOutputDir } from '@vibe-agent-toolkit/utils';
 * const binPath = getBinPath(import.meta.url);
 * const suite = setupRagTestSuite('stats', binPath, getTestOutputDir);
 *
 * it('should work', () => {
 *   const { result } = executeCliAndParseYaml(
 *     binPath,
 *     ['rag', 'stats', '--db', suite.dbPath],
 *     { cwd: suite.projectDir }
 *   );
 *   expect(result.status).toBe(0);
 * });
 * ```
 */
export function setupRagTestSuite(
  testName: string,
  binPath: string,
  getTestOutputDir: (pkg: string, ...segments: string[]) => string
): {
  tempDir: string;
  projectDir: string;
  dbPath: string;
  beforeAll: () => void;
  afterAll: () => void;
} {
  const suite = {
    tempDir: '',
    projectDir: '',
    dbPath: '',
    beforeAll: () => {
      suite.dbPath = getTestOutputDir('cli', 'system', `rag-${testName}-db`);
      const result = setupIndexedRagTest(
        `vat-rag-${testName}-test-`,
        'test-project',
        binPath,
        suite.dbPath
      );
      suite.tempDir = result.tempDir;
      suite.projectDir = result.projectDir;
    },
    afterAll: () => {
      fs.rmSync(suite.tempDir, { recursive: true, force: true });
    },
  };

  return suite;
}

/**
 * Execute RAG query command and verify basic success response
 * Eliminates duplication in RAG query tests
 *
 * @param binPath - Path to CLI binary
 * @param args - Command arguments (e.g., ['rag', 'query', 'term', '--limit', '5'])
 * @param cwd - Working directory
 * @returns Object with result and typed output
 */
export function executeRagQueryAndExpectSuccess(
  binPath: string,
  args: string[],
  cwd: string
): {
  result: CliResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output: any;
} {
  const { result, parsed } = executeAndParseYaml(binPath, args, { cwd });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const output = parsed as any;

  // Common assertions for successful RAG query
  if (result.status !== 0) {
    throw new Error(`Expected status 0, got ${String(result.status ?? 'null')}`);
  }

  if (output.status !== 'success') {
    throw new Error(`Expected success status, got ${String(output.status)}`);
  }

  return { result, output };
}
