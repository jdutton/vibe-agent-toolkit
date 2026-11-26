/**
 * The blob stage over a stored tier: a covered key's rows land where a parse would put them,
 * whatever order the store returns them in, a key's rows come from one read, and a key a demand
 * promotion adds is read from the tier once more, alone, and served when the store covers it.
 */

import { compareCodeUnits, readWorkCounters } from '@vibe-agent-toolkit/utils';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';
import { parseLookupsIn } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ParseDispatcher, withParseDispatcher } from '../src/parse-dispatcher.js';
import { populateBlobs, storableBlobFacts } from '../src/projection/blob-population.js';
import { blobRowsByKey } from '../src/projection/blob-resource-facts.js';
import { RunContentCache } from '../src/projection/content-cache.js';
import { DEFAULT_CONTENT_DEMAND, FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { crawlSourceFor } from '../src/projection/crawl-source.js';
import { afterClosurePromotion, type BlobStage } from '../src/projection/merge.js';
import { type Projection, ProjectionBuilder } from '../src/projection/projection.js';
import { QUERY_BLOB_REQUEST } from '../src/projection/query-projection.js';
import { diskRunContentSource } from '../src/projection/run-population.js';
import { emptyBlobRows, keyedContentKeys, storedBlobTier } from '../src/projection/store-hydration.js';
import { ALL_BLOB_REQUEST, type BlobRequest, type BlobScopedRows, type BlobScopedTableName, EXTENT_STEP_TABLES } from '../src/projection/store.js';
import { runStoredReads, storedTierReads } from '../src/projection/stored-reads.js';
import type { BlobConditionRow } from '../src/schemas/projection-blobs.js';

import { baseBuilderForRoot, populateBlobsOnOwnDispatcher } from './blob-fixture-population.js';
import { FakeFactStore } from './fake-fact-store.js';
import { createGitRepo, setupSubdirTestSuite, writeFileIn } from './test-helpers.js';

const suite = setupSubdirTestSuite('blob-stage-tier-');

/** Two headings, two links, two unresolved references: every ordered table holds more than one row. */
const DOCUMENT = '# One\n\nSee [a](./a.md) and [b](./b.md), [x][nowhere] and [y][elsewhere].\n\n## Two\n\nMore.\n';

/** The six tables the blob stage emits, as one projection holds them. */
function blobTables(projection: Projection): Pick<Projection, 'blobs' | 'blobConditions' | 'blobSections' | 'blobReferences' | 'skillTextFacts' | 'skillTextMatches'> {
  const { blobs, blobConditions, blobSections, blobReferences, skillTextFacts, skillTextMatches } = projection;
  return { blobs, blobConditions, blobSections, blobReferences, skillTextFacts, skillTextMatches };
}

/** `rows` with every table reversed: an order no store owes, and none the stage may rely on. */
function reversed(rows: BlobScopedRows): BlobScopedRows {
  const source = rows as unknown as Record<string, readonly unknown[]>;
  return Object.fromEntries(Object.entries(source).map(([table, tableRows]) => [table, tableRows.toReversed()])) as unknown as BlobScopedRows;
}

/** One condition row of `code` at `ordinal`. */
function conditionRow(code: string, ordinal: number): BlobConditionRow {
  return { blob: 'markdown.key', code, ordinal, severity: 'warning', message: `${code} ${String(ordinal)}`, line: null };
}

describe('a covered key\'s stored rows, in reversed order', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('are emitted where a parse puts them: the projection equals store-off, row for row', async () => {
    writeFileIn(suite.tempDir, 'doc.md', DOCUMENT);
    const storeOff = await baseBuilderForRoot(suite.tempDir);
    await populateBlobsOnOwnDispatcher(storeOff);
    const derived = storeOff.build();
    // The premise: each ordered table holds rows a reversal moves.
    expect(derived.blobSections.length).toBeGreaterThan(1);
    expect(derived.blobReferences.length).toBeGreaterThan(1);
    expect(derived.blobConditions.length).toBeGreaterThan(1);

    const keys = keyedContentKeys(derived);
    const stored = storedBlobTier(reversed({ ...emptyBlobRows(), ...blobTables(derived) }), keys);
    expect([...stored.covered], 'every key is covered, so every row is served').toEqual(keys);
    const served = await baseBuilderForRoot(suite.tempDir);
    await withParseDispatcher((dispatcher) => populateBlobs(served, { dispatcher, content: diskRunContentSource(served.base().contentCache), stored }));

    expect(blobTables(served.build())).toEqual(blobTables(derived));
  });

  it('put conditions by finding code, in the order a parse emits the codes, then by ordinal', () => {
    const inOrder = [conditionRow('HTML_PARSE_ERROR', 0), conditionRow('HTML_PARSE_ERROR', 1), conditionRow('UNRESOLVED_REFERENCE', 0), conditionRow('UNRESOLVED_REFERENCE', 1)];

    const grouped = blobRowsByKey({ ...emptyBlobRows(), blobConditions: inOrder.toReversed() });

    expect(grouped.get('markdown.key')?.conditions).toEqual(inOrder);
  });
});

