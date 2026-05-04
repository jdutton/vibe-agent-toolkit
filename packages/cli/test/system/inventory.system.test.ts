/**
 * System test: vat inventory command end-to-end.
 *
 * Tests against the committed claude-plugins-snapshot.zip fixture.
 * Reuses the shared getTestFixturesPath() helper for fixture extraction —
 * no duplication of extraction logic.
 *
 * --user mode: skipped in automated tests. Depends on the caller's ~/.claude
 * and cannot be made deterministic in CI. Manual smoke test is sufficient.
 */

import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	cleanupTestTempDir,
	createTestTempDir,
	getBinPath,
} from './test-common.js';
import { getTestFixturesPath } from './test-fixture-loader.js';
import { assertInventoryHasParseErrors, executeCli, parseYamlOutput } from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);

// Relative path components for the known-good fixture plugin used across test cases
const SUPERPOWERS_PATH_PARTS = ['cache', 'superpowers-marketplace', 'superpowers', '4.0.3'] as const;

const INVENTORY_SCHEMA = 'vat.inventory/v1alpha';

describe('vat inventory (system test)', () => {
	let tempDir: string;
	let fixtureDir: string;

	beforeAll(async () => {
		tempDir = createTestTempDir('vat-inventory-test-');
		fixtureDir = await getTestFixturesPath();
	}, 30_000);

	afterAll(() => {
		cleanupTestTempDir(tempDir);
	});

	describe('plugin inventory', () => {
		it('exits 0 and emits valid YAML with kind: plugin', () => {
			const pluginPath = safePath.join(fixtureDir, ...SUPERPOWERS_PATH_PARTS);
			const result = executeCli(binPath, ['inventory', pluginPath]);

			expect(result.status).toBe(0);
			expect(result.stdout).toBeTruthy();

			const parsed = parseYamlOutput(result.stdout);

			expect(parsed['schema']).toBe(INVENTORY_SCHEMA);
			expect(parsed['kind']).toBe('plugin');
			expect(parsed['vendor']).toBe('claude-code');
		});

		it('discovered.skills contains at least one entry for the superpowers plugin', () => {
			const pluginPath = safePath.join(fixtureDir, ...SUPERPOWERS_PATH_PARTS);
			const result = executeCli(binPath, ['inventory', pluginPath]);

			expect(result.status).toBe(0);

			const parsed = parseYamlOutput(result.stdout);
			const discovered = parsed['discovered'] as Record<string, unknown> | undefined;
			expect(discovered).toBeDefined();

			const skills = discovered?.['skills'];
			expect(Array.isArray(skills)).toBe(true);
			expect((skills as unknown[]).length).toBeGreaterThan(0);
		});

		it('--shallow omits nested skill inventories (paths only)', () => {
			const pluginPath = safePath.join(fixtureDir, ...SUPERPOWERS_PATH_PARTS);

			const full = executeCli(binPath, ['inventory', pluginPath]);
			const shallow = executeCli(binPath, ['inventory', pluginPath, '--shallow']);

			expect(full.status).toBe(0);
			expect(shallow.status).toBe(0);

			// Full output must be larger (contains nested skill frontmatter)
			expect(full.stdout.length).toBeGreaterThan(shallow.stdout.length);

			// Shallow output is still valid YAML with correct kind
			const parsedShallow = parseYamlOutput(shallow.stdout);
			expect(parsedShallow['kind']).toBe('plugin');
		});

		it('--format json emits valid JSON', () => {
			const pluginPath = safePath.join(fixtureDir, ...SUPERPOWERS_PATH_PARTS);
			const result = executeCli(binPath, ['inventory', pluginPath, '--format', 'json']);

			expect(result.status).toBe(0);

			let parsed: Record<string, unknown>;
			expect(() => {
				parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			}).not.toThrow();

			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(parsed!['kind']).toBe('plugin');
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(parsed!['schema']).toBe(INVENTORY_SCHEMA);
		});
	});

	describe('broken plugin (parse errors surface in output)', () => {
		let brokenPluginDir: string;

		beforeAll(() => {
			// Create a minimal plugin dir with invalid JSON in plugin.json
			brokenPluginDir = safePath.join(tempDir, 'broken-plugin');
			const pluginJsonDir = safePath.join(brokenPluginDir, '.claude-plugin');
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled path
			fs.mkdirSync(pluginJsonDir, { recursive: true });
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled path
			fs.writeFileSync(safePath.join(pluginJsonDir, 'plugin.json'), '{ invalid json !!!', 'utf-8');
		});

		it('exits 0 and surfaces parse errors in parseErrors[]', () => {
			// Inventory never throws on bad data — errors are structural output
			assertInventoryHasParseErrors(binPath, brokenPluginDir);
		});
	});

	describe('non-existent path', () => {
		it('exits 0 and surfaces a parseError for missing path', () => {
			const missingPath = safePath.join(tempDir, 'does-not-exist');
			// Extractor returns a valid PluginInventory with parseErrors — exit 0
			assertInventoryHasParseErrors(binPath, missingPath);
		});
	});

	describe('SKILL.md inventory', () => {
		it('exits 0 with kind: skill for a direct SKILL.md path', () => {
			const skillMd = safePath.join(
				fixtureDir,
				...SUPERPOWERS_PATH_PARTS,
				'skills',
				'brainstorming',
				'SKILL.md',
			);

			const result = executeCli(binPath, ['inventory', skillMd]);

			expect(result.status).toBe(0);

			const parsed = parseYamlOutput(result.stdout);
			expect(parsed['schema']).toBe(INVENTORY_SCHEMA);
			expect(parsed['kind']).toBe('skill');
		});
	});

	describe('no argument and no --user/--system', () => {
		it('exits 2 with an error', () => {
			const result = executeCli(binPath, ['inventory']);

			// Should fail with a clear message, not crash
			expect(result.status).toBe(2);
		});
	});

	describe('--system flag', () => {
		it('exits 2 with a not-implemented message', () => {
			const result = executeCli(binPath, ['inventory', '--system']);

			expect(result.status).toBe(2);
			expect(result.stderr).toContain('--system');
		});
	});

	// NOTE: --user is not tested here because it depends on the test runner's real ~/.claude
	// install, which is non-deterministic in CI. Manual smoke test:
	//   bun run vat inventory --user
});
