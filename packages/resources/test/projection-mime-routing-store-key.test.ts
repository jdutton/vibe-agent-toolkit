/**
 * Two runs that route differently must not share a stored extent.
 *
 * A projection store's reuse rule compares `(contributorId, parameterSet)`. A
 * collection's declared `mimeType` appears in NO parameter set — it reaches the
 * population through `PopulateOptions.collections` and changes which parser
 * runs, which changes the `mime` column, the content key, and every blob row
 * derived from it. Without the routing's fingerprint in the key, two runs over
 * an unchanged tree that disagree about routing are a **false hit**: same key,
 * materially different rows, exit 0.
 *
 * ## What each test here can actually fail on
 *
 * The suite is deliberately written against the KEY the store is asked for
 * rather than against the rows that come back. A rows-based assertion would pass
 * for a store that simply never hits, which is indistinguishable from a store
 * that is merely cold — and that is the whole failure mode being guarded, so it
 * must not be the thing the guard cannot tell apart.
 *
 * The non-vacuity floor is the FIRST test: two runs with identical routing must
 * produce the SAME key. Without it, a fingerprint that was simply random per
 * call would satisfy every "must differ" assertion below while destroying the
 * cache entirely.
 */

import { describe, expect, it } from 'vitest';

import { NO_DECLARED_MIME_TYPES } from '../src/index.js';
import { buildClaudeContextPopulation } from '../src/projection/claude-context-population.js';
import { ContributorRegistry } from '../src/projection/contributor.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { crawlSourceFor } from '../src/projection/crawl-source.js';
import { CONTENT_PARSING_SKIP, DISCARD_BLOB_POPULATION, populate } from '../src/projection/merge.js';
import { createCollectionMimeResolver } from '../src/projection/realizations.js';
import type {
  BlobScopedRows,
  ExtentKey,
  ExtentScopedRows,
  ProjectionStore,
} from '../src/projection/store.js';
import type { CollectionConfig } from '../src/schemas/project-config.js';

import { setupTempCorpus } from './helpers/temp-corpus.js';

/** A fixed hash, so the tree half of the key is constant across every arm. */
const FIXTURE_TREE_HASH = 'tree-hash-fixed-for-this-suite';

/** One source file and one prose file — enough to realize, not enough to be slow. */
const CORPUS = {
  'notes.md': '# Notes\n\nProse the default tables already route to markdown.\n',
  'strings.ts': 'export const marker = "store-key-fixture";\n',
};

/** The glob every declaration in this suite is written over. */
const TS_GLOB = '**/*.ts';

/** The type that pulls a `.ts` onto the markdown parser. */
const AS_PROSE = 'text/markdown';

/**
 * A DIFFERENT declared type for the same files.
 *
 * `text/plain` also routes to the markdown parser, which is deliberate: these
 * two arms must differ in the KEY even though they agree about which parser
 * runs, because they disagree about the recorded `mime` and a consumer reads
 * that column.
 */
const AS_PLAIN = 'text/plain';

/** A collection that types `.ts` as prose — the declaration under test. */
const TS_AS_MARKDOWN: Readonly<Record<string, CollectionConfig>> = {
  sources: { include: [TS_GLOB], mimeType: AS_PROSE },
};

/** The same shape, declaring a DIFFERENT type for the same files. */
const TS_AS_PLAIN: Readonly<Record<string, CollectionConfig>> = {
  sources: { include: [TS_GLOB], mimeType: AS_PLAIN },
};

const fixture = setupTempCorpus('vat-mime-store-key-', CORPUS);

/**
 * A store that records every key it is ASKED for and answers no read.
 *
 * Answering no read keeps each arm a full population, so what is compared is the
 * question each run posed rather than which of them happened to be served.
 */
class KeyRecordingStore implements ProjectionStore {
  /** Every key handed to `readExtent`, in call order. */
  readonly readKeys: ExtentKey[] = [];

  /**
   * @param servesBlobTier - Whether `readBlobFacts` may be called at all.
   *   Defaults to `false`, which THROWS: every arm above runs under
   *   `CONTENT_PARSING_SKIP`, so a blob read there means the skip stopped
   *   working and the arm is quietly measuring a different population. Only the
   *   two-pass lane below, which drives the real `buildClaudeContextPopulation`
   *   and therefore does derive blobs, opts in.
   */
  constructor(private readonly servesBlobTier = false) {}

  async writeExtent(_key: ExtentKey, _rows: ExtentScopedRows): Promise<void> {
    // Nothing to record: the read key is what the reuse rule compares.
  }

