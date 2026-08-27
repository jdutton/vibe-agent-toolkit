import { rm, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RunContentCache } from '../src/projection/content-cache.js';
import { ProjectionBuilder, REALIZATION_PROMOTION_UNREADABLE } from '../src/projection/projection.js';
import {
  collectRealization,
  createCollectionMimeResolver,
  type CollectionMimeResolver,
  type ContentDemand,
} from '../src/projection/realizations.js';

import { setupSubdirTestSuite } from './test-helpers.js';

const DOC = 'notes.md';
const OTHER_DOC = 'other.md';
const MISSING = 'never-written.md';
const DOC_CONTENT = '# Notes\n\n[b](./b.md)\n';

/**
 * A path whose extension routes to NO parser, so a collection-declared
 * `text/markdown` on it disagrees with `parserKindForPath` — the only shape in
 * which re-deriving the kind from the path is observable.
 */
const TYPED_SOURCE = 'typed-as-prose.ts';

const EXTENT_A = 'ctx-filesystem';
const EXTENT_B = 'ctx-package';
const RESOURCE = 'res-notes';
const OTHER_RESOURCE = 'res-other';

/** A markdown content key, which is what a promoted row must carry. */
const MARKDOWN_KEY = /^markdown\.[\da-f]{64}$/u;

const suite = setupSubdirTestSuite('ensure-content-key-');

/** One realization row's answer to "were these bytes keyed, and under what state". */
interface RowState {
  extentId: string;
  state: string;
  key: string | null;
}

async function writeDoc(path: string, content: string): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path beneath a mkdtemp root
  await writeFile(safePath.join(suite.tempDir, path), content, 'utf-8');
}

/**
 * A builder holding one realization of `path` per extent, under one demand policy.
 *
 * Built through `collectRealization` rather than by hand: the whole property
 * under test is that a row the *real* enumeration path left `deferred` can be
 * promoted, and a hand-stamped `contentState: 'deferred'` would prove only that
 * the fixture agrees with itself.
 */
async function builderWith(
  cache: RunContentCache,
  path: string,
  extentIds: readonly string[],
  demand: ContentDemand = 'deferred',
  mimeResolver?: CollectionMimeResolver,
): Promise<ProjectionBuilder> {
  const builder = new ProjectionBuilder({ root: suite.tempDir, contentCache: cache });
  for (const extentId of extentIds) {
    // Sequential: `collectRealization` reads through the shared cache, and the
    // miss/hit counts these tests assert on are the point.
    const row = await collectRealization(safePath.join(suite.tempDir, path), RESOURCE, {
      root: suite.tempDir,
      extentId,
      contentCache: cache,
      contentDemand: demand,
      mimeResolver,
    });
    builder.addRealization(row);
  }
  return builder;
}

/** Every realization of one path, in insertion order. */
function rowsFor(builder: ProjectionBuilder, path: string): RowState[] {
  return builder.build().resourceRealizations
    .filter((row) => row.path === path)
    .map((row) => ({ extentId: row.extentId, state: row.contentState, key: row.contentKey }));
}

/** The states alone, when the key's value does not matter to the claim. */
function statesFor(builder: ProjectionBuilder, path: string): string[] {
  return rowsFor(builder, path).map((row) => row.state);
}

