/**
 * `PopulateOptions.cache` end to end — a real corpus, the real driver, and a
 * store double standing in for a backend.
 *
 * ## The oracle is a string diff, not a judgement
 *
 * `store-hydration.ts` reconstructs three context-less tables by *reachability*
 * and calls that reconstruction "a claim, and the claim is falsifiable rather
 * than argued". This file is where it is falsified: `exportProjection` sorts
 * every table by its primary key and redacts the one path that legitimately
 * varies, so a hydrated projection and a freshly populated one are either the
 * same document or they are not. Every hit assertion below is therefore
 * `serializeProjection(hydrated) === serializeProjection(populated)` — one
 * comparison over twelve tables, which no per-table deep-equal could match for
 * either coverage or honesty. A bespoke comparison would have to *choose* which
 * columns to compare, and the columns a hydration bug drops are exactly the ones
 * nobody thinks to list.
 *
 * ## Why the double lives here and not in `projection-sqlite`
 *
 * `resources` must never import `@vibe-agent-toolkit/projection-sqlite`. That is
 * the architectural seam the whole storage design exists to preserve — the
 * driver is written against {@link ProjectionStore} and against nothing else, so
 * a second backend cannot quietly change what a hit means. Importing the shipped
 * backend to test the driver would dissolve that seam in the one place it is
 * most load-bearing.
 *
 * So {@link FakeProjectionStore} is deliberately the dumbest store that can
 * answer: one bundle per `(rootId, treeHash)`, one bundle per content key, and a
 * counter on every method. It does **not** implement `writeExtent`'s
 * additive-per-context semantics; that contract is a property of a *backend* and
 * is tested against the real one in `projection-sqlite`. What is under test here
 * is the driver's *reuse rule*, which is backend-independent by construction.
 *
 * ## The fixture writes real files, and says so before it claims anything
 *
 * A population that produced no rows would satisfy every assertion in this file
 * vacuously: an empty projection hydrates to an empty projection, byte for byte,
 * under a completely broken hydration. The first test is therefore a control
 * that pins non-trivial row counts in every table the caching path has to carry,
 * and every later assertion is read against it.
 */


import {
  __readCrawlTimingSnapshot,
  __setCrawlTimingForTest,
  CRAWL_STORE_READ_ID,
  CRAWL_STORE_WRITE_ID,
  safePath,
 GitTracker } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { ContributorRegistry } from '../src/projection/contributor.js';
import { ClosureExtentContributor } from '../src/projection/contributors/closure-extent.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { EXTENT_SOURCE_ENV, EXTENT_SOURCE_GIT } from '../src/projection/crawl-source.js';
import { serializeProjection } from '../src/projection/export.js';
import { BLOBS_SKIP, populate } from '../src/projection/merge.js';
import type { Projection } from '../src/projection/projection.js';
import type {
  BlobScopedRows,
  ExtentKey,
  ExtentScopedRows,
  ProjectionStore,
} from '../src/projection/store.js';
import { PROJECTION_TABLES } from '../src/projection/table-registry.js';
import type { JsonValue } from '../src/schemas/projection-shared.js';


import { setupSubdirTestSuite, useCorpusSuite } from './test-helpers.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const suite = setupSubdirTestSuite('projection-store-roundtrip-');

const SKILL_KIND = 'skill';
const EXTENT_NAME = 'foo-bundle';

/** The id the driver charges the closure contributor under. */
const CLOSURE_ID = `closure:${EXTENT_NAME}`;

/** The id the driver charges the filesystem contributor under. */
const FILESYSTEM_ID = 'builtin:filesystem';

const NESTED_DIR = 'skills/foo';
const ROOT_DOC = 'skills/foo/SKILL.md';
const DOC_B = 'skills/foo/b.md';
const DOC_C = 'skills/foo/c.md';

/**
 * A chain `SKILL.md → b.md → c.md`.
 *
 * More than one edge on purpose: a one-edge closure would reach the same extent
 * whether the driver followed `blob_references` or merely admitted the declared
 * root, so the fixture could not tell a served closure from an empty one — which
 * is the precise failure the blob-coverage rule exists to catch.
 */
