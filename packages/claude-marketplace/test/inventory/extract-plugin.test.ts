import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { extractClaudePluginInventory } from '../../src/inventory/extract-plugin.js';

const FIXTURE_BASE = safePath.resolve(__dirname, '../fixtures/inventory-plugin');
const SKILL_CLAUDE_PLUGIN_FIXTURE = 'skill-claude-plugin';
const MALFORMED_ASSETS_FIXTURE = 'malformed-assets';

describe('extractClaudePluginInventory', () => {
	describe('canonical fixture', () => {
		it('returns correct kind, vendor, shape', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, 'canonical'));

			expect(inv.kind).toBe('plugin');
			expect(inv.vendor).toBe('claude-code');
			expect(inv.shape).toBe('claude-plugin');
		});

		it('populates manifest from plugin.json', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, 'canonical'));

			expect(inv.manifest.name).toBe('canonical');
			expect(inv.manifest.version).toBe('1.0.0');
		});

		it('builds declared.skills as a 1-element array with correct ref', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, 'canonical'));

			expect(Array.isArray(inv.declared.skills)).toBe(true);
			expect(inv.declared.skills).toHaveLength(1);
			const skills = inv.declared.skills ?? [];
			const ref = skills[0];
			expect(ref?.manifestPath).toBe('./skills/foo');
			expect(ref?.exists).toBe(true);
		});

		it('returns null for undeclared component fields', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, 'canonical'));

			expect(inv.declared.commands).toBeNull();
			expect(inv.declared.agents).toBeNull();
			expect(inv.declared.hooks).toBeNull();
			expect(inv.declared.mcpServers).toBeNull();
			expect(inv.declared.lspServers).toBeNull();
		});

		it('discovers the foo skill', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, 'canonical'));

			expect(inv.discovered.skills).toHaveLength(1);
			const firstSkill = inv.discovered.skills[0];
			expect(firstSkill?.manifest.name).toBe('foo');
		});

		it('has no parse errors', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, 'canonical'));

			expect(inv.parseErrors).toEqual([]);
		});
	});

	describe('skill-claude-plugin fixture', () => {
		it('detects skill-claude-plugin shape', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, SKILL_CLAUDE_PLUGIN_FIXTURE));

			expect(inv.shape).toBe(SKILL_CLAUDE_PLUGIN_FIXTURE);
		});

		it('includes root SKILL.md in discovered.skills', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, SKILL_CLAUDE_PLUGIN_FIXTURE));

			expect(inv.discovered.skills.length).toBeGreaterThanOrEqual(1);
			const rootSkillPath = safePath.join(FIXTURE_BASE, SKILL_CLAUDE_PLUGIN_FIXTURE, 'SKILL.md');
			expect(inv.discovered.skills.some(s => s.path === rootSkillPath)).toBe(true);
		});

		it('returns null for declared.skills when manifest has no skills key', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, SKILL_CLAUDE_PLUGIN_FIXTURE));

			expect(inv.declared.skills).toBeNull();
		});
	});

	describe('tri-state fixture', () => {
		it('returns [] for explicit empty array (skills: [])', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, 'tri-state'));

			expect(inv.declared.skills).toEqual([]);
		});

		it('returns 1-element array for string path (commands: "./commands/cmd1.md")', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, 'tri-state'));

			expect(Array.isArray(inv.declared.commands)).toBe(true);
			expect(inv.declared.commands).toHaveLength(1);
			const commands = inv.declared.commands ?? [];
			const ref = commands[0];
			expect(ref?.manifestPath).toBe('./commands/cmd1.md');
			expect(ref?.exists).toBe(true);
		});

		it('returns null for absent agents field', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, 'tri-state'));

			expect(inv.declared.agents).toBeNull();
		});
	});

	describe('unexpected fixture', () => {
		it('reports unexpected skillManifests for SKILL.md outside skills/<name>/', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, 'unexpected'));

			const extraPath = safePath.join(FIXTURE_BASE, 'unexpected', 'extra', 'SKILL.md');
			expect(inv.unexpected.skillManifests).toContain(extraPath);
		});

		it('reports unexpected pluginManifests for nested .claude-plugin/plugin.json', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, 'unexpected'));

			const nestedPath = safePath.join(FIXTURE_BASE, 'unexpected', 'nested', '.claude-plugin', 'plugin.json');
			expect(inv.unexpected.pluginManifests).toContain(nestedPath);
		});
	});

	describe('missing plugin path edge case', () => {
		it('returns inventory with empty manifest and a parse error for non-existent path', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, 'does-not-exist'));

			expect(inv.kind).toBe('plugin');
			expect(inv.manifest).toEqual({});
			expect(inv.declared.skills).toBeNull();
			expect(inv.parseErrors.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('malformed-assets fixture (hooks.json + .mcp.json parse errors)', () => {
		it('populates parseErrors for malformed hooks/hooks.json', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, MALFORMED_ASSETS_FIXTURE));

			const hooksPath = safePath.join(FIXTURE_BASE, MALFORMED_ASSETS_FIXTURE, 'hooks', 'hooks.json');
			const hookErr = inv.parseErrors.find(e => e.path === hooksPath);
			expect(hookErr).toBeDefined();
			expect(hookErr?.message).toContain('hooks/hooks.json is not valid JSON');
		});

		it('populates parseErrors for malformed .mcp.json', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, MALFORMED_ASSETS_FIXTURE));

			const mcpPath = safePath.join(FIXTURE_BASE, MALFORMED_ASSETS_FIXTURE, '.mcp.json');
			const mcpErr = inv.parseErrors.find(e => e.path === mcpPath);
			expect(mcpErr).toBeDefined();
			expect(mcpErr?.message).toContain('.mcp.json is not valid JSON');
		});

		it('has no parse errors from plugin.json (which is valid)', async () => {
			const inv = await extractClaudePluginInventory(safePath.join(FIXTURE_BASE, MALFORMED_ASSETS_FIXTURE));

			const pluginJsonPath = safePath.join(
				FIXTURE_BASE, MALFORMED_ASSETS_FIXTURE, '.claude-plugin', 'plugin.json',
			);
			const pluginJsonErr = inv.parseErrors.find(e => e.path === pluginJsonPath);
			expect(pluginJsonErr).toBeUndefined();
		});
	});
});
