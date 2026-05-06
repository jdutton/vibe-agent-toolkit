import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractClaudeInstallInventory } from '../../src/inventory/extract-install.js';
import { buildClaudeUserPaths } from '../../src/paths/claude-paths.js';

const FIXTURE_BASE = safePath.resolve(__dirname, '../fixtures/inventory-install');
const FAKE_INSTALL = safePath.join(FIXTURE_BASE, 'fake-install');

describe('extractClaudeInstallInventory', () => {
	describe('fake-install fixture', () => {
		it('returns correct kind and vendor', async () => {
			const inv = await extractClaudeInstallInventory(FAKE_INSTALL);

			expect(inv.kind).toBe('install');
			expect(inv.vendor).toBe('claude-code');
		});

		it('sets installRoot to the resolved fixture path', async () => {
			const inv = await extractClaudeInstallInventory(FAKE_INSTALL);

			expect(inv.installRoot).toBe(safePath.resolve(FAKE_INSTALL));
		});

		it('discovers the demo marketplace', async () => {
			const inv = await extractClaudeInstallInventory(FAKE_INSTALL);

			expect(inv.marketplaces).toHaveLength(1);
			expect(inv.marketplaces[0]?.manifest.name).toBe('demo-marketplace');
		});

		it('discovers the cached plugin', async () => {
			const inv = await extractClaudeInstallInventory(FAKE_INSTALL);

			expect(inv.plugins).toHaveLength(1);
			expect(inv.plugins[0]?.manifest.name).toBe('demo-plugin');
		});

		it('has no parse errors', async () => {
			const inv = await extractClaudeInstallInventory(FAKE_INSTALL);

			expect(inv.parseErrors).toEqual([]);
		});
	});

	describe('empty install root', () => {
		it('returns empty inventory with no errors when directories are absent', async () => {
			const inv = await extractClaudeInstallInventory(
				safePath.join(FIXTURE_BASE, 'does-not-exist'),
			);

			expect(inv.kind).toBe('install');
			expect(inv.marketplaces).toEqual([]);
			expect(inv.plugins).toEqual([]);
			expect(inv.parseErrors).toEqual([]);
		});
	});

	describe('error paths and overloads', () => {
		let tempDir = '';

		beforeAll(() => {
			tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-install-test-'));
		});

		afterAll(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		it('accepts a ClaudeUserPaths object directly (object overload)', async () => {
			const paths = buildClaudeUserPaths(safePath.join(tempDir, 'object-overload', '.claude'));

			const inv = await extractClaudeInstallInventory(paths);

			expect(inv.kind).toBe('install');
			expect(inv.installRoot).toBe(paths.claudeDir);
			expect(inv.marketplaces).toEqual([]);
			expect(inv.plugins).toEqual([]);
		});

		it('records parse error when marketplaces dir is a file (readdir throws)', async () => {
			const claudeDir = safePath.join(tempDir, 'mp-as-file', '.claude');
			const pluginsDir = safePath.join(claudeDir, 'plugins');
			mkdirSyncReal(pluginsDir, { recursive: true });
			// Create marketplaces as a file rather than a directory.
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
			writeFileSync(safePath.join(pluginsDir,'marketplaces'), 'not a dir');

			const inv = await extractClaudeInstallInventory(claudeDir);

			expect(inv.parseErrors.length).toBeGreaterThanOrEqual(1);
			const err = inv.parseErrors.find(e => e.path.endsWith('marketplaces'));
			expect(err).toBeDefined();
		});

		it('records parse error when plugins/cache is a file (readdir throws on outer cache dir)', async () => {
			const claudeDir = safePath.join(tempDir, 'cache-as-file', '.claude');
			const pluginsDir = safePath.join(claudeDir, 'plugins');
			mkdirSyncReal(pluginsDir, { recursive: true });
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
			writeFileSync(safePath.join(pluginsDir,'cache'), 'not a dir');

			const inv = await extractClaudeInstallInventory(claudeDir);

			expect(inv.parseErrors.length).toBeGreaterThanOrEqual(1);
			const err = inv.parseErrors.find(e => e.path.endsWith('cache'));
			expect(err).toBeDefined();
		});

		it('walks valid cache structure with empty marketplace and plugin dirs', async () => {
			const claudeDir = safePath.join(tempDir, 'empty-cache-dirs', '.claude');
			const cacheDir = safePath.join(claudeDir, 'plugins', 'cache');
			// Create an empty marketplace dir under cache (no plugins beneath).
			mkdirSyncReal(safePath.join(cacheDir, 'empty-mp'), { recursive: true });
			// Create a marketplace with a plugin-name dir but no version dirs.
			mkdirSyncReal(safePath.join(cacheDir, 'mp-with-plugin', 'no-versions'), { recursive: true });
			// Also include a non-directory file directly under cache; should be filtered.
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
			writeFileSync(safePath.join(cacheDir, 'stray-file'), 'ignored');

			const inv = await extractClaudeInstallInventory(claudeDir);

			expect(inv.parseErrors).toEqual([]);
			expect(inv.plugins).toEqual([]);
		});
	});
});
