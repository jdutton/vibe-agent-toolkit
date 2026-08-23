import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

import type { MarketplaceInventory, PluginInventory } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';

import type { ClaudeUserPaths } from '../paths/claude-paths.js';
import { buildClaudeUserPaths, getClaudeUserPaths } from '../paths/claude-paths.js';

import { extractClaudeMarketplaceInventory } from './extract-marketplace.js';
import { extractClaudePluginInventory } from './extract-plugin.js';
import type { GitTrackerSource } from './extract-skill.js';
import { ClaudeInstallInventory } from './types.js';

type ParseErrors = ClaudeInstallInventory['parseErrors'];

/**
 * What {@link extractClaudeInstallInventory} needs.
 *
 * An options object rather than two positionals, for the reason the skill
 * extractor's is one: the install root is OPTIONAL (omit it for `~/.claude`) and
 * the tracker source is REQUIRED, and positional parameters cannot put a
 * required one after an optional one. No `SharedRegistrySource`, for the reason
 * `ClaudeMarketplaceInventoryOptions` states — every cached plugin sits in its
 * own directory, so one registry matches none of their skills' project roots.
 */
export interface ClaudeInstallInventoryOptions {
	/**
	 * REQUIRED. How to obtain the tracker for each cached plugin's skills.
	 *
	 * This is the `vat inventory --user` lane and it walks EVERY cached plugin
	 * under `~/.claude/plugins/cache`, so it is the largest population in the
	 * product whose gitignore answers this parameter decides. It was omitted
	 * here until 2026-08-15, and `extract-plugin.ts` substituted the
	 * tracker-less walk on its behalf without either end saying so.
	 */
	gitTrackerSource: GitTrackerSource;
	/**
	 * Where the install lives.
	 *
	 * A ClaudeUserPaths object for testing or when the caller has already
	 * resolved the install root; a string path to build paths from that root;
	 * omit for the default user install (`~/.claude`).
	 */
	pathsOrRoot?: ClaudeUserPaths | string;
}

/**
 * Build an InstallInventory by walking a Claude install root (default: ~/.claude).
 * Discovers marketplaces under plugins/marketplaces/<name>/ and cached plugins under
 * plugins/cache/<marketplace>/<name>/<version>/. Never throws — all failures surface
 * via parseErrors[].
 */
export async function extractClaudeInstallInventory(
	options: ClaudeInstallInventoryOptions,
): Promise<ClaudeInstallInventory> {
	const { gitTrackerSource } = options;
	const paths = resolvePaths(options.pathsOrRoot);
	const root = paths.claudeDir;
	const parseErrors: ParseErrors = [];
	const marketplaces: MarketplaceInventory[] = [];
	const plugins: PluginInventory[] = [];

	await collectMarketplaces(paths.marketplacesDir, marketplaces, parseErrors, gitTrackerSource);
	await collectCachedPlugins(paths.pluginsCacheDir, plugins, parseErrors, gitTrackerSource);

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
	gitTrackerSource: GitTrackerSource,
): Promise<void> {
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from validated ClaudeUserPaths
	if (!existsSync(marketplacesDir)) return;
	try {
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- path from validated ClaudeUserPaths
		const entries = await readdir(marketplacesDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const mpPath = safePath.join(marketplacesDir, entry.name);
			marketplaces.push(await extractClaudeMarketplaceInventory(mpPath, { gitTrackerSource }));
		}
	} catch (e) {
		parseErrors.push({ path: marketplacesDir, message: (e as Error).message });
	}
}

async function collectCachedPlugins(
	cacheDir: string,
	plugins: PluginInventory[],
	parseErrors: ParseErrors,
	gitTrackerSource: GitTrackerSource,
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
		await collectPluginsInMarketplaceCache(mpDir, plugins, parseErrors, gitTrackerSource);
	}
}

async function collectPluginsInMarketplaceCache(
	mpDir: string,
	plugins: PluginInventory[],
	parseErrors: ParseErrors,
	gitTrackerSource: GitTrackerSource,
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
				// N+1 WHOLE-CORPUS CRAWL — known, not fixed here. No `SharedRegistrySource` is
				// passed, so every skill in every cached plugin re-crawls and re-parses the whole
				// surrounding markdown corpus (~11.9s per crawl on a ~1,041-document monorepo).
				// Measured on the equivalent defect one lane over: a 19-skill plugin took 3m45s,
				// and 12.6s once a single registry was shared. This is the hot lane for
				// `vat inventory --user`, which walks EVERY cached plugin under
				// ~/.claude/plugins/cache; `collectMarketplaces` above has the same gap via
				// `extractClaudeMarketplaceInventory`.
				//
				// Strictly additive to fix: `memoizeSharedRegistry` in `extract-plugin.ts`
				// resolves a thunk lazily on the first skill and caches even a rejection. Copy
				// `linkRegistryProviderFor` (packages/cli/src/commands/inventory.ts) or
				// `pluginInventoryAt` (packages/cli/src/commands/audit.ts), keeping their
				// `findProjectRoot(...) === null` guard — with no project root each skill's root
				// is its OWN directory, a shared registry matches nothing, and that was measured
				// 1.5x SLOWER than the N+1. UNVERIFIED whether cached plugin dirs under
				// ~/.claude typically HAVE a project root at all; if they mostly do not, the
				// guard makes this a no-op and the win is smaller than the numbers above imply.
				plugins.push(await extractClaudePluginInventory(versionDir, { gitTrackerSource }));
			} catch (e) {
				parseErrors.push({ path: versionDir, message: (e as Error).message });
			}
		}
	}
}
