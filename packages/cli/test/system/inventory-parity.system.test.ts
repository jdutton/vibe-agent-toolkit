/**
 * Parity harness: every finding from the captured legacy snapshot must appear
 * in the new inventory-pipeline output. Additions are allowed; losses are not.
 *
 * Phase 4a ships this test as skipped. Task 4a.4 removes the skip after the
 * new dispatch is wired in and verified to pass.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { type FindingTuple, collectFindings } from './audit-test-helpers.js';
import { getTestFixturesPath } from './test-fixture-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('inventory pipeline parity', () => {
	it('produces at-least the same findings as the captured legacy snapshot', async () => {
		const corpus = await getTestFixturesPath();
		const snapshotPath = safePath.join(__dirname, '../fixtures/legacy-audit-snapshot.json');

		// eslint-disable-next-line security/detect-non-literal-fs-filename -- path is constructed internally
		const legacy = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as FindingTuple[];

		const newFindings = await collectFindings(corpus);

		for (const want of legacy) {
			const matched = newFindings.find(
				(f) =>
					f.code === want.code &&
					f.location === want.location &&
					f.severity === want.severity &&
					f.path === want.path,
			);
			expect(matched, `legacy finding lost: ${JSON.stringify(want)}`).toBeDefined();
		}
		// newFindings.length >= legacy.length is allowed and expected.
	}, 60_000);
});
