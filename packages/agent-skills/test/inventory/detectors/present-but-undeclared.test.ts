import { describe, it, expect } from 'vitest';

import { detectPresentButUndeclared } from '../../../src/inventory/detectors/present-but-undeclared.js';
import type { ComponentRef } from '../../../src/inventory/index.js';
import { makePluginInventory, makeSkillInventory } from '../plugin-inventory-fixtures.js';

const PRESENT_BUT_UNDECLARED_CODE = 'COMPONENT_PRESENT_BUT_UNDECLARED';
const SKILL_PATH = '/abs/skills/foo/SKILL.md';

function makeRef(resolvedPath: string): ComponentRef {
	return { manifestPath: resolvedPath, resolvedPath, exists: true };
}

describe('detectPresentButUndeclared', () => {
	describe('skills', () => {
		it('returns no issues when declared.skills is null (auto-discovery)', () => {
			const inv = makePluginInventory(
				{ skills: null },
				{ skills: [makeSkillInventory(SKILL_PATH)] },
			);
			expect(detectPresentButUndeclared(inv)).toEqual([]);
		});

		it('returns one issue when discovered skill is absent from explicit empty list', () => {
			const inv = makePluginInventory(
				{ skills: [] },
				{ skills: [makeSkillInventory(SKILL_PATH)] },
			);
			const issues = detectPresentButUndeclared(inv);
			expect(issues).toHaveLength(1);
			expect(issues[0]?.code).toBe(PRESENT_BUT_UNDECLARED_CODE);
			expect(issues[0]?.severity).toBe('info');
			expect(issues[0]?.message).toContain('skills');
		});

		it('returns no issues when discovered skill is in the declared list', () => {
			const inv = makePluginInventory(
				{ skills: [{ manifestPath: SKILL_PATH, resolvedPath: SKILL_PATH, exists: true }] },
				{ skills: [makeSkillInventory(SKILL_PATH)] },
			);
			expect(detectPresentButUndeclared(inv)).toEqual([]);
		});
	});

	const COMPONENT_CASES: Array<[
		keyof Pick<ReturnType<typeof makePluginInventory>['declared'], 'commands' | 'agents'>,
		keyof ReturnType<typeof makePluginInventory>['discovered'],
		string,
	]> = [
		['commands', 'commands', '/abs/commands/run.sh'],
		['agents', 'agents', '/abs/agents/helper.md'],
	];

	it.each(COMPONENT_CASES)(
		'returns no issues when declared.%s is null (auto-discovery)',
		(field, discoveredField, path) => {
			const inv = makePluginInventory(
				{ [field]: null },
				{ [discoveredField]: [makeRef(path)] },
			);
			expect(detectPresentButUndeclared(inv)).toEqual([]);
		},
	);

	it.each(COMPONENT_CASES)(
		'returns one issue when discovered %s is absent from explicit empty list',
		(field, discoveredField, path) => {
			const inv = makePluginInventory(
				{ [field]: [] },
				{ [discoveredField]: [makeRef(path)] },
			);
			const issues = detectPresentButUndeclared(inv);
			expect(issues).toHaveLength(1);
			expect(issues[0]?.code).toBe(PRESENT_BUT_UNDECLARED_CODE);
			expect(issues[0]?.message).toContain(field);
		},
	);

	it.each(COMPONENT_CASES)(
		'returns no issues when discovered %s is in the declared list',
		(field, discoveredField, path) => {
			const ref = makeRef(path);
			const inv = makePluginInventory({ [field]: [ref] }, { [discoveredField]: [ref] });
			expect(detectPresentButUndeclared(inv)).toEqual([]);
		},
	);
});
