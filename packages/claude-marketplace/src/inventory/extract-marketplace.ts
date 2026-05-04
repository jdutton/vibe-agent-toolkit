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
