import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import type {
	InstallInventory,
	MarketplaceInventory,
	PluginInventory,
} from '../../src/inventory/index.js';
import {
	INVENTORY_SCHEMA_VERSION,
	serializeInventory,
	serializeInventoryShallow,
} from '../../src/inventory/serialize.js';

const PLUGIN_PATH = '/home/user/plugins/p';
const VENDOR = 'claude-code';
const SHAPE_CLAUDE_PLUGIN = 'claude-plugin';

const fixturePlugin: PluginInventory = {
	kind: 'plugin',
	vendor: VENDOR,
	path: PLUGIN_PATH,
	shape: SHAPE_CLAUDE_PLUGIN,
	manifest: { name: 'p', version: '1.0.0' },
	declared: {
		skills: [{ manifestPath: './skills/bar', resolvedPath: `${PLUGIN_PATH}/skills/bar`, exists: true }],
		commands: null,
		agents: null,
		hooks: null,
		mcpServers: null,
		outputStyles: null,
		lspServers: null,
	},
	discovered: {
		skills: [
			{
				kind: 'skill',
				vendor: VENDOR,
				path: `${PLUGIN_PATH}/skills/bar/SKILL.md`,
				manifest: { name: 'bar' },
				files: { skillMd: `${PLUGIN_PATH}/skills/bar/SKILL.md`, linked: [], packaged: [] },
				parseErrors: [],
			},
		],
		commands: [],
		agents: [],
	},
	references: [],
	unexpected: { skillManifests: [], pluginManifests: [] },
	parseErrors: [],
};

