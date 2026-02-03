/* eslint-disable security/detect-non-literal-fs-filename */
// Test helpers legitimately use dynamic paths

/**
 * Test helpers for system tests
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';

import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import * as yaml from 'js-yaml';
import { expect } from 'vitest';

/**
 * Parse YAML output from CLI commands
 * Handles output with --- document markers
 */
export function parseYamlOutput(stdout: string): Record<string, unknown> {
  // Extract content between --- markers
  const parts = stdout.split('---\n').filter(part => part.trim());

  if (parts.length === 0) {
    throw new Error('No YAML content found in output');
  }

  // Parse the first document (there should only be one valid document)
  const yamlContent = parts[0];
  return yaml.load(yamlContent) as Record<string, unknown>;
}

/**
 * Create a temporary test project directory
 */
export function createTempProject(baseTempDir: string, name: string): string {
  const projectDir = join(baseTempDir, name);
  mkdirSyncReal(projectDir);
  return projectDir;
}

/**
 * Setup a project with .git and optional config
 */
export function setupProjectRoot(projectDir: string, config?: string): void {
  // Create .git to mark as project root
  mkdirSyncReal(join(projectDir, '.git'));

  if (config) {
    fs.writeFileSync(join(projectDir, 'vibe-agent-toolkit.config.yaml'), config);
  }
}

/**
 * Create a test markdown file
 */
export function createMarkdownFile(dir: string, filename: string, content: string): void {
  const docsDir = join(dir, 'docs');
  if (!fs.existsSync(docsDir)) {
    mkdirSyncReal(docsDir, { recursive: true });
  }
  fs.writeFileSync(join(docsDir, filename), content);
}

/**
 * Common test project setup with docs directory
 */
export interface TestProjectOptions {
  name: string;
  config?: string;
  withDocs?: boolean;
}

export function setupTestProject(
  baseTempDir: string,
  options: TestProjectOptions
): string {
  const projectDir = createTempProject(baseTempDir, options.name);
  setupProjectRoot(projectDir, options.config);

  if (options.withDocs) {
    mkdirSyncReal(join(projectDir, 'docs'));
  }

  return projectDir;
}

/**
 * Create a temporary directory for tests
 */
export function createTestTempDir(prefix: string): string {
  return fs.mkdtempSync(join(normalizedTmpdir(), prefix));
}

/**
 * Common result type for CLI execution
 */
export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Execute CLI command and return result
 */
export function executeCli(
  binPath: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): CliResult {
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  return spawnSync('node', [binPath, ...args], {
    encoding: 'utf-8',
    cwd: options?.cwd,
    env: options?.env,
  });
}

/**
 * Execute resources scan command
 */
export function executeResourcesScan(
  binPath: string,
  cwd: string
): CliResult {
  return executeCli(binPath, ['resources', 'scan'], { cwd });
}

/**
 * Execute resources validate command
 */
export function executeResourcesValidate(
  binPath: string,
  cwd: string
): CliResult {
  return executeCli(binPath, ['resources', 'validate'], { cwd });
}

/**
 * Execute resources scan with path argument
 */
export function executeResourcesScanPath(
  binPath: string,
  path: string
): CliResult {
  return executeCli(binPath, ['resources', 'scan', path]);
}

/**
 * Execute resources validate with path argument
 */
export function executeResourcesValidatePath(
  binPath: string,
  path: string
): CliResult {
  return executeCli(binPath, ['resources', 'validate', path]);
}

/**
 * Execute and parse YAML result
 */
export function executeAndParseYaml(
  binPath: string,
  args: string[],
  options?: { cwd?: string }
): { result: CliResult; parsed: Record<string, unknown> } {
  const result = executeCli(binPath, args, options);
  const parsed = parseYamlOutput(result.stdout);
  return { result, parsed };
}

/**
 * Execute scan and parse result
 */
export function executeScanAndParse(
  binPath: string,
  cwd: string
): { result: CliResult; parsed: Record<string, unknown> } {
  return executeAndParseYaml(binPath, ['resources', 'scan'], { cwd });
}

/**
 * Execute validate and parse result
 */
export function executeValidateAndParse(
  binPath: string,
  cwd: string
): { result: CliResult; parsed: Record<string, unknown> } {
  return executeAndParseYaml(binPath, ['resources', 'validate'], { cwd });
}

/**
 * Helper to assert validation failure and check error details in stderr
 * Encapsulates the common pattern of:
 * 1. Running validation and expecting failure
 * 2. Parsing YAML output and verifying error count
 * 3. Running text format command and checking stderr for specific error
 */
