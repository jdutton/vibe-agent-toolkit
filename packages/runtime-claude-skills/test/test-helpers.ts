
/* eslint-disable security/detect-non-literal-fs-filename -- test helpers use controlled temp directories */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { mkdirSyncReal,normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, expect } from 'vitest';
import type { z } from 'zod';

import { validateSkill } from '../src/validators/skill-validator.js';
import type { ValidationResult } from '../src/validators/types.js';

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
 * Create a skill with frontmatter only (no body)
 */
export function createFrontmatter(fields: Record<string, unknown>): string {
  const yaml = Object.entries(fields)
    .map(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        return `${key}:\n${Object.entries(value)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n')}`;
      }
      return `${key}: ${value}`;
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
