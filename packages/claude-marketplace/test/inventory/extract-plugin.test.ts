import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractClaudePluginInventory } from '../../src/inventory/extract-plugin.js';

const FIXTURE_BASE = safePath.resolve(__dirname, '../fixtures/inventory-plugin');
const SKILL_CLAUDE_PLUGIN_FIXTURE = 'skill-claude-plugin';
const MALFORMED_ASSETS_FIXTURE = 'malformed-assets';
const CLAUDE_PLUGIN_DIR = '.claude-plugin';
const PLUGIN_JSON = 'plugin.json';

/** Create a plugin root with .claude-plugin/plugin.json containing the given content. */
function makePluginWithManifest(root: string, content: string): string {
	const dir = safePath.join(root, CLAUDE_PLUGIN_DIR);
	mkdirSyncReal(dir, { recursive: true });
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
	writeFileSync(safePath.join(dir, PLUGIN_JSON), content);
	return root;
}

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

			const nestedPath = safePath.join(FIXTURE_BASE, 'unexpected', 'nested', CLAUDE_PLUGIN_DIR, PLUGIN_JSON);
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
				FIXTURE_BASE, MALFORMED_ASSETS_FIXTURE, CLAUDE_PLUGIN_DIR, PLUGIN_JSON,
			);
			const pluginJsonErr = inv.parseErrors.find(e => e.path === pluginJsonPath);
			expect(pluginJsonErr).toBeUndefined();
		});
	});

	describe('synthetic-fixture edge cases', () => {
		let tempDir = '';

		beforeAll(() => {
			tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-plugin-test-'));
		});

		afterAll(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		it('returns empty manifest when plugin dir has no plugin.json (and no SKILL.md)', async () => {
			const root = safePath.join(tempDir, 'no-manifest');
			mkdirSyncReal(root, { recursive: true });

			const inv = await extractClaudePluginInventory(root);

			expect(inv.shape).toBe('claude-plugin');
			expect(inv.manifest).toEqual({});
			expect(inv.declared.skills).toBeNull();
			expect(inv.parseErrors).toEqual([]);
		});

		it('records JSON parse error when plugin.json is malformed', async () => {
			const root = makePluginWithManifest(safePath.join(tempDir, 'bad-json'), '{ not valid');

			const inv = await extractClaudePluginInventory(root);

			expect(inv.parseErrors.length).toBeGreaterThanOrEqual(1);
			expect(inv.parseErrors[0]?.path).toContain('plugin.json');
		});

		it('records schema validation error and falls back to raw fields', async () => {
			// `name` is required to be a string — make it a number.
			// Other fields (version, description) are also numbers to exercise the typeof guards.
			const root = makePluginWithManifest(
				safePath.join(tempDir, 'schema-fail'),
				JSON.stringify({ name: 42, version: 7, description: false }),
			);

			const inv = await extractClaudePluginInventory(root);

			const schemaErr = inv.parseErrors.find(e => e.message.includes('schema validation failed'));
			expect(schemaErr).toBeDefined();
			// None of the typeof-string checks pass, so manifest stays empty.
			expect(inv.manifest).toEqual({});
		});

		it('records schema validation error but keeps string fields from raw manifest', async () => {
			// `name` valid, but `extras` introduces an invalid shape (e.g. version not a string).
			// Actually: ClaudePluginSchema requires `name: string`. We make `name` a number to fail,
			// but provide a string `description` to verify the typeof-string fallback.
			const root = makePluginWithManifest(
				safePath.join(tempDir, 'schema-fail-keep-strings'),
				JSON.stringify({ name: 0, version: '1.0.0', description: 'desc' }),
			);

			const inv = await extractClaudePluginInventory(root);

			const schemaErr = inv.parseErrors.find(e => e.message.includes('schema validation failed'));
			expect(schemaErr).toBeDefined();
			expect(inv.manifest.version).toBe('1.0.0');
			expect(inv.manifest.description).toBe('desc');
		});

		it('normalizes commands: null treated as explicit empty array', async () => {
			const root = makePluginWithManifest(
				safePath.join(tempDir, 'commands-null'),
				JSON.stringify({ name: 'p', commands: null }),
			);

			const inv = await extractClaudePluginInventory(root);

			expect(inv.declared.commands).toEqual([]);
		});

		it('normalizes hooks: string entry produces single-element list', async () => {
			const root = makePluginWithManifest(
				safePath.join(tempDir, 'hooks-string'),
				JSON.stringify({ name: 'p', hooks: './hooks/hook.json' }),
			);

			const inv = await extractClaudePluginInventory(root);

			expect(inv.declared.hooks).toHaveLength(1);
			expect(inv.declared.hooks?.[0]?.manifestPath).toBe('./hooks/hook.json');
		});

		it('normalizes hooks: empty array stays empty', async () => {
			const root = makePluginWithManifest(
				safePath.join(tempDir, 'hooks-empty'),
				JSON.stringify({ name: 'p', hooks: [] }),
			);

			const inv = await extractClaudePluginInventory(root);

			expect(inv.declared.hooks).toEqual([]);
		});

		it('normalizes hooks: array of strings produces refs for each', async () => {
			const root = makePluginWithManifest(
				safePath.join(tempDir, 'hooks-array'),
				JSON.stringify({ name: 'p', hooks: ['./a.json', './b.json'] }),
			);

			const inv = await extractClaudePluginInventory(root);

			expect(inv.declared.hooks).toHaveLength(2);
		});

		it('normalizes hooks: inline object becomes single ref with inline payload', async () => {
			const root = makePluginWithManifest(
				safePath.join(tempDir, 'hooks-inline'),
				JSON.stringify({ name: 'p', hooks: { PreToolUse: [{ matcher: '*' }] } }),
			);

			const inv = await extractClaudePluginInventory(root);

			expect(inv.declared.hooks).toHaveLength(1);
			const ref = inv.declared.hooks?.[0];
			expect(ref?.manifestPath).toBe('');
			expect(ref?.exists).toBe(false);
			expect((ref as { inline?: unknown })?.inline).toEqual({ PreToolUse: [{ matcher: '*' }] });
		});

		it('normalizes mcpServers: inline object becomes single ref with inline payload', async () => {
			const root = makePluginWithManifest(
				safePath.join(tempDir, 'mcp-inline'),
				JSON.stringify({ name: 'p', mcpServers: { someServer: { command: 'foo' } } }),
			);

			const inv = await extractClaudePluginInventory(root);

			expect(inv.declared.mcpServers).toHaveLength(1);
			const ref = inv.declared.mcpServers?.[0];
			expect((ref as { inline?: unknown })?.inline).toEqual({ someServer: { command: 'foo' } });
		});

		it('normalizes hooks: number value produces empty list (fallthrough branch)', async () => {
			const root = makePluginWithManifest(
				safePath.join(tempDir, 'hooks-number'),
				JSON.stringify({ name: 'p', hooks: 42 }),
			);

			const inv = await extractClaudePluginInventory(root);

			expect(inv.declared.hooks).toEqual([]);
		});

		it('skips a non-directory `skills` entry without throwing', async () => {
			// Make `skills` a regular file (not a directory) so readdir throws.
			const root = makePluginWithManifest(
				safePath.join(tempDir, 'skills-file'),
				JSON.stringify({ name: 'p' }),
			);
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
			writeFileSync(safePath.join(root, 'skills'), 'not a directory');

			const inv = await extractClaudePluginInventory(root);

			expect(inv.discovered.skills).toEqual([]);
		});

		it('discovers commands recursively (walks subdirectories)', async () => {
			const root = makePluginWithManifest(
				safePath.join(tempDir, 'nested-commands'),
				JSON.stringify({ name: 'p' }),
			);
			const subDir = safePath.join(root, 'commands', 'sub');
			mkdirSyncReal(subDir, { recursive: true });
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
			writeFileSync(safePath.join(root, 'commands', 'top.md'), '# top');
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp dir
			writeFileSync(safePath.join(subDir, 'nested.md'), '# nested');

			const inv = await extractClaudePluginInventory(root);

			expect(inv.discovered.commands).toHaveLength(2);
			const paths = inv.discovered.commands
				.map(c => c.manifestPath)
				.sort((a, b) => a.localeCompare(b));
			expect(paths[0]).toBe('./commands/sub/nested.md');
			expect(paths[1]).toBe('./commands/top.md');
		});

		it('handles non-existent commands subdirectory in walker via crawlForPattern', async () => {
			// Create a plugin with .claude-plugin nested but no commands dir; ensures crawlForPattern
			// silently handles missing subdirectories (covered indirectly via walkComponentDir's
			// catch when a subdirectory disappears under it).
			const root = makePluginWithManifest(
				safePath.join(tempDir, 'no-components'),
				JSON.stringify({ name: 'p' }),
			);

			const inv = await extractClaudePluginInventory(root);

			expect(inv.discovered.commands).toEqual([]);
			expect(inv.discovered.agents).toEqual([]);
			expect(inv.unexpected.skillManifests).toEqual([]);
		});
	});
});