const CORPUS: readonly { readonly path: string; readonly content: string }[] = [
  { path: ROOT_DOC, content: '---\nname: foo\n---\n\n# Foo\n\nSee [b](./b.md).\n' },
  { path: DOC_B, content: '# B\n\nOn to [c](./c.md).\n' },
  { path: DOC_C, content: '# C\n\nNothing links out of here.\n' },
];

/**
 * The tree hash this suite's runs share.
 *
 * An opaque string, which is exactly what {@link ExtentKey.treeHash} promises:
 * the store neither produces nor interprets it, so a test does not need git to
 * exercise the key.
 */
const TREE_HASH = 'tree-0000000000000000000000000000000000000000';

/** A second tree hash, naming a corpus this suite never populates. */
const OTHER_TREE_HASH = 'tree-1111111111111111111111111111111111111111';

/** The declaration the closure contributor runs under. */
const FULL_DEPTH_DECLARATION: JsonValue = {
  kind: SKILL_KIND,
  closureFrom: ROOT_DOC,
  follow: ['markdown-link'],
  maxDepth: 'full',
};

/**
 * The same declaration bounded to one hop.
 *
 * One id, two questions — §7.3's closure primitive is a generic contributor
 * handed a declaration, so `parameterSet` and not `contributorId` is what
 * separates them.
 */
const ONE_HOP_DECLARATION: JsonValue = { ...FULL_DEPTH_DECLARATION, maxDepth: 1 };

// ---------------------------------------------------------------------------
// The store double
// ---------------------------------------------------------------------------

/** A table bundle seen structurally, which is how the double walks every table. */
type RowBundle = Record<string, readonly Record<string, unknown>[]>;

/** {@link ProjectionTableSpec.scope} for the content-keyed half. */
const BLOB_SCOPE = 'blob';

/** The column three of the four blob-scoped tables name their key in. */
const BLOB_COLUMN = 'blob';

/**
 * The blob-scoped tables, read off the registry rather than written out, so a
 * thirteenth one is stored rather than silently dropped on the floor.
 */
const BLOB_TABLES: readonly string[] = Object.values(PROJECTION_TABLES)
  .filter((spec) => spec.scope === BLOB_SCOPE)
  .map((spec) => spec.key);

/** Which column each blob-scoped table names its content key in. */
const BLOB_KEY_COLUMNS: Readonly<Record<string, string>> = {
  blobs: 'contentKey',
  blobReferences: BLOB_COLUMN,
  blobSections: BLOB_COLUMN,
  blobConditions: BLOB_COLUMN,
};

/**
 * The key column of one blob-scoped table.
 *
 * Throws rather than defaulting: a thirteenth blob table whose rows this double
 * filed under `undefined` would make every coverage check pass by accident,
 * which is the shape of bug this whole file is written to catch.
 *
 * @param table - The {@link Projection} field name
 * @returns The column holding the content key
 */
function blobKeyColumn(table: string): string {
  const column = BLOB_KEY_COLUMNS[table];
  if (column === undefined) {
    throw new Error(
      `the store double does not know which column '${table}' keys its blob by.`
      + ' A blob-scoped table was added; teach BLOB_KEY_COLUMNS about it.',
    );
  }
  return column;
}

/**
 * An empty blob bundle, one array per blob-scoped table.
 *
 * @returns Four empty tables
 */
function emptyBlobBundle(): RowBundle {
  const bundle: RowBundle = {};
  for (const table of BLOB_TABLES) bundle[table] = [];
  return bundle;
}

/**
 * The simplest thing that satisfies {@link ProjectionStore} — and counts what it
 * was asked to do.
 *
 * The counters are the point. "The store answered" is only observable from the
 * outside as *work that did not happen*: a hit runs no contributor and writes
 * nothing, and without a count of the write calls a hit and a miss that happened
 * to produce identical rows are the same observation.
 */
class FakeProjectionStore implements ProjectionStore {
  /** How many times {@link readExtent} was asked. */
  readExtentCalls = 0;

  /** How many times {@link writeExtent} was asked. */
  writeExtentCalls = 0;

  /** How many times {@link readBlobFacts} was asked. */
  readBlobFactsCalls = 0;

  /** How many times {@link writeBlobFacts} was asked. */
  writeBlobFactsCalls = 0;

