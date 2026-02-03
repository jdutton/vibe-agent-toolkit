
/* eslint-disable security/detect-non-literal-fs-filename -- test helpers use controlled temp directories */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { mkdirSyncReal,normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, expect } from 'vitest';
import type { z } from 'zod';

import { validateSkill } from '../src/validators/skill-validator.js';
import type { LinkedFileValidationResult, ValidationResult } from '../src/validators/types.js';

/**
 * Setup temporary directory for tests
 * Automatically creates and cleans up temp dir before/after each test
 */
export function setupTempDir(prefix: string): { getTempDir: () => string } {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(normalizedTmpdir(), prefix));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return {
    getTempDir: () => tempDir,
  };
}

/**
 * Create a SKILL.md file with given content and validate it
 */
export async function createSkillAndValidate(
  tempDir: string,
  content: string,
): Promise<ValidationResult> {
  const skillPath = path.join(tempDir, 'SKILL.md');
  fs.writeFileSync(skillPath, content);
  return validateSkill({ skillPath });
}

/**
 * Create a transitive skill structure with linked markdown files
 *
 * @param tempDir - Base directory for skill
 * @param files - Map of relative paths to file contents
 * @param skillBody - Body content for SKILL.md (will auto-generate frontmatter)
 * @returns Object with paths to created files
 */
export function createTransitiveSkillStructure(
  tempDir: string,
  files: Record<string, string>,
  skillBody: string,
): { skillPath: string; filePaths: Record<string, string> } {
  // Create directories and files
  const filePaths: Record<string, string> = {};

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(tempDir, relativePath);
    const dir = path.dirname(fullPath);

    if (dir !== tempDir) {
      mkdirSyncReal(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content);
    filePaths[relativePath] = fullPath;
  }

  // Create SKILL.md
  const skillPath = path.join(tempDir, 'SKILL.md');
  fs.writeFileSync(skillPath, skillBody);

  return { skillPath, filePaths };
}

/**
 * Validate a skill with transitive link validation enabled
 *
 * @param skillPath - Path to SKILL.md
 * @param rootDir - Root directory for resolving links
 * @returns Validation result
 */
export async function validateSkillWithTransitiveChecking(
  skillPath: string,
  rootDir?: string,
): Promise<ValidationResult> {
  return validateSkill({
    skillPath,
    rootDir: rootDir ?? path.dirname(skillPath),
  });
}

/**
 * Validate a skill with unreferenced file detection enabled
 *
 * @param skillPath - Path to SKILL.md
 * @param rootDir - Root directory for scanning files
 * @returns Validation result
 */
export async function validateSkillWithUnreferencedFileCheck(
  skillPath: string,
  rootDir: string,
): Promise<ValidationResult> {
  return validateSkill({
    skillPath,
    rootDir,
    checkUnreferencedFiles: true,
  });
}

/**
 * Create and validate a transitive skill structure (convenience method)
 *
 * @param tempDir - Base directory for skill
 * @param files - Map of relative paths to file contents
 * @param skillBody - Body content for SKILL.md
 * @returns Validation result and file paths
 */
export async function createAndValidateTransitiveSkill(
  tempDir: string,
  files: Record<string, string>,
  skillBody: string,
): Promise<{ result: ValidationResult; skillPath: string; filePaths: Record<string, string> }> {
  const { skillPath, filePaths } = createTransitiveSkillStructure(tempDir, files, skillBody);
  const result = await validateSkillWithTransitiveChecking(skillPath, tempDir);
  return { result, skillPath, filePaths };
}

/**
 * Create and validate a simple single-resource skill structure
 * All of these tests follow the pattern: SKILL.md → resources/core.md
 *
 * @param tempDir - Base directory for skill
 * @param coreContent - Content for resources/core.md
 * @param skillName - Skill name (defaults to TEST_SKILL_NAME from tests)
 * @param skillDesc - Skill description (defaults to TEST_SKILL_DESC from tests)
 * @returns Validation result, first linked file result, and file paths
 */
export async function createAndValidateSingleResourceSkill(
  tempDir: string,
  coreContent: string,
  additionalFiles: Record<string, string> = {},
  skillName = 'test-skill',
  skillDesc = 'Test skill',
): Promise<{
  result: ValidationResult;
  coreResult: LinkedFileValidationResult | undefined;
  filePaths: Record<string, string>;
}> {
  const files = {
    'resources/core.md': coreContent,
    ...additionalFiles,
  };

  const skillBody = createSkillContent(
    { name: skillName, description: skillDesc },
    `\n# Test Skill\n\nSee [core](./resources/core.md).`,
  );

  const { result, filePaths } = await createAndValidateTransitiveSkill(tempDir, files, skillBody);

  return {
    result,
    coreResult: result.linkedFiles?.[0],
    filePaths,
  };
}

/**
 * Create a skill with frontmatter only (no body)
 */
export function createFrontmatter(fields: Record<string, unknown>): string {
  const yaml = Object.entries(fields)
    .map(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        return `${key}:\n${Object.entries(value)
          .map(([k, v]) => `  ${k}: ${String(v)}`)
          .join('\n')}`;
      }
      return `${key}: ${String(value)}`;
    })
    .join('\n');

  return `---\n${yaml}\n---`;
}

/**
 * Create a complete skill file (frontmatter + body)
 */
export function createSkillContent(
  frontmatter: Record<string, unknown>,
  body = '\n# My Skill',
): string {
  return `${createFrontmatter(frontmatter)}\n${body}`;
}

