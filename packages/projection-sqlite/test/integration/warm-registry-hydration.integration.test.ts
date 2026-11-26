/**
 * A warm run's resources registry, built from the SQLite store's blob facts, is
 * the cold registry: deep-equal resources, the same not-admitted logs and the
 * same findings in the same order, with no content read, hashed or parsed.
 *
 * Through the real store, each run on its own connection, so every fact a warm
 * run admits came back through SQLite rather than a handle's memory: a value the
 * encoding loses (a frontmatter timestamp, `-0`) would fail the equality here.
 * The per-key fallback, stored refusals and the readability probe are held in
 * `resources`' `run-population-hydration.integration.test.ts`.
 */

import { mkdtempSync } from 'node:fs';

import { DEFAULT_BLOB_TIER_BUDGET_BYTES, openSqliteFactStore } from '@vibe-agent-toolkit/projection-sqlite';
import { NO_GIT_MEMBERS,
  IGNORE_HOME_SETTLEMENT,
  type FactStore,
  type PopulationCache,
  type ResourceMetadata,
  ResourceRegistry,
  withRunPopulation,
} from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { GitTracker, runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { plantFiles, type WorkSpent, workSpentNow, workSpentSince } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { crawlWholeTree, teardownTreeSuite } from '../fixtures.js';

/** One file per kind of fact a resource carries: frontmatter values JSON cannot hold, links, anchors, a parse error. */
const TREE: Readonly<Record<string, string>> = {
  'README.md': '---\nid: home\nwhen: !!timestamp 2024-01-02T03:04:05Z\nnegzero: -0\n---\n# Home\n\nSee [the guide](./docs/guide.md#usage) and [gone](./docs/gone.md).\n',
  'docs/guide.md': '# Guide\n\n## Usage\n\n<a id="custom"></a>\n\nBack [home](../README.md#home) and [x][missing].\n\n## Usage\n',
  'docs/page.html': '<!DOCTYPE html><p id="a" id="b"><a href="./guide.md#usage">Guide</a></p>\n',
  'docs/data.json': '{ "see": "[a link](./guide.md)" }\n',
  'docs/frontmatter-error.md': '---\npaths:\n  - **/x/*.ts\n---\n# Bad\n',
};

/** What one run's registry produced, and the work it spent. */
interface RunOutput {
  readonly resources: readonly ResourceMetadata[];
  readonly notAdmitted: unknown;
  readonly issues: unknown;
  readonly stored: string;
  readonly work: WorkSpent;
}

let root: string;
let storeDirectory: string;
let cold: RunOutput;
let warm: RunOutput;
let off: RunOutput;

/**
 * Crawl and validate the tree in one run, on a store connection of its own or none.
 *
 * @param withStore - Whether the run has the SQLite store
 * @returns What the run's registry produced
 */
async function runOnce(withStore: boolean): Promise<RunOutput> {
  const store: FactStore | undefined = withStore ? openSqliteFactStore({ directory: storeDirectory, blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES }) : undefined;
  const storeOf = (): Promise<PopulationCache | undefined> =>
    Promise.resolve(store === undefined ? undefined : { store, treeHash: 'warm-registry-hydration', treeUnchanged: () => true });
  try {
    return await withRunPopulation(
      {
        root,
        outputs: [],
        membersOf: NO_GIT_MEMBERS,
        gitTracker: new GitTracker(root),
        cacheOf: storeOf,
        questionCacheOf: storeOf,
        holdsStore: true,
        collectionsFor: () => Promise.resolve(undefined),
        onHomeSettled: IGNORE_HOME_SETTLEMENT,
      },
      async (population) => {
        const before = workSpentNow();
        const registry = ResourceRegistry.forRun(population, { baseDir: root });
        const crawl = await crawlWholeTree(registry, root, population.source);
        const after = workSpentNow();
        return {
          resources: registry.getAllResources(),
          notAdmitted: registry.getNotAdmitted(),
          issues: (await registry.validate()).issues,
          stored: crawl.population.outcome.stored,
          work: workSpentSince(after, before),
        };
      },
    );
  } finally {
    await store?.close();
  }
}

beforeAll(async () => {
  // The on-disk parse cache would serve the cold run an earlier build's parse, and count its hits
  // as lookups.
  vi.stubEnv('VAT_CACHE', '0');
  root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-warm-registry-'));
  // A repository, as every stored tree is: only a file whose bytes the store's key reads is
  // admitted from the store, and git says which those are (untracked and not ignored, here).
  runGitOrThrow(['init', '-q'], { cwd: root });
  storeDirectory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-warm-registry-store-'));
  plantFiles(root, TREE);
  cold = await runOnce(true);
  warm = await runOnce(true);
  off = await runOnce(false);
});

afterAll(() => teardownTreeSuite(root, storeDirectory));

describe('warm registry hydration through the SQLite store', () => {
  it('runs cold, then warm from the store, then with no store', () => {
    expect([cold.stored, warm.stored, off.stored]).toEqual(['written', 'hit', 'no-store']);
    expect(warm.resources).toHaveLength(Object.keys(TREE).length);
  });

  it('builds the cold resources, logs and findings from the stored facts', () => {
    expect(warm.resources).toStrictEqual(cold.resources);
    expect(warm.resources).toStrictEqual(off.resources);
    expect({ notAdmitted: warm.notAdmitted, issues: warm.issues }).toStrictEqual({ notAdmitted: cold.notAdmitted, issues: cold.issues });
    expect({ notAdmitted: warm.notAdmitted, issues: warm.issues }).toStrictEqual({ notAdmitted: off.notAdmitted, issues: off.issues });
    expect(JSON.stringify(warm.resources)).toBe(JSON.stringify(cold.resources));
  });

  it('reads, hashes and parses nothing, and admits each file once', () => {
    expect(warm.work).toEqual({ reads: 0, hashed: 0, parseLookups: 0, admitted: Object.keys(TREE).length });
    expect(cold.work.admitted).toBe(Object.keys(TREE).length);
  });
});
