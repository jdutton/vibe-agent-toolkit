/**
 * Zero-loss proof that gates a RE-ANCHOR of `legacy-audit-snapshot.json`.
 *
 * The frozen baseline is 200 findings. A change that re-spells anchors
 * (`location`, `field`) must not change WHICH findings are detected — and a
 * snapshot refreshed without proving that cannot tell "we re-spelled the
 * anchors" apart from "we stopped detecting something".
 *
 * The proof: compare MULTISETS of the tuple dimensions the change does not
 * touch — `(path, code, severity, field)` — between the frozen baseline and a
 * fresh run. Identical multisets, in both directions, means a re-anchor is safe.
 * Any delta means STOP.
 *
 * Run:
 *   bun run packages/cli/test/system/zero-loss-proof.ts
 *
 * Exits non-zero and prints the delta when the proof fails.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';

import { type FindingTuple, collectFindings } from './audit-test-helpers.js';
import { getTestFixturesPath } from './test-fixture-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The dimensions a location re-anchor must leave byte-identical. */
function invariantKey(t: FindingTuple): string {
  return JSON.stringify([t.path, t.code, t.severity, t.field]);
}

function multiset(tuples: FindingTuple[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tuples) {
    const k = invariantKey(t);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function diff(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [k, n] of a) {
    const m = b.get(k) ?? 0;
    if (n !== m) out.push(`  ${k}: baseline=${n} fresh=${m}`);
  }
  for (const [k, m] of b) {
    if (!a.has(k)) out.push(`  ${k}: baseline=0 fresh=${m}`);
  }
  return out;
}

async function main(): Promise<void> {
  const corpus = await getTestFixturesPath();
  const snapshotPath = safePath.join(__dirname, '../fixtures/legacy-audit-snapshot.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is constructed internally
  const baseline = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as FindingTuple[];
  const fresh = await collectFindings(corpus);

  console.log(`baseline findings: ${baseline.length.toString()}`);
  console.log(`fresh findings:    ${fresh.length.toString()}`);

  const delta = diff(multiset(baseline), multiset(fresh));
  if (delta.length > 0) {
    console.error(`FAIL: (path, code, severity, field) multisets differ in ${delta.length.toString()} place(s):`);
    for (const line of delta) console.error(line);
    process.exit(1);
  }

  console.log('PASS: (path, code, severity, field) multisets are identical — zero findings lost, zero added.');
  console.log('Only `location` spelling changed; a re-capture is a re-anchor, not a redefinition.');
}

await main();
