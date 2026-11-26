/**
 * The blob writer's contract, written once and run against every
 * {@link FactStore}: the SQLite store and the test double alike, so a test that
 * passes through the double proves the rule the shipped writer implements.
 *
 * Framework-free, like `@vibe-agent-toolkit/utils/testing`: each case is a plain
 * async function that throws an `AssertionError` on failure, and each suite
 * registers them with its own runner
 * (`for (const c of BLOB_WRITER_CONTRACT) it(c.name, () => c.run(open))`).
 * Importing a test framework here would make it a runtime requirement of a
 * published subpath.
 *
 * Every case names the mutant it was proved red with: a writer that breaks the
 * one rule the case pins.
 */

import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';

import { compareCodeUnits, forEachInOrder } from '@vibe-agent-toolkit/utils';

import { orderContentKeys, type ContentKey } from '../content-key.js';
import type { HarnessId } from '../projection/harness/profile.js';
import { ALL_BLOB_REQUEST, type BlobFactsWrite, type BlobScopedRows, type FactStore } from '../projection/store.js';

import { testContentKey } from './test-content-key.js';

/**
 * A key the contract writes under one parser kind: which kind is immaterial to a writer, which
 * files rows by key text alone.
 *
 * @param seed - Distinguishes one contract key from another
 * @returns The key
 */
function contractKey(seed: string): ContentKey {
  return testContentKey('markdown', seed);
}

/** One store under the contract, and the one operation the port does not offer. */
export interface BlobWriterContractSubject {
  readonly store: FactStore;
  /**
   * Evict one content key as the store's own eviction does: its rows in every
   * blob-scoped table and its ledger entry, together.
   *
   * @param contentKey - The key to evict
   */
  evict(contentKey: ContentKey): Promise<void>;
  /**
   * The ledger as the store holds it: each tracked key and the bytes it records.
   *
   * @returns Content key to recorded bytes
   */
  ledgerBytes(): Promise<Readonly<Record<string, number>>>;
  /**
   * `blobRowBytes` summed over each key's STORED rows, measured from the rows
   * themselves and not from the ledger: what the ledger must equal.
   *
   * @returns Content key to the bytes of its stored rows
   */
  storedBytes(): Promise<Readonly<Record<string, number>>>;
}

/**
 * Open a fresh, empty store — a new one on every call, sharing nothing with an
 * earlier one — whose blob tier is kept within `blobTierBudgetBytes`.
 */
export type BlobWriterContractFactory = (options: { readonly blobTierBudgetBytes: number }) => Promise<BlobWriterContractSubject>;

/** One case of the contract. */
export interface BlobWriterContractCase {
  /** The rule, as a test name. */
  readonly name: string;
  /** The writer change that turns this case red. */
  readonly mutant: string;
  /** Run the case against a fresh store; throws on failure. */
  run(open: BlobWriterContractFactory): Promise<void>;
}

/** The harness every contract row is filed under. */
const HARNESS = 'claude-code';

/**
 * A second partition value. One harness ships today, but the port writes the
 * partitioned tables per `(blob, partition)` pair whatever the value, and a
 * newly reached pair of a covered key can only be told from its settled pair by
 * a second value. Neither store validates the value against the harness enum.
 */
const SECOND_HARNESS = 'second-harness' as HarnessId;

/**
 * One key's rows: a `blobs` row and one harness pair, with `wordCount` as the
 * value a case alters to tell a rewrite from a kept row.
 *
 * @param contentKey - The key
 * @param wordCount - The value a rewrite changes
 * @returns Every blob-scoped table
 */
