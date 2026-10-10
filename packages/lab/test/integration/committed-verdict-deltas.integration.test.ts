/**
 * The COMMITTED deltas file and the changelog it cites agree, both ways.
 *
 * `vat-lab verdict compare` refuses a deltas entry whose `changelog:` reference
 * does not name exactly one marker-carrying bullet — but only when someone runs
 * a crucible. Between runs, a changelog edit (a reworded bullet, a fragment
 * folded into `CHANGELOG.md`, a deleted file) could dangle every reference under
 * a green gate. This reads the same file through the same loader and resolver
 * the compare uses, on every gate.
 *
 * Both ways: every reference resolves to ONE bullet, and every
 * `<!-- verdict-delta:<id> -->` marker in the changelog is cited by an entry —
 * a marker nothing cites vouches for a delta nothing declares.
 *
 * Integration-tier: it reads committed files outside any fixture.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  bulletAnchors,
  CHANGELOG_REFERENCE_ROOT,
  changelogRefusals,
  COMMITTED_VERDICT_DELTAS,
  loadVerdictDeltas,
  readChangelogSources,
  type VerdictDeltas,
} from '../../src/facets/verdict/deltas.js';

const FRAGMENTS_DIR = '.changes';

function committedDeltas(): VerdictDeltas {
  const loaded = loadVerdictDeltas(COMMITTED_VERDICT_DELTAS);
  if (!loaded.ok) throw new Error(loaded.refusal);
  return loaded.deltas;
}

/** Every changelog file a marker can live in, as a deltas entry would cite it. */
function changelogFiles(): string[] {
  const fragments = readdirSync(safePath.join(CHANGELOG_REFERENCE_ROOT, FRAGMENTS_DIR))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `${FRAGMENTS_DIR}/${name}`);
  return ['CHANGELOG.md', ...fragments];
}

describe('the committed verdict deltas and the changelog', () => {
  it('declares at least one delta, so the checks below are not vacuous', () => {
    expect(committedDeltas().deltas.length).toBeGreaterThan(0);
  });

  it('cites, in every entry, exactly one marker-carrying bullet', () => {
    const deltas = committedDeltas();

    expect(changelogRefusals(deltas, readChangelogSources(deltas, CHANGELOG_REFERENCE_ROOT))).toStrictEqual([]);
  });

  it('cites every verdict-delta marker the changelog carries', () => {
    const cited = new Set(committedDeltas().deltas.map((entry) => entry.changelog));
    const carried = changelogFiles().flatMap((file) => {
      const ids = bulletAnchors(readFileSync(safePath.join(CHANGELOG_REFERENCE_ROOT, file), 'utf8')).keys();
      return [...ids].map((id) => `${file}#${id}`);
    });

    expect(carried.filter((reference) => !cited.has(reference))).toStrictEqual([]);
  });
});