  async readExtent(key: ExtentKey): Promise<ExtentScopedRows | undefined> {
    this.readKeys.push(key);
    return undefined;
  }

  async writeBlobFacts(_rows: BlobScopedRows): Promise<void> {
    // Unreachable under `CONTENT_PARSING_SKIP`, and a no-op when it is reachable.
  }

  async readBlobFacts(_contentKeys: readonly string[]): Promise<BlobScopedRows> {
    if (!this.servesBlobTier) {
      throw new Error('this arm declines the blob tier and must never read it');
    }
    return { blobs: [], blobReferences: [], blobSections: [], blobConditions: [] };
  }

  async close(): Promise<void> {
    // Nothing is held open.
  }
}

/**
 * Populate the fixture once under the given declarations and report the store
 * key the run asked under.
 *
 * @param collections - The project's collections, or undefined to declare none
 * @returns The `treeHash` half of the key, which is where ambient inputs land
 */
async function storeKeyFor(
  collections: Readonly<Record<string, CollectionConfig>> | undefined,
): Promise<string> {
  const store = new KeyRecordingStore();
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor(() => crawlSourceFor(fixture.root()), 'deferred'));

  await populate({
    root: fixture.root(),
    registry,
    contentParsing: CONTENT_PARSING_SKIP,
    onBlobPopulation: DISCARD_BLOB_POPULATION,
    cache: { store, treeHash: FIXTURE_TREE_HASH },
    ...(collections !== undefined && { collections }),
  });

  const [key] = store.readKeys;
  if (key === undefined) throw new Error('the run asked the store nothing — nothing to compare');
  return key.treeHash;
}

describe('the projection store key and collection-declared parse routing', () => {
  it('is the SAME for two runs whose routing is identical', async () => {
    // The non-vacuity floor for every "must differ" below. A fingerprint that
    // varied per call would satisfy all of them while making the store useless,
    // and no other assertion here could tell.
    expect(await storeKeyFor(TS_AS_MARKDOWN)).toBe(await storeKeyFor(TS_AS_MARKDOWN));
    expect(await storeKeyFor(undefined)).toBe(await storeKeyFor(undefined));
  });

  it('DIFFERS between a run that declares a type and one that does not', async () => {
    // THE false hit. Same tree, same contributor, same parameter set, and the
    // second run would have been served the first's `mime` columns and content
    // keys at exit 0.
    expect(await storeKeyFor(TS_AS_MARKDOWN)).not.toBe(await storeKeyFor(undefined));
  });

  it('DIFFERS between two runs declaring DIFFERENT types for the same files', async () => {
    // The declarations are the same SHAPE, so a fingerprint over "does this
    // project declare anything" rather than over the rules themselves would
    // collapse these two — and they route `.ts` to different parsers.
    expect(await storeKeyFor(TS_AS_MARKDOWN)).not.toBe(await storeKeyFor(TS_AS_PLAIN));
  });

  it('DIFFERS between two runs whose patterns differ but whose type does not', async () => {
    // `include` is part of the rule, not decoration: the same type applied to a
    // different file set produces a different corpus.
    const narrower: Readonly<Record<string, CollectionConfig>> = {
      sources: { include: ['src/**/*.ts'], mimeType: AS_PROSE },
    };

    expect(await storeKeyFor(TS_AS_MARKDOWN)).not.toBe(await storeKeyFor(narrower));
  });

  it('treats a collection that declares no type as no declaration at all', async () => {
    // The owner's rule, stated as a key property: a collection with no
    // `mimeType` cannot route and cannot conflict, so it must not fragment the
    // cache either. Adding one to a config should not cool every stored extent.
    const undeclared: Readonly<Record<string, CollectionConfig>> = {
      docs: { include: ['**/*.md'] },
    };

    expect(await storeKeyFor(undeclared)).toBe(await storeKeyFor(undefined));
  });
});