  /** One bundle per `(rootId, treeHash)`; a later write replaces the earlier one. */
  readonly #extents = new Map<string, ExtentScopedRows>();

  /** One bundle per content key, which is the granularity the real read takes. */
  readonly #blobs = new Map<string, RowBundle>();

  /**
   * Record blob facts, idempotently.
   *
   * A key the double already holds is left alone, matching the interface's own
   * promise — and not merely for fidelity: appending instead would duplicate
   * every row on the second write, and a hydration carrying doubled rows would
   * fail the byte-identical oracle for a reason that is the double's fault
   * rather than the driver's.
   *
   * @param rows - The four blob-scoped tables
   */
  async writeBlobFacts(rows: BlobScopedRows): Promise<void> {
    this.writeBlobFactsCalls++;
    const source = rows as unknown as RowBundle;
    const incoming = new Map<string, RowBundle>();
    for (const table of BLOB_TABLES) {
      for (const row of source[table] ?? []) {
        const key = String(row[blobKeyColumn(table)]);
        const bundle = incoming.get(key) ?? emptyBlobBundle();
        incoming.set(key, bundle);
        bundle[table] = [...(bundle[table] ?? []), row];
      }
    }
    for (const [key, bundle] of incoming) {
      if (!this.#blobs.has(key)) this.#blobs.set(key, bundle);
    }
  }

  /**
   * Read back what is held for a set of keys.
   *
   * A key never seen contributes no rows, which is a miss and not an error —
   * deciding what an incomplete answer means is `blobFactsCover`'s job, not a
   * backend's.
   *
   * @param contentKeys - The keys to look up
   * @returns The rows held for them
   */
  async readBlobFacts(contentKeys: readonly string[]): Promise<BlobScopedRows> {
    this.readBlobFactsCalls++;
    const merged = emptyBlobBundle();
    for (const key of contentKeys) {
      const held = this.#blobs.get(key);
      if (held === undefined) continue;
      for (const table of BLOB_TABLES) {
        merged[table] = [...(merged[table] ?? []), ...(held[table] ?? [])];
      }
    }
    return merged as unknown as BlobScopedRows;
  }

  /**
   * Store one tree's extent under its key.
   *
   * Wholesale replacement, not the additive-per-context merge a real backend
   * owes — see this file's header on why that contract is tested elsewhere.
   *
   * @param key - Which root, which tree
   * @param rows - The eight extent-scoped tables
   */
  async writeExtent(key: ExtentKey, rows: ExtentScopedRows): Promise<void> {
    this.writeExtentCalls++;
    this.#extents.set(extentKeyOf(key), rows);
  }

  /**
   * Read back everything stored under one tree.
   *
   * @param key - Which root, which tree
   * @returns The eight tables, or `undefined` when this tree was never written
   */
  async readExtent(key: ExtentKey): Promise<ExtentScopedRows | undefined> {
    this.readExtentCalls++;
    return this.#extents.get(extentKeyOf(key));
  }

  /** Release nothing. */
  async close(): Promise<void> {
    // Nothing is held open.
  }
}

/** What a {@link BrokenProjectionStore} throws. */
const STORE_FAILURE = 'the projection store is unreachable';

/**
 * A store that fails the way a real one fails: on the read, before anything else
 * has happened.
 *
 * Every method throws, so no test can accidentally pass by reaching a working
 * one behind it.
 */
class BrokenProjectionStore implements ProjectionStore {
  /** @returns Never */
  async writeBlobFacts(): Promise<void> {
    throw new Error(STORE_FAILURE);
  }

  /** @returns Never */
  async readBlobFacts(): Promise<BlobScopedRows> {
    throw new Error(STORE_FAILURE);
  }

  /** @returns Never */
  async writeExtent(): Promise<void> {
    throw new Error(STORE_FAILURE);
  }

  /** @returns Never */
  async readExtent(): Promise<ExtentScopedRows | undefined> {
    throw new Error(STORE_FAILURE);
  }