/** Each table's rows in a canonical order, so two tiers compare whatever order their reads joined in. */
function canonical(rows: BlobScopedRows): Record<string, string[]> {
  const source = rows as unknown as Record<string, readonly unknown[]>;
  return Object.fromEntries(Object.entries(source).map(([table, tableRows]) => [table, tableRows.map((row) => JSON.stringify(row)).sort(compareCodeUnits)]));
}

/** A store that records every blob request it is asked, and the keys of each. */
class RecordingStore extends FakeFactStore {
  readonly asked: BlobRequest<BlobScopedTableName>[] = [];
  readonly readKeys: (readonly string[])[] = [];

  override readBlobFacts<Table extends BlobScopedTableName>(contentKeys: readonly string[], request: BlobRequest<Table>): Promise<Pick<BlobScopedRows, Table>> {
    this.asked.push(request as unknown as BlobRequest<BlobScopedTableName>);
    this.readKeys.push(contentKeys);
    return super.readBlobFacts(contentKeys, request);
  }
}

/** Each request as the store was asked it: tables, and the reference forms sorted. */
function askedOf(store: RecordingStore): { tables: readonly string[]; forms: string | string[] }[] {
  return store.asked.map((request) => ({ tables: request.tables, forms: request.referenceForms === 'all' ? 'all' : [...request.referenceForms].sort(compareCodeUnits) }));
}

/** A store holding `derived`'s blob tier, recording what it is asked. */
async function recordingStoreOf(derived: Projection): Promise<RecordingStore> {
  const store = new RecordingStore();
  await store.writeBlobFacts({ rows: storableBlobFacts({ ...emptyBlobRows(), ...blobTables(derived) }), coveredAtRead: [], settledAtRead: [] });
  return store;
}

/** A tier over its own run's reads of `store`. */
function tierOver(store: FakeFactStore): ReturnType<typeof storedTierReads> {
  return storedTierReads(runStoredReads().of(store));
}

/** Two documents with AST and lexical references, populated store-off. */
async function twoDocuments(): Promise<Projection> {
  // A markdown link (an AST form), a bare token and an `@` import (lexical forms).
  writeFileIn(suite.tempDir, 'doc.md', '# Doc\n\nSee [other](./other.md), other.md and @other.md.\n');
  writeFileIn(suite.tempDir, 'other.md', '# Other\n');
  const builder = await baseBuilderForRoot(suite.tempDir);
  await populateBlobsOnOwnDispatcher(builder);
  return builder.build();
}

