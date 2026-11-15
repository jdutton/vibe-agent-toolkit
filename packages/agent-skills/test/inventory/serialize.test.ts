import { describe, expect, it } from 'vitest';

import type {
	InstallInventory,
	MarketplaceInventory,
	PluginInventory,
} from '../../src/inventory/index.js';
import {
	countInventories,
	InventorySerializedSchema,
	serializedInventory,
	unreadableParseErrors,
} from '../../src/inventory/serialize.js';

const PLUGIN_PATH = '/home/user/plugins/p';
const VENDOR = 'claude-code';
const SHAPE_CLAUDE_PLUGIN = 'claude-plugin';
const INSTALL_ROOT = '/home/user/.claude';
const MARKETPLACE_PATH = `${INSTALL_ROOT}/marketplaces/m`;
const STANDALONE_PLUGIN_PATH = `${INSTALL_ROOT}/plugins/standalone`;
const NESTED_PLUGIN_PATH = `${MARKETPLACE_PATH}/plugins/nested`;
const LOCKED_SKILLS_DIR = `${STANDALONE_PLUGIN_PATH}/skills/locked`;

const NO_DECLARATIONS: PluginInventory['declared'] = {
	skills: null,
	commands: null,
	agents: null,
	hooks: null,
	mcpServers: null,
	outputStyles: null,
	lspServers: null,
};

