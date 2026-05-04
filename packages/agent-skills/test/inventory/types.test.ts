import { describe, it, expect } from 'vitest';

import { isPluginInventory, isSkillInventory, isMarketplaceInventory, isInstallInventory } from '../../src/inventory/index.js';
import type { PluginInventory, SkillInventory } from '../../src/inventory/index.js';

describe('inventory kind narrowing', () => {
	it('narrows to PluginInventory when kind is "plugin"', () => {
		const value: { kind: string } = {
			kind: 'plugin',
			vendor: 'claude-code',
			path: '/home/user/plugins/p',
			parseErrors: [],
			manifest: { name: 'p', version: '1.0.0' },
			shape: 'claude-plugin',
			declared: {
				skills: null, commands: null, agents: null, hooks: null,
				mcpServers: null, outputStyles: null, lspServers: null,
			},
			discovered: { skills: [], commands: [], agents: [] },
			references: [],
			unexpected: { skillManifests: [], pluginManifests: [] },
		};
		expect(isPluginInventory(value)).toBe(true);
		expect(isSkillInventory(value)).toBe(false);
		expect(isMarketplaceInventory(value)).toBe(false);
		expect(isInstallInventory(value)).toBe(false);
		if (isPluginInventory(value)) {
			const _typed: PluginInventory = value;
			expect(_typed.shape).toBe('claude-plugin');
		}
	});

	it('narrows to SkillInventory when kind is "skill"', () => {
		const value: { kind: string } = {
			kind: 'skill',
			vendor: 'claude-code',
			path: '/home/user/skills/s/SKILL.md',
			parseErrors: [],
			manifest: { name: 's' },
			files: { skillMd: '/home/user/skills/s/SKILL.md', linked: [], packaged: [] },
		};
		expect(isSkillInventory(value)).toBe(true);
		if (isSkillInventory(value)) {
			const _typed: SkillInventory = value;
			expect(_typed.manifest.name).toBe('s');
		}
	});
});
