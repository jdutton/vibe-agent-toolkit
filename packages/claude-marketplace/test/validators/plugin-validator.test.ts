import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
	assertSingleError,
	assertValidationSuccess,
	cleanupTestFiles,
	createTestPlugin,
	setupTempDir,
} from '../../../agent-skills/test/test-helpers.js';
import { validatePlugin } from '../../src/validators/plugin-validator.js';

const CLAUDE_PLUGIN_DIR = '.claude-plugin';

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

	it('should return error when plugin.json fails schema validation', async () => {
		const tempDir = getTempDir();
		const pluginPath = createTestPlugin(tempDir, {
			name: 'Invalid_Name_With_Uppercase', // Invalid: must be lowercase-alphanumeric-with-hyphens
		});

		const result = await validatePlugin(pluginPath);

		expect(result.status).toBe('error');
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
			author: { name: 'VAT Test Suite' },
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

		expect(result.status).toBe('error');
		expect(
			result.issues.some(
				(issue) =>
					issue.code === 'PLUGIN_INVALID_SCHEMA' &&
					issue.message.includes('lowercase'),
			),
		).toBe(true);
	});

	it('should warn when plugin.json is missing version field', async () => {
		const tempDir = getTempDir();
		const pluginPath = createTestPlugin(tempDir, {
			name: 'no-version-plugin',
			description: 'A plugin without a version',
		});

		const result = await validatePlugin(pluginPath);

		expect(result.status).toBe('warning');
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
			author: { name: 'VAT Test Suite' },
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

		expect(result.status).toBe('error');
		expect(
			result.issues.some(
				(issue) =>
					issue.code === 'PLUGIN_INVALID_SCHEMA' &&
					issue.message.includes('semver'),
			),
		).toBe(true);
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

});
