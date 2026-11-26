/**
 * The blob stage over a stored tier: a covered key's rows land where a parse would put them,
 * whatever order the store returns them in, a key's rows come from one read, and a key a demand
 * promotion adds is read from the tier once more, alone, and served when the store covers it.
 */

import { compareCodeUnits, readWorkCounters } from '@vibe-agent-toolkit/utils';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';
import { parseLookupsIn } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { orderContentKeys, type ContentKey } from '../src/content-key.js';
import { type ParseDispatcher, withParseDispatcher } from '../src/parse-dispatcher.js';
import { populateBlobs, storableBlobFacts } from '../src/projection/blob-population.js';
import { AST_SYNTACTIC_FORMS } from '../src/projection/blob-references.js';
import { blobRowsByKey } from '../src/projection/blob-resource-facts.js';
import { NO_GIT_MEMBERS, RunContentCache } from '../src/projection/content-cache.js';
import { DEFAULT_CONTENT_DEMAND, FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { crawlSourceFor } from '../src/projection/crawl-source.js';
import { compareRows } from '../src/projection/export.js';
import { storedHarnessRows } from '../src/projection/harness/harness-pass.js';
import { afterClosurePromotion, type BlobStage } from '../src/projection/merge.js';
import { type Projection, ProjectionBuilder } from '../src/projection/projection.js';
import { QUERY_BLOB_REQUEST } from '../src/projection/query-projection.js';
import { diskRunContentSource } from '../src/projection/run-population.js';
import { emptyBlobRows, keyedContentKeys, storedBlobTier, type StoredBlobTier } from '../src/projection/store-hydration.js';
import {
  ALL_BLOB_REQUEST,
  type BlobFactsRead,
  type BlobFactsWrite,
  type BlobRequest,
  type BlobScopedRows,
  type BlobScopedTableName,
  EXTENT_STEP_TABLES,
  type HarnessPair,
} from '../src/projection/store.js';
import { PROJECTION_STORE_READ_FAILED_CODE, runStoredReads, storedTierReads } from '../src/projection/stored-reads.js';
import { PROJECTION_TABLES } from '../src/projection/table-registry.js';
import { type BlobConditionRow, type ReferenceSyntacticForm, ReferenceSyntacticFormSchema } from '../src/schemas/projection-blobs.js';
import type { HarnessBlobFactsRow, HarnessBlobImportRow } from '../src/schemas/projection-harness.js';
import { testContentKey } from '../src/testing.js';

import { baseBuilderForRoot, populateBlobsOnOwnDispatcher } from './blob-fixture-population.js';
import { FailingBlobStore, FakeFactStore, WIDE_BLOB_BUDGET_BYTES } from './fake-fact-store.js';
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

/** The one key {@link conditionRow} files under. */
const CONDITION_KEY = testContentKey('markdown', 'key');

/** One condition row of `code` at `ordinal`. */
function conditionRow(code: string, ordinal: number): BlobConditionRow {
  return { blob: CONDITION_KEY, code, ordinal, severity: 'warning', message: `${code} ${String(ordinal)}`, line: null };
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

    expect(grouped.get(CONDITION_KEY)?.conditions).toEqual(inOrder);
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
  readonly readKeys: (readonly ContentKey[])[] = [];

  override readBlobFacts<Table extends BlobScopedTableName>(contentKeys: readonly ContentKey[], request: BlobRequest<Table>): Promise<BlobFactsRead<Table>> {
    this.asked.push(request as unknown as BlobRequest<BlobScopedTableName>);
    this.readKeys.push(contentKeys);
    return super.readBlobFacts(contentKeys, request);
  }
}

/** What a store was asked: the tables, and of `blobReferences` the forms, each sorted. */
interface Asked {
  readonly tables: readonly string[];
  readonly forms: string | readonly string[];
}

/**
 * A request as {@link askedOf} reports it.
 *
 * @param request - The request
 * @returns Its tables and forms, sorted; no forms when it does not name `blobReferences`
 */
function asAsked(request: BlobRequest<BlobScopedTableName>): Asked {
  const forms = request.referenceForms === 'all' ? 'all' : [...request.referenceForms].sort(compareCodeUnits);
  return { tables: [...request.tables].sort(compareCodeUnits), forms: request.tables.includes('blobReferences') ? forms : [] };
}

/** Each request as the store was asked it. */
function askedOf(store: RecordingStore): Asked[] {
  return store.asked.map((request) => asAsked(request));
}

/** A write filing `derived`'s blob tier, covering nothing at read: a derived population's. */
function derivedWrite(derived: Projection): BlobFactsWrite {
  return { rows: storableBlobFacts({ ...emptyBlobRows(), ...blobTables(derived) }), coveredAtRead: [], settledAtRead: [] };
}

/** `store`, holding `derived`'s blob tier. */
async function filledWith<Store extends FakeFactStore>(store: Store, derived: Projection): Promise<Store> {
  await store.writeBlobFacts(derivedWrite(derived));
  return store;
}

/** A store holding `derived`'s blob tier, recording what it is asked. */
async function recordingStoreOf(derived: Projection): Promise<RecordingStore> {
  return filledWith(new RecordingStore(WIDE_BLOB_BUDGET_BYTES), derived);
}

/**
 * A store whose answer names every requested key present, whatever its ledger holds: to the reader,
 * the mutant that joins two reads without the presence check.
 */
class PresenceBlindStore extends RecordingStore {
  override async readBlobFacts<Table extends BlobScopedTableName>(contentKeys: readonly ContentKey[], request: BlobRequest<Table>): Promise<BlobFactsRead<Table>> {
    const { rows } = await super.readBlobFacts(contentKeys, request);
    return { rows, present: new Set(contentKeys) };
  }
}

/** The lexical forms: every form the query request leaves out. */
const LEXICAL_FORMS: ReadonlySet<ReferenceSyntacticForm> = new Set(ReferenceSyntacticFormSchema.options.filter((form) => !AST_SYNTACTIC_FORMS.has(form)));

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


  it('reads under a wider request only the forms it lacks, and holds what one whole read holds', async () => {
    const derived = await twoDocuments();
    const keys = keyedContentKeys(derived);
    const store = await recordingStoreOf(derived);
    // The premise: the store holds rows of both kinds of form.
    expect(derived.blobReferences.some((row) => AST_SYNTACTIC_FORMS.has(row.syntacticForm))).toBe(true);
    expect(derived.blobReferences.some((row) => LEXICAL_FORMS.has(row.syntacticForm))).toBe(true);

    const reader = tierOver(store);
    await reader.cover(keys, QUERY_BLOB_REQUEST);
    const joined = await reader.cover(keys, ALL_BLOB_REQUEST);
    await reader.cover(keys, ALL_BLOB_REQUEST);
    const asked = askedOf(store);
    const once = await tierOver(store).cover(keys, ALL_BLOB_REQUEST);

    expect(asked, 'the hit, then the lexical references alone, and a repeated cover reads nothing').toEqual([
      asAsked(QUERY_BLOB_REQUEST),
      asAsked({ tables: ['blobReferences'], referenceForms: LEXICAL_FORMS }),
    ]);
    expect(canonical(joined.rows)).toEqual(canonical(once.rows));
    expect([...joined.covered].sort(orderContentKeys)).toEqual([...once.covered].sort(orderContentKeys));
  });

  it('merges a narrow read and a wider one into a whole read\'s reference rows, in order', async () => {
    // An `@` import (lexical) on a line before a markdown link (AST): the two reads' ordinals interleave.
    writeFileIn(suite.tempDir, 'doc.md', '# Doc\n\nSee @other.md.\n\nThen [other](./other.md).\n');
    writeFileIn(suite.tempDir, 'other.md', '# Other\n');
    const builder = await baseBuilderForRoot(suite.tempDir);
    await populateBlobsOnOwnDispatcher(builder);
    const derived = builder.build();
    const keys = keyedContentKeys(derived);
    // The premise, in the order a key holds its rows (primary key), not the order a parse emits them.
    const inKeyOrder = derived.blobReferences.toSorted(compareRows(PROJECTION_TABLES.blobReferences));
    const firstAst = inKeyOrder.findIndex((row) => AST_SYNTACTIC_FORMS.has(row.syntacticForm));
    expect(firstAst, 'the premise: an AST row').toBeGreaterThan(0);
    expect(inKeyOrder.slice(0, firstAst).some((row) => LEXICAL_FORMS.has(row.syntacticForm)), 'the premise: a lexical row precedes an AST row').toBe(true);
    const store = await recordingStoreOf(derived);

    const reader = tierOver(store);
    await reader.cover(keys, QUERY_BLOB_REQUEST);
    const merged = await reader.cover(keys, ALL_BLOB_REQUEST);
    const once = await tierOver(store).cover(keys, ALL_BLOB_REQUEST);

    expect(merged.rows.blobReferences).toEqual(once.rows.blobReferences);
  });

  it('holds a key the store lacks as absent, reading nothing more until a write moves it', async () => {
    const derived = await twoDocuments();
    const keys = keyedContentKeys(derived);
    const store = new RecordingStore(WIDE_BLOB_BUDGET_BYTES);
    const reads = runStoredReads().of(store);

    expect((await reads.blobs(keys, QUERY_BLOB_REQUEST)).blobs).toEqual([]);
    expect((await reads.blobs(keys, ALL_BLOB_REQUEST)).blobReferences, 'a wider request is answered with no rows').toEqual([]);
    expect(store.asked, 'and reads nothing').toHaveLength(1);

    // A derived population files the keys: uncovered at read, so the write moves them.
    await reads.writeBlobs(derivedWrite(derived));
    const filed = await reads.blobs(keys, ALL_BLOB_REQUEST);

    expect(store.asked, 'the next ask reads them').toHaveLength(2);
    expect(filed.blobs.map((row) => row.contentKey).sort(orderContentKeys)).toEqual([...keys].sort(orderContentKeys));
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

    expect([...(await partial.cover([first], ALL_BLOB_REQUEST)).covered].sort(orderContentKeys)).toEqual([...once.covered].sort(orderContentKeys));
  });
});