export function contractBlobRows(contentKey: ContentKey, wordCount = 1): BlobScopedRows {
  return {
    blobs: [{
      contentKey,
      bytes: 1,
      encoding: 'utf-8',
      encodingSource: 'assumed',
      replacementCharacters: 0,
      tokenEstimate: 1,
      frontmatter: null,
      frontmatterValue: null,
      frontmatterError: null,
      frontmatterNotAMapping: false,
      anchors: [],
      wordCount,
      proseCodeUnits: 1,
      codeBlockCodeUnits: 0,
      linkCount: 0,
      headingCount: 0,
      sectionCount: 0,
      findingCount: 0,
    }],
    blobReferences: [],
    blobSections: [],
    blobConditions: [],
    harnessBlobFacts: [{ blob: contentKey, harness: HARNESS, injectedBytes: 1, injectedTokens: wordCount, paths: null }],
    harnessBlobImports: [],
    skillTextFacts: [],
    skillTextMatches: [],
  };
}

/**
 * The rows of several keys as one bundle.
 *
 * @param bundles - One bundle per key
 * @returns Their tables concatenated
 */
function mergedBlobRows(bundles: readonly BlobScopedRows[]): BlobScopedRows {
  const merged: Record<string, unknown[]> = {};
  for (const bundle of bundles) {
    for (const [table, rows] of Object.entries(bundle)) merged[table] = [...(merged[table] ?? []), ...(rows as unknown[])];
  }
  return merged as unknown as BlobScopedRows;
}

/**
 * A write whose read covered nothing: every held key and pair is replaced. What a
 * test that is not about coverage writes.
 *
 * @param rows - The rows to write
 * @returns The write
 */
export function uncoveredBlobWrite(rows: BlobScopedRows): BlobFactsWrite {
  return { rows, coveredAtRead: [], settledAtRead: [] };
}

/**
 * A write whose read covered `covered` and settled each of their harness pairs.
 *
 * @param rows - The rows to write
 * @param covered - The keys covered at read
 * @returns The write
 */
function coveredBlobWrite(rows: BlobScopedRows, covered: readonly ContentKey[]): BlobFactsWrite {
  return {
    rows,
    coveredAtRead: covered,
    settledAtRead: covered.map((contentKey) => ({ contentKey, harness: HARNESS })),
  };
}

/**
 * Every row the store holds for some keys.
 *
 * @param store - The store
 * @param keys - The keys
 * @returns The rows, every table
 */
function heldRows(store: FactStore, keys: readonly ContentKey[]): Promise<BlobScopedRows> {
  return store.readBlobFacts(keys, ALL_BLOB_REQUEST);
}

/**
 * Open a store, run `body`, and close the store however `body` ends.
 *
 * @param open - The factory
 * @param blobTierBudgetBytes - The budget
 * @param body - The case
 * @returns What `body` returns
 */
async function withStore<T>(
  open: BlobWriterContractFactory,
  blobTierBudgetBytes: number,
  body: (subject: BlobWriterContractSubject) => Promise<T>,
): Promise<T> {
  const subject = await open({ blobTierBudgetBytes });
  try {
    return await body(subject);
  } finally {
    await subject.store.close();
  }
}

/** A budget no case crosses unless it means to. */
const WIDE_BUDGET = 1_000_000_000;

/**
 * One key's rows grown by `extra` bytes of harness-read `paths`, so keys of one
 * shape differ in size by exactly the difference of their `extra`.
 *
 * @param contentKey - The key
 * @param extra - The length of the one path string
 * @returns Every blob-scoped table
 */
function sizedBlobRows(contentKey: ContentKey, extra: number): BlobScopedRows {
  const rows = contractBlobRows(contentKey);
  return { ...rows, harnessBlobFacts: rows.harnessBlobFacts.map((row) => ({ ...row, paths: ['x'.repeat(extra)] })) };
}

/**
 * What one {@link sizedBlobRows} key measures in the store under test: written
 * alone to a fresh store with a wide budget, read off its ledger.
 *
 * @param open - The factory
 * @param extra - The size parameter
 * @returns The key's recorded bytes
 */
