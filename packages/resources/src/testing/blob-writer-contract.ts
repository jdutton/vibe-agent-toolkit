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

import { deepStrictEqual, ok } from 'node:assert/strict';

import type { HarnessId } from '../projection/harness/profile.js';
import { ALL_BLOB_REQUEST, type BlobFactsWrite, type BlobScopedRows, type FactStore } from '../projection/store.js';

/** One store under the contract, and the one operation the port does not offer. */
export interface BlobWriterContractSubject {
  readonly store: FactStore;
  /**
   * Evict one content key as the store's own eviction does: its rows in every
   * blob-scoped table and its ledger entry, together.
   *
   * @param contentKey - The key to evict
   */
  evict(contentKey: string): Promise<void>;
}

/** Open a fresh, empty store keeping at most `retainedBlobKeys` content keys. */
export type BlobWriterContractFactory = (options: { readonly retainedBlobKeys: number }) => Promise<BlobWriterContractSubject>;

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
 * A content key of the shape the schema requires: `<parserKind>.<64 hex>`.
 *
 * @param seed - One hex digit, repeated
 * @returns The key
 */
export function contractContentKey(seed: string): string {
  return `markdown.${seed.repeat(64).slice(0, 64)}`;
}

/**
 * One key's rows: a `blobs` row and one harness pair, with `wordCount` as the
 * value a case alters to tell a rewrite from a kept row.
 *
 * @param contentKey - The key
 * @param wordCount - The value a rewrite changes
 * @returns Every blob-scoped table
 */
export function contractBlobRows(contentKey: string, wordCount = 1): BlobScopedRows {
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
function coveredBlobWrite(rows: BlobScopedRows, covered: readonly string[]): BlobFactsWrite {
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
function heldRows(store: FactStore, keys: readonly string[]): Promise<BlobScopedRows> {
  return store.readBlobFacts(keys, ALL_BLOB_REQUEST);
}

/**
 * Open a store, run `body`, and close the store however `body` ends.
 *
 * @param open - The factory
 * @param retainedBlobKeys - The window
 * @param body - The case
 */
async function withStore(
  open: BlobWriterContractFactory,
  retainedBlobKeys: number,
  body: (subject: BlobWriterContractSubject) => Promise<void>,
): Promise<void> {
  const subject = await open({ retainedBlobKeys });
  try {
    await body(subject);
  } finally {
    await subject.store.close();
  }
}

/** A window no case crosses unless it means to. */
const WIDE_WINDOW = 1000;

/** The four writer cases, in the order the port's steps run. */
export const BLOB_WRITER_CONTRACT: readonly BlobWriterContractCase[] = [
  {
    name: 'a covered key still in the ledger is not rewritten',
    mutant: 'ignore coveredAtRead: replace every held key',
    run: (open) => withStore(open, WIDE_WINDOW, async ({ store }) => {
      const key = contractContentKey('a');
      await store.writeBlobFacts(uncoveredBlobWrite(contractBlobRows(key)));
      const first = await heldRows(store, [key]);

      await store.writeBlobFacts(coveredBlobWrite(contractBlobRows(key, 2), [key]));

      deepStrictEqual(await heldRows(store, [key]), first, 'a covered key in the ledger was rewritten');
    }),
  },
  {
    name: 'a covered key evicted since the read is written again (healing)',
    mutant: 'skip the ledger lookup and trust coveredAtRead',
    run: (open) => withStore(open, WIDE_WINDOW, async ({ store, evict }) => {
      const key = contractContentKey('b');
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
    mutant: 'stamp only replaced keys and evict past max(retention, replaced)',
    run: (open) => withStore(open, 3, async ({ store }) => {
      const covered = ['c', 'd', 'e', 'f'].map((seed) => contractContentKey(seed));
      const added = contractContentKey('9');
      await store.writeBlobFacts(uncoveredBlobWrite(mergedBlobRows(covered.map((key) => contractBlobRows(key)))));

      const held = [...covered, added];
      await store.writeBlobFacts(coveredBlobWrite(mergedBlobRows(held.map((key) => contractBlobRows(key))), covered));

      const kept = new Set((await heldRows(store, held)).blobs.map((row) => row.contentKey));
      const lost = held.filter((key) => !kept.has(key));
      ok(lost.length === 0, `a write evicted ${lost.length} of its own ${held.length} held keys at a window of 3: ${lost.join(', ')}`);
    }),
  },
  {
    name: 'a covered key keeps its settled pair and gains a newly reached one',
    mutant: 'skip non-replaced partitioned rows: write no pair of a covered key',
    run: (open) => withStore(open, WIDE_WINDOW, async ({ store }) => {
      const key = contractContentKey('0');
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
];