describe('one reader for a hit and the derivation after it', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);


  it('reads a key again whole under a wider request, and holds what one whole read holds', async () => {
    const derived = await twoDocuments();
    const keys = keyedContentKeys(derived);
    const store = await recordingStoreOf(derived);
    // The premise: the store holds rows of both kinds of form.
    expect(derived.blobReferences.some((row) => QUERY_BLOB_REQUEST.referenceForms !== 'all' && QUERY_BLOB_REQUEST.referenceForms.has(row.syntacticForm))).toBe(true);
    expect(derived.blobReferences.some((row) => QUERY_BLOB_REQUEST.referenceForms !== 'all' && !QUERY_BLOB_REQUEST.referenceForms.has(row.syntacticForm))).toBe(true);

    const reader = tierOver(store);
    await reader.cover(keys, QUERY_BLOB_REQUEST);
    const joined = await reader.cover(keys, ALL_BLOB_REQUEST);
    await reader.cover(keys, ALL_BLOB_REQUEST);
    const asked = askedOf(store);
    const once = await tierOver(store).cover(keys, ALL_BLOB_REQUEST);

    expect(asked, 'the hit, then every key again whole, and a repeated cover reads nothing').toEqual([
      { tables: QUERY_BLOB_REQUEST.tables, forms: QUERY_BLOB_REQUEST.referenceForms === 'all' ? 'all' : [...QUERY_BLOB_REQUEST.referenceForms].sort(compareCodeUnits) },
      { tables: ALL_BLOB_REQUEST.tables, forms: 'all' },
    ]);
    expect(canonical(joined.rows)).toEqual(canonical(once.rows));
    expect([...joined.covered].sort(compareCodeUnits)).toEqual([...once.covered].sort(compareCodeUnits));
  });

  it('judges a key evicted between a hit and the wider read uncovered, holding none of its rows', async () => {
    const derived = await twoDocuments();
    const keys = keyedContentKeys(derived);
    const [evicted] = keys;
    if (evicted === undefined || keys.length < 2) throw new Error('the premise: two keyed documents');
    const store = await recordingStoreOf(derived);

    const reader = tierOver(store);
    const hit = await reader.cover(keys, QUERY_BLOB_REQUEST);
    expect(hit.covered.has(evicted), 'the hit covered it').toBe(true);
    // Another process's eviction, between the hit's read and the derivation's.
    store.forgetBlobFacts(evicted);
    const widened = await reader.cover(keys, ALL_BLOB_REQUEST);

    expect(widened.covered.has(evicted), 'a key gone from the store is not covered').toBe(false);
    expect(widened.rows.blobs.some((row) => row.contentKey === evicted), 'no row of it from the earlier read').toBe(false);
    expect(widened.rows.blobReferences.some((row) => row.blob === evicted), 'neither form of reference').toBe(false);
    expect([...widened.covered].sort(compareCodeUnits)).toEqual(keys.filter((key) => key !== evicted).sort(compareCodeUnits));
  });

  it('keeps every earlier key\'s coverage when a later read asks for one key', async () => {
    const derived = await twoDocuments();
    const keys = keyedContentKeys(derived);
    const store = await recordingStoreOf(derived);
    const once = await tierOver(store).cover(keys, ALL_BLOB_REQUEST);
    const [first] = keys;
    if (first === undefined || once.covered.size < 2) throw new Error('the premise: two covered keys');

    const partial = tierOver(store);
    await partial.cover(keys, QUERY_BLOB_REQUEST);

    expect([...(await partial.cover([first], ALL_BLOB_REQUEST)).covered].sort(compareCodeUnits)).toEqual([...once.covered].sort(compareCodeUnits));
  });
});

describe('a run\'s reads of one store', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('are one reader for every population of the run, and a write forgets only the keys it may move', async () => {
    writeFileIn(suite.tempDir, 'doc.md', DOCUMENT);
    writeFileIn(suite.tempDir, 'other.md', '# Other\n');
    const builder = await baseBuilderForRoot(suite.tempDir);
    await populateBlobsOnOwnDispatcher(builder);
    const derived = builder.build();
    const keys = keyedContentKeys(derived);
    const [moved, kept] = keys;
    if (moved === undefined || kept === undefined) throw new Error('the premise: two keyed documents');
    const store = await recordingStoreOf(derived);
    const run = runStoredReads();

    await run.of(store).blobs(keys, ALL_BLOB_REQUEST);
    await run.of(store).blobs(keys, ALL_BLOB_REQUEST);
    expect(store.asked, 'two asks of one run read once').toHaveLength(1);

    // A write that covered `kept` at read and not `moved`: only `moved` can have changed.
    await run.of(store).writeBlobs({ rows: storableBlobFacts({ ...emptyBlobRows(), ...blobTables(derived) }), coveredAtRead: [kept], settledAtRead: [] });
    await run.of(store).blobs(keys, ALL_BLOB_REQUEST);
    expect(store.asked, 'the re-read asks for the moved key alone').toHaveLength(2);
    expect(store.readKeys.at(-1)).toEqual([moved]);
  });

  it('answer a tree from what they hold when a request differs only in its steps', async () => {
    const store = new FakeFactStore();
    const tree = { rootId: 'root', treeHash: 'tree' };
    const reads = runStoredReads().of(store);
    const tables = EXTENT_STEP_TABLES.identity;

    await reads.extent(tree, { tables, steps: [] });
    await reads.extent(tree, { tables, steps: [] });
    expect(store.readExtentCalls, 'the same request reads once').toBe(1);

    // The store runs no step (the caller does, over the rows), so the held rows answer it.
    await reads.extent(tree, { tables, steps: ['identity'] });
    expect(store.readExtentCalls, 'a request differing only in its steps reads nothing').toBe(1);
  });
});

