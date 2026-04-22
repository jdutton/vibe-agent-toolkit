
/* eslint-disable security/detect-non-literal-fs-filename -- test helpers use controlled temp directories */
import * as fs from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { detectResourceFormat, enumerateSurfaces } from '../../src/validators/format-detection.js';
import {
	createAmbiguousDirectory,
	createTestPlugin,
	setupTempDir,
} from '../test-helpers.js';

const SURFACE_TYPE_CLAUDE_PLUGIN = 'claude-plugin';
const SURFACE_TYPE_AGENT_SKILL = 'agent-skill';

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

			expect(result.type).toBe(SURFACE_TYPE_CLAUDE_PLUGIN);
			expect(result.path).toBe(pluginDir);
		});

		it('should detect directory without .claude-plugin as unknown', async () => {
			const tempDir = getTempDir();
			const emptyDir = safePath.join(tempDir, 'empty');
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
			const marketplaceDir = safePath.join(tempDir, TEST_MARKETPLACE_NAME);
			const claudePluginDir = safePath.join(marketplaceDir, CLAUDE_PLUGIN_DIR);
			mkdirSyncReal(claudePluginDir, { recursive: true });

			const marketplaceData = {
				id: TEST_MARKETPLACE_NAME,
				name: 'Test Marketplace',
				version: '1.0.0',
				description: 'Test marketplace',
				plugins: [],
			};
			fs.writeFileSync(
				safePath.join(claudePluginDir, 'marketplace.json'),
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
			const colocatedDir = safePath.join(tempDir, 'colocated-marketplace');
			const claudePluginDir = safePath.join(colocatedDir, CLAUDE_PLUGIN_DIR);
			mkdirSyncReal(claudePluginDir, { recursive: true });

			// Create plugin.json
			const pluginData = {
				name: TEST_PLUGIN_NAME,
				description: 'A test plugin',
				version: '1.0.0',
			};
			fs.writeFileSync(
				safePath.join(claudePluginDir, 'plugin.json'),
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
				safePath.join(claudePluginDir, 'marketplace.json'),
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
			const registryPath = safePath.join(tempDir, 'installed_plugins.json');
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
			const registryPath = safePath.join(tempDir, 'known_marketplaces.json');
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
			const jsonPath = safePath.join(tempDir, 'random.json');
			fs.writeFileSync(jsonPath, JSON.stringify({ foo: 'bar' }, null, 2));

			const result = await detectResourceFormat(jsonPath);

			expect(result.type).toBe('unknown');
			expect(result.path).toBe(jsonPath);
			expect(result.reason).toContain('not a recognized registry');
		});

		it('should return unknown for file without .json extension', async () => {
			const tempDir = getTempDir();
			const txtPath = safePath.join(tempDir, 'installed_plugins.txt');
			fs.writeFileSync(txtPath, 'not json');

			const result = await detectResourceFormat(txtPath);

			expect(result.type).toBe('unknown');
			expect(result.path).toBe(txtPath);
			expect(result.reason).toContain('Not a JSON file');
		});

		it('should be case-sensitive for registry filenames', async () => {
			const tempDir = getTempDir();
			const registryPath = safePath.join(tempDir, 'Installed_Plugins.json');
			fs.writeFileSync(registryPath, JSON.stringify({ plugins: [] }, null, 2));

			const result = await detectResourceFormat(registryPath);

			expect(result.type).toBe('unknown');
			expect(result.path).toBe(registryPath);
			expect(result.reason).toContain('not a recognized registry');
		});
	});

	describe('Error handling', () => {
		it('should return unknown for non-existent path', async () => {
			const nonExistentPath = safePath.join(getTempDir(), 'does-not-exist');

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
			const restrictedDir = safePath.join(tempDir, 'restricted');
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

describe('enumerateSurfaces', () => {
	const fixturesBase = safePath.join(
		import.meta.dirname,
		'..',
		'fixtures',
		'packaging-shapes',
	);

	it('returns a single agent-skill surface for a standalone skill', async () => {
		const dir = safePath.join(fixturesBase, 'standalone-skill');
		const surfaces = await enumerateSurfaces(dir);
		expect(surfaces).toHaveLength(1);
		expect(surfaces[0]).toEqual({
			type: SURFACE_TYPE_AGENT_SKILL,
			path: safePath.join(dir, 'SKILL.md'),
		});
	});

	it('returns both agent-skill and claude-plugin for a skill-claude-plugin', async () => {
		const dir = safePath.join(fixturesBase, 'skill-claude-plugin-matching');
		const surfaces = await enumerateSurfaces(dir);
		expect(surfaces).toHaveLength(2);
		expect(surfaces).toContainEqual({
			type: SURFACE_TYPE_AGENT_SKILL,
			path: safePath.join(dir, 'SKILL.md'),
		});
		expect(surfaces).toContainEqual({ type: SURFACE_TYPE_CLAUDE_PLUGIN, path: dir });
	});

	it('returns only claude-plugin for a canonical plugin layout (no root SKILL.md)', async () => {
		const dir = safePath.join(fixturesBase, 'canonical-plugin');
		const surfaces = await enumerateSurfaces(dir);
		expect(surfaces).toHaveLength(1);
		expect(surfaces[0]).toEqual({ type: SURFACE_TYPE_CLAUDE_PLUGIN, path: dir });
	});

	it('returns only marketplace when only marketplace.json is present', async () => {
		const dir = safePath.join(fixturesBase, 'marketplace-only');
		const surfaces = await enumerateSurfaces(dir);
		expect(surfaces).toHaveLength(1);
		expect(surfaces[0]).toEqual({ type: 'marketplace', path: dir });
	});

	it('returns an empty array for an empty directory', async () => {
		const dir = safePath.join(fixturesBase, 'empty-dir');
		const surfaces = await enumerateSurfaces(dir);
		expect(surfaces).toEqual([]);
	});

	it('returns an empty array for a nonexistent path', async () => {
		const dir = safePath.join(fixturesBase, 'does-not-exist');
		const surfaces = await enumerateSurfaces(dir);
		expect(surfaces).toEqual([]);
	});

	it('returns an empty array for a file (not a directory)', async () => {
		const file = safePath.join(fixturesBase, 'standalone-skill', 'SKILL.md');
		const surfaces = await enumerateSurfaces(file);
		expect(surfaces).toEqual([]);
	});

	it('collapses co-located plugin+marketplace to a single marketplace surface', async () => {
		// Mirrors detectResourceFormat's co-located collapse — a marketplace that
		// declares `source: "./"` for its plugin SHOULD NOT produce a parallel
		// claude-plugin surface.
		const dir = safePath.join(fixturesBase, 'colocated-plugin-marketplace');
		const surfaces = await enumerateSurfaces(dir);
		expect(surfaces).toHaveLength(1);
		expect(surfaces[0]).toEqual({ type: 'marketplace', path: dir });
	});

	it('returns all three surfaces in enumerator-stable order when none collapse', async () => {
		// Non-co-located marketplace + plugin + SKILL.md: audit is expected to
		// emit three independent results; this test documents the ordering
		// contract (skill, plugin, marketplace).
		const dir = safePath.join(fixturesBase, 'three-surface');
		const surfaces = await enumerateSurfaces(dir);
		expect(surfaces).toHaveLength(3);
		expect(surfaces.map((s) => s.type)).toEqual([
			SURFACE_TYPE_AGENT_SKILL,
			SURFACE_TYPE_CLAUDE_PLUGIN,
			'marketplace',
		]);
	});
});