/**
 * Another process's eviction between a hit's read and the derivation's wider read, over a store
 * `make` builds.
 *
 * @param make - Builds the store
 * @returns The keys, the evicted one, and the tier after each read
 */
async function evictedBetweenReads(make: () => RecordingStore): Promise<{ keys: readonly ContentKey[]; evicted: ContentKey; hit: StoredBlobTier; widened: StoredBlobTier }> {
  const derived = await twoDocuments();
  const keys = keyedContentKeys(derived);
  const [evicted] = keys;
  if (evicted === undefined || keys.length < 2) throw new Error('the premise: two keyed documents');
  const store = await filledWith(make(), derived);

  const reader = tierOver(store);
  const hit = await reader.cover(keys, QUERY_BLOB_REQUEST);
  expect(hit.covered.has(evicted), 'the hit covered it').toBe(true);
  store.forgetBlobFacts(evicted);
  const widened = await reader.cover(keys, ALL_BLOB_REQUEST);
  return { keys, evicted, hit, widened };
}

describe('a torn read', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  // The mutant the presence check catches: to the reader, a store blind to presence is a reader
  // that joins two snapshots without the check. Under it the evicted key is judged covered on the
  // hit's rows, the hazard the next test guards; asserted, so the seed cannot pass on a setup error.
  it('over a store blind to presence, judges the evicted key covered on the first read\'s rows', async () => {
    const { evicted, hit, widened } = await evictedBetweenReads(() => new PresenceBlindStore(WIDE_BLOB_BUDGET_BYTES));
    const firstRead = hit.rows.blobs.filter((row) => row.contentKey === evicted);

    expect(firstRead, 'the premise: the hit read its blobs row').toHaveLength(1);
    expect(widened.covered.has(evicted), 'the mutant covers it').toBe(true);
    expect(widened.rows.blobs.filter((row) => row.contentKey === evicted), 'with the first read\'s blobs row').toEqual(firstRead);
  });

  it('judges a key evicted between a hit and the wider read uncovered, holding none of its rows', async () => {
    const { keys, evicted, widened } = await evictedBetweenReads(() => new RecordingStore(WIDE_BLOB_BUDGET_BYTES));

    expect(widened.covered.has(evicted), 'a key gone from the store is not covered').toBe(false);
    expect(widened.rows.blobs.some((row) => row.contentKey === evicted), 'no row of it from the earlier read').toBe(false);
    expect(widened.rows.blobReferences.some((row) => row.blob === evicted), 'neither form of reference').toBe(false);
    expect([...widened.covered].sort(orderContentKeys)).toEqual(keys.filter((key) => key !== evicted).sort(orderContentKeys));
  });
});

