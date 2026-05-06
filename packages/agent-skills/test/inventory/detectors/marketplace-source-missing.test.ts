import { describe, it, expect } from 'vitest';

import { detectMarketplacePluginSourceMissing } from '../../../src/inventory/detectors/marketplace-source-missing.js';
import type { MarketplaceInventory, PluginRef } from '../../../src/inventory/index.js';

function makePluginRef(manifestPath: string, source: PluginRef['source'], exists: boolean): PluginRef {
	return { manifestPath, resolvedPath: `/abs/${manifestPath}`, exists, source };
}

function makeMarketplace(plugins: PluginRef[]): MarketplaceInventory {
	return {
		kind: 'marketplace',
		vendor: 'claude-code',
		path: '/home/user/marketplace',
		parseErrors: [],
		manifest: { name: 'test-market' },
		declared: { plugins },
		discovered: { plugins: [] },
	};
}

describe('detectMarketplacePluginSourceMissing', () => {
	it('returns no issues when there are no plugins', () => {
		expect(detectMarketplacePluginSourceMissing(makeMarketplace([]))).toEqual([]);
	});

	it('returns no issues when all path-sourced plugins exist', () => {
		const inv = makeMarketplace([makePluginRef('plugins/my-plugin', 'path', true)]);
		expect(detectMarketplacePluginSourceMissing(inv)).toEqual([]);
	});

	it('returns one issue for a missing path-sourced plugin', () => {
		const inv = makeMarketplace([makePluginRef('plugins/missing-plugin', 'path', false)]);
		const issues = detectMarketplacePluginSourceMissing(inv);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.code).toBe('MARKETPLACE_PLUGIN_SOURCE_MISSING');
		expect(issues[0]?.severity).toBe('error');
		expect(issues[0]?.message).toContain('plugins/missing-plugin');
	});

	it.each(['git', 'npm', 'unknown'] as const)(
		'returns no issues for %s-sourced plugins even when they do not exist',
		source => {
			const inv = makeMarketplace([makePluginRef('some/path', source, false)]);
			expect(detectMarketplacePluginSourceMissing(inv)).toEqual([]);
		},
	);

	it('returns one issue per missing path-sourced plugin', () => {
		const inv = makeMarketplace([
			makePluginRef('plugins/a', 'path', false),
			makePluginRef('plugins/b', 'path', true),
			makePluginRef('plugins/c', 'path', false),
			makePluginRef('plugins/d', 'git', false),
		]);
		const issues = detectMarketplacePluginSourceMissing(inv);
		expect(issues).toHaveLength(2);
		for (const issue of issues) {
			expect(issue.code).toBe('MARKETPLACE_PLUGIN_SOURCE_MISSING');
			expect(issue.severity).toBe('error');
		}
	});
});
