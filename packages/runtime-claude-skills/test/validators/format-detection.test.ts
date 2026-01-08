
/* eslint-disable security/detect-non-literal-fs-filename -- test helpers use controlled temp directories */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { detectResourceFormat } from '../../src/validators/format-detection.js';
import {
	createAmbiguousDirectory,
	createTestPlugin,
	setupTempDir,
} from '../test-helpers.js';

describe('detectResourceFormat', () => {
	const { getTempDir } = setupTempDir('format-detection-test-');

	const TEST_PLUGIN_NAME = 'test-plugin';
	const TEST_MARKETPLACE_NAME = 'test-marketplace';
	const CLAUDE_PLUGIN_DIR = '.claude-plugin';

	describe('Plugin detection', () => {
		it('should detect a valid plugin directory', async () => {
			const tempDir = getTempDir();
			const pluginDir = createTestPlugin(tempDir, {
				id: 'test-plugin',
				name: 'Test Plugin',
				version: '1.0.0',
				description: 'Test description',
				skills: [],
			});

			const result = await detectResourceFormat(pluginDir);

			expect(result.type).toBe('claude-plugin');
			expect(result.path).toBe(pluginDir);
		});

		it('should detect directory without .claude-plugin as unknown', async () => {
			const tempDir = getTempDir();
			const emptyDir = path.join(tempDir, 'empty');
			mkdirSyncReal(emptyDir);

			const result = await detectResourceFormat(emptyDir);

			expect(result.type).toBe('unknown');
			expect(result.path).toBe(emptyDir);
			expect(result.reason).toContain('no .claude-plugin');
		});
	});

	describe('Marketplace detection', () => {
		it('should detect a valid marketplace directory', async () => {
			const tempDir = getTempDir();
			const marketplaceDir = path.join(tempDir, TEST_MARKETPLACE_NAME);
			const claudePluginDir = path.join(marketplaceDir, CLAUDE_PLUGIN_DIR);
			mkdirSyncReal(claudePluginDir, { recursive: true });

			const marketplaceData = {
				id: TEST_MARKETPLACE_NAME,
				name: 'Test Marketplace',
				version: '1.0.0',
				description: 'Test marketplace',
				plugins: [],
			};
			fs.writeFileSync(
				path.join(claudePluginDir, 'marketplace.json'),
				JSON.stringify(marketplaceData, null, 2),
			);

			const result = await detectResourceFormat(marketplaceDir);

			expect(result.type).toBe('marketplace');
			expect(result.path).toBe(marketplaceDir);
		});
	});

	describe('Ambiguous detection', () => {
		it('should detect co-located plugin as marketplace (valid pattern)', async () => {
			const tempDir = getTempDir();
			const colocatedDir = path.join(tempDir, 'colocated-marketplace');
			const claudePluginDir = path.join(colocatedDir, CLAUDE_PLUGIN_DIR);
			mkdirSyncReal(claudePluginDir, { recursive: true });

			// Create plugin.json
			const pluginData = {
				name: TEST_PLUGIN_NAME,
				description: 'A test plugin',
				version: '1.0.0',
			};
			fs.writeFileSync(
				path.join(claudePluginDir, 'plugin.json'),
				JSON.stringify(pluginData, null, 2),
			);

			// Create marketplace.json with co-located plugin (source: "./")
			const marketplaceData = {
				name: TEST_MARKETPLACE_NAME,
				owner: { name: 'Test' },
				metadata: { description: 'Test', version: '1.0.0' },
				plugins: [
					{
						name: TEST_PLUGIN_NAME,
						description: 'A test plugin',
						source: './', // Co-located plugin
					},
				],
			};
			fs.writeFileSync(
				path.join(claudePluginDir, 'marketplace.json'),
				JSON.stringify(marketplaceData, null, 2),
			);

			const result = await detectResourceFormat(colocatedDir);

			expect(result.type).toBe('marketplace');
			expect(result.path).toBe(colocatedDir);
		});

		it('should return unknown when directory has both plugin.json and marketplace.json (not co-located)', async () => {
			const tempDir = getTempDir();
			const ambiguousDir = createAmbiguousDirectory(
				tempDir,
				{ id: 'test' },
				{ id: 'test' },
			);


			const result = await detectResourceFormat(ambiguousDir);

			expect(result.type).toBe('unknown');
			expect(result.path).toBe(ambiguousDir);
			expect(result.reason).toContain('both plugin.json and marketplace.json');
		});
	});

	describe('Registry detection', () => {
		it('should detect installed_plugins.json as installed-plugins-registry', async () => {
			const tempDir = getTempDir();
			const registryPath = path.join(tempDir, 'installed_plugins.json');
			fs.writeFileSync(registryPath, JSON.stringify({ plugins: [] }, null, 2));

			const result = await detectResourceFormat(registryPath);

			expect(result.type).toBe('installed-plugins-registry');
			expect(result.path).toBe(registryPath);
			if (result.type === 'installed-plugins-registry') {
				expect(result.filename).toBe('installed_plugins.json');
			}
		});

		it('should detect known_marketplaces.json as known-marketplaces-registry', async () => {
			const tempDir = getTempDir();
			const registryPath = path.join(tempDir, 'known_marketplaces.json');
			fs.writeFileSync(
				registryPath,
				JSON.stringify({ marketplaces: [] }, null, 2),
			);

			const result = await detectResourceFormat(registryPath);

			expect(result.type).toBe('known-marketplaces-registry');
			expect(result.path).toBe(registryPath);
			if (result.type === 'known-marketplaces-registry') {
				expect(result.filename).toBe('known_marketplaces.json');
			}
		});

		it('should return unknown for JSON file that is not a recognized registry', async () => {
			const tempDir = getTempDir();
			const jsonPath = path.join(tempDir, 'random.json');
			fs.writeFileSync(jsonPath, JSON.stringify({ foo: 'bar' }, null, 2));

			const result = await detectResourceFormat(jsonPath);

			expect(result.type).toBe('unknown');
			expect(result.path).toBe(jsonPath);
			expect(result.reason).toContain('not a recognized registry');
		});

		it('should return unknown for file without .json extension', async () => {
			const tempDir = getTempDir();
			const txtPath = path.join(tempDir, 'installed_plugins.txt');
			fs.writeFileSync(txtPath, 'not json');

			const result = await detectResourceFormat(txtPath);

			expect(result.type).toBe('unknown');
			expect(result.path).toBe(txtPath);
			expect(result.reason).toContain('Not a JSON file');
		});

		it('should be case-sensitive for registry filenames', async () => {
			const tempDir = getTempDir();
			const registryPath = path.join(tempDir, 'Installed_Plugins.json');
			fs.writeFileSync(registryPath, JSON.stringify({ plugins: [] }, null, 2));

			const result = await detectResourceFormat(registryPath);

			expect(result.type).toBe('unknown');
			expect(result.path).toBe(registryPath);
			expect(result.reason).toContain('not a recognized registry');
		});
	});

	describe('Error handling', () => {
		it('should return unknown for non-existent path', async () => {
			const nonExistentPath = path.join(getTempDir(), 'does-not-exist');

			const result = await detectResourceFormat(nonExistentPath);

			expect(result.type).toBe('unknown');
			expect(result.path).toBe(nonExistentPath);
			expect(result.reason).toContain('does not exist');
		});

		it('should handle permission errors gracefully', async () => {
			// This test is platform-specific and may not work on all systems
			// Skipping on Windows where permission errors are harder to simulate
			if (process.platform === 'win32') {
				return;
			}

			const tempDir = getTempDir();
			const restrictedDir = path.join(tempDir, 'restricted');
			mkdirSyncReal(restrictedDir);
			fs.chmodSync(restrictedDir, 0o000);

			try {
				const result = await detectResourceFormat(restrictedDir);

				expect(result.type).toBe('unknown');
				expect(result.path).toBe(restrictedDir);
				expect(result.reason).toBeDefined();
			} finally {
				// Restore permissions for cleanup
				// eslint-disable-next-line sonarjs/file-permissions -- restoring permissions after test
				fs.chmodSync(restrictedDir, 0o755);
			}
		});
	});
});