/** A tracked document and a gitignored one the default deferral leaves unkeyed until a promotion. */
const TRACKED = 'README.md';
const IGNORED = 'ignored/notes.md';

/** Plant the repository; returns its git oracle. */
async function plantPromotable(): Promise<GitTracker> {
  writeFileIn(suite.tempDir, TRACKED, '# Readme\n\nSee [notes](./ignored/notes.md).\n');
  writeFileIn(suite.tempDir, IGNORED, '# Notes\n\n[back](../README.md)\n');
  writeFileIn(suite.tempDir, '.gitignore', 'ignored/\n');
  createGitRepo(suite.tempDir);
  const tracker = new GitTracker(suite.tempDir);
  await tracker.initialize();
  return tracker;
}

/** The base stratum alone, the ignored document deferred. */
async function deferredBase(tracker: GitTracker): Promise<ProjectionBuilder> {
  const builder = new ProjectionBuilder({ root: suite.tempDir, gitTracker: tracker, contentCache: new RunContentCache() });
  const contribution = await new FilesystemExtentContributor((at) => crawlSourceFor(at, []), DEFAULT_CONTENT_DEMAND).contribute(builder.base(), null);
  for (const row of contribution.realizations) builder.addRealization(row);
  return builder;
}

/** A store holding both documents' facts: a run that promoted the ignored one, filed. */
async function primedStore(tracker: GitTracker): Promise<{ store: FakeFactStore; promotedKey: string }> {
  const builder = await deferredBase(tracker);
  const promotedKey = await builder.ensureContentKey(IGNORED);
  if (promotedKey === null) throw new Error(`${IGNORED} could not be promoted`);
  await populateBlobsOnOwnDispatcher(builder);
  const store = new FakeFactStore();
  await store.writeBlobFacts({ rows: storableBlobFacts({ ...emptyBlobRows(), ...blobTables(builder.build()) }), coveredAtRead: [], settledAtRead: [] });
  return { store, promotedKey };
}

/** The stage over `store`, its base read and populate done, as `deriveProjection` runs it. */
async function stageOverBase(builder: ProjectionBuilder, dispatcher: ParseDispatcher, store: FakeFactStore): Promise<BlobStage> {
  const stage: BlobStage = { dispatcher, content: diskRunContentSource(builder.base().contentCache), tier: tierOver(store) };
  const stored = await stage.tier.cover(keyedContentKeys(builder.base()), ALL_BLOB_REQUEST);
  await populateBlobs(builder, { dispatcher, content: stage.content, stored });
  return stage;
}

describe('a key a demand promotion adds', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('reads nothing further when nothing was promoted', async () => {
    const tracker = await plantPromotable();
    const { store } = await primedStore(tracker);
    const builder = await deferredBase(tracker);
    const reads = vi.spyOn(store, 'readBlobFacts');

    await withParseDispatcher(async (dispatcher) => {
      const stage = await stageOverBase(builder, dispatcher, store);
      await afterClosurePromotion(builder, builder.contentPromotionAttempts, stage);
    });

    expect(reads, 'the base read alone').toHaveBeenCalledTimes(1);
  });

  it('is read from the tier once more, alone, and served when the store covers it', async () => {
    const tracker = await plantPromotable();
    const { store, promotedKey } = await primedStore(tracker);
    const builder = await deferredBase(tracker);
    const reads = vi.spyOn(store, 'readBlobFacts');

    const { before, after } = await withParseDispatcher(async (dispatcher) => {
      const stage = await stageOverBase(builder, dispatcher, store);
      const attempts = builder.contentPromotionAttempts;
      expect(await builder.ensureContentKey(IGNORED)).toBe(promotedKey);
      const counted = readWorkCounters();
      await afterClosurePromotion(builder, attempts, stage);
      return { before: counted, after: readWorkCounters() };
    });

    expect(reads, 'the base read, then one for the promoted key').toHaveBeenCalledTimes(2);
    expect(reads.mock.calls[1]?.[0], 'the further read asks only the key no earlier read asked about').toEqual([promotedKey]);
    expect(after['blob.storeServed'] - before['blob.storeServed'], 'the promoted key is served').toBe(1);
    expect(parseLookupsIn(after) - parseLookupsIn(before), 'and never parsed').toBe(0);
    expect(builder.build().blobs.map((row) => row.contentKey)).toContain(promotedKey);
  });
});
