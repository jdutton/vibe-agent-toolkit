/* eslint-disable security/detect-non-literal-fs-filename */
// Test helpers legitimately use dynamic paths

/**
 * Test helpers for system tests
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

import * as yaml from 'js-yaml';

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
  fs.mkdirSync(projectDir);
  return projectDir;
}

/**
 * Setup a project with .git and optional config
 */
export function setupProjectRoot(projectDir: string, config?: string): void {
  // Create .git to mark as project root
  fs.mkdirSync(join(projectDir, '.git'));

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
    fs.mkdirSync(docsDir, { recursive: true });
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
    fs.mkdirSync(join(projectDir, 'docs'));
  }

  return projectDir;
}

/**
 * Create a temporary directory for tests
 */
export function createTestTempDir(prefix: string): string {
  return fs.mkdtempSync(join(os.tmpdir(), prefix));
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
  const { spawnSync } = require('node:child_process');
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

  const { spawnSync } = require('node:child_process');
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
