/**
 * I0 over the workspace relations (spec 6.4): one clean corpus per layout (`../helpers/workspace-rows.ts`:
 * npm with canonicalised patterns, yarn berry's `{ packages }` and root-relative `workspace:` paths,
 * bun's `link:`, `file:` and duplicate names, and pnpm with catalogs kept as written, the
 * `workspace:<path>` and `workspace:<alias>@` forms, and an `.npmrc` the step never reads) answers a
 * census of `workspace_packages`, `workspace_dependencies` and `workspace_conditions`, and of every
 * `data__*` relation, identically store-off, cold, warm and with half the blob tier evicted; the
 * census holds rows in every relation, then the layout's own answer, before it is compared.
 *
 * One seed over the pnpm corpus, store-off against warm: half the row-set tier evicted after the
 * prime, so the warm run re-extracts exactly those row sets and answers the same.
 */

import { describe, expect, it } from 'vitest';

import { seedRunner, seedTitle, treeSeedSuite, type I0Seed } from '../helpers/cache-differential.js';
import { rowSetEvictionSeed } from '../helpers/data-rows.js';
import { cleanLayoutSeed, expectWorkspaceCensus, layoutTree, PNPM, routedPairsOf, WORKSPACE_LAYOUTS } from '../helpers/workspace-rows.js';

/**
 * Every other stored row set evicted after the warm prime of the pnpm corpus: the workspace step's
 * declared reads meet the gaps and the run re-extracts exactly them.
 */
const ROW_SET_EVICTION: I0Seed = rowSetEvictionSeed('workspaceRowSetEviction', routedPairsOf(PNPM), (runs) => {
  expectWorkspaceCensus(runs, PNPM.answer, PNPM.npmrcSetting);
});

/**
 * One suite per corpus: each registers its hooks and runs its seeds.
 *
 * Reds, each seeded once and reverted against an earlier form of the step:
 * - the npm layout's only workspace condition removed (so its corpus held none): "npm",
 *   "storeOff:measured: relations with no row", `['workspace_conditions']`, before any comparison,
 *   1 failure;
 * - `workspace-packages.ts` `docOf` keeping shadowed nodes, later occurrences first (so the first of
 *   a repeated key wins): every test failed "the layout's workspace answer";
 * - `canonicalDir` skipping a `..` segment in place of applying it: npm lost `libs/lib/package.json`
 *   and the pnpm layout lost the `workspace:../c` target.
 */
for (const layout of WORKSPACE_LAYOUTS) {
  const seeds = layout === PNPM ? [cleanLayoutSeed(layout), ROW_SET_EVICTION] : [cleanLayoutSeed(layout)];
  describe(`the workspace relations answer alike in every arm: ${layout.name}`, () => {
    const run = seedRunner(treeSeedSuite(layoutTree(layout), import.meta.url));
    for (const seed of seeds) it(seedTitle(seed), async () => expect(await run(seed)).toEqual(seed.arms));
  });
}
