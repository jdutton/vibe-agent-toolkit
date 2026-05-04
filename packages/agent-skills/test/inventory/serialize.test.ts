import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import type { PluginInventory } from '../../src/inventory/index.js';
import {
	INVENTORY_SCHEMA_VERSION,
	serializeInventory,
	serializeInventoryShallow,
} from '../../src/inventory/serialize.js';

const PLUGIN_PATH = '/home/user/plugins/p';
const VENDOR = 'claude-code';

const fixturePlugin: PluginInventory = {
	kind: 'plugin',
	vendor: VENDOR,
	path: PLUGIN_PATH,
	shape: 'claude-plugin',
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
});
