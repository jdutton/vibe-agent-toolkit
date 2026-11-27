/**
 * I0 over the workspace relations (spec 6.4): one clean corpus per layout (`../helpers/workspace-rows.ts`:
 * npm with canonicalised patterns, yarn's `{ packages }`, bun's `link:` and `file:`, and pnpm with a
 * catalog and a named one, the `workspace:<path>` form, and `link-workspace-packages` on and off in
 * `pnpm-workspace.yaml` and in `.npmrc`, and a `${VAR}` there stored literally) answers a census of
 * `workspace_packages`, `workspace_dependencies` and `workspace_conditions`, and of every `data__*`
 * relation, identically store-off, cold, warm and with half the blob tier evicted; the census holds
 * rows in every relation, then the layout's own answer, before it is compared.
 *
 * Seeds over the pnpm corpora, store-off against warm:
 * - half the row-set tier evicted after the prime: the warm run re-extracts exactly those row sets
 *   and answers the same;
 * - `.npmrc` alone edited from `${VAR}` to `true`: the warm run extracts exactly that one file, and
 *   the plain range and the catalog range to `b` now link it.
 */

import { writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { seedRunner, seedTitle, treeSeedSuite, type I0Seed } from '../helpers/cache-differential.js';
import { rowSetEvictionSeed, WARM_ARMS, WARM_MEASURED, warmRowSetSpend } from '../helpers/data-rows.js';
import {
  cleanLayoutSeed,
  expectWorkspaceCensus,
  layoutTree,
  NPMRC_EDITED_ANSWER,
  NPMRC_ON,
  PNPM_NPMRC_VARIABLE,
  PNPM_YAML_ON,
  routedPairsOf,
  WORKSPACE_LAYOUTS,
} from '../helpers/workspace-rows.js';

const PNPM_PAIRS = routedPairsOf(PNPM_YAML_ON);

/**
 * Every other stored row set evicted after the warm prime of the pnpm corpus: the workspace step's
 * declared reads meet the gaps and the run re-extracts exactly them.
 */
const ROW_SET_EVICTION: I0Seed = rowSetEvictionSeed('workspaceRowSetEviction', PNPM_PAIRS, (runs) => {
  expectWorkspaceCensus(runs, PNPM_YAML_ON.answer, PNPM_YAML_ON.npmrcSetting);
});

/**
 * `.npmrc` alone rewritten after the prime, uncommitted, from `${VAR}` (off) to `true` (on).
 *
 * Red, seeded once and reverted: `workspace-packages.ts` `workspaceDeclaration` never reading the
 * root `.npmrc` (its setting always undefined): this seed and pnpmNpmrcOn failed "the layout's
 * workspace answer" (the plain and catalog ranges to `b` linking nothing), 2 failures.
 */
const NPMRC_EDIT: I0Seed = {
  name: 'npmrcEdit',
  needs: null,
  arms: WARM_ARMS,
  verbs: ['query'],
  env: () => ({ ...PNPM_NPMRC_VARIABLE.env }),
  toB: (_arm, _dirs, corpus) => {
    writeFileSync(safePath.join(corpus, '.npmrc'), `${NPMRC_ON}\n`);
    return Promise.resolve();
  },
  expect: { agreesAndRepairs: { arm: 'warmSameHistory', because: 'the edit moves the tree, so the warm run derives it and extracts the edited .npmrc alone' } },
  consumed: {
    runs: WARM_MEASURED,
    check: (runs) => {
      expectWorkspaceCensus(runs, NPMRC_EDITED_ANSWER, 1);
      const { extracted, served } = warmRowSetSpend(runs);
      expect({ extracted, served }).toEqual({ extracted: 1, served: routedPairsOf(PNPM_NPMRC_VARIABLE) - 1 });
    },
  },
};

/**
 * One suite per corpus: each registers its hooks and runs its seeds.
 *
 * Reds, each seeded once and reverted:
 * - the npm layout's `catalog:` range removed (so its corpus holds no workspace condition): "npm",
 *   "storeOff:measured: relations with no row", `['workspace_conditions']`, before any comparison,
 *   1 failure;
 * - `workspace-packages.ts` `docOf` keeping shadowed nodes, later occurrences first (so the first of
 *   a repeated key wins): every test failed "the layout's workspace answer", 9 failures;
 * - `canonicalDir` skipping a `..` segment in place of applying it: npm lost `libs/lib/package.json`
 *   (3 packages for 4) and every pnpm layout lost the `workspace:../c` link, 7 failures;
 * - `settingAt` reading a `${VAR}` string as on: pnpmNpmrcVariable linked `b`, 1 failure.
 */
for (const layout of WORKSPACE_LAYOUTS) {
  const seeds = [cleanLayoutSeed(layout)];
  if (layout === PNPM_YAML_ON) seeds.push(ROW_SET_EVICTION);
  if (layout === PNPM_NPMRC_VARIABLE) seeds.push(NPMRC_EDIT);
  describe(`the workspace relations answer alike in every arm: ${layout.name}`, () => {
    const run = seedRunner(treeSeedSuite(layoutTree(layout), import.meta.url));
    for (const seed of seeds) it(seedTitle(seed), async () => expect(await run(seed)).toEqual(seed.arms));
  });
}
