/**
 * Permanent regression guard: every finding the captured legacy pipeline
 * produced over the claude-plugins-snapshot.zip fixture must continue to
 * appear in audit output. Additions are fine; losses indicate a regression.
 * The legacy pipeline itself was deleted in Phase 4c — only the snapshot
 * remains.
 *
 * The snapshot has been re-anchored (never redefined) twice: once when
 * `ValidationIssue`'s anchor contract landed, and once when the anchor BASE
 * became the invocation scan root. See `capture-legacy-snapshot.ts` for both,
 * and `zero-loss-proof.ts` for the proof that gates any future re-capture.
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
					// `field` is compared too — otherwise re-anchoring a finding's
					// document-internal pointer would slip past this guard.
					f.field === want.field &&
					f.severity === want.severity &&
					f.path === want.path,
			);
			expect(matched, `legacy finding lost: ${JSON.stringify(want)}`).toBeDefined();
		}
		// newFindings.length >= legacy.length is allowed and expected.
	}, 60_000);
});
