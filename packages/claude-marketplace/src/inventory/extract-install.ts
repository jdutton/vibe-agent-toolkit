import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

import type { MarketplaceInventory, PluginInventory } from '@vibe-agent-toolkit/agent-skills';
import { direntKindFollowing, direntKindFollowingSync, safePath } from '@vibe-agent-toolkit/utils';

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
	 * product whose gitignore answers this parameter decides. While it was
	 * omitted here, `extract-plugin.ts` substituted the tracker-less walk on
	 * its behalf without either end saying so — hence REQUIRED, never defaulted.
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
	if (!existsSync(marketplacesDir)) return;
	try {
		const entries = await readdir(marketplacesDir, { withFileTypes: true });
		for (const entry of entries) {
			// A symlinked marketplace (a dev install) is a marketplace: follow it.
			if ((await direntKindFollowing(marketplacesDir, entry)) !== 'directory') continue;
			const mpPath = safePath.join(marketplacesDir, entry.name);
			marketplaces.push(await extractClaudeMarketplaceInventory(mpPath, { gitTrackerSource }));
		}
	} catch (e) {
		parseErrors.push({ path: marketplacesDir, message: (e as Error).message });
	}
}

/**
 * The subdirectories of `dir`, or `[]` with the listing failure recorded in
 * `parseErrors` — every failure, the concurrent-deletion race included, because
 * a path that was listed a moment ago and is now gone is worth a row too.
 */
async function subdirectoriesOrRecord(dir: string, parseErrors: ParseErrors): Promise<string[]> {
	try {
		return (await readdir(dir, { withFileTypes: true }))
			// Followed: a `--dev` install puts a marketplace or plugin here AS a link.
			.filter(e => direntKindFollowingSync(dir, e) === 'directory')
			.map(e => safePath.join(dir, e.name));
	} catch (e) {
		parseErrors.push({ path: dir, message: (e as Error).message });
		return [];
	}
}

async function collectCachedPlugins(
	cacheDir: string,
	plugins: PluginInventory[],
	parseErrors: ParseErrors,
	gitTrackerSource: GitTrackerSource,
): Promise<void> {
	if (!existsSync(cacheDir)) return;

	for (const mpDir of await subdirectoriesOrRecord(cacheDir, parseErrors)) {
		await collectPluginsInMarketplaceCache(mpDir, plugins, parseErrors, gitTrackerSource);
	}
}

async function collectPluginsInMarketplaceCache(
	mpDir: string,
	plugins: PluginInventory[],
	parseErrors: ParseErrors,
	gitTrackerSource: GitTrackerSource,
): Promise<void> {
	// A level the OS refuses to list is recorded against its own path, the same way
	// the cache root above is: an unlisted marketplace used to read as "no plugins".
	const pluginNameDirs = await subdirectoriesOrRecord(mpDir, parseErrors);

	for (const nameDir of pluginNameDirs) {
		const versionDirs = await subdirectoriesOrRecord(nameDir, parseErrors);
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