  /** @returns Never */
  async close(): Promise<void> {
    throw new Error(STORE_FAILURE);
  }
}

/**
 * One comparable string per {@link ExtentKey}.
 *
 * Both halves, because that is the whole claim the key makes: a tree hash filed
 * under the wrong root is a cross-corpus hit, which is the one failure the key
 * exists to make impossible.
 *
 * @param key - The key to flatten
 * @returns A string equal exactly when the keys are
 */
function extentKeyOf(key: ExtentKey): string {
  return `${key.rootId} ${key.treeHash}`;
}

// ---------------------------------------------------------------------------
// Driving the corpus
// ---------------------------------------------------------------------------

/** The filesystem extent alone — a population that reads no blob table. */
function filesystemOnly(): ContributorRegistry {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());
  return registry;
}

/** The filesystem extent plus a closure over it — the two-contributor question. */
function filesystemAndClosure(): ContributorRegistry {
  const registry = filesystemOnly();
  registry.register(new ClosureExtentContributor(EXTENT_NAME, SKILL_KIND));
  return registry;
}

/** What one population run is asked to do. */
interface RunRequest {
  /** The contributors to register. */
  readonly registry: ContributorRegistry;
  /** The store to cache through, or omitted to run with no cache at all. */
  readonly store?: ProjectionStore;
  /** Which tree the store is keyed on; defaults to {@link TREE_HASH}. */
  readonly treeHash?: string;
  /** The closure declaration; defaults to {@link FULL_DEPTH_DECLARATION}. */
  readonly declaration?: JsonValue;
  /** `'skip'` to decline blob derivation; omitted to derive. */
  readonly blobs?: typeof BLOBS_SKIP;
  /**
   * A git oracle to populate under, or omitted for the tracker-less run.
   *
   * An AMBIENT input: it reaches the filesystem contributor through
   * `ProjectionBase` rather than through any parameter set, and it decides every
   * realization's `gitignored`. That is why it has to be part of the store key.
   */
  readonly gitTracker?: GitTracker;
}

/** What one population run produced, and what it cost. */
interface Run {
  /** The projection itself, for row-count controls. */
  readonly projection: Projection;
  /** {@link serializeProjection} of it — the oracle every hit is compared on. */
  readonly document: string;
  /**
   * One entry per contributor invocation, `id@pass`.
   *
   * Empty is the observable signature of a hit: `populate` short-circuits before
   * the builder exists, so nothing can have run.
   */
  readonly contributorRuns: readonly string[];
}

/**
 * Populate the fixture corpus.
 *
 * @param request - Registry, cache, declaration and blob setting
 * @returns The projection, its document, and every contributor invocation
 */
async function run(request: RunRequest): Promise<Run> {
  const contributorRuns: string[] = [];
  const projection = await populate({
    root: suite.tempDir,
    registry: request.registry,
    // Handed on every run, registered or not: `requestedContributors` reads the
    // registry and ignores a parameter set nobody claims, so one constant keeps
    // the filesystem contributor's own parameter set at `null` across every arm.
    parameters: { [CLOSURE_ID]: request.declaration ?? FULL_DEPTH_DECLARATION },
    onContributorTiming: (timing) => {
      contributorRuns.push(`${timing.contributorId}@${timing.pass}`);
    },
    ...(request.store === undefined
      ? {}
      : { cache: { store: request.store, treeHash: request.treeHash ?? TREE_HASH } }),
    ...(request.blobs === undefined ? {} : { blobs: request.blobs }),
    ...(request.gitTracker === undefined ? {} : { gitTracker: request.gitTracker }),
  });
  return { projection, document: serializeProjection(projection), contributorRuns };
}

/** Where this suite points the crawl-timing seam. Beneath the fixture, removed with it. */
function dumpDir(): string {
  return safePath.join(suite.tempDir, '.crawl-dumps');
}

/**
 * The synthetic store ids the timing seam has accumulated so far.
 *
 * @returns `projection-store:read` and/or `projection-store:write`, in the order filed
 */
function storeTimingIds(): string[] {
  return __readCrawlTimingSnapshot()
    .entries.map((entry) => entry.contributorId)
    .filter((id) => id === CRAWL_STORE_READ_ID || id === CRAWL_STORE_WRITE_ID);
}

// ---------------------------------------------------------------------------

