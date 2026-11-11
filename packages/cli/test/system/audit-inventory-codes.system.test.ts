/**
 * System test: `vat audit` emits inventory-detector codes (Task 3.4).
 *
 * Exercises the four inventory-driven detectors wired into `getValidationResults`
 * in Task 3.4. Uses the loader-semantics research fixtures for declared-but-missing
 * and a small inline fixture under test/fixtures/inventory-codes/ for the
 * present-but-undeclared and marketplace-missing-source cases.
 *
 * REFERENCE_TARGET_MISSING is not exercised here — references[] is not yet
 * populated by the extractor (Task 2.5 left it as []).
 */

import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { overOutputRowsMarkdown } from '@vibe-agent-toolkit/utils/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import {
	createSuiteContext,
	executeCli,
	executeCliAndParseYaml,
} from './test-common.js';

// ---------------------------------------------------------------------------
// Suite-level constants
// ---------------------------------------------------------------------------

const TEMP_DIR_PREFIX = 'vat-audit-inventory-codes-';

const ctx = createSuiteContext(TEMP_DIR_PREFIX, import.meta.url);

const fixturesBase = safePath.join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'fixtures',
	'inventory-codes',
);

const loaderSemanticsBase = safePath.join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..',
	'..',
	'docs',
	'research',
	'fixtures',
	'loader-semantics',
);

/** The linked document {@link refusedProject}'s skill links, root-relative. */
const REFUSED = 'skills/linker/reference.md';

/**
 * A project that is a plugin, its one skill linking a document too large to parse.
 *
 * @param resources - The `resources:` block's lines, or `null` for a project with no config file
 * @returns The project root
 */
function refusedProject(resources: readonly string[] | null): string {
	const root = ctx.createTempDir();
	const skillDir = safePath.join(root, 'skills', 'linker');
	mkdirSyncReal(safePath.join(root, '.claude-plugin'), { recursive: true });
	mkdirSyncReal(skillDir, { recursive: true });
	if (resources !== null) {
		writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), ['resources:', ...resources, ''].join('\n'));
	}
	writeFileSync(safePath.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', version: '0.0.1', description: 'Fixture plugin.' }));
	writeFileSync(
		safePath.join(skillDir, 'SKILL.md'),
		'---\nname: linker\ndescription: Fixture skill linking one reference document too large to parse.\n---\n\n# linker\n\nSee [the reference](reference.md).\n',
	);
	writeFileSync(safePath.join(skillDir, 'reference.md'), overOutputRowsMarkdown('SKILL.md'));
	return root;
}

