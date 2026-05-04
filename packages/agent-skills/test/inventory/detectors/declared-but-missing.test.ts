import { describe, it, expect } from 'vitest';

import { detectDeclaredButMissing } from '../../../src/inventory/detectors/declared-but-missing.js';
import type { ComponentRef, HookRef, PluginInventory } from '../../../src/inventory/index.js';
import { makeComponentRef, makeHookRef, makePluginInventory } from '../plugin-inventory-fixtures.js';

const DECLARED_BUT_MISSING_CODE = 'COMPONENT_DECLARED_BUT_MISSING';
const SKILL_REF_PATH = 'skills/foo/SKILL.md';

// Each entry: [declared field, ref with exists:false, expected message fragment]
const FIELD_CASES: Array<[keyof PluginInventory['declared'], ComponentRef | HookRef, string]> = [
	['skills', makeComponentRef(SKILL_REF_PATH, false), SKILL_REF_PATH],
	['commands', makeComponentRef('commands/run.sh', false), 'commands'],
	['agents', makeComponentRef('agents/helper.md', false), 'agents'],
	['hooks', makeHookRef('hooks/post-install.sh', false), 'hooks'],
	['mcpServers', makeComponentRef('mcp/server.js', false), 'mcpServers'],
	['outputStyles', makeComponentRef('styles/default.css', false), 'outputStyles'],
	['lspServers', makeComponentRef('lsp/server.js', false), 'lspServers'],
];

describe('detectDeclaredButMissing', () => {
	it('returns no issues when declared list is null (auto-discovery)', () => {
		const inv = makePluginInventory({ skills: null });
		expect(detectDeclaredButMissing(inv)).toEqual([]);
	});

	it('returns no issues when all declared skills exist', () => {
		const inv = makePluginInventory({ skills: [makeComponentRef(SKILL_REF_PATH, true)] });
		expect(detectDeclaredButMissing(inv)).toEqual([]);
	});

	it.each(FIELD_CASES)('returns one issue for missing %s entry', (field, ref, expectedFragment) => {
		const inv = makePluginInventory({ [field]: [ref] });
		const issues = detectDeclaredButMissing(inv);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.code).toBe(DECLARED_BUT_MISSING_CODE);
		expect(issues[0]?.severity).toBe('warning');
		expect(issues[0]?.message).toContain(expectedFragment);
	});

	it('still emits an issue for a missing hook even when inline config is present', () => {
		const inv = makePluginInventory({
			hooks: [makeHookRef('hooks/setup.sh', false, { event: 'PostInstall' })],
		});
		const issues = detectDeclaredButMissing(inv);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.code).toBe(DECLARED_BUT_MISSING_CODE);
	});

	it('returns no issues when all field lists are null', () => {
		expect(detectDeclaredButMissing(makePluginInventory())).toEqual([]);
	});
});
