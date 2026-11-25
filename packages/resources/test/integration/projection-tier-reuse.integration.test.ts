/**
 * The blob tier on an extent miss: one coverage predicate, the race guard, a torn read.
 *
 * Every case populates one committed 4-file tree through the store double
 * (`FakeFactStore`), which is the reuse rule's own seam: the double needs no
 * backend, and a case can drop rows or tear a read through the port alone.
 *
 * - **One predicate.** A markdown key whose `blobs` row is held and whose
 *   `skillTextFacts` row is gone is uncovered for the extent hit, for the reuse
 *   read on the miss that follows, and for stored admission, by the one reader
 *   (`uncoveredContentKeys` / `blobFactsReader`); one run covers it again.
 * - **Race guard.** A run whose tree moved files no extent, and still files its
 *   blob facts, with what its read covered.
 * - **Torn read.** A key evicted between the extent read and the blob read is a
 *   miss, never a hit with a hole in it.
 */

import { writeFile } from 'node:fs/promises';

import { readWorkCounters, safePath } from '@vibe-agent-toolkit/utils';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';
import { parseLookupsIn, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContributorRegistry } from '../../src/projection/contributor.js';
import { DEFAULT_CONTENT_DEMAND, FilesystemExtentContributor } from '../../src/projection/contributors/filesystem-extent.js';
import { crawlSourceFor } from '../../src/projection/crawl-source.js';
import { serializeProjection } from '../../src/projection/export.js';
import { populate, type PopulationCache, type PopulationOutcome } from '../../src/projection/merge.js';
import type { Projection } from '../../src/projection/projection.js';
import type { PopulationMembers } from '../../src/projection/resource-population.js';
import { parserKindOf } from '../../src/projection/router.js';
import { IGNORE_HOME_SETTLEMENT, withRunPopulation } from '../../src/projection/run-population.js';
import { keyedContentKeys, uncoveredContentKeys } from '../../src/projection/store-hydration.js';
import {
  ALL_BLOB_REQUEST,
  type BlobFactsWrite,
  type BlobRequest,
  type BlobScopedRows,
  type BlobScopedTableName,
  type ExtentKey,
  type ExtentRequest,
  type ExtentScopedRows,
  type ExtentScopedTableName,
} from '../../src/projection/store.js';
import { storedComputeBy, storedContentOf } from '../../src/projection/stored-admission.js';
import { ResourceRegistry } from '../../src/resource-registry.js';
import type { ResourceMetadata } from '../../src/schemas/resource-metadata.js';
import { FakeFactStore } from '../fake-fact-store.js';
import { inOwnRun } from '../helpers/population-run.js';
import { createCommittedRepo } from '../test-helpers.js';

/** The 4-file tree: linked markdown, no skill-text matches, so each key's skill text is one facts row. */
const TREE: Readonly<Record<string, string>> = {
  'README.md': '# Home\n\nSee [one](./docs/one.md) and [two](./docs/two.md).\n',
  'docs/one.md': '# One\n\nBack [home](../README.md).\n',
  'docs/two.md': '# Two\n\nOn to [three](./three.md).\n',
  'docs/three.md': '# Three\n\nThe end.\n',
};

/** The file a case edits or drops rows for. */
const EDITED = 'docs/two.md';

/** The primed tree's key, and the edited tree's. */
const PRIMED = 'tree-primed';
const EDITED_TREE = 'tree-edited';

let root = '';

beforeAll(() => {
  // The parse cache would serve a run what an earlier run parsed; this suite judges the store alone.
  vi.stubEnv('VAT_CACHE', '0');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  // Every case writes the tree; a fresh copy keeps one case's edit out of the next.
  root = createCommittedRepo('vat-tier-reuse-case-', { files: { ...TREE }, gitignore: '' });
});

afterEach(() => {
  removeTempDir(root);
});