describe('populate through a projection store', () => {
  useCorpusSuite(suite, [NESTED_DIR], CORPUS);

  afterEach(() => {
    // Module-level state shared by every test in this file. An enabled seam
    // would leak into the next test and make its counts unreadable — and a
    // suite that only passes in isolation is the signature of exactly that.
    __setCrawlTimingForTest(null);
    // Same hazard, different global: `crawlSourceSelector` reads this at each
    // call, so a test that sets it and does not clear it silently changes the
    // store key of every test after it.
    delete process.env[EXTENT_SOURCE_ENV];
  });

  describe('the fixture', () => {
    it('produces a non-trivial projection, so no later assertion can pass vacuously', async () => {
      // Read this first. Every claim below is of the form "hydrated equals
      // populated", and an empty projection satisfies all of them under a
      // completely broken hydration. These counts are the negative control that
      // makes the rest of the file mean something.
      const { projection } = await run({ registry: filesystemAndClosure() });

      // Two contexts: the filesystem extent, and the closure over it.
      expect(projection.resolutionContexts).toHaveLength(2);
      expect(projection.zoneProvenance).toHaveLength(2);
      // Three documents, realized in both extents, plus the directories.
      expect(projection.resourceRealizations.length).toBeGreaterThan(CORPUS.length);
      expect(projection.resources.length).toBeGreaterThanOrEqual(CORPUS.length);
      // The closure admitted more than its declared root, which is what proves
      // the edges were followed rather than the extent reduced to one file.
      expect(projection.resourceExtents.length).toBeGreaterThan(CORPUS.length);
      // The blob tier is populated and the reference graph is real — two edges,
      // `SKILL.md → b.md → c.md`.
      expect(projection.blobs.length).toBeGreaterThanOrEqual(CORPUS.length);
      expect(projection.blobReferences.length).toBeGreaterThanOrEqual(2);
      expect(projection.blobSections.length).toBeGreaterThan(0);
      // And the roots row the driver places itself.
      expect(projection.roots).toHaveLength(1);
    });
  });

  describe('the round trip', () => {
    it('hydrates a byte-identical document from the store on a second run over the same tree', async () => {
      // The whole design in one assertion. `selectRequestedRows` rebuilds
      // `roots`, `resources` and `resourceTags` by reachability rather than by
      // reading them back under a context, and this is where that reconstruction
      // is falsified: a single dropped or surplus row moves the document.
      const store = new FakeProjectionStore();
      const populated = await run({ registry: filesystemAndClosure(), store });
      const hydrated = await run({ registry: filesystemAndClosure(), store });

      // The hit is asserted FIRST, and it is not decoration. Measured against a
      // store double whose `readExtent` always answers `undefined`, the document
      // comparison below stays GREEN — because two correct full populations of an
      // unchanged tree also produce identical documents. The oracle can prove a
      // hydration wrong; only the absence of contributor work can prove a
      // hydration HAPPENED.
      expect(hydrated.contributorRuns).toEqual([]);
      expect(hydrated.document).toBe(populated.document);
    });

    it('runs no contributor at all when the store answers the run', async () => {
      // Identical documents alone would not prove a hit — a correct re-population
      // produces the identical document too, which is what makes this file's
      // oracle usable in the first place. The saving is only observable as work
      // that did not happen.
      const store = new FakeProjectionStore();
      const populated = await run({ registry: filesystemAndClosure(), store });
      const hydrated = await run({ registry: filesystemAndClosure(), store });

      expect(populated.contributorRuns).toContain(`${FILESYSTEM_ID}@1`);
      expect(populated.contributorRuns.length).toBeGreaterThan(1);
      expect(hydrated.contributorRuns).toEqual([]);
    });

    it('writes both tiers on the miss and neither on the hit', async () => {
      const store = new FakeProjectionStore();

      await run({ registry: filesystemAndClosure(), store });
      expect(store.writeBlobFactsCalls).toBe(1);
      expect(store.writeExtentCalls).toBe(1);

      await run({ registry: filesystemAndClosure(), store });
      // A hit reads both tiers — the blob read is how coverage is checked — but
      // it must write neither. A store that rewrote what it just served would
      // turn every hit into the cost it was supposed to avoid.
      expect(store.writeBlobFactsCalls).toBe(1);
      expect(store.writeExtentCalls).toBe(1);
      expect(store.readExtentCalls).toBe(2);
    });
  });

  describe('off by default', () => {
    it('produces the identical document with no cache supplied at all', async () => {
      // The guarantee that lets the option ship dark: a run with no `cache` is
      // the run that shipped, byte for byte. Compared against the CACHED MISS
      // rather than the hit, because the miss is the arm that also writes — a
      // driver that mutated the projection on its way into the store would show
      // up here and nowhere else.
      const store = new FakeProjectionStore();
      const uncached = await run({ registry: filesystemAndClosure() });
      const missed = await run({ registry: filesystemAndClosure(), store });

      expect(missed.document).toBe(uncached.document);
    });

    it('never reaches a store it was not handed', async () => {
      // Cheap, and it pins the thing an eventual "default store" would break:
      // a store the caller did not opt into must not be consulted, or a stale
      // process-wide cache starts answering runs that never asked for one.
      const store = new FakeProjectionStore();

      await run({ registry: filesystemAndClosure() });

      expect(store.readExtentCalls).toBe(0);
      expect(store.writeExtentCalls).toBe(0);
      expect(store.readBlobFactsCalls).toBe(0);
      expect(store.writeBlobFactsCalls).toBe(0);
    });
  });

  describe('ambient inputs the parameter sets do not name', () => {
    // 🪤 The reuse rule compares `(contributorId, parameterSet)`, and
    // `FilesystemExtentContributor` has a FIXED id that always runs under
    // `null`. Two inputs it actually reads appear in no parameter set at all —
    // the git tracker (through `ProjectionBase`) and `VAT_EXTENT_SOURCE`
    // (through `crawlSourceFor`) — so before `storeKeyFor` folded them in, two
    // runs asking one question got each other's answer: same key, same
    // provenance rows, materially different realizations, exit 0.
    //
    // These assert the SEPARATION, which is the store's job. That the rows
    // genuinely differ is the filesystem extent's own business and is pinned by
    // its own suites; conflating the two here would make these tests fail for
    // reasons that have nothing to do with the key.

    it('misses when one run had a git oracle and the other did not', async () => {
      const store = new FakeProjectionStore();
      const tracker = new GitTracker(suite.tempDir);
      await tracker.initialize();

      await run({ registry: filesystemAndClosure(), store, gitTracker: tracker });
      const trackerless = await run({ registry: filesystemAndClosure(), store });

      // A hit here would hand a tracker-less run rows whose `gitignored` column
      // was decided by an oracle it never had — or, in the other direction,
      // admit the ignored half of a tree because the stored run could not see it.
      expect(trackerless.contributorRuns.length).toBeGreaterThan(0);
      expect(store.writeExtentCalls).toBe(2);
    });

    it('misses when the two runs selected different enumerators', async () => {
      const store = new FakeProjectionStore();
      await run({ registry: filesystemAndClosure(), store });

      process.env[EXTENT_SOURCE_ENV] = EXTENT_SOURCE_GIT;
      const viaGit = await run({ registry: filesystemAndClosure(), store });

      // The key folds the raw SELECTOR, not the effective source, so this
      // separates even where both would resolve to the walk. Over-separating is
      // the safe direction: the cost is one cold run, and the alternative is a
      // confidently wrong membership.
      expect(viaGit.contributorRuns.length).toBeGreaterThan(0);
      expect(store.writeExtentCalls).toBe(2);
    });

    it('still hits when the ambient inputs match, so the key did not simply stop working', async () => {
      // The control. Without it, the two misses above are satisfied by a key
      // that never matches anything — which is the failure mode a
      // separation test cannot otherwise distinguish from success.
      const store = new FakeProjectionStore();
      const tracker = new GitTracker(suite.tempDir);
      await tracker.initialize();

      const first = await run({ registry: filesystemAndClosure(), store, gitTracker: tracker });
      const second = await run({ registry: filesystemAndClosure(), store, gitTracker: tracker });

      expect(second.contributorRuns).toEqual([]);
      expect(second.document).toBe(first.document);
    });
  });

  describe('what makes a stored extent an answer to THIS run', () => {
    it('misses when the tree hash names a different tree', async () => {
      // `ExtentKey` is `(rootId, treeHash)` and both halves are load-bearing. A
      // hash that matched loosely would serve one tree's rows for another's, and
      // the rows would be internally consistent — the worst kind of wrong.
      const store = new FakeProjectionStore();
      await run({ registry: filesystemAndClosure(), store });

      const other = await run({
        registry: filesystemAndClosure(),
        store,
        treeHash: OTHER_TREE_HASH,
      });

      expect(other.contributorRuns.length).toBeGreaterThan(0);
      expect(store.writeExtentCalls).toBe(2);
    });

    it('misses when the run registered a contributor the stored extent never ran', async () => {
      // The key names a TREE, never a QUESTION. A stored filesystem extent
      // answers half of `{filesystem, closure}`, and half an answer here is a
      // projection whose closure extent is its own declared root — populated,
      // plausible and wrong.
      const store = new FakeProjectionStore();
      await run({ registry: filesystemOnly(), store });

      const broader = await run({ registry: filesystemAndClosure(), store });

      expect(broader.contributorRuns).toContain(`${FILESYSTEM_ID}@1`);
      expect(broader.contributorRuns).toContain(`${CLOSURE_ID}@1`);
    });

    it('hits a broader stored extent while handing back none of the extra contributor rows', async () => {
      // The strongest assertion in the file, and the one the superset-hydration
      // bug breaks. A stored `{filesystem, closure}` extent DOES answer a
      // `{filesystem}` run — the narrower question is contained in it — but
      // `buildResourcePopulation` walks `resourceRealizations` with no extent
      // filter at all, so handing back the closure's re-realization of the same
      // files would show the caller paths no contributor of its own realized.
      //
      // Asserted as equality against a fresh filesystem-only populate rather
      // than as "no row mentions the closure context", because the latter would
      // miss a dropped row, a duplicated identity, or a surplus `resourceTags`
      // entry that the reachability reconstruction dragged along.
      const store = new FakeProjectionStore();
      const bare = await run({ registry: filesystemOnly() });
      await run({ registry: filesystemAndClosure(), store });

      const narrowed = await run({ registry: filesystemOnly(), store });

      expect(narrowed.contributorRuns).toEqual([]);
      expect(narrowed.document).toBe(bare.document);
    });

    it('misses when a contributor of the same id ran under a different parameter set', async () => {
      // One id, two questions. §7.3's closure primitive is a generic contributor
      // handed a declaration, so `closure:foo-bundle` at `maxDepth: 'full'` and
      // at `maxDepth: 1` are different extents wearing one name — and reusing
      // one for the other returns a confidently wrong membership.
      const store = new FakeProjectionStore();
      await run({ registry: filesystemAndClosure(), store });

      const bounded = await run({
        registry: filesystemAndClosure(),
        store,
        declaration: ONE_HOP_DECLARATION,
      });

      expect(bounded.contributorRuns).toContain(`${CLOSURE_ID}@1`);
      expect(store.writeExtentCalls).toBe(2);
    });
  });

  describe('blob coverage', () => {
    it('misses an extent stored by a run that declined to derive blobs', async () => {
      // A `'skip'` run still writes its extent — that is what lets the next
      // command share the enumeration — but that extent names content keys the
      // blob tier does not hold. Accepting it would reduce every closure extent
      // to its own declared root, converge on iteration one, and report success:
      // the silent-emptiness failure arriving through the cache.
      //
      // The registry is filesystem-only on BOTH arms, because a registered blob
      // reader makes `'skip'` throw outright — the miss under test is the one
      // that survives that refusal.
      const store = new FakeProjectionStore();
      const skipped = await run({ registry: filesystemOnly(), store, blobs: BLOBS_SKIP });
      expect(skipped.projection.blobs).toStrictEqual([]);
      expect(store.writeExtentCalls).toBe(1);
      // Not written at all, rather than written empty: "nothing to say about
      // blobs" and "there are none" are different facts.
      expect(store.writeBlobFactsCalls).toBe(0);

      const deriving = await run({ registry: filesystemOnly(), store });

      expect(store.readBlobFactsCalls).toBe(1);
      expect(deriving.contributorRuns).toContain(`${FILESYSTEM_ID}@1`);
      expect(deriving.projection.blobs.length).toBeGreaterThan(0);
      expect(store.writeBlobFactsCalls).toBe(1);
    });

    it('hits with four empty blob tables when the reading run also declines', async () => {
      // The mirror, and it is what keeps `'skip'` honest on both paths: a run
      // that declined to derive the tier must also decline to read it back, or a
      // hit would hand it four tables a populate would have left empty and
      // hydrated would stop being indistinguishable from populated.
      const store = new FakeProjectionStore();
      const populated = await run({ registry: filesystemOnly(), store, blobs: BLOBS_SKIP });

      const hydrated = await run({ registry: filesystemOnly(), store, blobs: BLOBS_SKIP });

      expect(hydrated.contributorRuns).toEqual([]);
      expect(hydrated.projection.blobs).toStrictEqual([]);
      expect(hydrated.projection.blobReferences).toStrictEqual([]);
      expect(hydrated.projection.blobSections).toStrictEqual([]);
      expect(hydrated.projection.blobConditions).toStrictEqual([]);
      expect(hydrated.document).toBe(populated.document);
      // The blob tier was never asked, which is the observable half of "declined
      // to read it back" — an empty answer from a read that DID happen would
      // look identical in the rows.
      expect(store.readBlobFactsCalls).toBe(0);
    });

    it('refuses an unsound skip before asking the store, however good an answer it holds', async () => {
      // `populate` resolves the blob decision FIRST, deliberately ahead of the
      // cache read: `'skip'` with a registered blob reader throws, and a run that
      // would have been refused must not be served from a store instead. The
      // soundness of the request is a property of the registry — a caller must
      // not be able to launder an unsound run through a warm cache.
      //
      // The unchanged read count is the whole assertion. A refusal that happened
      // AFTER the read would throw the identical error and pass a test that only
      // checked `rejects`.
      const store = new FakeProjectionStore();
      await run({ registry: filesystemAndClosure(), store });
      const readsBeforeTheRefusal = store.readExtentCalls;

      await expect(run({ registry: filesystemAndClosure(), store, blobs: BLOBS_SKIP }))
        .rejects.toThrow(CLOSURE_ID);

      expect(store.readExtentCalls).toBe(readsBeforeTheRefusal);
    });
  });

  describe('a failing store', () => {
    it('surfaces the store error instead of quietly re-deriving', async () => {
      // Deliberately NOT recoverable. A cache is recoverable by definition, so
      // swallowing this is tempting — and it is also how a store that has failed
      // to write for a week goes unnoticed while every run pays full price and
      // reports success. The whole value of the cache is unobservable from the
      // outside; only the error is.
      await expect(run({ registry: filesystemAndClosure(), store: new BrokenProjectionStore() }))
        .rejects.toThrow(STORE_FAILURE);
    });
  });

  describe('the timing rows', () => {
    it('files a read row and a write row on a miss', async () => {
      __setCrawlTimingForTest(dumpDir());

      await run({ registry: filesystemAndClosure(), store: new FakeProjectionStore() });

      expect(storeTimingIds()).toEqual([CRAWL_STORE_READ_ID, CRAWL_STORE_WRITE_ID]);
    });

    it('files a read row and NO write row on a hit', async () => {
      // The pair is what makes a dump readable: read-and-no-write is a hit,
      // both is a miss that paid twice, neither is a run with no store. Without
      // the read row a hit is indistinguishable from a subject that exercised
      // nothing at all — which has already turned one A/B into a measurement of
      // noise.
      const store = new FakeProjectionStore();
      await run({ registry: filesystemAndClosure(), store });

      // Re-arming clears the accumulators, so what follows is the hit alone.
      __setCrawlTimingForTest(dumpDir());
      await run({ registry: filesystemAndClosure(), store });

      expect(storeTimingIds()).toEqual([CRAWL_STORE_READ_ID]);
      // And nothing else is charged either — a hit runs no contributor and no
      // blob stage, so the read row is the entire dump.
      expect(__readCrawlTimingSnapshot().entries).toHaveLength(1);
      expect(__readCrawlTimingSnapshot().entries[0]?.stratum).toBe('base');
      expect(__readCrawlTimingSnapshot().entries[0]?.pass).toBe(1);
    });

    it('files neither row when the run has no store', async () => {
      __setCrawlTimingForTest(dumpDir());

      await run({ registry: filesystemAndClosure() });

      expect(storeTimingIds()).toEqual([]);
    });
  });
});
