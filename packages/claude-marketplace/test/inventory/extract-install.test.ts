import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractClaudeInstallInventory } from '../../src/inventory/extract-install.js';
import { NO_GIT_TRACKER } from '../../src/inventory/extract-skill.js';
import { buildClaudeUserPaths } from '../../src/paths/claude-paths.js';

const FIXTURE_BASE = safePath.resolve(__dirname, '../fixtures/inventory-install');
const FAKE_INSTALL = safePath.join(FIXTURE_BASE, 'fake-install');

/**
 * An install root where one of the two directories the walk lists is a FILE.
 *
 * `marketplaces/` and `plugins/cache/` are both reached with `readdir`, and both
 * record a parse error against the path that could not be listed rather than
 * failing the extraction. The two cases differ only in which name is occupied,
 * so the setup is shared rather than written twice.
 *
 * @param tempDir - The suite's temp root
 * @param fixtureName - A directory name under it, unique per case
 * @param occupied - The name under `plugins/` to create as a file
 * @returns The extraction's inventory
 */
async function installWithFileWhereDirExpected(
	tempDir: string,
	fixtureName: string,
	occupied: string,
): Promise<Awaited<ReturnType<typeof extractClaudeInstallInventory>>> {
	const claudeDir = safePath.join(tempDir, fixtureName, '.claude');
	const pluginsDir = safePath.join(claudeDir, 'plugins');
	mkdirSyncReal(pluginsDir, { recursive: true });
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
	writeFileSync(safePath.join(pluginsDir, occupied), 'not a dir');
	return extractClaudeInstallInventory({
		pathsOrRoot: claudeDir,
		gitTrackerSource: NO_GIT_TRACKER,
	});
}

/**
 * The tracker-less walk, said out loud.
 *
 * These fixtures have no git repository behind them, so no tracker could
 * answer for them and none of these assertions is about gitignore. Naming the
 * choice is the point: the extractors REQUIRE a source precisely so a suite
 * cannot land in the tracker-less state by leaving an argument off, which is how
 * the walker/closure divergence stayed invisible for three commits.
 */
describe('extractClaudeInstallInventory', () => {
	describe('fake-install fixture', () => {
		it('returns correct kind and vendor', async () => {
			const inv = await extractClaudeInstallInventory({ pathsOrRoot: FAKE_INSTALL, gitTrackerSource: NO_GIT_TRACKER });

			expect(inv.kind).toBe('install');
			expect(inv.vendor).toBe('claude-code');
		});

		it('sets installRoot to the resolved fixture path', async () => {
			const inv = await extractClaudeInstallInventory({ pathsOrRoot: FAKE_INSTALL, gitTrackerSource: NO_GIT_TRACKER });

			expect(inv.installRoot).toBe(safePath.resolve(FAKE_INSTALL));
		});

		it('discovers the demo marketplace', async () => {
			const inv = await extractClaudeInstallInventory({ pathsOrRoot: FAKE_INSTALL, gitTrackerSource: NO_GIT_TRACKER });

			expect(inv.marketplaces).toHaveLength(1);
			expect(inv.marketplaces[0]?.manifest.name).toBe('demo-marketplace');
		});

		it('discovers the cached plugin', async () => {
			const inv = await extractClaudeInstallInventory({ pathsOrRoot: FAKE_INSTALL, gitTrackerSource: NO_GIT_TRACKER });

			expect(inv.plugins).toHaveLength(1);
			expect(inv.plugins[0]?.manifest.name).toBe('demo-plugin');
		});

		it('has no parse errors', async () => {
			const inv = await extractClaudeInstallInventory({ pathsOrRoot: FAKE_INSTALL, gitTrackerSource: NO_GIT_TRACKER });

			expect(inv.parseErrors).toEqual([]);
		});
	});

	describe('empty install root', () => {
		it('returns empty inventory with no errors when directories are absent', async () => {
			const inv = await extractClaudeInstallInventory({ pathsOrRoot: safePath.join(FIXTURE_BASE, 'does-not-exist'), gitTrackerSource: NO_GIT_TRACKER });

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

			const inv = await extractClaudeInstallInventory({ pathsOrRoot: paths, gitTrackerSource: NO_GIT_TRACKER });

			expect(inv.kind).toBe('install');
			expect(inv.installRoot).toBe(paths.claudeDir);
			expect(inv.marketplaces).toEqual([]);
			expect(inv.plugins).toEqual([]);
		});

		it('records parse error when marketplaces dir is a file (readdir throws)', async () => {
			const inv = await installWithFileWhereDirExpected(tempDir, 'mp-as-file', 'marketplaces');

			expect(inv.parseErrors.length).toBeGreaterThanOrEqual(1);
			const err = inv.parseErrors.find(e => e.path.endsWith('marketplaces'));
			expect(err).toBeDefined();
		});

		it('records parse error when plugins/cache is a file (readdir throws on outer cache dir)', async () => {
			const inv = await installWithFileWhereDirExpected(tempDir, 'cache-as-file', 'cache');

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

			const inv = await extractClaudeInstallInventory({ pathsOrRoot: claudeDir, gitTrackerSource: NO_GIT_TRACKER });

			expect(inv.parseErrors).toEqual([]);
			expect(inv.plugins).toEqual([]);
		});
	});
});
