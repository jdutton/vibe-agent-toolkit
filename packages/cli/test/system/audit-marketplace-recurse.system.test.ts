/**
 * System test: `vat audit <marketplace-dir>` recurses into co-located,
 * path-source plugins declared by the marketplace and audits each one with
 * the same pipeline used when audit is pointed directly at a plugin.
 *
 * Pre-existing behavior (before this test): audit against a marketplace
 * scanned only the marketplace.json itself (filesScanned: 1) and silently
 * skipped path-source plugins on disk. This test guards the new behavior so
 * the recursion never regresses.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { beforeAll, describe, expect, it } from 'vitest';

import {
	createSuiteContext,
	executeCliAndParseYaml,
} from './test-common.js';

// ---------------------------------------------------------------------------
// Suite-level constants
// ---------------------------------------------------------------------------

const TEMP_DIR_PREFIX = 'vat-audit-marketplace-recurse-';

const ctx = createSuiteContext(TEMP_DIR_PREFIX, import.meta.url);

const fixtureDir = safePath.join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'fixtures',
	'marketplace-with-plugins',
);

interface AuditYamlResult {
	summary?: { filesScanned?: number };
	files?: Array<{ type?: string; path?: string }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('vat audit — marketplace recursion (system test)', () => {
	beforeAll(ctx.setup);

	it('recurses into path-source plugins declared by the marketplace', async () => {
		const { result, parsed } = await executeCliAndParseYaml(
			ctx.binPath,
			['audit', fixtureDir],
		);

		expect(result.status).toBe(0);

		const audit = parsed as AuditYamlResult;
		const yamlResults = audit.files ?? [];
		// 1 marketplace + 2 plugins (foo, bar) + 1 skill (foo/skills/example) = 4 minimum.
		expect(audit.summary?.filesScanned ?? 0).toBeGreaterThanOrEqual(4);
		expect(yamlResults.length).toBeGreaterThanOrEqual(4);

		const types = yamlResults.map((r) => r.type);
		expect(types).toContain('marketplace');
		// claude-plugin appears twice (foo, bar)
		expect(types.filter((t) => t === 'claude-plugin').length).toBeGreaterThanOrEqual(2);
		expect(types).toContain('agent-skill');

		// Verify plugin paths are the co-located plugin roots, not the marketplace root.
		const pluginPaths = yamlResults
			.filter((r) => r.type === 'claude-plugin')
			.map((r) => r.path ?? '');
		const fooMatches = pluginPaths.some((p) => p.includes(safePath.join('plugins', 'foo')));
		const barMatches = pluginPaths.some((p) => p.includes(safePath.join('plugins', 'bar')));
		expect(fooMatches).toBe(true);
		expect(barMatches).toBe(true);

		// Verify the skill audited belongs to foo.
		const skillPaths = yamlResults
			.filter((r) => r.type === 'agent-skill')
			.map((r) => r.path ?? '');
		const exampleSkillFound = skillPaths.some((p) => p.includes(safePath.join('plugins', 'foo', 'skills', 'example')));
		expect(exampleSkillFound).toBe(true);
	});
});