/** One population of {@link root}: the filesystem extent, through `store` under `treeHash`, or store-off. */
async function populateThrough(
  cache: { readonly store: FakeFactStore; readonly treeHash: string; readonly treeUnchanged: boolean } | undefined,
): Promise<{ readonly projection: Projection; readonly outcome: PopulationOutcome }> {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor((at) => crawlSourceFor(at, []), DEFAULT_CONTENT_DEMAND));
  return inOwnRun(populate, {
    root,
    registry,
    ...(cache === undefined
      ? {}
      : { cache: { store: cache.store, treeHash: cache.treeHash, treeUnchanged: () => cache.treeUnchanged } }),
  });
}

/** The keyed content key a projection files `path` under. */
function keyOf(projection: Projection, path: string): string {
  const row = projection.resourceRealizations.find((realization) => realization.path === path && realization.contentState === 'keyed');
  if (row?.contentKey === undefined || row.contentKey === null) throw new Error(`${path} is not keyed in the projection`);
  return row.contentKey;
}

/** The keys `store` does not cover, by the one predicate, over every blob table. */
async function uncoveredIn(store: FakeFactStore, keys: readonly string[]): Promise<string[]> {
  return uncoveredContentKeys(await store.readBlobFacts(keys, ALL_BLOB_REQUEST), keys);
}

/** Whether a blob-scoped row is filed under `key`: `blobs` by `contentKey`, every other table by `blob`. */
function filedUnder(row: unknown, key: string): boolean {
  const record = row as { readonly contentKey?: unknown; readonly blob?: unknown };
  return record.blob === key || record.contentKey === key;
}

/**
 * Replace what `store` holds for `key` with its rows minus `table`'s, through the port alone:
 * forget the key, then write its other rows back as a replace (covered by nothing at read).
 */
async function dropTableRows(store: FakeFactStore, key: string, table: BlobScopedTableName): Promise<void> {
  const held = await store.readBlobFacts([key], ALL_BLOB_REQUEST);
  store.forgetBlobFacts(key);
  const rows = { ...held, [table]: [] } as BlobScopedRows;
  await store.writeBlobFacts({ rows, coveredAtRead: [], settledAtRead: [] });
}

/** A store double that records every blob-facts write it is handed. */
class RecordingStore extends FakeFactStore {
  readonly writes: BlobFactsWrite[] = [];

  override writeBlobFacts(write: BlobFactsWrite): Promise<void> {
    this.writes.push(write);
    return super.writeBlobFacts(write);
  }
}

/**
 * A store double whose blob read drops one key's rows, once, right after an extent read
 * answered: an eviction landing between the two reads, in the store's own override.
 */
class TornReadStore extends FakeFactStore {
  #tearing: string | undefined;
  #armed = false;
  torn = 0;

  /** @param key - The key the next read after an answered extent read drops */
  tear(key: string): void {
    this.#tearing = key;
  }

