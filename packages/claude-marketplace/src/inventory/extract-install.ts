import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

import type { MarketplaceInventory, PluginInventory } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';

import type { ClaudeUserPaths } from '../paths/claude-paths.js';
import { buildClaudeUserPaths, getClaudeUserPaths } from '../paths/claude-paths.js';

import { extractClaudeMarketplaceInventory } from './extract-marketplace.js';
import { extractClaudePluginInventory } from './extract-plugin.js';
import { ClaudeInstallInventory } from './types.js';

type ParseErrors = ClaudeInstallInventory['parseErrors'];

/**
 * Build an InstallInventory by walking a Claude install root (default: ~/.claude).
 * Discovers marketplaces under plugins/marketplaces/<name>/ and cached plugins under
 * plugins/cache/<marketplace>/<name>/<version>/. Never throws — all failures surface
 * via parseErrors[].
 *
 * Pass a ClaudeUserPaths object directly for testing or when the caller has already
 * resolved the install root; pass a string path to build paths automatically from
 * that root; omit entirely to use the default user install (~/.claude).
 */
export async function extractClaudeInstallInventory(
	pathsOrRoot?: ClaudeUserPaths | string,
): Promise<ClaudeInstallInventory> {
	const paths = resolvePaths(pathsOrRoot);
	const root = paths.claudeDir;
	const parseErrors: ParseErrors = [];
	const marketplaces: MarketplaceInventory[] = [];
	const plugins: PluginInventory[] = [];

	await collectMarketplaces(paths.marketplacesDir, marketplaces, parseErrors);
	await collectCachedPlugins(paths.pluginsCacheDir, plugins, parseErrors);

	return new ClaudeInstallInventory({
		path: root,
		installRoot: root,
		marketplaces,
		plugins,
		parseErrors,
	});
}

function resolvePaths(pathsOrRoot: ClaudeUserPaths | string | undefined): ClaudeUserPaths {
	if (pathsOrRoot === undefined) return getClaudeUserPaths();
	if (typeof pathsOrRoot === 'string') return buildClaudeUserPaths(safePath.resolve(pathsOrRoot));
	return pathsOrRoot;
}

async function collectMarketplaces(
	marketplacesDir: string,
	marketplaces: MarketplaceInventory[],
	parseErrors: ParseErrors,
): Promise<void> {
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from validated ClaudeUserPaths
	if (!existsSync(marketplacesDir)) return;
	try {
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from validated ClaudeUserPaths
		const entries = await readdir(marketplacesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const mpPath = safePath.join(marketplacesDir, entry.name);
			marketplaces.push(await extractClaudeMarketplaceInventory(mpPath));
		}
	} catch (e) {
		parseErrors.push({ path: marketplacesDir, message: (e as Error).message });
	}
}

async function collectCachedPlugins(
	cacheDir: string,
	plugins: PluginInventory[],
	parseErrors: ParseErrors,
): Promise<void> {
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from validated ClaudeUserPaths
	if (!existsSync(cacheDir)) return;

	let marketplaceDirs: string[];
	try {
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from validated ClaudeUserPaths
		marketplaceDirs = (await readdir(cacheDir, { withFileTypes: true }))
			.filter(e => e.isDirectory())
			.map(e => safePath.join(cacheDir, e.name));
	} catch (e) {
		parseErrors.push({ path: cacheDir, message: (e as Error).message });
		return;
	}

	for (const mpDir of marketplaceDirs) {
		await collectPluginsInMarketplaceCache(mpDir, plugins, parseErrors);
	}
}

async function collectPluginsInMarketplaceCache(
	mpDir: string,
	plugins: PluginInventory[],
	parseErrors: ParseErrors,
): Promise<void> {
	let pluginNameDirs: string[];
	try {
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from cache directory walk
		pluginNameDirs = (await readdir(mpDir, { withFileTypes: true }))
			.filter(e => e.isDirectory())
			.map(e => safePath.join(mpDir, e.name));
	} catch {
		// best-effort: skip unreadable marketplace cache directories
		return;
	}

	for (const nameDir of pluginNameDirs) {
		let versionDirs: string[];
		try {
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- path constructed from cache directory walk
			versionDirs = (await readdir(nameDir, { withFileTypes: true }))
				.filter(e => e.isDirectory())
				.map(e => safePath.join(nameDir, e.name));
		} catch {
			continue;
		}
		for (const versionDir of versionDirs) {
			try {
				plugins.push(await extractClaudePluginInventory(versionDir));
			} catch (e) {
				parseErrors.push({ path: versionDir, message: (e as Error).message });
			}
		}
	}
}
