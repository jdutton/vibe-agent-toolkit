import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

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
		const parsed = yaml.load(yamlOut) as Record<string, unknown>;
		expect(parsed['kind']).toBe('plugin');
		expect(parsed['vendor']).toBe(VENDOR);
		expect((parsed['discovered'] as { skills: unknown[] }).skills).toHaveLength(1);
	});

	it('preserves the null tri-state for declared.commands', () => {
		const out = serializeInventory(fixturePlugin, 'json');
		const parsed = JSON.parse(out) as { declared: { commands: unknown } };
		expect(parsed.declared.commands).toBeNull();
	});

	it('shallow projection drops nested skills', () => {
		const out = serializeInventoryShallow(fixturePlugin, 'yaml');
		const parsed = yaml.load(out) as { discovered: { skills: unknown[] } };
		expect(parsed.discovered.skills).toEqual([]);
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
				discovered: { plugins: unknown[] };
			}>;
			plugins: Array<{ path: string; discovered: { skills: unknown[] } }>;
		};

		// Top-level child paths survive.
		expect(parsed.marketplaces).toHaveLength(1);
		expect(parsed.marketplaces[0]?.path).toBe(MARKETPLACE_PATH);
		expect(parsed.plugins).toHaveLength(1);
		expect(parsed.plugins[0]?.path).toBe(STANDALONE_PLUGIN_PATH);

		// Marketplace child shallow-projected: discovered.plugins emptied, declared.plugins preserved.
		expect(parsed.marketplaces[0]?.discovered.plugins).toEqual([]);
		expect(parsed.marketplaces[0]?.declared.plugins).toHaveLength(1);

		// Plugin child shallow-projected: discovered.skills emptied.
		expect(parsed.plugins[0]?.discovered.skills).toEqual([]);
	});
});