/** One read a {@link HeldStore} holds until the test releases it. */
interface HeldRead {
  readonly release: () => void;
}

/**
 * A store whose reads, while `holding`, wait for the test to release them: answered from the ledger
 * at the release, or, when `snapshotAtCall`, from the ledger at the call (a read whose transaction
 * ran before an eviction and whose answer arrives after it).
 */
class HeldStore extends RecordingStore {
  holding = false;
  snapshotAtCall = false;
  readonly held: HeldRead[] = [];

  override readBlobFacts<Table extends BlobScopedTableName>(contentKeys: readonly ContentKey[], request: BlobRequest<Table>): Promise<BlobFactsRead<Table>> {
    if (!this.holding) return super.readBlobFacts(contentKeys, request);
    const gate = Promise.withResolvers<undefined>();
    this.held.push({ release: () => { gate.resolve(undefined); } });
    if (this.snapshotAtCall) {
      const answer = super.readBlobFacts(contentKeys, request);
      return gate.promise.then(async () => answer);
    }
    return gate.promise.then(async () => super.readBlobFacts(contentKeys, request));
  }
}

/** Let every started call reach its store read, and every released read settle. */
async function settled(): Promise<void> {
  await new Promise((resolve) => { setImmediate(resolve); });
}

/** An answer's reference rows as sorted text: a row held twice shows twice. */
function referenceTexts(rows: Pick<BlobScopedRows, 'blobReferences'>): string[] {
  return rows.blobReferences.map((row) => JSON.stringify(row)).sort(compareCodeUnits);
}

