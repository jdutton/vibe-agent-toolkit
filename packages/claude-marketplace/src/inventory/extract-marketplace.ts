import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { PluginInventory, PluginRef } from '@vibe-agent-toolkit/agent-skills';
import { MarketplaceManifestSchema } from '@vibe-agent-toolkit/agent-skills';
import { normalizePath, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { extractClaudePluginInventory } from './extract-plugin.js';
import type { GitTrackerSource } from './extract-skill.js';
import { ClaudeMarketplaceInventory } from './types.js';

type ParseErrors = ClaudeMarketplaceInventory['parseErrors'];

const MARKETPLACE_JSON = 'marketplace.json';

/**
 * What {@link extractClaudeMarketplaceInventory} needs besides the marketplace path.
 *
 * A tracker source and **nothing else**, where the plugin and skill lanes also
 * accept a `SharedRegistrySource`. That omission is deliberate and measured: a
 * marketplace fans out to plugins that each sit in their own directory, so one
 * registry matches none of their skills' project roots and was measured 1.5×
 * SLOWER than the N+1 crawl it was meant to remove. Offering the parameter here
 * would invite a caller to pay for that.
 *
 * The tracker source is the opposite case, which is why the two are separated
 * rather than passed on together: it is asked per skill about that skill's own
 * root and answers `undefined` for any root it cannot serve, so it costs nothing
 * where it does not apply — and where it does apply it decides a `gitignored`
 * answer, not merely how fast that answer is reached.
 */
export interface ClaudeMarketplaceInventoryOptions {
	/**
	 * REQUIRED. How to obtain the tracker for each discovered plugin's skills;
	 * pass `NO_GIT_TRACKER` to choose the tracker-less walk for all of them.
	 */
	gitTrackerSource: GitTrackerSource;
}

/**
 * Build a MarketplaceInventory for a directory containing a .claude-plugin/marketplace.json
 * manifest. Never throws — all failures surface via parseErrors[].
 *
 * For path-source entries that exist on disk, the plugin extractor is called recursively so
 * discovered.plugins is fully populated. Remote entries (git, npm, unknown) are declarations
 * only — they are never fetched.
 */
export async function extractClaudeMarketplaceInventory(
	marketplacePath: string,
	options: ClaudeMarketplaceInventoryOptions,
): Promise<ClaudeMarketplaceInventory> {
	const absolute = safePath.resolve(marketplacePath);
	const parseErrors: ParseErrors = [];
	const manifestFilePath = safePath.join(absolute, '.claude-plugin', MARKETPLACE_JSON);

	// eslint-disable-next-line security/detect-non-literal-fs-filename -- absolute is resolved from caller-supplied path
	if (!existsSync(manifestFilePath)) {
		parseErrors.push({ path: manifestFilePath, message: 'marketplace.json not found' });
		return new ClaudeMarketplaceInventory({
			path: absolute,
			manifest: {},
			declared: { plugins: [] },
			discovered: { plugins: [] },
			parseErrors,
		});
	}

	let raw: unknown;
	try {
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- absolute path resolved from marketplace root
		raw = JSON.parse(await readFile(manifestFilePath, 'utf-8'));
	} catch (e) {
		parseErrors.push({ path: manifestFilePath, message: (e as Error).message });
		return new ClaudeMarketplaceInventory({
			path: absolute,
			manifest: {},
			declared: { plugins: [] },
			discovered: { plugins: [] },
			parseErrors,
		});
	}

	const result = MarketplaceManifestSchema.safeParse(raw);
	const data = result.success ? result.data : (raw as Record<string, unknown>);

	if (!result.success) {
		parseErrors.push({
			path: manifestFilePath,
			message: `marketplace.json schema validation failed: ${result.error.issues.map(i => i.message).join('; ')}`,
		});
	}

	const manifest = {
		...(typeof data['name'] === 'string' && { name: data['name'] }),
		...(typeof data['description'] === 'string' && { description: data['description'] }),
	};

	const pluginsRaw = (data['plugins'] as unknown[] | undefined) ?? [];
	const declared: PluginRef[] = [];
	const discovered: PluginInventory[] = [];
	const root: MarketplaceRoot = {
		path: absolute,
		realPath: toForwardSlash(normalizePath(absolute)),
		manifestFilePath,
		parseErrors,
	};

	for (const entry of pluginsRaw) {
		const ref = pluginEntryToRef(root, entry);
		declared.push(ref);
		if (ref.source === 'path' && ref.exists) {
			// N+1 WHOLE-CORPUS CRAWL — known, not fixed here. `extractClaudePluginInventory`
			// accepts an optional `sharedRegistry`; omitting it means every skill
			// under every discovered plugin re-crawls and re-parses the whole surrounding
			// markdown corpus (~11.9s per crawl on a ~1,041-document monorepo). Measured on the
			// equivalent defect one lane over: a 19-skill plugin took 3m45s, and 12.6s once a
			// single registry was shared. This site degrades `vat inventory <marketplace-dir>`
			// and `vat audit` pointed at a marketplace root; `extract-install.ts` also reaches
			// here (via `collectMarketplaces`) for `vat inventory --user`.
			//
			// Threading a registry through is strictly additive: `memoizeSharedRegistry` in
			// `extract-plugin.ts` resolves a thunk lazily on the first skill and caches even a
			// rejection, so a plugin of only commands/agents still crawls nothing. Copy
			// `linkRegistryProviderFor` (packages/cli/src/commands/inventory.ts) or
			// `pluginInventoryAt` (packages/cli/src/commands/audit.ts) — INCLUDING their
			// `findProjectRoot(...) === null` guard: with no project root each skill's root is
			// its OWN directory, so a shared registry matches nothing and was measured 1.5x
			// SLOWER than the N+1 it was meant to remove.
			//
			// The tracker source is NOT omitted the same way, and used to be. It was never a
			// performance footnote: it decides a `gitignored` answer, not just how fast that
			// answer is reached, and the two oracles are demonstrably distinguishable (see the
			// divergence suite in test/inventory/extract-skill.test.ts). While this function
			// had no parameter for it, `extract-plugin.ts` substituted `NO_GIT_TRACKER` on
			// this lane's behalf and every skill under every plugin reached from here walked
			// with the `git check-ignore` oracle. It now comes from the caller, which is the
			// only participant that owns the per-root tracker cache.
			discovered.push(
				await extractClaudePluginInventory(ref.resolvedPath, {
					gitTrackerSource: options.gitTrackerSource,
				}),
			);
		}
	}

	return new ClaudeMarketplaceInventory({
		path: absolute,
		manifest,
		declared: { plugins: declared },
		discovered: { plugins: discovered },
		parseErrors,
	});
}

function strField(obj: Record<string, unknown>, key: string, fallback: string): string {
	const v = obj[key];
	return typeof v === 'string' ? v : fallback;
}

/** The marketplace a string `source` is resolved against, and where a refusal is recorded. */
interface MarketplaceRoot {
	path: string;
	/** `path` after realpath — the identity a symlinked source is compared against. */
	realPath: string;
	manifestFilePath: string;
	parseErrors: ParseErrors;
}

/**
 * The directory a string `source` names, or `undefined` when it lies outside
 * the marketplace root — by any of three spellings of "outside".
 *
 * `marketplace.json` is attacker-reachable content (it is the thing being
 * audited), and this lane reads the RAW entries even when the schema refused
 * the manifest, so the schema's own refusal of an absolute or `..` source is
 * no protection here: before this guard, `source: "/etc"` was resolved, walked,
 * and published at `../` locations. Three checks, each reusing the utils
 * predicate the skill `files:` containment already trusts:
 *
 * 1. `safePath.joinUnderRoot` — refuses an absolute path (POSIX, drive letter,
 *    UNC) and a `..` climb, behind either separator (`toForwardSlash` first).
 * 2. `existsSync` — a source that is not there is `exists: false`, as before.
 * 3. realpath, via `normalizePath`, compared against the root's OWN realpath
 *    with the same `joinUnderRoot` — a symlink inside the root pointing out is
 *    outside; a root reached through a symlink (`/var` → `/private/var`) is not
 *    "escaping itself".
 *
 * `vat claude marketplace validate` enforces the same contract on its lane
 * (`containedPluginDir` in `packages/cli/src/commands/claude/marketplace/validate.ts`);
 * its third step goes through `escapesCorpusRoot`, which lives in the CLI
 * package and cannot be imported from here, so this lane asks the question
 * through `joinUnderRoot` instead.
 */
function containedSourceDir(root: MarketplaceRoot, source: string): { resolved: string; exists: boolean } | undefined {
	let resolved: string;
	try {
		resolved = safePath.joinUnderRoot(root.path, toForwardSlash(source));
	} catch {
		return undefined;
	}
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- contained under the marketplace root by joinUnderRoot
	if (!existsSync(resolved)) return { resolved, exists: false };
	try {
		safePath.joinUnderRoot(root.realPath, safePath.relative(root.realPath, toForwardSlash(normalizePath(resolved))));
	} catch {
		return undefined;
	}
	return { resolved, exists: true };
}

/**
 * A string `source` as a {@link PluginRef}. A source outside the root is
 * declared but never walked: `exists: false` keeps it out of `discovered`, so
 * `detectMarketplacePluginSourceMissing` (the code `vat audit` already emits
 * for a path source it cannot reach) names it on the manifest itself, and a
 * `parseErrors` entry says WHY for `vat inventory`. `resolvedPath` is the
 * manifest, not the outside target, so no consumer relativizes a path that
 * starts with `../`.
 */
function pathSourceRef(root: MarketplaceRoot, source: string): PluginRef {
	const dir = containedSourceDir(root, source);
	if (dir === undefined) {
		root.parseErrors.push({
			path: root.manifestFilePath,
			message: `plugin source "${source}" resolves outside the marketplace directory and was not walked`
				+ ' — a plugin source must be a relative path that stays inside the marketplace'
				+ ' (no absolute path, no ".." segment, no symlink pointing out).',
		});
		return { manifestPath: source, resolvedPath: root.manifestFilePath, exists: false, source: 'path' };
	}
	return { manifestPath: source, resolvedPath: dir.resolved, exists: dir.exists, source: 'path' };
}

function pluginEntryToRef(root: MarketplaceRoot, entry: unknown): PluginRef {
	if (typeof entry !== 'object' || entry === null) {
		return { manifestPath: '', resolvedPath: '', exists: false, source: 'unknown' };
	}
	const e = entry as Record<string, unknown>;
	const source = e['source'];

	if (typeof source === 'string') {
		return pathSourceRef(root, source);
	}

	if (typeof source === 'object' && source !== null) {
		const obj = source as Record<string, unknown>;
		const kind = strField(obj, 'source', 'unknown');
		switch (kind) {
			case 'github':
				return {
					manifestPath: `github:${strField(obj, 'repo', '')}`,
					resolvedPath: '',
					exists: false,
					source: 'git',
				};
			case 'url':
				return {
					manifestPath: strField(obj, 'url', ''),
					resolvedPath: '',
					exists: false,
					source: 'git',
				};
			case 'npm':
				return {
					manifestPath: `npm:${strField(obj, 'package', '')}`,
					resolvedPath: '',
					exists: false,
					source: 'npm',
				};
			case 'pip':
				return {
					manifestPath: `pip:${strField(obj, 'package', '')}`,
					resolvedPath: '',
					exists: false,
					source: 'unknown',
				};
			default:
				return {
					manifestPath: `${kind}:${strField(obj, 'package', '')}`,
					resolvedPath: '',
					exists: false,
					source: 'unknown',
				};
		}
	}

	return { manifestPath: '', resolvedPath: '', exists: false, source: 'unknown' };
}