export function assertValidationFailureWithErrorInStderr(
  binPath: string,
  projectDir: string,
  expectedErrorInStderr: string
): void {
  const { result, parsed } = executeValidateAndParse(binPath, projectDir);

  // Should fail due to validation error
  expect(result.status).toBe(1);
  expect(parsed.status).toBe('failed');
  expect(parsed.errorsFound).toBeGreaterThan(0);

  // Check error details in stderr (use text format)
  const textResult = executeCli(binPath, ['resources', 'validate', '--format', 'text'], { cwd: projectDir });
  expect(textResult.stderr).toContain(expectedErrorInStderr);
}

/**
 * Test helper for config error scenarios
 * Sets up project with invalid config, creates test.md, runs scan, and returns result
 */
export function testConfigError(
  tempDir: string,
  projectName: string,
  invalidConfig: string,
  binPath: string
): CliResult {
  const projectDir = setupTestProject(tempDir, {
    name: projectName,
    config: invalidConfig,
    withDocs: true,
  });

  fs.writeFileSync(join(projectDir, 'docs/test.md'), '# Test');

  // eslint-disable-next-line sonarjs/no-os-command-from-path
  return spawnSync('node', [binPath, 'resources', 'scan'], {
    encoding: 'utf-8',
    cwd: projectDir,
  });
}

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

/**
 * Create a schema file (JSON or YAML) for frontmatter validation tests
 * @param dir - Directory to create schema in
 * @param filename - Schema filename (e.g., 'schema.json', 'schema.yaml')
 * @param schema - Schema object
 */
export function createSchemaFile(
  dir: string,
  filename: string,
  schema: Record<string, unknown>
): string {
  const schemaPath = join(dir, filename);
  const content = filename.endsWith('.yaml') || filename.endsWith('.yml')
    ? yaml.dump(schema)
    : JSON.stringify(schema, null, 2);
  fs.writeFileSync(schemaPath, content);
  return schemaPath;
}

/**
 * Create a markdown file with frontmatter
 * @param dir - Directory to create file in
 * @param filename - Markdown filename
 * @param frontmatter - Frontmatter object (or null for no frontmatter)
 * @param content - Markdown content (defaults to '# Content')
 */
export function createMarkdownWithFrontmatter(
  dir: string,
  filename: string,
  frontmatter: Record<string, unknown> | null,
  content = '# Content'
): string {
  const mdPath = join(dir, filename);
  let fileContent = '';

  if (frontmatter) {
    // Use yaml.dump for proper YAML formatting (handles arrays, objects, etc.)
    const frontmatterYaml = yaml.dump(frontmatter).trim();
    fileContent = `---\n${frontmatterYaml}\n---\n\n${content}`;
  } else {
    fileContent = content;
  }

  fs.writeFileSync(mdPath, fileContent);
  return mdPath;
}

/**
 * Execute resources validate command with frontmatter schema
 * @param binPath - Path to CLI binary
 * @param targetDir - Directory to validate
 * @param schemaPath - Path to schema file
 */
export function executeResourcesValidateWithSchema(
  binPath: string,
  targetDir: string,
  schemaPath: string
): CliResult {
  return executeCli(binPath, ['resources', 'validate', targetDir, '--frontmatter-schema', schemaPath]);
}

/**
 * Setup test with schema and markdown, then execute validation
 * Eliminates common pattern in frontmatter validation tests
 *
 * @param tempDir - Temporary test directory
 * @param schema - JSON Schema for frontmatter validation
 * @param schemaFilename - Schema filename (defaults to 'schema.json')
 * @param frontmatter - Frontmatter object (or null for no frontmatter)
 * @param mdFilename - Markdown filename (defaults to 'test.md')
 * @param mdContent - Markdown content (defaults to '# Content')
 * @param binPath - Path to CLI binary
 * @returns Validation result
 */
export function setupSchemaAndValidate(
  tempDir: string,
  schema: Record<string, unknown>,
  schemaFilename: string,
  frontmatter: Record<string, unknown> | null,
  mdFilename: string,
  mdContent: string,
  binPath: string
): CliResult {
  const schemaPath = createSchemaFile(tempDir, schemaFilename, schema);
  createMarkdownWithFrontmatter(tempDir, mdFilename, frontmatter, mdContent);
  return executeResourcesValidateWithSchema(binPath, tempDir, schemaPath);
}
