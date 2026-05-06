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

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
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

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('MARKETPLACE_PLUGIN_SOURCE_MISSING');
	});

	// -------------------------------------------------------------------------
	// REFERENCE_TARGET_MISSING — deferred (references[] not yet populated by extractor)
	// -------------------------------------------------------------------------
	it.todo('REFERENCE_TARGET_MISSING — references[] not yet populated by extractor (Task 2.5)');
});
