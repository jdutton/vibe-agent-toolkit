/**
 * System test: vat inventory command end-to-end.
 *
 * Tests against the committed claude-plugins-snapshot.zip fixture.
 * Reuses the shared getTestFixturesPath() helper for fixture extraction —
 * no duplication of extraction logic.
 *
 * Every document is parsed with the verb's registered schema, so a shape the
 * registry does not describe is a red test here and not only in the writer.
 *
 * --user runs only over a fake HOME here: the caller's real ~/.claude cannot be
 * made deterministic in CI.
 */

import * as fs from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { INVENTORY_REPORT_SCHEMA } from '../../src/commands/inventory-schema.js';

import {
	cleanupTestTempDir,
	createTestTempDir,
	fakeHomeEnv,
	getBinPath,
	writeFileTree,
} from './test-common.js';
import { getTestFixturesPath } from './test-fixture-loader.js';
import { executeCli } from './test-helpers/index.js';

const binPath = getBinPath(import.meta.url);

// Relative path components for the known-good fixture plugin used across test cases
const SUPERPOWERS_PATH_PARTS = ['cache', 'superpowers-marketplace', 'superpowers', '4.0.3'] as const;

/** Run `vat inventory` and parse its document — YAML or JSON — with the registered schema. */
function inventory(args: readonly string[], env?: NodeJS.ProcessEnv): { status: number | null; stderr: string; stdout: string; report: ReturnType<typeof INVENTORY_REPORT_SCHEMA.parse> } {
	const result = executeCli(binPath, ['inventory', ...args], env === undefined ? {} : { env });
	return { status: result.status, stderr: result.stderr, stdout: result.stdout, report: INVENTORY_REPORT_SCHEMA.parse(yaml.parse(result.stdout)) };
}

/** The `data.inventory` of a completed run, as a record. */
function inventoryOf(report: ReturnType<typeof INVENTORY_REPORT_SCHEMA.parse>): Record<string, unknown> {
	if (report.status === 'error') throw new Error(`the run refused: ${report.error.code} ${report.error.message}`);
	return report.data.inventory as Record<string, unknown>;
}

/** Run `vat inventory` with `locked` at mode 000, restoring it after. */
function withLocked(locked: string, args: readonly string[], env?: NodeJS.ProcessEnv): ReturnType<typeof inventory> {
	fs.chmodSync(locked, 0o000);
	try {
		return inventory(args, env);
	} finally {
		fs.chmodSync(locked, 0o755);
	}
}

/** The locations of the report's findings, each asserted to be SCAN_PATH_UNREADABLE. */
function unreadableLocations(report: ReturnType<typeof INVENTORY_REPORT_SCHEMA.parse>): string[] {
	expect(report.status).toBe('findings');
	expect(report.findings.map((f) => f.code)).toEqual(report.findings.map(() => 'SCAN_PATH_UNREADABLE'));
	return report.findings.map((f) => f.location ?? '');
}

