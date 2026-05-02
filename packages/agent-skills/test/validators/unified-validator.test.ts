
/* eslint-disable security/detect-non-literal-fs-filename -- Test files use controlled temp directories */
import * as fs from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { validate } from '../../src/validators/unified-validator.js';
import {
	assertSingleError,
	assertValidationSuccess,
	createAmbiguousDirectory,
	createTestMarketplace,
	createTestPlugin,
	setupTempDir,
} from '../test-helpers.js';

describe('validate (unified validator)', () => {
	const { getTempDir } = setupTempDir('unified-validator-');
	const TEST_PLUGIN_NAME = 'test-plugin';

	describe('plugin validation', () => {
		it('should route to plugin validator for plugin directory', async () => {
			const tempDir = getTempDir();
			const pluginDir = createTestPlugin(tempDir, {
				name: TEST_PLUGIN_NAME,
				description: 'Test plugin',
				version: '1.0.0',
				author: { name: 'VAT Test Suite' },
				license: 'MIT',
			});

			const result = await validate(pluginDir);

			assertValidationSuccess(result);
			expect(result.type).toBe('claude-plugin');
			expect(result.metadata?.name).toBe(TEST_PLUGIN_NAME);
		});
	});

	describe('marketplace validation', () => {
		it('should validate marketplace directory successfully', async () => {
			const tempDir = getTempDir();
			const marketplaceDir = createTestMarketplace(tempDir, {
				name: 'test-marketplace',
				owner: { name: 'Test Owner', email: 'test@example.com' },
				plugins: [{ name: TEST_PLUGIN_NAME, source: `./${TEST_PLUGIN_NAME}` }],
			});

			const result = await validate(marketplaceDir);

			expect(result.status).toBe('success');
			expect(result.type).toBe('marketplace');
			expect(result.metadata?.name).toBe('test-marketplace');
		});
	});

	describe('registry validation', () => {
		it('should route to installed plugins registry validator', async () => {
			const tempDir = getTempDir();
			const registryPath = safePath.join(tempDir, 'installed_plugins.json');
			fs.writeFileSync(
				registryPath,
				JSON.stringify(
					{
						version: 2,
						plugins: {},
					},
					null,
					2,
				),
			);

			const result = await validate(registryPath);

			assertValidationSuccess(result);
			expect(result.type).toBe('registry');
		});

		it('should route to known marketplaces registry validator', async () => {
			const tempDir = getTempDir();
			const registryPath = safePath.join(tempDir, 'known_marketplaces.json');
			// Known marketplaces registry is just a record (no version field)
			fs.writeFileSync(registryPath, JSON.stringify({}, null, 2));

			const result = await validate(registryPath);

			assertValidationSuccess(result);
			expect(result.type).toBe('registry');
		});
	});

	describe('unknown format handling', () => {
		it('should return error for non-existent path', async () => {
			const nonExistentPath = safePath.join(getTempDir(), 'does-not-exist');

			const result = await validate(nonExistentPath);

			expect(result.status).toBe('error');
			expect(result.type).toBe('unknown');
			assertSingleError(result, 'UNKNOWN_FORMAT');
			expect(result.summary).toContain('Path does not exist');
			expect(result.issues[0]?.message).toContain('Path does not exist');
		});

		it('should return error for directory without .claude-plugin', async () => {
			const tempDir = getTempDir();
			const emptyDir = safePath.join(tempDir, 'empty-dir');
			mkdirSyncReal(emptyDir, { recursive: true });

			const result = await validate(emptyDir);

			expect(result.status).toBe('error');
			expect(result.type).toBe('unknown');
			assertSingleError(result, 'UNKNOWN_FORMAT');
			expect(result.summary).toContain('no .claude-plugin subdirectory');
		});

		it('should return error for ambiguous directory (both plugin and marketplace)', async () => {
			const tempDir = getTempDir();
			const ambiguousDir = createAmbiguousDirectory(
				tempDir,
				{ name: 'test', description: 'test', version: '1.0.0' },
				{ name: 'test', owner: {}, metadata: {} },
			);

			const result = await validate(ambiguousDir);

			expect(result.status).toBe('error');
			expect(result.type).toBe('unknown');
			assertSingleError(result, 'UNKNOWN_FORMAT');
			expect(result.summary).toContain('both plugin.json and marketplace.json');
		});

		it('should return error for non-JSON file', async () => {
			const tempDir = getTempDir();
			const textFilePath = safePath.join(tempDir, 'test.txt');
			fs.writeFileSync(textFilePath, 'not a json file');

			const result = await validate(textFilePath);

			expect(result.status).toBe('error');
			expect(result.type).toBe('unknown');
			assertSingleError(result, 'UNKNOWN_FORMAT');
			expect(result.summary).toContain('Not a JSON file');
		});

		it('should return error for unrecognized JSON file', async () => {
			const tempDir = getTempDir();
			const jsonFilePath = safePath.join(tempDir, 'random.json');
			fs.writeFileSync(jsonFilePath, JSON.stringify({ foo: 'bar' }));

			const result = await validate(jsonFilePath);

			expect(result.status).toBe('error');
			expect(result.type).toBe('unknown');
			assertSingleError(result, 'UNKNOWN_FORMAT');
			expect(result.summary).toContain('not a recognized registry');
		});
	});

	describe('error handling', () => {
		it('should handle unexpected errors gracefully', async () => {
			// Test with a path that might cause unexpected errors (e.g., invalid characters)
			const invalidPath = '\0invalid';

			const result = await validate(invalidPath);

			expect(result.status).toBe('error');
			expect(result.type).toBe('unknown');
			expect(result.issues.length).toBeGreaterThan(0);
			expect(result.issues[0]?.severity).toBe('error');
		});
	});
});