describe('ProjectionBuilder.ensureContentKey', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('promotes a deferred realization to keyed and returns the key', async () => {
    await writeDoc(DOC, DOC_CONTENT);
    const cache = new RunContentCache();
    const builder = await builderWith(cache, DOC, [EXTENT_A]);
    expect(statesFor(builder, DOC)).toEqual(['deferred']);

    const key = await builder.ensureContentKey(DOC);

    expect(key).toMatch(MARKDOWN_KEY);
    expect(rowsFor(builder, DOC)).toEqual([{ extentId: EXTENT_A, state: 'keyed', key }]);
    expect(builder.contentPromotions).toBe(1);
  });

  it('records a read that throws as unreadable, and does not count it as a promotion', async () => {
    await writeDoc(DOC, DOC_CONTENT);
    const cache = new RunContentCache();
    const builder = await builderWith(cache, DOC, [EXTENT_A]);
    // Deferring meant the bytes were never read, so deleting the file now makes
    // the demand-time read the first and only one — and it fails.
    await rm(safePath.join(suite.tempDir, DOC), { force: true });

    const key = await builder.ensureContentKey(DOC);

    expect(key).toBeNull();
    expect(rowsFor(builder, DOC)).toEqual([{ extentId: EXTENT_A, state: 'unreadable', key: null }]);
    // No content key entered the projection, so there is nothing for a second
    // blob-derivation run to find. Counting this would make the merge driver
    // re-derive the whole corpus for a file it could not read.
    expect(builder.contentPromotions).toBe(0);
  });

  it('records WHY a failed promotion produced no key, instead of swallowing the error', async () => {
    // The defect this pins: the `catch` was bare. The error's `code`, its
    // message and the path were all discarded, so the projection carried an
    // `unreadable` row and no statement of what went wrong — the state without
    // the cause.
    await writeDoc(DOC, DOC_CONTENT);
    const cache = new RunContentCache();
    const builder = await builderWith(cache, DOC, [EXTENT_A, EXTENT_B]);
    // The positive control for the assertion below: the corpus really did reach
    // this builder, so an empty condition table would be a fact about the catch
    // rather than about a fixture that enumerated nothing.
    expect(statesFor(builder, DOC)).toEqual(['deferred', 'deferred']);
    expect(builder.build().realizationConditions).toEqual([]);

    await rm(safePath.join(suite.tempDir, DOC), { force: true });
    await builder.ensureContentKey(DOC);

    const conditions = builder.build().realizationConditions
      .filter((row) => row.code === REALIZATION_PROMOTION_UNREADABLE);
    // One per extent that deferred the path, matching the rows that were
    // rewritten — a single row would leave EXTENT_B `unreadable` with nothing
    // saying why.
    expect(conditions.map((row) => row.extentId)).toEqual([EXTENT_A, EXTENT_B]);
    for (const row of conditions) {
      expect(row.path).toBe(DOC);
      // The path and the `errorLabel`, exactly as `readTarget` records them for
      // a blob. ENOENT, not the raw message: an `fs` message embeds the absolute
      // path, and every other column here is root-relative.
      expect(row.message).toContain(DOC);
      expect(row.message).toContain('ENOENT');
      expect(row.message).not.toContain(suite.tempDir);
    }
  });

  it('counts a failed promotion as an ATTEMPT, so it cannot read as nobody having asked', async () => {
    // `contentPromotions` alone cannot express this: it is the SUCCESS counter,
    // and the merge driver comparing only that reported "every read failed" and
    // "no consumer asked" as the same deliberate no-op.
    await writeDoc(DOC, DOC_CONTENT);
    const cache = new RunContentCache();
    const builder = await builderWith(cache, DOC, [EXTENT_A]);
    expect(builder.contentPromotionAttempts).toBe(0);

    await rm(safePath.join(suite.tempDir, DOC), { force: true });
    await builder.ensureContentKey(DOC);

    expect(builder.contentPromotionAttempts).toBe(1);
    expect(builder.contentPromotions).toBe(0);
  });

  it('does not count an attempt for a path with nothing deferred — no read, no question', async () => {
    // The discriminator that stops `contentPromotionAttempts` degenerating into
    // "how many times was `ensureContentKey` called". Without it every lens
    // asking after an already-keyed path would make the driver re-run the blob
    // stage over a corpus with no new work in it.
    await writeDoc(DOC, DOC_CONTENT);
    const cache = new RunContentCache();
    const builder = await builderWith(cache, DOC, [EXTENT_A], 'eager');

    await builder.ensureContentKey(DOC);

    expect(builder.contentPromotionAttempts).toBe(0);
    expect(builder.build().realizationConditions).toEqual([]);
  });

  it('reads once however often it is asked — a second call is a memo, not a read', async () => {
    await writeDoc(DOC, DOC_CONTENT);
    const cache = new RunContentCache();
    const builder = await builderWith(cache, DOC, [EXTENT_A]);

    const first = await builder.ensureContentKey(DOC);
    const missesAfterFirst = cache.stats.misses;
    const second = await builder.ensureContentKey(DOC);

    // Idempotence asserted against the cache, not by inspection: a memo whose
    // hit rate nothing measures is a claim rather than a property.
    expect(missesAfterFirst).toBe(1);
    expect(second).toBe(first);
    expect(cache.stats.misses).toBe(missesAfterFirst);
    expect(builder.contentPromotions).toBe(1);
  });

  it('touches the cache not at all for a path the base already keyed', async () => {
    await writeDoc(DOC, DOC_CONTENT);
    const cache = new RunContentCache();
    const builder = await builderWith(cache, DOC, [EXTENT_A], 'eager');
    const enumerated = rowsFor(builder, DOC)[0]?.key;
    const before = cache.stats;

    const key = await builder.ensureContentKey(DOC);

    expect(key).toBe(enumerated);
    // Neither counter moves: the early return happens before `readKeyedContent`
    // is called at all, so this is stronger than "the read was a cache hit".
    expect(cache.stats.misses).toBe(before.misses);
    expect(cache.stats.hits).toBe(before.hits);
    expect(builder.contentPromotions).toBe(0);
  });

  it('promotes every extent that realizes the path, on one read', async () => {
    await writeDoc(DOC, DOC_CONTENT);
    const cache = new RunContentCache();
    const builder = await builderWith(cache, DOC, [EXTENT_A, EXTENT_B]);

    const key = await builder.ensureContentKey(DOC);

    // Leaving one row deferred would make the answer depend on which extent a
    // consumer happened to join through.
    expect(rowsFor(builder, DOC)).toEqual([
      { extentId: EXTENT_A, state: 'keyed', key },
      { extentId: EXTENT_B, state: 'keyed', key },
    ]);
    expect(cache.stats.misses).toBe(1);
    // Per path, not per row: two rows were rewritten by one act of reading.
    expect(builder.contentPromotions).toBe(1);
  });

  it('returns null without reading for a path that has no bytes to key', async () => {
    const cache = new RunContentCache();
    const builder = await builderWith(cache, MISSING, [EXTENT_A]);
    expect(statesFor(builder, MISSING)).toEqual(['none']);

    const key = await builder.ensureContentKey(MISSING);

    expect(key).toBeNull();
    // `none` is not `deferred`: a demand policy may not relabel a path that has
    // nothing to read, and asking for it must not attempt a read.
    expect(statesFor(builder, MISSING)).toEqual(['none']);
    expect(cache.stats).toMatchObject({ misses: 0, hits: 0 });
    expect(builder.contentPromotions).toBe(0);
  });

  it('returns null for a path this projection never realized', async () => {
    const cache = new RunContentCache();
    const builder = await builderWith(cache, DOC, [EXTENT_A]);
    await writeDoc(OTHER_DOC, DOC_CONTENT);

    // On disk, but not a row: `ensureContentKey` promotes realizations, it does
    // not enumerate. Reading here would put bytes in the cache for a path no
    // extent claims.
    expect(await builder.ensureContentKey(OTHER_DOC)).toBeNull();
    expect(cache.stats.misses).toBe(0);
  });

  it('keys a promoted row under the row\'s OWN mime, not the one its extension implies', async () => {
    // The defect this pins: `ensureContentKey` re-derived the parser kind with
    // `parserKindForPath(absolutePath)`. A collection that declares
    // `mimeType: text/markdown` for a `.ts` file puts `text/markdown` on the
    // row, and the enumeration path (`keyOrState`) already honours it — but a
    // row that DEFERRED reaches its key through here instead, and re-deriving
    // from the path handed the bytes to no parser at all. The result was a row
    // whose `mime` said prose and whose `contentKey` said `none.<digest>`: a
    // well-formed entry with the wrong contents, which every downstream stage
    // reads the kind back off.
    await writeDoc(TYPED_SOURCE, DOC_CONTENT);
    const cache = new RunContentCache();
    const resolver = createCollectionMimeResolver({
      prose: { include: ['**/*.ts'], mimeType: 'text/markdown' },
    });
    const builder = await builderWith(cache, TYPED_SOURCE, [EXTENT_A], 'deferred', resolver);

    // Positive control, both halves. Without the first the fixture might be
    // asserting about a `.md` file; without the second there is no deferral and
    // `ensureContentKey` never reaches the read this test is about.
    const before = builder.build().resourceRealizations.find((row) => row.path === TYPED_SOURCE);
    expect(before?.mime).toBe('text/markdown');
    expect(before?.contentState).toBe('deferred');

    const key = await builder.ensureContentKey(TYPED_SOURCE);

    expect(key).toMatch(MARKDOWN_KEY);
    expect(rowsFor(builder, TYPED_SOURCE)).toEqual([
      { extentId: EXTENT_A, state: 'keyed', key },
    ]);
  });

  it('rewrites rows in place, leaving the table in its insertion order', async () => {
    await writeDoc(DOC, DOC_CONTENT);
    await writeDoc(OTHER_DOC, '# Other\n');
    const cache = new RunContentCache();
    const builder = await builderWith(cache, DOC, [EXTENT_A]);
    builder.addRealization(await collectRealization(
      safePath.join(suite.tempDir, OTHER_DOC),
      OTHER_RESOURCE,
      { root: suite.tempDir, extentId: EXTENT_A, contentCache: cache },
    ));
    builder.addRealization(await collectRealization(
      safePath.join(suite.tempDir, DOC),
      RESOURCE,
      { root: suite.tempDir, extentId: EXTENT_B, contentCache: cache, contentDemand: 'deferred' },
    ));

    await builder.ensureContentKey(DOC);

    // A promotion that pushed the rewritten rows to the end would reorder the
    // table under a change that is supposed to touch two columns.
    expect(builder.build().resourceRealizations.map((row) => [row.path, row.extentId])).toEqual([
      [DOC, EXTENT_A],
      [OTHER_DOC, EXTENT_A],
      [DOC, EXTENT_B],
    ]);
  });
});