/** A held-read store filled with two documents, and one of their keys. */
async function heldStoreOfOneKey(): Promise<{ key: ContentKey; store: HeldStore }> {
  const derived = await twoDocuments();
  const [key] = keyedContentKeys(derived);
  if (key === undefined) throw new Error('the premise: a keyed document');
  return { key, store: await filledWith(new HeldStore(WIDE_BLOB_BUDGET_BYTES), derived) };
}

describe('overlapping calls on one key', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('share one read, and each answer holds each reference once', async () => {
    const { key, store } = await heldStoreOfOneKey();
    const whole = await runStoredReads().of(store).blobs([key], ALL_BLOB_REQUEST);
    expect(whole.blobReferences.length, 'the premise: the key holds references').toBeGreaterThan(0);
    const before = store.asked.length;
    const reads = runStoredReads().of(store);

    store.holding = true;
    const first = reads.blobs([key], ALL_BLOB_REQUEST);
    const second = reads.blobs([key], ALL_BLOB_REQUEST);
    await settled();
    for (const read of store.held) read.release();
    const answers = await Promise.all([first, second]);

    for (const answer of answers) expect(referenceTexts(answer), 'each reference once').toEqual(referenceTexts(whole));
    expect(store.asked.length - before, 'the store is asked once').toBe(1);
  });

  it('keep a key a read found absent absent, whatever a read begun before it answers', async () => {
    const { key, store } = await heldStoreOfOneKey();
    const reads = runStoredReads().of(store);
    const held = await reads.blobs([key], { tables: ['blobs', 'blobReferences'], referenceForms: AST_SYNTACTIC_FORMS });
    expect(held.blobs, 'the premise: the key is held').toHaveLength(1);

    store.holding = true;
    // B: the lexical references, read before the eviction and answered after it.
    store.snapshotAtCall = true;
    const wider = reads.blobs([key], { tables: ['blobReferences'], referenceForms: LEXICAL_FORMS });
    await settled();
    // A: the harness unit, read after the eviction and answered first.
    store.snapshotAtCall = false;
    const harness = reads.blobs([key], { tables: ['harnessBlobFacts'], referenceForms: 'all' });
    await settled();
    store.forgetBlobFacts(key);
    const [readB, readA] = store.held;
    if (readA === undefined || readB === undefined) throw new Error('the premise: both reads are held');
    readA.release();
    await settled();
    readB.release();
    const answers: readonly object[] = [await harness, await wider];
    store.holding = false;
    const after = await reads.blobs([key], ALL_BLOB_REQUEST);

    expect(store.held, 'the premise: two reads, one per unit').toHaveLength(2);
    expect(held.blobReferences.length, 'the premise: the key held rows before the eviction').toBeGreaterThan(0);
    expect(storedBlobTier(after, [key]).covered.has(key), 'a key a read found gone is not covered').toBe(false);
    for (const answer of [...answers, after]) {
      expect(Object.values(answer).flat(), 'and holds none of its rows').toEqual([]);
    }
  });

  it('read a unit again after its read rejected, the rejection coded as the store\'s', async () => {
    const derived = await twoDocuments();
    const keys = keyedContentKeys(derived);
    const store = await filledWith(new FailingBlobStore(WIDE_BLOB_BUDGET_BYTES), derived);
    const reads = runStoredReads().of(store);

    store.failBlobs = true;
    await expect(reads.blobs(keys, ALL_BLOB_REQUEST)).rejects.toMatchObject({ code: PROJECTION_STORE_READ_FAILED_CODE, cause: store.failure });
    store.failBlobs = false;
    const retried = await reads.blobs(keys, ALL_BLOB_REQUEST);

    expect(retried.blobs.map((row) => row.contentKey).sort(orderContentKeys)).toEqual([...keys].sort(orderContentKeys));
  });
});