const fixturePlugin: PluginInventory = {
	kind: 'plugin',
	vendor: VENDOR,
	path: PLUGIN_PATH,
	shape: SHAPE_CLAUDE_PLUGIN,
	manifest: { name: 'p', version: '1.0.0' },
	declared: {
		...NO_DECLARATIONS,
		skills: [{ manifestPath: './skills/bar', resolvedPath: `${PLUGIN_PATH}/skills/bar`, exists: true }],
		// An inline hooks config, as the extractor records one: no path, the config on the ref.
		hooks: [{ manifestPath: '', resolvedPath: '', exists: false, inline: { PreToolUse: [] } }],
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

/** A plugin with no skills of its own — `[]` here is the truth about it. */
const nestedPlugin: PluginInventory = {
	...fixturePlugin,
	path: NESTED_PLUGIN_PATH,
	manifest: { name: 'nested', version: '1.0.0' },
	declared: NO_DECLARATIONS,
	discovered: { skills: [], commands: [], agents: [] },
};

const marketplace: MarketplaceInventory = {
	kind: 'marketplace',
	vendor: VENDOR,
	path: MARKETPLACE_PATH,
	manifest: { name: 'm' },
	declared: {
		plugins: [{ manifestPath: './plugins/nested', resolvedPath: NESTED_PLUGIN_PATH, exists: true, source: 'path' }],
	},
	discovered: { plugins: [nestedPlugin] },
	parseErrors: [],
};

const standalonePlugin: PluginInventory = {
	...fixturePlugin,
	path: STANDALONE_PLUGIN_PATH,
	manifest: { name: 'standalone', version: '1.0.0' },
	declared: NO_DECLARATIONS,
	// The plugin records its unreadable skills directory, and so does the install it sits in.
	parseErrors: [{ path: LOCKED_SKILLS_DIR, message: 'EACCES', unreadable: true }],
};

const install: InstallInventory = {
	kind: 'install',
	vendor: VENDOR,
	path: INSTALL_ROOT,
	installRoot: INSTALL_ROOT,
	marketplaces: [marketplace],
	plugins: [standalonePlugin],
	parseErrors: [
		{ path: LOCKED_SKILLS_DIR, message: 'EACCES', unreadable: true },
		{ path: `${INSTALL_ROOT}/plugins/broken/.claude-plugin/plugin.json`, message: 'not JSON' },
	],
};

describe('serializedInventory', () => {
	/**
	 * Pins an ABSENCE, so it must fail if a `schema:` label is ever reintroduced:
	 * the published object carries no version label — `kind` is the discriminator.
	 */
	it.each(['full', 'shallow'] as const)('the %s projection carries no schema version label', (projection) => {
		expect('schema' in serializedInventory(fixturePlugin, projection)).toBe(false);
	});

	it('the full projection is the inventory itself, and never claims a projection', () => {
		const full = serializedInventory(fixturePlugin, 'full');
		expect(full).toBe(fixturePlugin);
		expect('projection' in full).toBe(false);
	});

	it('the shallow projection marks nested skills as not-walked, not as empty', () => {
		const shallow = serializedInventory(fixturePlugin, 'shallow') as { projection: unknown; discovered: { skills: unknown } };
		expect(shallow.projection).toBe('shallow');
		expect(shallow.discovered.skills).toBeNull();
	});

	/**
	 * The distinguishing fixture: a plugin whose scan genuinely found zero
	 * skills. Without it no case could tell "I did not look" (shallow) from
	 * "I looked and there is nothing" — both used to be `discovered.skills: []`.
	 */
	it('distinguishes "did not look" from "looked and found nothing"', () => {
		const scanned = serializedInventory(nestedPlugin, 'full') as PluginInventory;
		const projected = serializedInventory(nestedPlugin, 'shallow') as unknown as { discovered: { skills: unknown } };
		expect(scanned.discovered.skills).toEqual([]);
		expect(projected.discovered.skills).toBeNull();
	});

	it('the shallow projection of an install shallow-projects each child and keeps its declarations', () => {
		const shallow = serializedInventory(install, 'shallow') as unknown as {
			marketplaces: Array<{ path: string; declared: { plugins: unknown[] }; discovered: { plugins: unknown } }>;
			plugins: Array<{ path: string; discovered: { skills: unknown } }>;
		};
		expect(shallow.marketplaces.map((m) => m.path)).toEqual([MARKETPLACE_PATH]);
		expect(shallow.marketplaces[0]?.discovered.plugins).toBeNull();
		expect(shallow.marketplaces[0]?.declared.plugins).toHaveLength(1);
		expect(shallow.plugins.map((p) => p.path)).toEqual([STANDALONE_PLUGIN_PATH]);
		expect(shallow.plugins[0]?.discovered.skills).toBeNull();
	});
});

describe('InventorySerializedSchema', () => {
	it.each([
		['plugin', fixturePlugin],
		['marketplace', marketplace],
		['install', install],
	] as const)('accepts the full and the shallow projection of a %s', (_kind, inventory) => {
		expect(() => InventorySerializedSchema.parse(serializedInventory(inventory, 'full'))).not.toThrow();
		expect(() => InventorySerializedSchema.parse(serializedInventory(inventory, 'shallow'))).not.toThrow();
	});

	/**
	 * The extractor records ANY object-valued manifest field as one ref carrying
	 * `inline` — hooks by type, but `commands` too at runtime — so the schema
	 * must take it on every declared list, not only the three typed with it.
	 */
	it('accepts an inline config on a declared list, on hooks and on any other field', () => {
		const inline = { PreToolUse: [{ matcher: 'Bash' }] };
		const ref = { manifestPath: '', resolvedPath: '', exists: false, inline };
		const withInline = { ...fixturePlugin, declared: { ...NO_DECLARATIONS, hooks: [ref], commands: [ref] } };

		const parsed = InventorySerializedSchema.parse(serializedInventory(withInline, 'full')) as PluginInventory;
		expect(parsed.declared.hooks?.[0]?.inline).toEqual(inline);
		expect(InventorySerializedSchema.safeParse(serializedInventory(withInline, 'shallow')).success).toBe(true);
	});

	it('refuses an unwalked list on a document that does not say it is shallow', () => {
		const unmarked = { ...fixturePlugin, discovered: { ...fixturePlugin.discovered, skills: null } };
		expect(InventorySerializedSchema.safeParse(unmarked).success).toBe(false);
	});

	it('refuses a key the inventory model does not declare', () => {
		expect(InventorySerializedSchema.safeParse({ ...fixturePlugin, schema: 'v1' }).success).toBe(false);
	});
});

describe('countInventories', () => {
	it('counts the subject and every inventory nested under it', () => {
		// install + marketplace + its nested plugin + the standalone plugin + its one skill.
		expect(countInventories(install)).toBe(5);
		expect(countInventories(nestedPlugin)).toBe(1);
	});
});

describe('unreadableParseErrors', () => {
	it('collects each path the OS refused once, across the whole tree, and no content defect', () => {
		expect(unreadableParseErrors(install)).toEqual([{ path: LOCKED_SKILLS_DIR, message: 'EACCES', unreadable: true }]);
		expect(unreadableParseErrors(fixturePlugin)).toEqual([]);
	});
});