/**
 * Assert that validation result has specific error code
 */
export function expectError(result: ValidationResult, code: string): void {
  const issue = result.issues.find((i) => i.code === code);
  if (!issue) {
    throw new Error(
      `Expected error code '${code}' but found: ${result.issues.map((i) => i.code).join(', ')}`,
    );
  }
}

/**
 * Assert that validation result has specific warning code
 */
export function expectWarning(result: ValidationResult, code: string): void {
  const issue = result.issues.find((i) => i.code === code && i.severity === 'warning');
  if (!issue) {
    throw new Error(
      `Expected warning code '${code}' but found: ${result.issues.filter((i) => i.severity === 'warning').map((i) => i.code).join(', ')}`,
    );
  }
}

/**
 * Create a SKILL.md file with given content (for integration tests)
 */
export function createSkillFile(tempDir: string, content: string): string {
  const skillPath = path.join(tempDir, 'SKILL.md');
  fs.writeFileSync(skillPath, content);
  return skillPath;
}

// ============================================================================
// Schema Testing Helpers
// ============================================================================

/**
 * Load a registry fixture file from test/fixtures/registries/
 */
export function loadRegistryFixture(name: string): unknown {
	const fixturePath = path.resolve(__dirname, 'fixtures/registries', name);
	return JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
}

/**
 * List to track temporary files created during tests
 */
const tempFiles: string[] = [];

/**
 * Clean up all temporary test files
 * Call this in afterEach() hooks
 */
export function cleanupTestFiles(): void {
	for (const file of tempFiles) {
		try {
			fs.unlinkSync(file);
		} catch {
			// Ignore errors - file may not exist
		}
	}
	tempFiles.length = 0;
}

/**
 * Assert that a Zod schema validation fails with expected error
 *
 * @param schema - Zod schema to validate against
 * @param data - Invalid data to test
 * @param expectedPath - Expected error path (field name)
 * @param expectedMessage - Expected error message substring
 */
export function assertValidationError<T extends z.ZodTypeAny>(
	schema: T,
	data: unknown,
	expectedPath: string,
	expectedMessage: string,
): void {
	const result = schema.safeParse(data);

	expect(result.success).toBe(false);

	if (!result.success) {
		// Find error matching expected path
		const pathError = result.error.issues.find((issue) =>
			issue.path.join('.').includes(expectedPath),
		);

		expect(pathError).toBeDefined();
		expect(pathError?.message).toContain(expectedMessage);
	}
}

// ============================================================================
// Plugin Testing Helpers
// ============================================================================

/**
 * Assert that validation result is successful (no errors)
 */
export function assertValidationSuccess(result: ValidationResult): void {
	expect(result.status).toBe('success');
	expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
}

/**
 * Assert that validation result has a single error with specified code
 */
export function assertSingleError(
	result: ValidationResult,
	code: string,
): void {
	expect(result.status).toBe('error');
	expect(result.issues).toHaveLength(1);
	expect(result.issues[0]?.code).toBe(code);
	expect(result.issues[0]?.severity).toBe('error');
}

const CLAUDE_PLUGIN_DIR = '.claude-plugin';

/**
 * Create a test plugin directory structure
 * Returns the path to the created plugin directory
 */
export function createTestPlugin(
	baseDir: string,
	pluginData: Record<string, unknown>,
	pluginName = 'test-plugin',
): string {
	const pluginDir = path.join(baseDir, pluginName);
	const claudePluginDir = path.join(pluginDir, CLAUDE_PLUGIN_DIR);

	mkdirSyncReal(claudePluginDir, { recursive: true });

	const pluginJsonPath = path.join(claudePluginDir, 'plugin.json');
	fs.writeFileSync(pluginJsonPath, JSON.stringify(pluginData, null, 2));

	return pluginDir;
}

/**
 * Create a test marketplace directory structure
 * Returns the path to the created marketplace directory
 */
export function createTestMarketplace(
	baseDir: string,
	marketplaceData: Record<string, unknown>,
	marketplaceName = 'test-marketplace',
): string {
	const marketplaceDir = path.join(baseDir, marketplaceName);
	const claudePluginDir = path.join(marketplaceDir, CLAUDE_PLUGIN_DIR);

	mkdirSyncReal(claudePluginDir, { recursive: true });

	const marketplaceJsonPath = path.join(claudePluginDir, 'marketplace.json');
	fs.writeFileSync(
		marketplaceJsonPath,
		JSON.stringify(marketplaceData, null, 2),
	);

	return marketplaceDir;
}

/**
 * Create an ambiguous directory with both plugin.json and marketplace.json
 * Returns the path to the created directory
 */
export function createAmbiguousDirectory(
	baseDir: string,
	pluginData: Record<string, unknown>,
	marketplaceData: Record<string, unknown>,
	dirName = 'ambiguous',
): string {
	const ambiguousDir = path.join(baseDir, dirName);
	const claudePluginDir = path.join(ambiguousDir, CLAUDE_PLUGIN_DIR);
	mkdirSyncReal(claudePluginDir, { recursive: true });

	// Create both plugin.json and marketplace.json
	fs.writeFileSync(
		path.join(claudePluginDir, 'plugin.json'),
		JSON.stringify(pluginData, null, 2),
	);
	fs.writeFileSync(
		path.join(claudePluginDir, 'marketplace.json'),
		JSON.stringify(marketplaceData, null, 2),
	);

	return ambiguousDir;
}
