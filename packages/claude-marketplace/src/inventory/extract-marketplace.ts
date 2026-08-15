import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { PluginInventory, PluginRef } from '@vibe-agent-toolkit/agent-skills';
import { MarketplaceManifestSchema } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';

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

	for (const entry of pluginsRaw) {
		const ref = pluginEntryToRef(absolute, entry);
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

function pluginEntryToRef(base: string, entry: unknown): PluginRef {
	if (typeof entry !== 'object' || entry === null) {
		return { manifestPath: '', resolvedPath: '', exists: false, source: 'unknown' };
	}
	const e = entry as Record<string, unknown>;
	const source = e['source'];

	if (typeof source === 'string') {
		const resolved = safePath.resolve(base, source);
		return {
			manifestPath: source,
			resolvedPath: resolved,
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from marketplace-relative path entry
			exists: existsSync(resolved),
			source: 'path',
		};
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
