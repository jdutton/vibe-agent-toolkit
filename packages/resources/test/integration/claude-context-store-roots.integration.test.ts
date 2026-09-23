/**
 * The Claude-context lane takes its import roots from the STORE when the store
 * already holds this tree's enumeration.
 *
 * ## Why a real tree, and why it is then emptied
 *
 * The claim is *negative* — that nothing was crawled — and a negative claim
 * about the filesystem is only falsifiable if the filesystem can answer
 * differently. So the first population runs against a real tree and files its
 * extent; the second runs against the same root with **every file removed**.
 * The root directory itself stays, because `rootIdFor` resolves the real path
 * and would otherwise fall back to the nearest surviving ancestor, minting a
 * different root id and turning the hit under test into a trivially missed key.
 *
 * ⚠️ `treeUnchanged()` answering `true` over an emptied tree is a deliberate
 * lie, and it is the instrument: the store is keyed on a tree hash the caller
 * supplies, so holding that hash still while the tree moves is the only way to
 * separate *"the roots came from the store"* from *"the roots came from a crawl
 * that happened to agree"*. Nothing outside a test may hold it still.
 *
 * Before the lane consulted the store, the second run crawled an empty tree,
 * discovered no roots, registered no `ClaudeImportExtentContributor`, and
 * therefore asked the store for a strictly narrower question than the first run
 * had answered — so the hydrated projection came back with **zero** claude-import
 * contexts while reporting success. That is the red this file was written from.
 */

import { rm } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { buildClaudeContextPopulation } from '../../src/projection/claude-context-population.js';
import { AgenticConventionContributor } from '../../src/projection/contributors/agentic-convention.js';
import {
  CLAUDE_IMPORT_KIND,
  ClaudeImportExtentContributor,
} from '../../src/projection/contributors/claude-import-extent.js';
import { ClaudeRulesScopeContributor } from '../../src/projection/contributors/claude-rules-scope.js';
import { DISCARD_BLOB_POPULATION, type PopulationCache } from '../../src/projection/merge.js';
import type { Projection } from '../../src/projection/projection.js';
import { FakeProjectionStore } from '../fake-projection-store.js';
import { plantTree, razeTree } from '../helpers/temp-corpus.js';

/** Opaque to the store, and held CONSTANT across the emptying — see the header. */
const TREE_HASH = 'tree-1111111111111111111111111111111111111111';

/** Two `CLAUDE.md` and two rules files, so a count of 4 cannot be an accident of one. */
const TREE: Readonly<Record<string, string>> = {
  'CLAUDE.md': '# Root\n\n@docs/handbook.md\n',
  'docs/handbook.md': '# Handbook\n',
  'docs/CLAUDE.md': '# Docs\n',
  '.claude/rules/always.md': '---\ndescription: always on\n---\n\nAlways.\n',
  '.claude/rules/typescript.md': '---\npaths: ["**/*.ts"]\n---\n\nTS only.\n',
};

let root: string | undefined;

afterEach(async () => {
  await razeTree(root);
  root = undefined;
});

/**
 * Populate `root` through `store`, under the frozen tree hash.
 *
 * @param store - The store double both runs share
 * @returns The projection the lane produced
 */
async function populateThrough(store: FakeProjectionStore): Promise<Projection> {
  const cache: PopulationCache = { store, treeHash: TREE_HASH, treeUnchanged: () => true };
  return buildClaudeContextPopulation({
    root: root ?? '',
    cache,
    onBlobPopulation: DISCARD_BLOB_POPULATION,
  });
}

/** Every claude-import extent the projection registered. */
function importContexts(projection: Projection): readonly string[] {
  return projection.resolutionContexts
    .filter((row) => row.kind === CLAUDE_IMPORT_KIND)
    .map((row) => row.contextId);
}

/** Remove every entry under the root, leaving the root directory itself. */
async function emptyTree(): Promise<void> {
  for (const relative of ['CLAUDE.md', 'docs', '.claude']) {
    await rm(safePath.join(root ?? '', relative), { recursive: true, force: true });
  }
}

describe('buildClaudeContextPopulation root discovery', () => {
  it('crawls for the roots when the store holds nothing (positive control)', async () => {
    root = await plantTree('vat-claude-store-roots-', TREE);
    const store = new FakeProjectionStore();

    const first = await populateThrough(store);

    // The control for both assertions below: the crawl DOES find four roots on
    // this tree, and an emptied tree is a genuinely different answer rather
    // than one the fixture could never distinguish.
    expect(importContexts(first)).toHaveLength(4);
    expect(store.writeExtentCalls).toBe(1);
  });

  it('takes the roots from the store rather than crawling for them', async () => {
    root = await plantTree('vat-claude-store-roots-', TREE);
    const store = new FakeProjectionStore();
    const first = await populateThrough(store);

    await emptyTree();
    const second = await populateThrough(store);

    // Identical extents over a tree that no longer holds a single file: the
    // root list cannot have come from the filesystem.
    expect(importContexts(second)).toEqual(importContexts(first));
    expect(importContexts(second)).toHaveLength(4);
  });

  it('keeps the pre-read key equal to the population key — the tripwire', async () => {
    // `readStoredRealizations` is handed the SAME options object `populate`
    // gets, before the classifiers and one import contributor per root have
    // been registered. The two keys can only diverge if one of those later
    // registrations declares a `registrationQuestion`, which `storeKeyFor`
    // folds into the tree hash — so this pins that none does.
    //
    // ⚠️ A divergence would cost speed, not correctness: the pre-read would
    // simply stop hitting and the lane would crawl, exactly as the case below
    // shows it does. This test is what makes that a decision rather than a
    // silent, permanent regression back to two populations per run.
    const declared = [
      new AgenticConventionContributor(),
      new ClaudeRulesScopeContributor(),
      new ClaudeImportExtentContributor('CLAUDE.md'),
    ].filter((contributor) => contributor.registrationQuestion !== undefined);

    expect(declared.map((contributor) => contributor.id)).toEqual([]);
  });

  it('crawls again once the store cannot answer for this tree', async () => {
    root = await plantTree('vat-claude-store-roots-', TREE);
    const store = new FakeProjectionStore();
    await populateThrough(store);

    await emptyTree();
    // A DIFFERENT store — the same emptied tree the case above served from the
    // stored rows. Without an answer to read, the lane crawls, finds nothing,
    // and says so. This is what keeps the assertion above from passing because
    // the lane stopped looking at the tree altogether.
    const cold = await populateThrough(new FakeProjectionStore());

    expect(importContexts(cold)).toEqual([]);
  });
});
