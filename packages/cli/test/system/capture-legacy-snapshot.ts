/**
 * One-shot capture script: freeze the legacy audit pipeline's output over the fixture corpus.
 *
 * Run once locally at the start of Chunk 4 / Phase 4a:
 *   bun run packages/cli/test/system/capture-legacy-snapshot.ts
 *
 * Output: packages/cli/test/fixtures/legacy-audit-snapshot.json
 *
 * NEVER run this in CI. The snapshot was captured once at the start of Phase 4a
 * and frozen for the lifetime of the regression baseline. Do not re-run unless
 * you intend to redefine the baseline.
 *
 * RE-ANCHORED TWICE (never redefined). Both re-captures were gated on the same
 * proof: the new run must reproduce every legacy tuple exactly on the dimensions
 * the change does NOT touch, with zero findings lost and zero added. If you
 * re-capture again, run `zero-loss-proof.ts` FIRST — a snapshot refreshed without
 * it cannot tell "we re-spelled the anchors" apart from "we stopped detecting
 * something".
 *
 *   1. `ValidationIssue`'s anchor contract: `location` became project-relative
 *      and document-internal pointers moved to the new `field`. Gated on
 *      `(path, code, severity)`. 200 -> 200.
 *   2. The anchor BASE became the invocation scan root instead of each
 *      resource's nearest-ancestor governing config. Under the old base every
 *      skill's `location` collapsed to the bare string `SKILL.md` (no config or
 *      git root exists inside a plugin cache, so the base was the skill's own
 *      directory), and distinct files could share one `location`. Gated on
 *      `(path, code, severity, field)`. 200 -> 200, multisets identical.
 *
 * Strategy: audit the corpus root recursively in one pass (mirrors what the
 * existing system tests and `vat audit <fixtureDir>` do). The full-corpus pass
 * surfaces skill issues inside cached plugins that per-directory audits miss.
 */

import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

import { type FindingTuple, collectFindings } from './audit-test-helpers.js';
import { getTestFixturesPath } from './test-fixture-loader.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = safePath.join(__dirname, '../fixtures');
const snapshotPath = safePath.join(fixturesDir, 'legacy-audit-snapshot.json');

// ---------------------------------------------------------------------------
// Summary helper
// ---------------------------------------------------------------------------

function topCodesByFrequency(tuples: FindingTuple[], n: number): Array<{ code: string; count: number }> {
	const counts = new Map<string, number>();
	for (const t of tuples) {
		counts.set(t.code, (counts.get(t.code) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([code, count]) => ({ code, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, n);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.error('=== capture-legacy-snapshot: starting ===');
	const start = Date.now();

	const corpus = await getTestFixturesPath();
	console.error(`corpus: ${corpus}`);

	// Audit the entire corpus root recursively in one pass.
	// This mirrors how existing system tests and `vat audit <fixtureDir>` work,
	// and surfaces skill issues inside cached plugins that per-directory audits miss.
	console.error('running collectFindings on corpus root (recursive)...');

	let sorted: FindingTuple[];
	try {
		sorted = await collectFindings(corpus);
	} catch (err) {
		console.error(`FATAL: audit crashed on corpus root: ${String(err)}`);
		process.exit(1);
	}

	console.error(`audit returned ${sorted.length.toString()} finding tuples`);

	// Write snapshot
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- path is constructed internally
	fsSync.writeFileSync(snapshotPath, `${JSON.stringify(sorted, null, 2)}\n`, 'utf-8');

	const elapsed = ((Date.now() - start) / 1000).toFixed(1);
	const top5 = topCodesByFrequency(sorted, 5);

	console.log(`snapshot written: ${snapshotPath}`);
	console.log(`total tuples: ${sorted.length.toString()}`);
	console.log(`elapsed: ${elapsed}s`);
	console.log('top 5 codes:');
	for (const { code, count } of top5) {
		console.log(`  ${code}: ${count.toString()}`);
	}
}

await main();
