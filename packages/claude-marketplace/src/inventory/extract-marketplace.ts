import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { PluginInventory, PluginRef } from '@vibe-agent-toolkit/agent-skills';
import { MarketplaceManifestSchema } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';

import { extractClaudePluginInventory } from './extract-plugin.js';
import { ClaudeMarketplaceInventory } from './types.js';

type ParseErrors = ClaudeMarketplaceInventory['parseErrors'];

const MARKETPLACE_JSON = 'marketplace.json';

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
			// takes an optional second `SharedRegistrySource`; omitting it means every skill
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
			// The SAME omission covers the third argument, a `GitTrackerSource`, and it is not
			// a performance footnote: `extractClaudeSkillInventory` requires that source, so
			// `extract-plugin.ts` substitutes `NO_GIT_TRACKER` on this lane's behalf, and every
			// skill under every plugin reached from here walks with the `git check-ignore`
			// oracle rather than an active set. That decides a `gitignored` answer, not just
			// its cost — the two oracles are demonstrably distinguishable (see the divergence
			// suite in test/inventory/extract-skill.test.ts). This function has no parameter to
			// thread either source through; giving it one is the follow-up, and it must land
			// together with `extract-install.ts`, which omits both the same way.
			discovered.push(await extractClaudePluginInventory(ref.resolvedPath));
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
