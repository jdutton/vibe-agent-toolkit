/**
 * Warm edit seed, harness reach: an edit to `CLAUDE.md` that adds an `@`-import of a file the
 * harness never reached. The edited file's key is the only one uncovered; the newly reached
 * file's blob facts are held, but its `(blob, harness)` pair was never settled, so the miss
 * derives that pair, and the edited file's, and serves every other stored pair.
 *
 * The edit is uncommitted: `HEAD` never moves.
 */

import { appendFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import type { RecordedRuns } from '../helpers/cache-differential.js';
import { contentKeyAt, editSeed, editSeedCases, keysOf } from '../helpers/warm-edit-seeds.js';

const MEMORY = 'CLAUDE.md';

/** A file no import, rule or memory file reaches in the gate fixture. */
const NEWLY_REACHED = 'docs/two.md';

/** The harness relation a settled pair has a row in. */
const HARNESS_FACTS = 'harness_blob_facts';

/**
 * The content keys a recorded dump holds harness facts for.
 *
 * @param runs - The consumed runs
 * @param label - Which run's dump
 * @returns The `blob` column of each harness facts row
 */
function harnessFactKeys(runs: RecordedRuns, label: keyof RecordedRuns): unknown[] {
  const data = runs[label]?.query?.document['data'] as { rows?: ReadonlyArray<{ relation: string; row: string }> } | undefined;
  return (data?.rows ?? [])
    .filter((row) => row.relation === HARNESS_FACTS)
    .map((row) => (JSON.parse(row.row) as { blob: unknown }).blob);
}

/** The pairs the `vat validate` parent's `resources` phase derived, from its one dump that has the phase. */
function resourcesPhasePairs(runs: RecordedRuns): number | undefined {
  const dumps = (runs['warmSameHistory:measured']?.vatValidate?.work ?? []).filter((dump) => 'resources' in dump.phases);
  expect(dumps, 'one vat validate dump carries the resources phase').toHaveLength(1);
  return dumps[0]?.phases['resources']?.['harness.pairsDerived'];
}

const newlyReachedPair = editSeed({
  name: 'a newly reached harness pair',
  toB: (_arm, _dirs, corpus) => {
    appendFileSync(safePath.join(corpus, MEMORY), `\n@${NEWLY_REACHED}\n`);
    return Promise.resolve();
  },
  uncovered: (_dirs, corpus) => [contentKeyAt(corpus, MEMORY)],
  consumed: {
    runs: ['warmSameHistory:prime', 'warmSameHistory:measured', 'storeOff:measured'],
    check: (runs) => {
      const [reached] = keysOf(runs, 'warmSameHistory:prime', NEWLY_REACHED);
      expect(reached, `${NEWLY_REACHED}: keyed in the prime`).toBeDefined();
      expect(keysOf(runs, 'storeOff:measured', NEWLY_REACHED), `${NEWLY_REACHED}: its bytes unchanged`).toEqual([reached]);
      // Never settled in the prime, reached after the edit.
      expect(harnessFactKeys(runs, 'warmSameHistory:prime'), `${NEWLY_REACHED}: no pair in the prime`).not.toContain(reached);
      expect(harnessFactKeys(runs, 'storeOff:measured'), `${NEWLY_REACHED}: reached after the edit`).toContain(reached);
      // The miss derives exactly two pairs: the edited memory file's, and the newly reached file's.
      expect(resourcesPhasePairs(runs), 'harness pairs the warm vat validate derived').toBe(2);
    },
  },
});

describe('warm edit: harness reach', () => {
  for (const seed of editSeedCases([newlyReachedPair], import.meta.url)) it.skipIf(seed.unplantable)(seed.title, seed.run);
});
