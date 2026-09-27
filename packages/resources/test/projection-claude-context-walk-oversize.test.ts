/**
 * The size cliff is NOT a reach rule: the launch walk skips an oversize file's
 * injected text, but the loader still stats it and `prunedBehind` follows its
 * imports — so its harness facts are read STRICTLY. A missing facts row there
 * is a producer bug and throws; it never reads as "imports nothing", which
 * would silently report nothing pruned behind the cliff.
 */

import { describe, expect, it } from 'vitest';

import { launchWalk } from '../src/projection/claude-context-walk.js';
import { CLAUDE_OVERSIZE_BYTES } from '../src/projection/harness/claude-code.js';
import { HarnessFactsAbsentError } from '../src/projection/harness/facts-index.js';
import type { Projection } from '../src/projection/projection.js';

import { claudeContextFixture } from './helpers/claude-context-fixture.js';

const BIG = 'big.md';
const BEHIND = 'behind.md';

/**
 * A root `CLAUDE.md` importing {@link BIG}, which imports {@link BEHIND} — with
 * `big.md`'s blob restamped past the cliff, the honest way to make it oversize
 * without writing 4 MiB into a fixture.
 *
 * @returns The projection and `big.md`'s content key
 */
async function oversizeChain(): Promise<{ projection: Projection; bigKey: string }> {
  const built = await claudeContextFixture({ 'CLAUDE.md': `@${BIG}\n`, [BIG]: `@${BEHIND}\n`, [BEHIND]: 'behind\n' });
  const bigKey = built.resourceRealizations.find((row) => row.path === BIG)?.contentKey;
  if (bigKey === undefined || bigKey === null) throw new Error('fixture: big.md is not keyed');
  const projection: Projection = {
    ...built,
    blobs: built.blobs.map((row) => (row.contentKey === bigKey ? { ...row, bytes: CLAUDE_OVERSIZE_BYTES + 1 } : row)),
  };
  return { projection, bigKey };
}

describe('launchWalk behind the size cliff', () => {
  it('reports the file pruned behind an oversize importer, read through its facts', async () => {
    const { projection } = await oversizeChain();

    const walk = launchWalk(projection, '');

    expect(walk.pruned.map((entry) => entry.path)).toEqual([BEHIND]);
  });

  it('throws a coded error — never prunes nothing — when the oversize importer has no facts row', async () => {
    const { projection, bigKey } = await oversizeChain();
    const underived: Projection = {
      ...projection,
      harnessBlobFacts: projection.harnessBlobFacts.filter((row) => row.blob !== bigKey),
    };

    expect(() => launchWalk(underived, '')).toThrow(HarnessFactsAbsentError);
  });
});