describe('vat inventory (system test)', () => {
	let tempDir: string;
	let fixtureDir: string;

	beforeAll(async () => {
		tempDir = createTestTempDir('vat-inventory-test-');
		fixtureDir = getTestFixturesPath();
	}, 30_000);

	afterAll(() => {
		cleanupTestTempDir(tempDir);
	});

	describe('plugin inventory', () => {
		it('exits 0 and publishes an ok report whose data.inventory is kind: plugin', () => {
			const { status, report } = inventory([safePath.join(fixtureDir, ...SUPERPOWERS_PATH_PARTS)]);

			expect(status).toBe(0);
			expect(report.status).toBe('ok');
			const inv = inventoryOf(report);
			// The inventory carries no version label — `kind` is the only discriminator.
			expect('schema' in inv).toBe(false);
			expect(inv['kind']).toBe('plugin');
			expect(inv['vendor']).toBe('claude-code');
			// The plugin and each of its skills.
			expect(report.examined).toBe(1 + ((inv['discovered'] as { skills: unknown[] }).skills.length));
		});

		it('discovered.skills contains at least one entry for the superpowers plugin', () => {
			const { report } = inventory([safePath.join(fixtureDir, ...SUPERPOWERS_PATH_PARTS)]);

			const skills = (inventoryOf(report)['discovered'] as { skills: unknown }).skills;
			expect(Array.isArray(skills)).toBe(true);
			expect((skills as unknown[]).length).toBeGreaterThan(0);
		});

		it('--shallow marks nested skill inventories as not walked, under the same key', () => {
			const pluginPath = safePath.join(fixtureDir, ...SUPERPOWERS_PATH_PARTS);

			const full = inventory([pluginPath]);
			const shallow = inventory([pluginPath, '--shallow']);

			expect(full.status).toBe(0);
			expect(shallow.status).toBe(0);
			const inv = inventoryOf(shallow.report);
			expect(inv['kind']).toBe('plugin');
			expect(inv['projection']).toBe('shallow');
			expect((inv['discovered'] as { skills: unknown }).skills).toBeNull();
			// A projection is a rendering choice, not less work: both runs inventoried the same.
			expect(shallow.report.examined).toBe(full.report.examined);
		});

		it('--format json emits the same report as JSON', () => {
			const { status, stdout, report } = inventory([safePath.join(fixtureDir, ...SUPERPOWERS_PATH_PARTS), '--format', 'json']);

			expect(status).toBe(0);
			expect(() => JSON.parse(stdout) as unknown).not.toThrow();
			expect(inventoryOf(report)['kind']).toBe('plugin');
			expect(stdout).not.toContain('"schema"');
		});
	});

	describe('broken plugin (parse errors surface in data, not as findings)', () => {
		it('exits 0 with the parse error in data.inventory.parseErrors[]', () => {
			// Invalid JSON in plugin.json: the inventory records it; judging it is `vat audit`'s job.
			const brokenPluginDir = safePath.join(tempDir, 'broken-plugin');
			fs.mkdirSync(safePath.join(brokenPluginDir, '.claude-plugin'), { recursive: true });
			fs.writeFileSync(safePath.join(brokenPluginDir, '.claude-plugin', 'plugin.json'), '{ invalid json !!!', 'utf-8');

			const { status, report } = inventory([brokenPluginDir]);

			expect(status).toBe(0);
			expect(report.status).toBe('ok');
			const inv = inventoryOf(report);
			expect(inv['kind']).toBe('plugin');
			expect((inv['parseErrors'] as unknown[]).length).toBeGreaterThan(0);
		});
	});

	describe('non-existent path', () => {
		it('refuses with USAGE_INVALID at exit 2 — never an inventory of nothing', () => {
			const { status, report } = inventory([safePath.join(tempDir, 'does-not-exist')]);

			expect(status).toBe(2);
			expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' } });
		});
	});

	describe('SKILL.md inventory', () => {
		it('exits 0 with kind: skill for a direct SKILL.md path', () => {
			const skillMd = safePath.join(fixtureDir, ...SUPERPOWERS_PATH_PARTS, 'skills', 'brainstorming', 'SKILL.md');

			const { status, report } = inventory([skillMd]);

			expect(status).toBe(0);
			expect(inventoryOf(report)['kind']).toBe('skill');
			expect(report.examined).toBe(1);
		});
	});

	describe('no argument and no --user/--system', () => {
		it('refuses with USAGE_INVALID at exit 2', () => {
			const { status, report } = inventory([]);

			expect(status).toBe(2);
			expect(report).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' } });
		});
	});

	describe('--system flag', () => {
		it('refuses with NOT_IMPLEMENTED at exit 2, naming the flag on stderr', () => {
			const { status, stderr, report } = inventory(['--system']);

			expect(status).toBe(2);
			expect(report).toMatchObject({ status: 'error', error: { code: 'NOT_IMPLEMENTED' } });
			expect(stderr).toContain('--system');
		});
	});

	/**
	 * A path the OS refuses is not inventoried, so the run is never `ok`: every
	 * lane's read failure carries the `unreadable` mark the finding is built from.
	 * Each case restores the mode it took away before the suite removes tempDir.
	 */
	describe.skipIf(CANNOT_DENY_READS)('a path the OS refuses is a SCAN_PATH_UNREADABLE finding, never ok', () => {
		it('--user: an unreadable ~/.claude/plugins is refused, not read as an empty install', () => {
			const home = safePath.join(tempDir, 'home-locked');
			const plugins = safePath.join(home, '.claude', 'plugins');
			fs.mkdirSync(safePath.join(plugins, 'marketplaces'), { recursive: true });

			const { status, report } = withLocked(plugins, ['--user'], { ...process.env, ...fakeHomeEnv(home) });

			expect(status).toBe(0);
			expect(unreadableLocations(report)).toContain('plugins/marketplaces');
		});

		it('plugin lane: an unreadable plugin.json', () => {
			const dir = safePath.join(tempDir, 'locked-manifest');
			writeFileTree(dir, { '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }) });

			const { status, report } = withLocked(safePath.join(dir, '.claude-plugin', 'plugin.json'), [dir]);

			expect(status).toBe(0);
			expect(unreadableLocations(report)).toEqual(['.claude-plugin/plugin.json']);
		});

		it('skill lane: an unreadable SKILL.md inside a plugin', () => {
			const dir = safePath.join(tempDir, 'locked-skill');
			writeFileTree(dir, {
				'.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
				'skills/s/SKILL.md': '---\nname: s\ndescription: A skill.\n---\n\n# s\n',
			});

			const { status, report } = withLocked(safePath.join(dir, 'skills', 's', 'SKILL.md'), [dir]);

			expect(status).toBe(0);
			expect(unreadableLocations(report)).toEqual(['skills/s/SKILL.md']);
		});

		it('an unreadable SKILL.md named as the subject refuses with INPUT_UNREADABLE — nothing was inventoried', () => {
			const dir = safePath.join(tempDir, 'locked-subject');
			writeFileTree(dir, { 'SKILL.md': '---\nname: s\ndescription: A skill.\n---\n' });
			const skillMd = safePath.join(dir, 'SKILL.md');

			const { status, report } = withLocked(skillMd, [skillMd]);

			expect(status).toBe(2);
			expect(report).toMatchObject({ status: 'error', error: { code: 'INPUT_UNREADABLE' } });
		});
	});

	// NOTE: --user over the runner's REAL ~/.claude is not tested (non-deterministic in CI;
	// the refusal case above uses a fake HOME). Manual smoke test:
	//   bun run vat inventory --user
});