function measuredSize(open: BlobWriterContractFactory, extra: number): Promise<number> {
  return withStore(open, WIDE_BUDGET, async ({ store, ledgerBytes }) => {
    const key = contractKey('probe');
    await store.writeBlobFacts(uncoveredBlobWrite(sizedBlobRows(key, extra)));
    const bytes = (await ledgerBytes())[key];
    ok(bytes !== undefined && bytes > 0, `the probe key recorded ${String(bytes)} bytes`);
    return bytes;
  });
}

/**
 * Several keys' rows in one bundle, key `i` grown by `extras[i]`.
 *
 * @param keys - The keys
 * @param extras - Their size parameters, by position
 * @returns The bundle
 */
function sizedBundle(keys: readonly ContentKey[], extras: readonly number[]): BlobScopedRows {
  return mergedBlobRows(keys.map((key, index) => sizedBlobRows(key, extras[index] ?? 0)));
}

/**
 * The keys a ledger tracks, sorted.
 *
 * @param ledger - The ledger
 * @returns Its keys in code-unit order
 */
function trackedKeys(ledger: Readonly<Record<string, number>>): readonly string[] {
  return Object.keys(ledger).sort(compareCodeUnits);
}

/** The writer cases, in the order the port's steps run, then the byte ledger's. */
export const BLOB_WRITER_CONTRACT: readonly BlobWriterContractCase[] = [
  {
    name: 'a covered key still in the ledger is not rewritten',
    mutant: 'ignore coveredAtRead: replace every held key',
    run: (open) => withStore(open, WIDE_BUDGET, async ({ store }) => {
      const key = contractKey('a');
      await store.writeBlobFacts(uncoveredBlobWrite(contractBlobRows(key)));
      const first = await heldRows(store, [key]);

      await store.writeBlobFacts(coveredBlobWrite(contractBlobRows(key, 2), [key]));

      deepStrictEqual(await heldRows(store, [key]), first, 'a covered key in the ledger was rewritten');
    }),
  },
  {
    name: 'a covered key evicted since the read is written again (healing)',
    mutant: 'skip the ledger lookup and trust coveredAtRead',
    run: (open) => withStore(open, WIDE_BUDGET, async ({ store, evict }) => {
      const key = contractKey('b');
      await store.writeBlobFacts(uncoveredBlobWrite(contractBlobRows(key)));
      await evict(key);

      await store.writeBlobFacts(coveredBlobWrite(contractBlobRows(key), [key]));

      const held = await heldRows(store, [key]);
      deepStrictEqual(held.blobs.map((row) => row.contentKey), [key], 'a covered key evicted since the read was not healed');
      deepStrictEqual(held.harnessBlobFacts.map((row) => row.blob), [key], 'a healed key lost its settled harness pair');
    }),
  },
  {
    name: 'every held key is re-stamped before eviction',
    mutant: 'stamp only replaced keys and protect only the newest `replaced` ledger rows from the budget',
    // A budget of one byte: only the held-key floor keeps anything.
    run: (open) => withStore(open, 1, async ({ store }) => {
      const covered = ['c', 'd', 'e', 'f'].map((seed) => contractKey(seed));
      const added = contractKey('9');
      await store.writeBlobFacts(uncoveredBlobWrite(mergedBlobRows(covered.map((key) => contractBlobRows(key)))));

      const held = [...covered, added];
      await store.writeBlobFacts(coveredBlobWrite(mergedBlobRows(held.map((key) => contractBlobRows(key))), covered));

      const kept = new Set((await heldRows(store, held)).blobs.map((row) => row.contentKey));
      const lost = held.filter((key) => !kept.has(key));
      ok(lost.length === 0, `a write evicted ${lost.length} of its own ${held.length} held keys at a budget of one byte: ${lost.join(', ')}`);
    }),
  },
  {
    name: 'a covered key keeps its settled pair and gains a newly reached one',
    mutant: 'skip non-replaced partitioned rows: write no pair of a covered key',
    run: (open) => withStore(open, WIDE_BUDGET, async ({ store }) => {
      const key = contractKey('0');
      await store.writeBlobFacts(uncoveredBlobWrite(contractBlobRows(key)));
      const first = await heldRows(store, [key]);

      const altered = contractBlobRows(key, 2);
      const reached = { ...altered.harnessBlobFacts[0], harness: SECOND_HARNESS } as BlobScopedRows['harnessBlobFacts'][number];
      await store.writeBlobFacts({
        rows: { ...altered, harnessBlobFacts: [...altered.harnessBlobFacts, reached] },
        coveredAtRead: [key],
        settledAtRead: [{ contentKey: key, harness: HARNESS }],
      });

      const held = await heldRows(store, [key]);
      deepStrictEqual(held.blobs, first.blobs, 'a covered key\'s blob rows were rewritten');
      deepStrictEqual(
        held.harnessBlobFacts.filter((row) => row.harness === HARNESS),
        first.harnessBlobFacts,
        'a settled pair was rewritten',
      );
      deepStrictEqual(
        held.harnessBlobFacts.filter((row) => row.harness !== HARNESS).map((row) => row.harness),
        [SECOND_HARNESS],
        'a newly reached pair of a covered key was not written',
      );
    }),
  },
  {
    name: 'the oldest keys go until the newest fit the byte budget',
    mutant: 'keep a count of keys (the budget divided by a key\'s mean size) instead of their bytes',
    run: async (open: BlobWriterContractFactory): Promise<void> => {
      // Five single-key writes, key i grown by extras[i]; every key is `base`
      // plus its extra, so the budget (B + C + D = 3 base + 400) cuts the same
      // keys whatever `base` measures in this store. Newest first after each
      // write: C's write takes A (3 base + 700); E's takes C and B (3 base + 600).
      const extras = [400, 100, 200, 100, 300];
      const base = await measuredSize(open, 0);
      const budget = 3 * base + 100 + 200 + 100;
      const keys = ['a', 'b', 'c', 'd', 'e'].map((seed) => contractKey(`budget-${seed}`));
      const survivors = await withStore(open, budget, async ({ store, ledgerBytes }) => {
        await forEachInOrder([...keys.entries()], ([index, key]) =>
          store.writeBlobFacts(uncoveredBlobWrite(sizedBlobRows(key, extras[index] ?? 0))));
        return trackedKeys(await ledgerBytes());
      });
      deepStrictEqual(survivors, keys.slice(3).sort(orderContentKeys), 'the budget kept another set than the newest that fit');
    },
  },
  {
    name: 'every held key stays even when the held keys alone exceed the budget',
    mutant: 'cut by bytes alone, without the held-row floor',
    run: async (open: BlobWriterContractFactory): Promise<void> => {
      // Two writes of five keys, each larger than three keys' bytes. Each keeps
      // all five of its own; the second takes every key of the first.
      const extras = [100, 150, 200, 250, 300];
      const budget = 3 * (await measuredSize(open, 100));
      const first = extras.map((_, index) => contractKey(`first-${index}`));
      const second = extras.map((_, index) => contractKey(`second-${index}`));
      await withStore(open, budget, async ({ store, ledgerBytes }) => {
        await store.writeBlobFacts(uncoveredBlobWrite(sizedBundle(first, extras)));
        deepStrictEqual(trackedKeys(await ledgerBytes()), [...first].sort(orderContentKeys), 'a write evicted its own held keys');
        await store.writeBlobFacts(uncoveredBlobWrite(sizedBundle(second, extras)));
        deepStrictEqual(trackedKeys(await ledgerBytes()), [...second].sort(orderContentKeys), 'the second write kept another set than its own');
        deepStrictEqual((await heldRows(store, first)).blobs, [], 'an evicted key kept its rows');
      });
    },
  },
  {
    name: 'a re-stamped key keeps its recorded bytes',
    mutant: 're-stamp writes 0 bytes',
    run: (open) => withStore(open, WIDE_BUDGET, async ({ store, ledgerBytes, storedBytes }) => {
      const key = contractKey('restamp');
      await store.writeBlobFacts(uncoveredBlobWrite(sizedBlobRows(key, 50)));
      const recorded = (await ledgerBytes())[key];

      await store.writeBlobFacts(coveredBlobWrite(sizedBlobRows(key, 50), [key]));

      ok(recorded !== undefined && recorded > 0, `the first write recorded ${String(recorded)} bytes`);
      strictEqual((await ledgerBytes())[key], recorded, 'a re-stamp changed the recorded bytes');
      strictEqual((await storedBytes())[key], recorded, 'the recorded bytes are not the stored rows\' bytes');
    }),
  },
  {
    name: 'a replaced key records the size of the rows that replaced it',
    mutant: 'record a replaced key as a re-stamp (its old bytes plus the new rows)',
    run: (open) => withStore(open, WIDE_BUDGET, async ({ store, ledgerBytes, storedBytes }) => {
      const key = contractKey('resized');
      await store.writeBlobFacts(uncoveredBlobWrite(sizedBlobRows(key, 10)));
      const before = (await ledgerBytes())[key];

      await store.writeBlobFacts(uncoveredBlobWrite(sizedBlobRows(key, 300)));

      const after = (await ledgerBytes())[key];
      notStrictEqual(after, before, 'a replaced key kept its old size');
      strictEqual(after, (await storedBytes())[key], 'a replaced key\'s recorded bytes are not its stored rows\' bytes');
    }),
  },
  {
    name: 'the ledger equals the measure of the stored rows for every key after mixed writes',
    mutant: 'skip subtracting the stored rows of an unsettled pair before its delete',
    run: (open) => withStore(open, WIDE_BUDGET, async ({ store, ledgerBytes, storedBytes }) => {
      const [a, b, c] = ['mixed-a', 'mixed-b', 'mixed-c'].map((seed) => contractKey(seed));
      if (a === undefined || b === undefined || c === undefined) throw new Error('three keys');
      const pair = (key: ContentKey, harness: HarnessId, extra: number): BlobScopedRows['harnessBlobFacts'][number] =>
        ({ blob: key, harness, injectedBytes: 1, injectedTokens: 1, paths: ['y'.repeat(extra)] });
      // Replace: first writes of a and b, b with a second harness's pair.
      await store.writeBlobFacts(uncoveredBlobWrite(sizedBlobRows(a, 20)));
      const bRows = sizedBlobRows(b, 30);
      await store.writeBlobFacts(uncoveredBlobWrite({ ...bRows, harnessBlobFacts: [...bRows.harnessBlobFacts, pair(b, SECOND_HARNESS, 7)] }));
      // Re-stamp of a, adding a second harness's pair it did not hold.
      const aRows = sizedBlobRows(a, 20);
      await store.writeBlobFacts(coveredBlobWrite({ ...aRows, harnessBlobFacts: [...aRows.harnessBlobFacts, pair(a, SECOND_HARNESS, 11)] }, [a]));
      // A concurrent pair: b covered, its second pair unsettled, so deleted and
      // re-inserted at another size; c replaced beside it.
      await store.writeBlobFacts(coveredBlobWrite(
        mergedBlobRows([{ ...bRows, harnessBlobFacts: [...bRows.harnessBlobFacts, pair(b, SECOND_HARNESS, 90)] }, sizedBlobRows(c, 5)]),
        [b],
      ));
      // A replace of a, which takes its second harness's pair with it.
      await store.writeBlobFacts(uncoveredBlobWrite(sizedBlobRows(a, 3)));

      deepStrictEqual(await ledgerBytes(), await storedBytes(), 'the ledger is not the measure of the stored rows');
      deepStrictEqual(trackedKeys(await ledgerBytes()), [a, b, c].sort(orderContentKeys), 'a key left the ledger');
    }),
  },
];