describe('the routing fingerprint itself', () => {
  it('is the named constant when nothing declares a type', () => {
    // Pinned as a VALUE, not merely as "equal to the empty case", so a store key
    // someone is debugging carries a legible reason rather than a hash of
    // nothing. Both spellings of "no declarations" reach it.
    expect(createCollectionMimeResolver(undefined).fingerprint).toBe(NO_DECLARED_MIME_TYPES);
    expect(createCollectionMimeResolver({}).fingerprint).toBe(NO_DECLARED_MIME_TYPES);
  });

  it('preserves declaration ORDER, because order decides which conflict is named', () => {
    // Two collections, same pair of types, opposite order. They resolve the same
    // `mime` — but `mimeFor` names `matched[0]` as the winner and the other as
    // the rival, and a conflict is a ROW. Sorting the fingerprint would let two
    // configs that emit different `realization_conditions` share a key.
    const first = createCollectionMimeResolver({
      a: { include: [TS_GLOB], mimeType: AS_PROSE },
      b: { include: [TS_GLOB], mimeType: AS_PLAIN },
    });
    const reversed = createCollectionMimeResolver({
      b: { include: [TS_GLOB], mimeType: AS_PLAIN },
      a: { include: [TS_GLOB], mimeType: AS_PROSE },
    });

    expect(first.fingerprint).not.toBe(reversed.fingerprint);
  });
});

/**
 * A corpus with a Claude instruction root, so the real lane runs BOTH passes.
 *
 * `CLAUDE.md` is what `discoverImportRoots` looks for; without one the lane
 * registers no `@`-import contributor and the two passes collapse into a shape
 * that cannot show the hazard.
 */
const TWO_PASS_CORPUS = {
  'CLAUDE.md': '# Root\n\nThe instruction root the discovery pass exists to find.\n',
  'helper.ts': 'export const marker = "two-pass-fixture";\n',
};

const twoPass = setupTempCorpus('vat-mime-two-pass-', TWO_PASS_CORPUS);

/**
 * Every distinct ambient key half that one `buildClaudeContextPopulation` asked
 * the store for, across BOTH of its passes.
 *
 * @param collections - The project's collections, or undefined to declare none
 * @returns The distinct `treeHash` values the run posed, in first-seen order
 */
async function ambientKeysAcrossBothPasses(
  collections: Readonly<Record<string, CollectionConfig>> | undefined,
): Promise<string[]> {
  const store = new KeyRecordingStore(true);

  await buildClaudeContextPopulation({
    root: twoPass.root(),
    cache: { store, treeHash: FIXTURE_TREE_HASH },
    onBlobPopulation: DISCARD_BLOB_POPULATION,
    ...(collections !== undefined && { collections }),
  });

  return [...new Set(store.readKeys.map((key) => key.treeHash))];
}

/**
 * ⚠️ **Read this before trusting the two arms below as live guards.**
 *
 * The lane's `discoverImportRoots` docstring used to claim that a discovery pass
 * which did not receive `collections` would key differently from the real pass
 * and the two would evict each other from the store, run after run. That is
 * FALSE, and it was checked the only way worth checking: the `collections`
 * forwarding was deleted from the discovery pass and the whole `resources` suite
 * — 2,469 tests — stayed green. The mechanism is that the discovery pass is
 * never handed a `cache` at all, so it asks the store nothing and has no key to
 * collide with; and a declared type cannot change what it ANSWERS either,
 * because `claudeImportRootsFrom` reads `path` / `basenameLower` / `isDirectory`
 * and never `mime`.
 *
 * So the `toHaveLength(1)` arms are TRIPWIRES for a hazard that is currently
 * unreachable, not proofs that two live passes agree. They are kept — and said
 * to be tripwires rather than dressed up as live coverage — because the day the
 * discovery pass gains a store, the divergence they catch is otherwise SILENT:
 * a store that never hits looks exactly like a store that is merely cold.
 *
 * The third arm is the one carrying weight today: it drives the real lane end to
 * end and proves a declaration reaches the store key through it.
 */
describe('the two passes of the Claude-context lane', () => {
  it('ask the store under ONE ambient key, so they cannot evict each other', async () => {
    const keys = await ambientKeysAcrossBothPasses(TS_AS_MARKDOWN);

    expect(keys).toHaveLength(1);
  });

  it('still ask under one key when nothing declares a type', async () => {
    const keys = await ambientKeysAcrossBothPasses(undefined);

    expect(keys).toHaveLength(1);
  });

  it('asks under a DIFFERENT key once a declaration appears', async () => {
    // The live arm. Not satisfiable by a lane that ignores `collections`: it
    // runs the real `buildClaudeContextPopulation`, so the declaration has to
    // survive every seam between the caller and `storeKeyFor` to move this key.
    // This is what actually reddens if the REAL pass stops forwarding routing.
    const [declared] = await ambientKeysAcrossBothPasses(TS_AS_MARKDOWN);
    const [undeclared] = await ambientKeysAcrossBothPasses(undefined);

    expect(declared).not.toBe(undeclared);
  });
});