  override async readExtent<Table extends ExtentScopedTableName>(
    key: ExtentKey,
    request: ExtentRequest<Table>,
  ): Promise<Pick<ExtentScopedRows, Table> | undefined> {
    const extent = await super.readExtent(key, request);
    if (extent !== undefined && this.#tearing !== undefined) this.#armed = true;
    return extent;
  }

  override async readBlobFacts<Table extends BlobScopedTableName>(
    contentKeys: readonly string[],
    request: BlobRequest<Table>,
  ): Promise<Pick<BlobScopedRows, Table>> {
    const rows = await super.readBlobFacts(contentKeys, request);
    const key = this.#tearing;
    if (!this.#armed || key === undefined) return rows;
    this.#armed = false;
    this.#tearing = undefined;
    this.torn += 1;
    const source = rows as unknown as Record<string, readonly unknown[]>;
    const kept = Object.fromEntries(Object.entries(source).map(([table, tableRows]) => [table, tableRows.filter((row) => !filedUnder(row, key))]));
    return kept as unknown as Pick<BlobScopedRows, Table>;
  }
}

describe('one coverage predicate for the hit, the reuse read and stored admission', () => {
  it('calls a key with a blobs row and no skill-text row uncovered everywhere, and one run covers it again', async () => {
    const store = new RecordingStore();
    const primed = await populateThrough({ store, treeHash: PRIMED, treeUnchanged: true });
    expect(primed.outcome).toEqual({ population: 'derived', stored: 'written' });
    const keys = keyedContentKeys(primed.projection);
    // The four documents and the .gitignore the repository is committed with.
    expect(keys).toHaveLength(5);
    const k = keyOf(primed.projection, EDITED);
    expect(parserKindOf(k), 'the dropped row is a markdown key\'s skill text').toBe('markdown');

    await dropTableRows(store, k, 'skillTextFacts');
    const held = await store.readBlobFacts([k], ALL_BLOB_REQUEST);
    expect(held.blobs.map((row) => row.contentKey), 'K keeps its blobs row').toEqual([k]);
    expect(held.skillTextFacts, 'K holds no skill-text row').toEqual([]);

    // Stored admission: K is sent cold by the tier's answer; every other member is served.
    const members = primed.projection.resourceRealizations.map((row) => ({ path: safePath.join(root, row.path), row }));
    const stored = storedContentOf(members, store);
    const admission = await Promise.all(keys.map(async (key) => {
      const member = members.find(({ row }) => row.contentKey === key);
      if (member === undefined) throw new Error(`no member keyed ${key}`);
      const answer = await storedComputeBy(member.row, parserKindOf(key), stored.facts);
      return [key, answer.computeBy] as const;
    }));
    expect(Object.fromEntries(admission)).toEqual(Object.fromEntries(keys.map((key) => [key, key === k ? 'readRoute' : null])));

    // The hit: the extent is held, K is not covered, so the run derives and writes.
    const healed = await populateThrough({ store, treeHash: PRIMED, treeUnchanged: true });
    expect(healed.outcome, 'the hit called K uncovered').toEqual({ population: 'derived', stored: 'written' });

    // One run covers it again, and the next run is a hit.
    expect(await uncoveredIn(store, keys)).toEqual([]);
    const served = await populateThrough({ store, treeHash: PRIMED, treeUnchanged: true });
    expect(served.outcome).toEqual({ population: 'store', stored: 'hit' });
    expect(serializeProjection(served.projection)).toBe(serializeProjection(primed.projection));
  });

  it('the reuse read calls the same key uncovered: the partial-tier miss writes every other key as covered at read', async () => {
    const store = new RecordingStore();
    const primed = await populateThrough({ store, treeHash: PRIMED, treeUnchanged: true });
    const keys = keyedContentKeys(primed.projection);
    const k = keyOf(primed.projection, EDITED);
    await dropTableRows(store, k, 'skillTextFacts');
    store.writes.length = 0;

    await populateThrough({ store, treeHash: PRIMED, treeUnchanged: true });

    expect(store.writes).toHaveLength(1);
    const [write] = store.writes;
    expect([...(write?.coveredAtRead ?? [])].sort((a, b) => a.localeCompare(b)))
      .toEqual(keys.filter((key) => key !== k).sort((a, b) => a.localeCompare(b)));
  });
});

/** Prime, then edit {@link EDITED} and run under the edited tree's key with the tree reported moved. */
async function movedRun(): Promise<{ readonly store: RecordingStore; readonly unchanged: readonly string[]; readonly outcome: PopulationOutcome }> {
  const store = new RecordingStore();
  const primed = await populateThrough({ store, treeHash: PRIMED, treeUnchanged: true });
  const unchanged = keyedContentKeys(primed.projection).filter((key) => key !== keyOf(primed.projection, EDITED));
  await writeFile(safePath.join(root, EDITED), '# Two\n\nEdited, and on to [three](./three.md).\n');
  store.writes.length = 0;
  store.writeExtentCalls = 0;
  const { outcome } = await populateThrough({ store, treeHash: EDITED_TREE, treeUnchanged: false });
  return { store, unchanged, outcome };
}

describe('the race guard with reuse', () => {
  it('files no extent when the tree moved during the run, and still files its blob facts', async () => {
    const { store, outcome } = await movedRun();
    expect(outcome).toEqual({ population: 'derived', stored: 'skipped-tree-changed' });
    expect(store.writeExtentCalls, 'an extent filed under a key that no longer describes the tree').toBe(0);
    expect(store.writes, 'the blob facts are keyed by bytes read, so they are filed').toHaveLength(1);
    // Nothing was filed under the edited key, so the next run there misses rather than hits.
    const next = await populateThrough({ store, treeHash: EDITED_TREE, treeUnchanged: true });
    expect(next.outcome).toEqual({ population: 'derived', stored: 'written' });
  });

  it('files the moved run\'s blob facts with what its read covered', async () => {
    const { store, unchanged } = await movedRun();
    const [write] = store.writes;
    expect([...(write?.coveredAtRead ?? [])].sort((a, b) => a.localeCompare(b)))
      .toEqual([...unchanged].sort((a, b) => a.localeCompare(b)));
  });
});

describe('a torn read', () => {
  it('a key evicted between the extent read and the blob read is a miss, and answers as store-off does', async () => {
    const store = new TornReadStore();
    const primed = await populateThrough({ store, treeHash: PRIMED, treeUnchanged: true });
    store.tear(keyOf(primed.projection, EDITED));

    const torn = await populateThrough({ store, treeHash: PRIMED, treeUnchanged: true });
    expect(store.torn, 'the read was torn').toBe(1);
    expect(torn.outcome).toEqual({ population: 'derived', stored: 'written' });

    const storeOff = await populateThrough(undefined);
    expect(serializeProjection(torn.projection)).toBe(serializeProjection(storeOff.projection));
  });
});

/** The members the admission cases crawl: every markdown file of the tree. */
const CRAWLED: PopulationMembers = { include: ['**/*.md'], exclude: [], ignoredRefusals: 'record' };

/** What one run's admission did: the home's outcome, what its registry admitted, and the work admission alone spent. */
interface AdmissionRun {
  readonly outcome: PopulationOutcome;
  readonly resources: readonly ResourceMetadata[];
  readonly parseLookups: number;
  /** The parses admission asked the run's dispatcher for, its memo's answers included. */
  readonly dispatcherAsks: number;
  readonly blobReads: number;
}

/**
 * One run homed at {@link root} over `store` under `treeHash`: the home enumerated first, then a
 * registry crawl admits its members, so the counters read across the crawl are admission's alone.
 *
 * @param store - The store the run reads and writes
 * @param treeHash - The key the run files the tree under
 * @returns The run's admission
 */
function admitThrough(store: FakeFactStore, treeHash: string): Promise<AdmissionRun> {
  const cacheOf = (): Promise<PopulationCache> => Promise.resolve({ store, treeHash, treeUnchanged: () => true });
  return withRunPopulation({
    root,
    outputs: [],
    gitTracker: new GitTracker(root),
    cacheOf,
    questionCacheOf: cacheOf,
    holdsStore: true,
    collectionsFor: () => Promise.resolve(undefined),
    onHomeSettled: IGNORE_HOME_SETTLEMENT,
  }, async (population) => {
    const { outcome } = await population.source.enumerate(root, [], 'refuse', CRAWLED);
    const lookups = parseLookupsIn(readWorkCounters());
    const reads = store.readBlobFactsCalls;
    const registry = ResourceRegistry.forRun(population, { baseDir: root, gitTracker: population.gitTracker });
    // The run's dispatcher answers a key it already parsed from its own memo, counting no lookup:
    // each ask is still the cold lane's, so admission's asks are counted at the dispatcher itself.
    const asks = vi.spyOn(population.dispatcher, 'parse');
    try {
      await registry.crawl({
        baseDir: root,
        include: [...CRAWLED.include],
        exclude: [...CRAWLED.exclude],
        ignoredRefusals: CRAWLED.ignoredRefusals,
        outputs: [],
        unreadable: 'refuse',
        populationSource: population.source,
      });
      return {
        outcome,
        resources: registry.getAllResources(),
        parseLookups: parseLookupsIn(readWorkCounters()) - lookups,
        dispatcherAsks: asks.mock.calls.length,
        blobReads: store.readBlobFactsCalls - reads,
      };
    } finally {
      asks.mockRestore();
    }
  });
}

describe('stored admission after a written miss', () => {
  it('admission after a written miss computes nothing', async () => {
    const store = new FakeFactStore();
    expect((await admitThrough(store, PRIMED)).outcome).toEqual({ population: 'derived', stored: 'written' });
    await writeFile(safePath.join(root, EDITED), '# Two\n\nEdited, and on to [three](./three.md).\n');

    const miss = await admitThrough(store, EDITED_TREE);
    expect(miss.outcome, 'the edit moved the key, so the run derived and filed it').toEqual({ population: 'derived', stored: 'written' });
    expect(miss.parseLookups, 'admission asked the parse lane for a member the projection already holds').toBe(0);
    expect(miss.dispatcherAsks, 'admission computed a member the projection already holds').toBe(0);
    expect(miss.blobReads, 'admission read the store for facts the run just derived').toBe(0);

    const fresh = await admitThrough(store, EDITED_TREE);
    expect(fresh.outcome).toEqual({ population: 'store', stored: 'hit' });
    expect(miss.resources.map((resource) => resource.filePath)).toEqual(fresh.resources.map((resource) => resource.filePath));
    expect(miss.resources).toEqual(fresh.resources);
  });
});

describe('an extent miss reuses covered keys', () => {
  it('parses only the edited key, serves every other key from the tier, and answers as store-off does', async () => {
    const store = new FakeFactStore();
    const primed = await populateThrough({ store, treeHash: PRIMED, treeUnchanged: true });
    // The four documents and the .gitignore: the edit leaves four keys covered, three markdown and one `none.`.
    expect(keyedContentKeys(primed.projection)).toHaveLength(5);
    await writeFile(safePath.join(root, EDITED), '# Two\n\nEdited, and on to [three](./three.md).\n');
    const extentReads = store.readExtentCalls;
    const blobReads = store.readBlobFactsCalls;
    const before = readWorkCounters();

    const miss = await populateThrough({ store, treeHash: EDITED_TREE, treeUnchanged: true });

    const after = readWorkCounters();
    expect(miss.outcome, 'the edit moved the key').toEqual({ population: 'derived', stored: 'written' });
    expect(store.readExtentCalls - extentReads, 'one extent read, the miss').toBe(1);
    expect(store.readBlobFactsCalls - blobReads, 'one tier read, in derivation').toBe(1);
    expect(parseLookupsIn(after) - parseLookupsIn(before), 'only the edited key is looked up').toBe(1);
    expect(after['blob.storeServed'] - before['blob.storeServed'], 'every other key is served from the tier').toBe(4);

    const storeOff = await populateThrough(undefined);
    expect(miss.projection, 'row for row, in order').toEqual(storeOff.projection);
  });

  it('files a served harness pair as settled at read', async () => {
    await writeFile(safePath.join(root, 'CLAUDE.md'), '# Memory\n\n@docs/one.md\n');
    const store = new RecordingStore();
    const primed = await populateThrough({ store, treeHash: PRIMED, treeUnchanged: true });
    const memory = { contentKey: keyOf(primed.projection, 'CLAUDE.md'), harness: 'claude-code' };
    expect(primed.projection.harnessBlobFacts.map(({ blob, harness }) => ({ contentKey: blob, harness })), 'the premise: the memory file\'s pair is reached').toContainEqual(memory);
    await writeFile(safePath.join(root, EDITED), '# Two\n\nEdited, and on to [three](./three.md).\n');

    const miss = await populateThrough({ store, treeHash: EDITED_TREE, treeUnchanged: true });

    expect(miss.outcome).toEqual({ population: 'derived', stored: 'written' });
    expect(store.writes.at(-1)?.settledAtRead, 'the pair the miss served from the tier').toContainEqual(memory);
    expect(store.writes.at(-1)?.coveredAtRead).toContain(memory.contentKey);
  });
});
