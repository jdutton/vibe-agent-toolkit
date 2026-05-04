import { describe, it, expect } from 'vitest';

import { isPluginInventory, isSkillInventory, isMarketplaceInventory, isInstallInventory } from '../../src/inventory/index.js';
import type { PluginInventory, SkillInventory } from '../../src/inventory/index.js';

import { makePluginInventory, makeSkillInventory } from './plugin-inventory-fixtures.js';

describe('inventory kind narrowing', () => {
	it('narrows to PluginInventory when kind is "plugin"', () => {
		const value: { kind: string } = makePluginInventory();
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
		const value: { kind: string } = makeSkillInventory('/home/user/skills/s/SKILL.md', 's');
		expect(isSkillInventory(value)).toBe(true);
		if (isSkillInventory(value)) {
			const _typed: SkillInventory = value;
			expect(_typed.manifest.name).toBe('s');
		}
	});
});
