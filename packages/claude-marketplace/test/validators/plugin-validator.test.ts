import fs from 'node:fs';

import type { ValidationResult } from '@vibe-agent-toolkit/agent-skills';
import { countBySeverity } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
	assertSingleError,
	assertSingleUnreadable,
	assertValidationSuccess,
	cleanupTestFiles,
	createTestPlugin,
	setupTempDir,
} from '../../../agent-skills/test/test-helpers.js';
import { validatePlugin } from '../../src/validators/plugin-validator.js';

const CLAUDE_PLUGIN_DIR = '.claude-plugin';
const TEST_AUTHOR_NAME = 'VAT Test Suite';

/** An error-counted result carrying a PLUGIN_INVALID_SCHEMA issue whose message names `fragment`. */
function expectSchemaErrorMentioning(result: ValidationResult, fragment: string): void {
	expect(result.summary.errors).toBeGreaterThan(0);
	expect(
		result.issues.some((issue) => issue.code === 'PLUGIN_INVALID_SCHEMA' && issue.message.includes(fragment)),
	).toBe(true);
}

describe('validatePlugin', () => {
	const { getTempDir } = setupTempDir('plugin-validator-test-');

	afterEach(() => {
		cleanupTestFiles();
	});

	it('should validate a simple plugin directory successfully', async () => {
		const pluginPath = safePath.resolve(
			__dirname,
			'../../../agent-skills/test/fixtures/plugins/valid-simple-plugin',
		);

		const result = await validatePlugin(pluginPath);

		assertValidationSuccess(result);
		expect(result.path).toBe(pluginPath);
		expect(result.type).toBe('claude-plugin');
	});

	it('should return error when plugin.json is missing', async () => {
		const tempDir = getTempDir();
		const pluginPath = safePath.resolve(tempDir, 'missing-manifest');

		const result = await validatePlugin(pluginPath);

		assertSingleError(result, 'PLUGIN_MISSING_MANIFEST');
	});

	it('should return error when plugin.json has invalid JSON syntax', async () => {
		const tempDir = getTempDir();
		const pluginPath = createTestPlugin(tempDir, { invalid: 'json' });

		// Overwrite with invalid JSON
		const fs = await import('node:fs');
		fs.writeFileSync(
			safePath.join(pluginPath, CLAUDE_PLUGIN_DIR, 'plugin.json'),
			'{ invalid json }',
		);

		const result = await validatePlugin(pluginPath);

		assertSingleError(result, 'PLUGIN_INVALID_JSON');
	});

	it('reports a plugin.json the OS will not read as unreadable, not as invalid JSON', async () => {
		const pluginPath = createTestPlugin(getTempDir(), { name: 'unreadable-manifest' });
		const manifest = safePath.join(pluginPath, CLAUDE_PLUGIN_DIR, 'plugin.json');
		fs.rmSync(manifest);
		fs.mkdirSync(manifest);

		const result = await validatePlugin(pluginPath);

		assertSingleUnreadable(result, `${CLAUDE_PLUGIN_DIR}/plugin.json`, 'EISDIR');
	});

	it('should return error when plugin.json fails schema validation', async () => {
		const tempDir = getTempDir();
		const pluginPath = createTestPlugin(tempDir, {
			name: 'Invalid_Name_With_Uppercase', // Invalid: must be lowercase-alphanumeric-with-hyphens
		});

		const result = await validatePlugin(pluginPath);

		expect(result.summary.errors).toBeGreaterThan(0);
		expect(result.issues.length).toBeGreaterThan(0);
		// Schema error is the blocker; PLUGIN_NAME_NOT_KEBAB_CASE may also fire.
		expect(
			result.issues.some((issue) => issue.code === 'PLUGIN_INVALID_SCHEMA'),
		).toBe(true);
	});

	it('should return success with metadata for valid plugin', async () => {
		const tempDir = getTempDir();
		const pluginPath = createTestPlugin(tempDir, {
			name: 'my-test-plugin',
			description: 'A test plugin for validation',
			version: '2.3.4',
			author: { name: TEST_AUTHOR_NAME },
			license: 'MIT',
		});

		const result = await validatePlugin(pluginPath);

		assertValidationSuccess(result);
		expect(result.metadata?.name).toBe('my-test-plugin');
		expect(result.metadata?.version).toBe('2.3.4');
	});

	it('should validate plugin name format', async () => {
		const tempDir = getTempDir();
		const pluginPath = createTestPlugin(tempDir, {
			name: 'Invalid_Name',
			description: 'Test plugin',
			version: '1.0.0',
		});

		const result = await validatePlugin(pluginPath);

		expectSchemaErrorMentioning(result, 'lowercase');
	});

	it('should warn when plugin.json is missing version field', async () => {
		const tempDir = getTempDir();
		const pluginPath = createTestPlugin(tempDir, {
			name: 'no-version-plugin',
			description: 'A plugin without a version',
		});

		const result = await validatePlugin(pluginPath);

		expect(result.summary).toMatchObject({ errors: 0 });
		expect(result.summary.warnings).toBeGreaterThan(0);
		expect(result.metadata?.name).toBe('no-version-plugin');
		const versionIssue = result.issues.find(i => i.code === 'PLUGIN_MISSING_VERSION');
		expect(versionIssue).toBeDefined();
		expect(versionIssue?.severity).toBe('warning');
		expect(versionIssue?.message).toContain('unknown');
	});

	it('should accept pre-release version format', async () => {
		const tempDir = getTempDir();
		const pluginPath = createTestPlugin(tempDir, {
			name: 'rc-plugin',
			description: 'A plugin with pre-release version',
			version: '1.0.0-rc.3',
			author: { name: TEST_AUTHOR_NAME },
			license: 'MIT',
		});

		const result = await validatePlugin(pluginPath);

		assertValidationSuccess(result);
		expect(result.metadata?.version).toBe('1.0.0-rc.3');
	});

	it('should validate semver version format', async () => {
		const tempDir = getTempDir();
		const pluginPath = createTestPlugin(tempDir, {
			name: 'test-plugin',
			description: 'Test plugin',
			version: 'v1.0', // Invalid semver
		});

		const result = await validatePlugin(pluginPath);

		expectSchemaErrorMentioning(result, 'semver');
	});

	it('emits PLUGIN_NAME_NOT_KEBAB_CASE alongside schema error for invalid names', async () => {
		const tempDir = getTempDir();
		const pluginPath = createTestPlugin(tempDir, {
			name: 'Invalid_Name',
			description: 'x',
			version: '1.0.0',
		});
		const result = await validatePlugin(pluginPath);
		const codes = result.issues.map((i) => i.code);
		expect(codes).toContain('PLUGIN_NAME_NOT_KEBAB_CASE');
		expect(codes).toContain('PLUGIN_INVALID_SCHEMA');
		const kebabIssue = result.issues.find((i) => i.code === 'PLUGIN_NAME_NOT_KEBAB_CASE');
		expect(kebabIssue?.severity).toBe('info');
	});

	it('emits PLUGIN_MISSING_DESCRIPTION/AUTHOR/LICENSE at info severity when fields absent', async () => {
		const tempDir = getTempDir();
		const pluginPath = createTestPlugin(tempDir, {
			name: 'minimal-plugin',
			version: '1.0.0',
		});
		const result = await validatePlugin(pluginPath);
		const codes = result.issues.map((i) => i.code).sort((a, b) => a.localeCompare(b));
		expect(codes).toContain('PLUGIN_MISSING_DESCRIPTION');
		expect(codes).toContain('PLUGIN_MISSING_AUTHOR');
		expect(codes).toContain('PLUGIN_MISSING_LICENSE');
		for (const code of [
			'PLUGIN_MISSING_DESCRIPTION',
			'PLUGIN_MISSING_AUTHOR',
			'PLUGIN_MISSING_LICENSE',
		] as const) {
			const issue = result.issues.find((i) => i.code === code);
			expect(issue?.severity).toBe('info');
		}
	});

	describe('summary counts agree with the issues actually reported', () => {
		it('counts post-schema warning + info findings (not zeros)', async () => {
			const tempDir = getTempDir();
			// No version -> 1 warning; no description/author/license -> 3 info.
			const pluginPath = createTestPlugin(tempDir, { name: 'counts-plugin' });

			const result = await validatePlugin(pluginPath);

			expect(result.issues).toHaveLength(4);
			expect(result.summary).toEqual({ errors: 0, warnings: 1, info: 3 });
			expect(result.summary).toEqual(countBySeverity(result.issues));
			expect(result.status).toBe('findings');
			// The one describeIssues sentence: the counts, never a second wording.
			expect(result.description).toBe('0 errors, 1 warnings, 3 info');
		});

		it('counts post-schema error + info findings under --strict', async () => {
			const tempDir = getTempDir();
			// strict raises the missing-version finding to error severity.
			const pluginPath = createTestPlugin(tempDir, { name: 'counts-strict-plugin' });

			const result = await validatePlugin(pluginPath, { strict: true });

			expect(result.issues).toHaveLength(4);
			expect(result.summary).toEqual({ errors: 1, warnings: 0, info: 3 });
			expect(result.summary).toEqual(countBySeverity(result.issues));
			expect(result.summary.errors).toBeGreaterThan(0);
		});

		// Positive control: distinguishes "correctly zero" from "never populated".
		it('reports zeros ONLY when the findings list is genuinely empty', async () => {
			const tempDir = getTempDir();
			const pluginPath = createTestPlugin(tempDir, {
				name: 'complete-plugin',
				description: 'A plugin with every recommended field present',
				version: '1.0.0',
				author: { name: TEST_AUTHOR_NAME },
				license: 'MIT',
			});

			const result = await validatePlugin(pluginPath);

			expect(result.issues).toHaveLength(0);
			expect(result.summary).toEqual({ errors: 0, warnings: 0, info: 0 });
			expect(result.status).toBe('ok');
			expect(result.description).toBe('Valid plugin');
		});

		it('counts schema errors on the failure path', async () => {
			const tempDir = getTempDir();
			const pluginPath = createTestPlugin(tempDir, {
				name: 'Invalid_Name',
				description: 'x',
				version: '1.0.0',
			});

			const result = await validatePlugin(pluginPath);

			expect(result.summary).toEqual(countBySeverity(result.issues));
			expect(result.summary.errors).toBeGreaterThan(0);
			// The kebab-case observation rides along at info severity.
			expect(result.summary.info).toBe(1);
		});
	});

	// `bin/` is a documented, supported Claude Code feature; the hosted-sync
	// rejection behind PLUGIN_TOPLEVEL_BIN_DIR is a single undocumented
	// observation. Until that changes it must stay advisory — never a
	// build-blocking error, not even on the strict publish path.
	it('reports a top-level bin/ directory as a warning, even under strict', async () => {
		const tempDir = getTempDir();
		const pluginPath = createTestPlugin(
			tempDir,
			{ name: 'bin-plugin', version: '1.0.0' },
			'bin-plugin',
		);
		mkdirSyncReal(safePath.join(pluginPath, 'bin'), { recursive: true });
		fs.writeFileSync(safePath.join(pluginPath, 'bin', 'tool.mjs'), 'export {};');

		const result = await validatePlugin(pluginPath, { strict: true });

		const issue = result.issues.find((i) => i.code === 'PLUGIN_TOPLEVEL_BIN_DIR');
		expect(issue?.severity).toBe('warning');
		expect(result.issues.some((i) => i.severity === 'error')).toBe(false);
		// The anchor contract: `location` is relative to the anchor root (the
		// plugin directory when no `locationRoot` is given), never absolute.
		expect(issue?.location).toBe('bin');
	});

});
