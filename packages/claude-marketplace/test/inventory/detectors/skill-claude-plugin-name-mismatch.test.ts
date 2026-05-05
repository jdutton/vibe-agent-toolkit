import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { detectSkillClaudePluginNameMismatch } from '../../../src/inventory/detectors/skill-claude-plugin-name-mismatch.js';
import { ClaudePluginInventory, ClaudeSkillInventory } from '../../../src/inventory/types.js';

const PLUGIN_PATH = '/test/plugins/my-plugin';
const PLUGIN_JSON_PATH = safePath.join(PLUGIN_PATH, '.claude-plugin', 'plugin.json');
const ROOT_SKILL_PATH = safePath.join(PLUGIN_PATH, 'SKILL.md');

function makeRootSkill(name: string): ClaudeSkillInventory {
	return new ClaudeSkillInventory({
		path: ROOT_SKILL_PATH,
		manifest: { name },
		files: { skillMd: ROOT_SKILL_PATH, linked: [], packaged: [] },
		parseErrors: [],
	});
}

function makePluginInventory(overrides: {
	shape?: ClaudePluginInventory['shape'];
	manifestName?: string;
	skillName?: string;
	includeRootSkill?: boolean;
}): ClaudePluginInventory {
	const {
		shape = 'skill-claude-plugin',
		manifestName = 'my-plugin',
		skillName = 'my-plugin',
		includeRootSkill = true,
	} = overrides;

	const skills = includeRootSkill ? [makeRootSkill(skillName)] : [];

	return new ClaudePluginInventory({
		path: PLUGIN_PATH,
		shape,
		manifest: { name: manifestName, version: '1.0.0' },
		declared: {
			skills: null,
			commands: null,
			agents: null,
			hooks: null,
			mcpServers: null,
			outputStyles: null,
			lspServers: null,
		},
		discovered: { skills, commands: [], agents: [] },
		references: [],
		unexpected: { skillManifests: [], pluginManifests: [] },
		parseErrors: [],
	});
}

describe('detectSkillClaudePluginNameMismatch', () => {
	it('returns no issues when names match', () => {
		const inv = makePluginInventory({ skillName: 'my-plugin', manifestName: 'my-plugin' });

		expect(detectSkillClaudePluginNameMismatch(inv)).toEqual([]);
	});

	it('returns a warning when skill name differs from plugin name', () => {
		const inv = makePluginInventory({ skillName: 'the-skill-name', manifestName: 'the-plugin-name' });

		const issues = detectSkillClaudePluginNameMismatch(inv);

		expect(issues).toHaveLength(1);
		const issue = issues[0];
		expect(issue?.severity).toBe('warning');
		expect(issue?.code).toBe('SKILL_CLAUDE_PLUGIN_NAME_MISMATCH');
		expect(issue?.message).toBe(
			'plugin.json name "the-plugin-name" does not match co-located SKILL.md frontmatter name "the-skill-name"',
		);
		expect(issue?.location).toBe(PLUGIN_JSON_PATH);
		expect(issue?.fix).toBe(
			'Align the names: update plugin.json `name` to match SKILL.md `name` (the skill is authoritative), or intentionally namespace the plugin (configure `validation.severity` or `validation.allow` with a reason).',
		);
	});

	it('returns no issues for claude-plugin shape (no root SKILL.md)', () => {
		const inv = makePluginInventory({ shape: 'claude-plugin', includeRootSkill: false });

		expect(detectSkillClaudePluginNameMismatch(inv)).toEqual([]);
	});

	it('returns no issues when root skill is not found in discovered.skills', () => {
		const inv = makePluginInventory({ includeRootSkill: false });

		expect(detectSkillClaudePluginNameMismatch(inv)).toEqual([]);
	});

	it('returns no issues when plugin name is undefined', () => {
		const inv = new ClaudePluginInventory({
			path: PLUGIN_PATH,
			shape: 'skill-claude-plugin',
			manifest: {},
			declared: {
				skills: null,
				commands: null,
				agents: null,
				hooks: null,
				mcpServers: null,
				outputStyles: null,
				lspServers: null,
			},
			discovered: { skills: [makeRootSkill('my-skill')], commands: [], agents: [] },
			references: [],
			unexpected: { skillManifests: [], pluginManifests: [] },
			parseErrors: [],
		});

		expect(detectSkillClaudePluginNameMismatch(inv)).toEqual([]);
	});

	it('returns no issues when skill name is empty string', () => {
		const inv = makePluginInventory({ skillName: '', manifestName: 'my-plugin' });

		expect(detectSkillClaudePluginNameMismatch(inv)).toEqual([]);
	});
});
