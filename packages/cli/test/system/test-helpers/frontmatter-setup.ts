/* eslint-disable security/detect-non-literal-fs-filename */
// Test helpers legitimately use dynamic paths

/**
 * Frontmatter validation test setup helpers for system tests
 */

import * as fs from 'node:fs';
import { join } from 'node:path';

import * as yaml from 'js-yaml';

import type { CliResult } from './cli-runner.js';
import { executeCli } from './cli-runner.js';

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
