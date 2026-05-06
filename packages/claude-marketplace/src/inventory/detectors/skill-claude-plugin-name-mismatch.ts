/**
 * Detector: SKILL_CLAUDE_PLUGIN_NAME_MISMATCH
 *
 * Pure function — no I/O. Consumes a ClaudePluginInventory and returns a
 * warning when the root SKILL.md frontmatter `name` disagrees with the
 * plugin.json `name`. Only fires for skill-claude-plugin shape (i.e., a plugin
 * directory that has both a root SKILL.md and a .claude-plugin/plugin.json).
 */

import type { ValidationIssue } from '@vibe-agent-toolkit/agent-skills';
import { safePath } from '@vibe-agent-toolkit/utils';

import type { ClaudePluginInventory } from '../types.js';

/**
 * Return a SKILL_CLAUDE_PLUGIN_NAME_MISMATCH warning when the plugin's
 * co-located root SKILL.md `name` frontmatter disagrees with `plugin.json`
 * `name`, or an empty array when the names agree, are absent, or the
 * inventory is not a skill-claude-plugin shape.
 */
export function detectSkillClaudePluginNameMismatch(inv: ClaudePluginInventory): ValidationIssue[] {
	if (inv.shape !== 'skill-claude-plugin') return [];
	if (inv.vendor !== 'claude-code') return [];

	const rootSkillPath = safePath.join(inv.path, 'SKILL.md');
	const rootSkill = inv.discovered.skills.find(s => s.path === rootSkillPath);
	if (rootSkill === undefined) return [];

	const skillName = rootSkill.manifest.name;
	const pluginName = inv.manifest.name;
	if (skillName === '' || pluginName === undefined || skillName === pluginName) return [];

	return [{
		severity: 'warning',
		code: 'SKILL_CLAUDE_PLUGIN_NAME_MISMATCH',
		message: `plugin.json name "${pluginName}" does not match co-located SKILL.md frontmatter name "${skillName}"`,
		location: safePath.join(inv.path, '.claude-plugin', 'plugin.json'),
		fix: 'Align the names: update plugin.json `name` to match SKILL.md `name` (the skill is authoritative), or intentionally namespace the plugin (configure `validation.severity` or `validation.allow` with a reason).',
	}];
}