/** The audit's refusal findings for one project, audited at `target` (the project root by default). */
async function refusals(root: string, target = root): Promise<{ status: number | null; found: Array<Record<string, unknown>>; stderr: string }> {
	const { result, parsed } = await executeCliAndParseYaml(ctx.binPath, ['audit', target]);
	const findings = (parsed['findings'] ?? []) as Array<Record<string, unknown>>;
	return { status: result.status, found: findings.filter((finding) => finding['code'] === 'RESOURCE_PARSE_LIMIT_EXCEEDED'), stderr: result.stderr };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('vat audit — inventory detector codes (system test)', () => {
	beforeAll(ctx.setup);

	// -------------------------------------------------------------------------
	// COMPONENT_DECLARED_BUT_MISSING
	// -------------------------------------------------------------------------
	it('emits COMPONENT_DECLARED_BUT_MISSING when a declared skill path does not exist', async () => {
		const fixturePath = safePath.join(loaderSemanticsBase, 'declared-but-missing');
		const result = await executeCli(ctx.binPath, ['audit', fixturePath]);

		// Audit always exits 0 — it is advisory only
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('COMPONENT_DECLARED_BUT_MISSING');
	});

	// -------------------------------------------------------------------------
	// COMPONENT_PRESENT_BUT_UNDECLARED
	// -------------------------------------------------------------------------
	it('emits COMPONENT_PRESENT_BUT_UNDECLARED when manifest has explicit empty skills list', async () => {
		const fixturePath = safePath.join(fixturesBase, 'present-but-undeclared-explicit');
		const result = await executeCli(ctx.binPath, ['audit', fixturePath]);

		// Audit always exits 0
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('COMPONENT_PRESENT_BUT_UNDECLARED');
	});

	// -------------------------------------------------------------------------
	// present-but-undeclared fixture in loader-semantics does NOT fire
	// because its manifest omits the skills field (auto-discovery is intentional)
	// -------------------------------------------------------------------------
	it('does NOT emit COMPONENT_PRESENT_BUT_UNDECLARED when manifest has no skills field', async () => {
		const fixturePath = safePath.join(loaderSemanticsBase, 'present-but-undeclared');
		const result = await executeCli(ctx.binPath, ['audit', fixturePath]);

		expect(result.status).toBe(0);
		expect(result.stdout).not.toContain('COMPONENT_PRESENT_BUT_UNDECLARED');
	});

	// -------------------------------------------------------------------------
	// MARKETPLACE_PLUGIN_SOURCE_MISSING
	// -------------------------------------------------------------------------
	it('emits MARKETPLACE_PLUGIN_SOURCE_MISSING for a marketplace with a missing path-source plugin', async () => {
		const fixturePath = safePath.join(fixturesBase, 'marketplace-missing-source');
		const { result } = await executeCliAndParseYaml(ctx.binPath, ['audit', fixturePath]);

		// Exit 1: the exit code follows `status`, and this tree has an error-severity finding.
		expect(result.status).toBe(1);
		expect(result.stdout).toContain('MARKETPLACE_PLUGIN_SOURCE_MISSING');
	});

	// -------------------------------------------------------------------------
	// RESOURCE_PARSE_LIMIT_EXCEEDED — a linked document the crawl refused to parse
	// -------------------------------------------------------------------------
	it('files a linked document the crawl refused to parse once, under its own code, not PLUGIN_INVALID_JSON', async () => {
		const plugin = refusedProject(null);

		const result = await executeCli(ctx.binPath, ['audit', plugin]);

		expect(result.status).toBe(1);
		expect(result.stdout.match(/RESOURCE_PARSE_LIMIT_EXCEEDED/g)?.length ?? 0).toBeGreaterThan(0);
		expect(result.stdout).toContain('reference.md');
		expect(result.stdout).not.toContain('PLUGIN_INVALID_JSON');
	});

	// The refusal resolves through the SUBJECT project's `resources.validation` —
	// its allow list and its severity — as every other verb resolves it, located
	// against the one root the audit reports from.
	describe('a refused linked document under the subject project\'s resources.validation', () => {
		it('is an error at its root-relative path, in the one refusal sentence, and fails the audit', async () => {
			const { status, found, stderr } = await refusals(refusedProject(['  include: ["**/*.md"]']));

			// Once per audited subject that reaches it (the plugin and its skill), each alike.
			expect(found.length, stderr).toBeGreaterThan(0);
			for (const finding of found) {
				expect(finding).toStrictEqual(expect.objectContaining({ severity: 'error', location: REFUSED }));
				expect(String(finding['message'])).toMatch(new RegExp(`^'${REFUSED}' was enumerated but its parse was stopped at its outputRows limit`));
			}
			expect(status).toBe(1);
		});

		it('is a warning when the project sets its severity to warning', async () => {
			const { found, stderr } = await refusals(refusedProject(['  validation:', '    severity:', '      RESOURCE_PARSE_LIMIT_EXCEEDED: warning']));

			expect(found.length, stderr).toBeGreaterThan(0);
			for (const finding of found) expect(finding).toStrictEqual(expect.objectContaining({ severity: 'warning', location: REFUSED }));
		});

		it('is no finding when the project allows it at its path', async () => {
			const { found, stderr } = await refusals(refusedProject([
				'  validation:',
				'    allow:',
				'      RESOURCE_PARSE_LIMIT_EXCEEDED:',
				`        - paths: ["${REFUSED}"]`,
				'          reason: seeded refusal, excused at its one path',
			]));

			expect(found, stderr).toStrictEqual([]);
		});

		it('locates it against the audited directory, and still matches the allow entry at its project path', async () => {
			const strict = refusedProject(['  include: ["**/*.md"]']);
			const allowed = refusedProject([
				'  validation:',
				'    allow:',
				'      RESOURCE_PARSE_LIMIT_EXCEEDED:',
				`        - paths: ["${REFUSED}"]`,
				'          reason: seeded refusal, excused at its one path',
			]);

			const located = await refusals(strict, safePath.join(strict, 'skills'));
			const excused = await refusals(allowed, safePath.join(allowed, 'skills'));

			expect(located.found.length, located.stderr).toBeGreaterThan(0);
			for (const finding of located.found) expect(finding['location']).toBe('linker/reference.md');
			expect(excused.found, excused.stderr).toStrictEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// REFERENCE_TARGET_MISSING — NOT COVERED by this inventory.
	//
	// The extractor does not populate references[] yet, so there is no fixture
	// that can make this code fire. Recorded as a comment rather than as a
	// registered-but-never-run case: such a case reads as a listed test in the
	// suite output, which is a coverage claim this file cannot back. Add a real
	// case here when the extractor starts populating references[].
	// -------------------------------------------------------------------------
});