describe('serializeInventory', () => {
	it('emits a top-level schema discriminator', () => {
		const out = serializeInventory(fixturePlugin, 'yaml');
		expect(out.startsWith(`schema: ${INVENTORY_SCHEMA_VERSION}\n`)).toBe(true);
	});

	it('round-trips through YAML without loss', () => {
		const yamlOut = serializeInventory(fixturePlugin, 'yaml');
		const parsed = yaml.parse(yamlOut) as Record<string, unknown>;
		expect(parsed['kind']).toBe('plugin');
		expect(parsed['vendor']).toBe(VENDOR);
		expect((parsed['discovered'] as { skills: unknown[] }).skills).toHaveLength(1);
	});

	it('preserves the null tri-state for declared.commands', () => {
		const out = serializeInventory(fixturePlugin, 'json');
		const parsed = JSON.parse(out) as { declared: { commands: unknown } };
		expect(parsed.declared.commands).toBeNull();
	});

	it('shallow projection marks nested skills as not-walked, not as empty', () => {
		const out = serializeInventoryShallow(fixturePlugin, 'yaml');
		const parsed = yaml.parse(out) as {
			projection: unknown;
			discovered: { skills: unknown };
		};
		expect(parsed.discovered.skills).toBeNull();
		expect(parsed.projection).toBe('shallow');
	});

	it('a full serialization never claims a projection', () => {
		const out = serializeInventory(fixturePlugin, 'yaml');
		const parsed = yaml.parse(out) as Record<string, unknown>;
		expect(parsed['projection']).toBeUndefined();
	});

	/**
	 * The distinguishing fixture: a plugin whose scan genuinely found zero
	 * skills. Every other fixture here has at least one discovered skill, so
	 * no existing test could tell "I did not look" (shallow) apart from
	 * "I looked and there is nothing" (a real scan of an empty plugin) —
	 * both used to serialize to `discovered.skills: []`.
	 */
	it('distinguishes "did not look" from "looked and found nothing"', () => {
		const genuinelyEmptyPlugin: PluginInventory = {
			...fixturePlugin,
			discovered: { skills: [], commands: [], agents: [] },
		};

		const realScanFoundNothing = serializeInventory(genuinelyEmptyPlugin, 'json');
		const didNotLook = serializeInventoryShallow(genuinelyEmptyPlugin, 'json');

		// The two documents must not be byte-identical — they are different answers.
		expect(didNotLook).not.toBe(realScanFoundNothing);

		const scanned = JSON.parse(realScanFoundNothing) as { discovered: { skills: unknown } };
		const projected = JSON.parse(didNotLook) as { discovered: { skills: unknown } };
		expect(scanned.discovered.skills).toEqual([]);
		expect(projected.discovered.skills).toBeNull();
	});

	it('shallow projection on install preserves child marketplaces and plugins as shallow projections', () => {
		const INSTALL_ROOT = '/home/user/.claude';
		const MARKETPLACE_PATH = `${INSTALL_ROOT}/marketplaces/m`;
		const STANDALONE_PLUGIN_PATH = `${INSTALL_ROOT}/plugins/standalone`;
		const NESTED_PLUGIN_PATH = `${MARKETPLACE_PATH}/plugins/nested`;

		const nestedPlugin: PluginInventory = {
			kind: 'plugin',
			vendor: VENDOR,
			path: NESTED_PLUGIN_PATH,
			shape: SHAPE_CLAUDE_PLUGIN,
			manifest: { name: 'nested', version: '1.0.0' },
			declared: {
				skills: null,
				commands: null,
				agents: null,
				hooks: null,
				mcpServers: null,
				outputStyles: null,
				lspServers: null,
			},
			discovered: { skills: [], commands: [], agents: [] },
			references: [],
			unexpected: { skillManifests: [], pluginManifests: [] },
			parseErrors: [],
		};

		const marketplace: MarketplaceInventory = {
			kind: 'marketplace',
			vendor: VENDOR,
			path: MARKETPLACE_PATH,
			manifest: { name: 'm' },
			declared: {
				plugins: [
					{
						manifestPath: './plugins/nested',
						resolvedPath: NESTED_PLUGIN_PATH,
						exists: true,
						source: 'path',
					},
				],
			},
			discovered: { plugins: [nestedPlugin] },
			parseErrors: [],
		};

		const standalonePlugin: PluginInventory = {
			kind: 'plugin',
			vendor: VENDOR,
			path: STANDALONE_PLUGIN_PATH,
			shape: SHAPE_CLAUDE_PLUGIN,
			manifest: { name: 'standalone', version: '1.0.0' },
			declared: {
				skills: null,
				commands: null,
				agents: null,
				hooks: null,
				mcpServers: null,
				outputStyles: null,
				lspServers: null,
			},
			discovered: {
				skills: [
					{
						kind: 'skill',
						vendor: VENDOR,
						path: `${STANDALONE_PLUGIN_PATH}/skills/foo/SKILL.md`,
						manifest: { name: 'foo' },
						files: {
							skillMd: `${STANDALONE_PLUGIN_PATH}/skills/foo/SKILL.md`,
							linked: [],
							packaged: [],
						},
						parseErrors: [],
					},
				],
				commands: [],
				agents: [],
			},
			references: [],
			unexpected: { skillManifests: [], pluginManifests: [] },
			parseErrors: [],
		};

		const install: InstallInventory = {
			kind: 'install',
			vendor: VENDOR,
			path: INSTALL_ROOT,
			installRoot: INSTALL_ROOT,
			marketplaces: [marketplace],
			plugins: [standalonePlugin],
			parseErrors: [],
		};

		const out = serializeInventoryShallow(install, 'json');
		const parsed = JSON.parse(out) as {
			marketplaces: Array<{
				path: string;
				declared: { plugins: unknown[] };
				discovered: { plugins: unknown };
			}>;
			plugins: Array<{ path: string; discovered: { skills: unknown } }>;
		};

		// Top-level child paths survive.
		expect(parsed.marketplaces).toHaveLength(1);
		expect(parsed.marketplaces[0]?.path).toBe(MARKETPLACE_PATH);
		expect(parsed.plugins).toHaveLength(1);
		expect(parsed.plugins[0]?.path).toBe(STANDALONE_PLUGIN_PATH);

		// Marketplace child shallow-projected: discovered.plugins not walked, declared.plugins preserved.
		expect(parsed.marketplaces[0]?.discovered.plugins).toBeNull();
		expect(parsed.marketplaces[0]?.declared.plugins).toHaveLength(1);

		// Plugin child shallow-projected: discovered.skills not walked.
		// The nested plugin genuinely had zero discovered skills, so `[]` here
		// would be indistinguishable from the truth about it.
		expect(parsed.plugins[0]?.discovered.skills).toBeNull();
	});
});
