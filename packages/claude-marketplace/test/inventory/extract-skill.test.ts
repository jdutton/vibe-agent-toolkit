import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { extractClaudeSkillInventory } from '../../src/inventory/extract-skill.js';

const FIXTURE_DIR = safePath.resolve(__dirname, '../fixtures/inventory-skill');
const SKILL_MD = safePath.resolve(FIXTURE_DIR, 'SKILL.md');

describe('extractClaudeSkillInventory', () => {
	it('returns a ClaudeSkillInventory with correct manifest, paths, and linked files', async () => {
		const inv = await extractClaudeSkillInventory(SKILL_MD);

		expect(inv.kind).toBe('skill');
		expect(inv.vendor).toBe('claude-code');
		expect(inv.manifest.name).toBe('example-skill');
		expect(inv.manifest.description).toBe('Test skill for inventory extraction');
		expect(inv.files.skillMd.endsWith('SKILL.md')).toBe(true);
		expect(inv.files.linked.length).toBeGreaterThanOrEqual(1);
		expect(inv.files.linked.some(p => p.endsWith('reference.md'))).toBe(true);
		expect(inv.files.packaged).toEqual([]);
		expect(inv.parseErrors).toEqual([]);
	});

	it('returns a ClaudeSkillInventory with parseErrors when SKILL.md does not exist', async () => {
		const nonExistent = safePath.resolve(FIXTURE_DIR, 'does-not-exist/SKILL.md');
		const inv = await extractClaudeSkillInventory(nonExistent);

		expect(inv.kind).toBe('skill');
		expect(inv.vendor).toBe('claude-code');
		expect(inv.manifest.name).toBe('');
		expect(inv.parseErrors.length).toBeGreaterThanOrEqual(1);
	});
});
