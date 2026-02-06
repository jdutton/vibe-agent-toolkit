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
 *
 * Uses file-based output capture to avoid Bun's 64KB spawnSync buffer limit.
 * This is necessary for commands that produce large YAML outputs (e.g., audit).
 */
export function executeCli(
  binPath: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): CliResult {
  // Create temp files for stdout/stderr to avoid Bun's 64KB buffer limit
  // eslint-disable-next-line sonarjs/pseudo-random -- Test utility, not security-sensitive
  const stdoutFile = join(normalizedTmpdir(), `vat-test-stdout-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  // eslint-disable-next-line sonarjs/pseudo-random -- Test utility, not security-sensitive
  const stderrFile = join(normalizedTmpdir(), `vat-test-stderr-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

  // Open file descriptors
  const stdoutFd = fs.openSync(stdoutFile, 'w');
  const stderrFd = fs.openSync(stderrFile, 'w');

  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const result = spawnSync('node', [binPath, ...args], {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ['inherit', stdoutFd, stderrFd],
    });

    // Close file descriptors
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);

    // Read output from files
    const stdout = fs.readFileSync(stdoutFile, 'utf-8');
    const stderr = fs.readFileSync(stderrFile, 'utf-8');

    return {
      status: result.status,
      stdout,
      stderr,
    };
  } finally {
    // Cleanup temp files
    try {
      fs.unlinkSync(stdoutFile);
    } catch {
      // Ignore cleanup errors
    }
    try {
      fs.unlinkSync(stderrFile);
    } catch {
      // Ignore cleanup errors
    }
  }
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
 * Execute command and parse YAML output (convenience wrapper)
 * Alternative signature that takes cwd as third parameter
 */
export function executeCommandAndParse(
  binPath: string,
  args: string[],
  cwd: string
): { result: CliResult; parsed: Record<string, unknown> } {
  return executeAndParseYaml(binPath, args, { cwd });
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
 *
 * @returns Object with both YAML and text results for additional assertions
 */
export function assertValidationFailureWithErrorInStderr(
  binPath: string,
  projectDir: string,
  expectedErrorInStderr: string
): { yamlResult: CliResult; textResult: CliResult; parsed: Record<string, unknown> } {
  const { result, parsed } = executeValidateAndParse(binPath, projectDir);

  // Should fail due to validation error
  expect(result.status).toBe(1);
  expect(parsed.status).toBe('failed');
  expect(parsed.errorsFound).toBeGreaterThan(0);

  // Check error details in stderr (use text format)
  const textResult = executeCli(binPath, ['resources', 'validate', '--format', 'text'], { cwd: projectDir });
  expect(textResult.stderr).toContain(expectedErrorInStderr);

  return { yamlResult: result, textResult, parsed };
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
 * Set up test suite for skills install command tests
 * Creates temp directories and provides consistent setup/cleanup
 *
 * @param testPrefix - Prefix for temp directory name
 * @returns Suite object with tempDir, projectDir, skillsDir, binPath, and lifecycle methods
 */
export function setupInstallTestSuite(testPrefix: string): {
  tempDir: string;
  projectDir: string;
  skillsDir: string;
  binPath: string;
  beforeEach: () => void;
  afterEach: () => void;
} {
  const suite = {
    tempDir: '',
    projectDir: '',
    skillsDir: '',
    binPath: join(process.cwd(), 'packages', 'cli', 'dist', 'bin.js'),
    beforeEach: () => {
      suite.tempDir = createTestTempDir(testPrefix);
      suite.projectDir = join(suite.tempDir, 'project');
      suite.skillsDir = join(suite.projectDir, '.claude', 'skills');
      fs.mkdirSync(suite.skillsDir, { recursive: true });
    },
    afterEach: () => {
      if (suite.tempDir) {
        fs.rmSync(suite.tempDir, { recursive: true, force: true });
      }
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

/**
 * Wait for data to arrive on a stream with optional pattern matching
 * Replaces hardcoded setTimeout delays with event-based waiting
 *
 * @param stream - Readable stream to wait for (stdout/stderr)
 * @param options - Configuration options
 * @returns Accumulated data from stream
 *
 * @example
 * ```typescript
 * // Wait for any data (up to 2s)
 * await waitForStreamData(server.stdout, { timeout: 2000 });
 *
 * // Wait for specific JSON-RPC response
 * await waitForStreamData(server.stdout, {
 *   timeout: 2000,
 *   pattern: /"id":\s*1/
 * });
 * ```
 */
export function waitForStreamData(
  stream: NodeJS.ReadableStream,
  options: { timeout?: number; pattern?: RegExp } = {}
): Promise<string> {
  const timeout = options.timeout ?? 2000;
  const pattern = options.pattern;

  return new Promise((resolve, reject) => {
    let accumulated = '';
    let resolved = false;
    let timeoutId: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      stream.removeListener('data', onData);
    };

    const onData = (chunk: Buffer) => {
      if (resolved) return;

      accumulated += chunk.toString();

      // If pattern specified, check for match
      if (pattern?.test(accumulated)) {
        resolved = true;
        cleanup();
        resolve(accumulated);
      }
    };

    // Set up timeout
    timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();

        // If we accumulated data, resolve with it
        // If no data and pattern required, reject
        if (accumulated.length > 0 || !pattern) {
          resolve(accumulated);
        } else {
          reject(new Error(`Timeout waiting for pattern: ${String(pattern)}`));
        }
      }
    }, timeout);

    // Listen for data
    stream.on('data', onData);

    // If no pattern specified, just wait for timeout to collect data
    if (!pattern) {
      // Will resolve with whatever data arrives before timeout
    }
  });
}