/**
 * A harness pass's write of one `(key, claude-code)` pair, unsettled at read: the key's facts and
 * one import, its read having covered the key.
 *
 * @param key - The key
 * @returns The pair, its facts row, and the write
 */
function harnessPairWrite(key: ContentKey): { pair: HarnessPair; facts: HarnessBlobFactsRow; write: BlobFactsWrite } {
  const pair: HarnessPair = { contentKey: key, harness: 'claude-code' };
  const facts: HarnessBlobFactsRow = { blob: key, harness: 'claude-code', injectedBytes: 4, injectedTokens: 1, paths: null };
  const imports: HarnessBlobImportRow[] = [{ blob: key, harness: 'claude-code', ordinal: 0, rawRef: '@other.md', target: 'other.md', line: 3 }];
  return { pair, facts, write: { rows: { ...emptyBlobRows(), harnessBlobFacts: [facts], harnessBlobImports: imports }, coveredAtRead: [key], settledAtRead: [] } };
}

describe('the harness tables, one unit per key', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('are read together when a request names one, and answered as asked', async () => {
    const derived = await twoDocuments();
    const keys = keyedContentKeys(derived);
    const store = await recordingStoreOf(derived);

    const answer = await runStoredReads().of(store).blobs(keys, { tables: ['harnessBlobFacts'], referenceForms: 'all' });

    expect(askedOf(store)).toEqual([asAsked({ tables: ['harnessBlobFacts', 'harnessBlobImports'], referenceForms: 'all' })]);
    expect(Object.keys(answer)).toEqual(['harnessBlobFacts']);
  });

  it('hold a pair the store gains after their read as unsettled, until a write moves the key', async () => {
    const derived = await twoDocuments();
    const keys = keyedContentKeys(derived);
    const [key] = keys;
    if (key === undefined) throw new Error('the premise: a keyed document');
    const store = await recordingStoreOf(derived);
    const reads = runStoredReads().of(store);
    const tier = storedTierReads(reads);
    const { pair, facts, write } = harnessPairWrite(key);

    await tier.cover(keys, QUERY_BLOB_REQUEST);
    // Another process's harness pass files the pair, after this run's read.
    await store.writeBlobFacts(write);
    const widened = await tier.cover(keys, ALL_BLOB_REQUEST);
    expect(storedHarnessRows(widened).rowsFor(pair), 'unsettled, so this run\'s harness pass derives it').toBeUndefined();

    // That pass files it unsettled at read: the write moves the key, and the next ask reads it.
    await reads.writeBlobs(write);
    const filed = await tier.cover(keys, ALL_BLOB_REQUEST);

    expect(store.readKeys.at(-1), 'the moved key alone').toEqual([key]);
    expect(storedHarnessRows(filed).rowsFor(pair)?.facts).toEqual(facts);
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
    const store = new FakeFactStore(WIDE_BLOB_BUDGET_BYTES);
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
  const builder = new ProjectionBuilder({ root: suite.tempDir, gitTracker: tracker, contentCache: new RunContentCache(NO_GIT_MEMBERS) });
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
  const store = new FakeFactStore(WIDE_BLOB_BUDGET_BYTES);
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
