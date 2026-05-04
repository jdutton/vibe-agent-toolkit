import { describe, expect, it } from 'vitest';

import {
	ClaudeInstallInventory,
	ClaudeMarketplaceInventory,
	ClaudePluginInventory,
	ClaudeSkillInventory,
} from '../../src/inventory/types.js';

const emptyDeclared = {
	skills: null,
	commands: null,
	agents: null,
	hooks: null,
	mcpServers: null,
	outputStyles: null,
	lspServers: null,
} as const;

describe('Claude inventory classes', () => {
	it('ClaudePluginInventory satisfies the PluginInventory contract', () => {
		const inv = new ClaudePluginInventory({
			path: '/home/user/plugins/p',
			shape: 'claude-plugin',
			manifest: { name: 'p' },
			declared: emptyDeclared,
			discovered: { skills: [], commands: [], agents: [] },
			references: [],
			unexpected: { skillManifests: [], pluginManifests: [] },
			parseErrors: [],
		});
		expect(inv.kind).toBe('plugin');
		expect(inv.vendor).toBe('claude-code');
	});

	it('ClaudeSkillInventory satisfies the SkillInventory contract', () => {
		const inv = new ClaudeSkillInventory({
			path: '/home/user/skills/s/SKILL.md',
			manifest: { name: 's' },
			files: { skillMd: '/home/user/skills/s/SKILL.md', linked: [], packaged: [] },
			parseErrors: [],
		});
		expect(inv.kind).toBe('skill');
	});

	it('ClaudeMarketplaceInventory satisfies the MarketplaceInventory contract', () => {
		const inv = new ClaudeMarketplaceInventory({
			path: '/home/user/marketplaces/mp',
			manifest: { name: 'mp' },
			declared: { plugins: [] },
			discovered: { plugins: [] },
			parseErrors: [],
		});
		expect(inv.kind).toBe('marketplace');
	});

	it('ClaudeInstallInventory satisfies the InstallInventory contract', () => {
		const inv = new ClaudeInstallInventory({
			path: '/home/user/.claude',
			installRoot: '/home/user/.claude',
			marketplaces: [],
			plugins: [],
			parseErrors: [],
		});
		expect(inv.kind).toBe('install');
	});
});
