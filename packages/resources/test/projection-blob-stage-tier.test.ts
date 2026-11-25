/**
 * The blob stage over a stored tier: a covered key's rows land where a parse would put them,
 * whatever order the store returns them in, and a key a demand promotion adds is read from the
 * tier once more, alone, and served when the store covers it.
 */

import { readWorkCounters } from '@vibe-agent-toolkit/utils';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';
import { parseLookupsIn } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ParseDispatcher, withParseDispatcher } from '../src/parse-dispatcher.js';
import { populateBlobs, storableBlobFacts } from '../src/projection/blob-population.js';
import { blobRowsByKey } from '../src/projection/blob-resource-facts.js';
import { RunContentCache } from '../src/projection/content-cache.js';
import { DEFAULT_CONTENT_DEMAND, FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { crawlSourceFor } from '../src/projection/crawl-source.js';
import { afterClosurePromotion, type BlobStage, storedTierReads } from '../src/projection/merge.js';
import { type Projection, ProjectionBuilder } from '../src/projection/projection.js';
import { diskRunContentSource } from '../src/projection/run-population.js';
import { emptyBlobRows, keyedContentKeys, storedBlobTier } from '../src/projection/store-hydration.js';
import type { BlobScopedRows } from '../src/projection/store.js';
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
  const stage: BlobStage = { dispatcher, content: diskRunContentSource(builder.base().contentCache), tier: storedTierReads(store) };
  const stored = await stage.tier.cover(keyedContentKeys(builder.base()));
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
