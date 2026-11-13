/**
 * I0, the divergence seed: a wrong parse-cache entry the comparison must catch.
 *
 * Cold's parse tree gets one entry, filed under the real bytes' content key of
 * `docs/one.md`, holding the facts of a forged text: a sentinel heading and a
 * link to a file that does not exist. The entry is schema-valid, so the run
 * serves it as a hit, and the dump must name exactly the relations those facts
 * reach. Store-off stays the clean reference: the plant goes in the store-on arm.
 *
 * `claude context` is not run: its tokens come from its own read of the raw
 * bytes, never from the parse cache, so it cannot see the plant.
 */

import { computeContentKey, parseContentCached, ParseCache } from '@vibe-agent-toolkit/resources';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { corpusBytes, FORGED_SENTINEL, GATE_FIXTURE, seedSuite, seedTitle, type I0Seed } from '../helpers/cache-differential.js';

const FORGED_PATH = 'docs/one.md';

/** `docs/one.md` with its heading replaced by the sentinel and one more link, to a file that is not there. */
function forgedText(): string {
  const real = GATE_FIXTURE[FORGED_PATH];
  if (real === undefined) throw new Error(`the gate fixture has no ${FORGED_PATH}`);
  return real.replace('# One\n', `# ${FORGED_SENTINEL}\n\nSee [the missing page](./missing.md).\n`);
}

const forgedParseEntry: I0Seed = {
  needs: null,
  name: 'forgedParseEntry',
  arms: ['storeOff', 'cold'],
  verbs: ['validate', 'check', 'query'],
  beforeRun: async (arm, dirs, corpus) => {
    if (arm !== 'cold') return;
    const forged = await parseContentCached(forgedText(), 'markdown', { dispatcher: undefined, cache: new ParseCache({ enabled: false }) });
    const filed = await new ParseCache({ cacheDir: dirs.parse, enabled: true })
      .setByKey(computeContentKey(corpusBytes(corpus, FORGED_PATH), 'markdown'), forged);
    expect(filed, 'the forged entry was persisted').toBe(true);
  },
  expect: {
    diverges: {
      relations: ['blobs', 'blob_sections', 'blob_references', 'edges', 'edge_resolutions'],
      verbs: ['validate', 'check', 'query'],
    },
  },
  consumed: {
    runs: ['cold:measured', 'storeOff:measured'],
    check: (runs) => {
      expect(runs['cold:measured']?.query?.stdout).toContain(FORGED_SENTINEL);
      expect(runs['storeOff:measured']?.query?.stdout).not.toContain(FORGED_SENTINEL);
    },
  },
};

const suite = seedSuite(import.meta.url);

describe('a forged parse-cache entry is caught by relation', () => {
  beforeAll(suite.setup);
  afterAll(suite.cleanup);

  it(seedTitle(forgedParseEntry), async () => {
    expect(await suite.run(forgedParseEntry)).toEqual(forgedParseEntry.arms);
  });
});
