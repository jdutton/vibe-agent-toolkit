/**
 * The work counters' seed table: one seed per counter, each a small piece of
 * real work whose EXACT effect on every counter is pinned.
 *
 * A counter nothing moves on purpose is a counter nobody would notice stop
 * counting, so B1a's honesty while ungated rests here. Each seed builds what its
 * act needs (unmeasured), runs the act between two reads of the counters, and
 * the suite asserts the delta of EVERY counter: the ones named in `delta` by
 * exactly that much, every other one by zero. Exact deltas, never ceilings.
 *
 * The table is split by counter family, one integration file per family, so no
 * file runs past the integration tier's per-file budget. Each family's type is
 * carved out of `WorkCounter` so the compiler rejects a missing or extra key;
 * `work-counters-store.integration.test.ts` asserts the families' union is the
 * whole name set, both ways.
 */

import { writeFileSync } from 'node:fs';

import { readSkillDocument, type SkillTextRun } from '@vibe-agent-toolkit/agent-skills';
import {
  DEFAULT_BLOB_TIER_BUDGET_BYTES,
  hydrateRunDatabase,
  openSqliteFactStore,
  type RelationSource,
  type RunDatabase,
} from '@vibe-agent-toolkit/projection-sqlite';
import {
  ALL_BLOB_REQUEST,
  ALL_EXTENT_REQUEST,
  blobFactsReader,
  type BlobScopedRows,
  computeContentKey,
  type ExtentScopedRows,
  IGNORE_HOME_SETTLEMENT,
  ParseCache,
  markVatCacheRoot,
  ParseDispatcher,
  parseContentCached,
  parseRoutingFor,
  type ParsePoolPolicy,
  PROJECTION_TABLES,
  type Projection,
  readContentWithKey,
  ResourceRegistry,
  StoreQuestionUnavailableError,
  withRunPopulation,
} from '@vibe-agent-toolkit/resources';
import { testContentKey, uncoveredBlobWrite } from '@vibe-agent-toolkit/resources/testing';
import { normalizedTmpdir, readWorkCounters, safePath, toForwardSlash, WORK_COUNTER_NAMES, type WorkCounter, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { GitTracker, gitTreeSnapshot, withGitSnapshotCache } from '@vibe-agent-toolkit/utils/git';
import { createTempDir, removeTempDir, scratchTmpdirEnv } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, expect, vi } from 'vitest';

import { createChecksOverlapGate } from '../../src/commands/checks-overlap-gate.js';
import { checkGitInstalled } from '../../src/commands/doctor.js';
import type { Logger } from '../../src/utils/logger.js';
import { withQueriedProjection } from '../../src/utils/projection-query.js';
import { HOME_KEY, hit, keyed as keyedRealization, ROOT } from '../helpers/overlap-gate-fixtures.js';
import { commitTestFixture } from '../test-helpers.js';

/** The fact store's counters. */
type StoreLaneCounter = Extract<WorkCounter, `store.${'rows' | 'reads' | 'writes'}.${string}`>;

/** The parse route's and the content key's counters. */
type ParseCounter = Extract<WorkCounter, `parse.${string}` | `content.${string}`>;

/** Everything a population or a git spawn moves: the rest of the name set. */
type PopulationCounter = Exclude<WorkCounter, StoreLaneCounter | ParseCounter>;

/** What a seed's act did, for a seed whose count is also reported in words. */
type ActResult = string | undefined;

/** The measured work. */
type Act = () => ActResult | Promise<ActResult>;

/** Where a seed puts what it builds, and how it is disposed of. */
interface SeedScope {
  /** A fresh temp directory, removed after the seed. */
  readonly dir: () => string;
  /** Run `dispose` after the seed, however it ended. */
  readonly defer: (dispose: () => Promise<void> | void) => void;
}

/** One counter's seed. */
interface Seed {
  /** Build what the act needs — unmeasured — and return the act. */
  readonly prepare: (scope: SeedScope) => Act | Promise<Act>;
  /**
   * Every counter the act moves, by exactly how much; a counter not named must
   * not move. `'moved'` for the one load-dependent counter: only its own
   * movement is asserted.
   */
  readonly delta: Partial<Record<WorkCounter, number>> | 'moved';
  /** For a seed whose act reports its count in words: that number, read back. */
  readonly reported?: (result: ActResult) => number;
}

/**
 * The `fs.lstat`s every population's crawl-source choice makes below its root to ask whether
 * the git marker is readable: `.git`, then the chain to `.git/HEAD` (two components).
 */
const GIT_MARKER_LSTATS = 3;

/**
 * The `fs.lstat`s the first population of a root in a process adds, each one component below
 * the root: git's root discovery probing `.git`, and the config loader probing the config file.
 * Both answers are kept for the process, so a later population of the same root walks neither.
 */
const FIRST_POPULATION_LSTATS = 2;

/**
 * The real temp directory's components below the filesystem root (a drive is not one): what a
 * chain walk of a path under it from that root lstats before it reaches the path's own.
 */
const TMP_DEPTH = toForwardSlash(normalizedTmpdir()).split('/').filter((part) => part !== '' && !/^[A-Za-z]:$/u.test(part)).length;

/** A content key the store seeds file rows under. */
const BLOB_KEY = testContentKey('markdown', 'seed');

/** One `blobs` row and nothing else: one row written, one row decoded. */
function oneBlobRow(): BlobScopedRows {
  return {
    blobs: [{
      contentKey: BLOB_KEY,
      bytes: 3,
      encoding: 'utf-8',
      encodingSource: 'default',
      replacementCharacters: 0,
      tokenEstimate: 1,
      frontmatter: null,
      frontmatterValue: null,
      frontmatterError: null,
      frontmatterNotAMapping: false,
      anchors: [],
      wordCount: 1,
      proseCodeUnits: 1,
      codeBlockCodeUnits: 0,
      linkCount: 0,
      headingCount: 1,
      sectionCount: 1,
      findingCount: 0,
    }],
    blobReferences: [],
    blobSections: [],
    blobConditions: [],
    harnessBlobFacts: [],
    harnessBlobImports: [],
    skillTextFacts: [],
    skillTextMatches: [],
  } as unknown as BlobScopedRows;
}

/** An extent naming no rows: a write of the manifest row only. */
const EMPTY_EXTENT = {} as ExtentScopedRows;

/** The extent key the store seeds use. */
const EXTENT_KEY = { rootId: 'seed-root', treeHash: 'seed-tree' };

/**
 * A fact store, closed after the seed.
 *
 * @param scope - The seed's scope
 * @returns The open store
 */
function storeOf(scope: SeedScope): ReturnType<typeof openSqliteFactStore> {
  const store = openSqliteFactStore({ directory: scope.dir(), blobTierBudgetBytes: DEFAULT_BLOB_TIER_BUDGET_BYTES });
  scope.defer(() => store.close());
  return store;
}

/** A read of a store holding one row: one read, one row decoded. */
function decodeSeed(): Seed {
  return {
    prepare: async (scope) => {
      const store = storeOf(scope);
      await store.writeBlobFacts(uncoveredBlobWrite(oneBlobRow()));
      return async () => {
        await store.readBlobFacts([BLOB_KEY], ALL_BLOB_REQUEST);
        return undefined;
      };
    },
    delta: { 'store.reads.blob': 1, 'store.rows.decoded.persistent': 1 },
  };
}

/** A second read of the row the prepare already read on the same open store: it is decoded again. */
function secondReadSeed(): Seed {
  return {
    prepare: async (scope) => {
      const store = storeOf(scope);
      await store.writeBlobFacts(uncoveredBlobWrite(oneBlobRow()));
      await store.readBlobFacts([BLOB_KEY], ALL_BLOB_REQUEST);
      return async () => {
        await store.readBlobFacts([BLOB_KEY], ALL_BLOB_REQUEST);
        return undefined;
      };
    },
    delta: { 'store.reads.blob': 1, 'store.rows.decoded.persistent': 1, 'store.rows.decoded.repeated': 1 },
  };
}

/** A read of an extent never written: one read, nothing decoded. */
function readMissSeed(): Seed {
  return {
    prepare: (scope) => {
      const store = storeOf(scope);
      return async () => {
        await store.readExtent(EXTENT_KEY, ALL_EXTENT_REQUEST);
        return undefined;
      };
    },
    delta: { 'store.reads.extent': 1 },
  };
}

/** One write: of one blob row, or of an extent with no rows. */
function writeSeed(rows: 'one blob row' | 'no rows'): Seed {
  return {
    prepare: (scope) => {
      const store = storeOf(scope);
      return async () => {
        await (rows === 'one blob row' ? store.writeBlobFacts(uncoveredBlobWrite(oneBlobRow())) : store.writeExtent(EXTENT_KEY, EMPTY_EXTENT));
        return undefined;
      };
    },
    delta: rows === 'one blob row'
      ? { 'store.writes.persistent': 1, 'store.rows.written.persistent': 1 }
      : { 'store.writes.persistent': 1 },
  };
}

export const STORE_SEEDS: Readonly<Record<StoreLaneCounter, Seed>> = {
  'store.rows.decoded.persistent': decodeSeed(),
  'store.rows.decoded.repeated': secondReadSeed(),
  // The blob read that decodes one row: the decode seed counts it too.
  'store.reads.blob': decodeSeed(),
  'store.reads.extent': readMissSeed(),
  'store.writes.persistent': writeSeed('no rows'),
  'store.rows.written.persistent': writeSeed('one blob row'),
};

/**
 * A projection of one `blobs` row and one root row, every other table empty.
 */
function oneBlobProjection(): Projection {
  const empty = Object.fromEntries(Object.keys(PROJECTION_TABLES).map((table) => [table, []]));
  return {
    ...(empty as unknown as Projection),
    ...oneBlobRow(),
    roots: [{ id: EXTENT_KEY.rootId, path: '/seed' }],
  };
}

/** What every `EXPLAIN` the gate prepares adds: four per handle opened, one per gated call. */
function explained(work: { readonly handles: number; readonly gatedCalls: number }): number {
  return (4 * work.handles) + work.gatedCalls;
}

/**
 * Hydrating a run database with {@link oneBlobProjection}'s two non-empty relations: one
 * hydration transaction, its two rows, and the handle's four reference reads.
 *
 * @param scope - The seed's scope
 * @returns The open run database, closed after the seed
 */
function hydratedOneBlob(scope: SeedScope): RunDatabase {
  const projection = oneBlobProjection();
  const database = hydrateRunDatabase({
    rootId: EXTENT_KEY.rootId,
    relations: new Map<string, RelationSource>([
      ['blobs', { rows: projection.blobs }],
      ['roots', { rows: projection.roots }],
    ]),
  });
  scope.defer(() => database.close());
  return database;
}

/** Hydrating a run database over {@link oneBlobProjection}: one hydration, two rows. */
function hydrationSeed(): Seed {
  return {
    prepare: (scope) => () => {
      hydratedOneBlob(scope);
      return undefined;
    },
    delta: {
      'hydration.writes': 1,
      'hydration.rows.written': 2,
      'statement.explained': explained({ handles: 1, gatedCalls: 0 }),
    },
  };
}

/** A run database over {@link oneBlobProjection}, asked one statement. */
function explainedSeed(): Seed {
  return {
    prepare: (scope) => () => {
      hydratedOneBlob(scope).query('SELECT COUNT(*) AS n FROM blobs');
      return undefined;
    },
    delta: {
      'hydration.writes': 1,
      'hydration.rows.written': 2,
      'statement.explained': explained({ handles: 1, gatedCalls: 1 }),
    },
  };
}

/** A document unique to one seed, so no parse cache can already hold it. */
function uniqueDocument(label: string): string {
  return `# ${label}\n\nSeed ${String(process.hrtime.bigint())}.\n`;
}

/**
 * A dispatcher over a private parse cache, shut down after the seed.
 *
 * @param scope - The seed's scope
 * @param policy - The pool's limits
 * @returns The dispatcher
 */
function dispatcherOf(scope: SeedScope, policy: ParsePoolPolicy = {}, cacheDir = scope.dir()): ParseDispatcher {
  const dispatcher = new ParseDispatcher(new ParseCache({ cacheDir, enabled: true }), policy);
  scope.defer(() => dispatcher.shutdown());
  return dispatcher;
}

/**
 * One parse of `content` on `dispatcher`, swallowing a refusal: the seed asserts
 * on counters, and a refusal is the work some seeds exist to count.
 */
async function parseOnce(content: string, dispatcher: ParseDispatcher): Promise<ActResult> {
  await parseContentCached(content, 'markdown', { dispatcher }).catch(() => undefined);
  return undefined;
}

/** What reading and keying a file holding `content` adds: one read, one hash over its UTF-8 bytes. */
function readAndKeyed(content: string): Partial<Record<WorkCounter, number>> {
  return { 'content.read': 1, ...keyed(content) };
}

/** What keying `content` adds: one hash over its UTF-8 bytes. */
function keyed(content: string): Partial<Record<WorkCounter, number>> {
  return { 'content.hashed': 1, 'content.hashedBytes': Buffer.byteLength(content, 'utf8') };
}

/** A parse on a pool whose limits the content breaches, or that runs it: one dispatch. */
function parseSeed(label: string, policy: ParsePoolPolicy, moves: Partial<Record<WorkCounter, number>>): Seed {
  return contentSeed(uniqueDocument(label), policy, moves);
}

/** A seed that parses `content` once on a dispatcher of `policy`, moving what keying it moves plus `moves`. */
function contentSeed(content: string, policy: ParsePoolPolicy, moves: Partial<Record<WorkCounter, number>>): Seed {
  return {
    prepare: (scope) => {
      const dispatcher = dispatcherOf(scope, policy);
      return () => parseOnce(content, dispatcher);
    },
    delta: { ...keyed(content), ...moves },
  };
}

/** Every dispatcher's input cap, which is the population's: there is no smaller cap to name. */
const INPUT_CAP = new ParseDispatcher(new ParseCache({ enabled: false }), {}).inputBytes;

/** A document one byte past {@link INPUT_CAP}. */
function overCapDocument(label: string): string {
  const head = uniqueDocument(label);
  return head + 'x'.repeat(INPUT_CAP + 1 - Buffer.byteLength(head, 'utf8'));
}

/** A document with three links: three output rows past a one-row cap. */
const THREE_LINKS = '# Links\n\n[a](./a.md) [b](./b.md) [c](./c.md)\n';

/** A list nested 1,000 levels deep: seconds of parse, refused at the parse clock. */
const DEEPLY_NESTED_LIST = Array.from({ length: 1000 }, (_, level) => ' '.repeat(level * 2) + '- x\n').join('');

/** Bytes a content key is computed over by the hashing seed. */
const HASHED = new TextEncoder().encode('# hashed\n');

export const PARSE_SEEDS: Readonly<Record<ParseCounter, Seed>> = {
  // A dispatch files what it parsed: the parent's write on the wire transport.
  'parse.dispatched': parseSeed('dispatched', {}, { 'parse.dispatched': 1, 'parse.cache.written': 1 }),
  // The wire transport named outright, so an exported VAT_PARSE_TRANSPORT cannot
  // move this seed to the worker's site, which PARSE_SITE_SEEDS covers.
  'parse.cache.written': parseSeed('written', { transport: 'wire' }, {
    'parse.dispatched': 1,
    'parse.cache.written': 1,
  }),
  'parse.cache.hit': (() => {
    const content = uniqueDocument('hit');
    return {
      // Filed by one dispatcher, hit by another over the same cache: a dispatcher
      // answers a key it already parsed from its own memory, with no lookup.
      prepare: async (scope: SeedScope) => {
        const cacheDir = scope.dir();
        await parseOnce(content, dispatcherOf(scope, {}, cacheDir));
        const reader = dispatcherOf(scope, {}, cacheDir);
        return () => parseOnce(content, reader);
      },
      delta: { ...keyed(content), 'parse.cache.hit': 1 },
    };
  })(),
  'parse.redispatched': (() => {
    // The worker files the entry and says so; the read-back then finds it gone,
    // as after a concurrent cache clear, so the document is parsed again: one
    // document dispatched once, and one re-dispatch. Each parse files an entry:
    // the worker's, counted at its stored reply, and the re-parse's.
    const content = uniqueDocument('redispatched');
    return {
      prepare: (scope: SeedScope) => {
        const cache = new ParseCache({ cacheDir: scope.dir(), enabled: true });
        Object.assign(cache, { read: (): Promise<null> => Promise.resolve(null) });
        const dispatcher = new ParseDispatcher(cache, { transport: 'cache' });
        scope.defer(() => dispatcher.shutdown());
        return () => parseOnce(content, dispatcher);
      },
      delta: { ...keyed(content), 'parse.dispatched': 1, 'parse.redispatched': 1, 'parse.cache.written': 2 },
    };
  })(),
  'parse.refused.keyDetermined': {
    prepare: (scope) => {
      const dispatcher = dispatcherOf(scope, { limits: { outputRows: 1 } });
      return () => parseOnce(THREE_LINKS, dispatcher);
    },
    delta: { ...keyed(THREE_LINKS), 'parse.dispatched': 1, 'parse.refused.keyDetermined': 1 },
  },
  'parse.refused.inputCap.read': {
    prepare: (scope) => {
      const file = safePath.join(scope.dir(), 'over-cap.md');
      writeFileSync(file, '# over the cap\n', 'utf8');
      return async () => {
        await readContentWithKey(file, 'markdown', 4).catch(() => undefined);
        return undefined;
      };
    },
    delta: { 'parse.refused.inputCap.read': 1 },
  },
  'parse.refused.inputCap.dispatch': contentSeed(overCapDocument('input cap'), {}, {
    'parse.refused.inputCap.dispatch': 1,
  }),
  'parse.refused.load': {
    // A list nested 1,000 deep parses for seconds (the cost is quadratic in the
    // depth), so a two-second parse clock stops it, and leaves a loaded machine
    // room to load the parser first. Only the count's movement is pinned: a
    // stop under load is not the document's to decide.
    prepare: (scope) => {
      const dispatcher = dispatcherOf(scope, { limits: { timeMs: 2000, heapMb: 1024 } });
      return () => parseOnce(DEEPLY_NESTED_LIST, dispatcher);
    },
    delta: 'moved',
  },
  'content.hashed': {
    prepare: () => () => {
      computeContentKey(HASHED, 'markdown');
      return undefined;
    },
    delta: { 'content.hashed': 1, 'content.hashedBytes': HASHED.byteLength },
  },
  'content.hashedBytes': contentSeed(overCapDocument('hashed bytes'), {}, {
    'parse.refused.inputCap.dispatch': 1,
  }),
  'content.read': (() => {
    const content = uniqueDocument('read');
    return {
      prepare: (scope: SeedScope) => {
        const file = safePath.join(scope.dir(), 'read.md');
        writeFileSync(file, content, 'utf8');
        return async () => {
          await readContentWithKey(file, 'markdown', null);
          return undefined;
        };
      },
      delta: readAndKeyed(content),
    };
  })(),
};

/** A logger that keeps what it is told, so a seed can read back a warning. */
function recordingLogger(lines: string[]): Logger {
  const keep = (message: string): void => {
    lines.push(message);
  };
  return { info: keep, warn: keep, error: keep, debug: keep };
}

/** A self-referencing YAML anchor: refused at its nesting depth, at once, every run. */
const CYCLIC_FRONTMATTER = '---\ncyc: &anchor\n  self: *anchor\n---\n\n# Cyclic\n';

/**
 * A committed tree, queried through the real query lane against a private
 * store, with the process's temp directory already private to the seed.
 *
 * @param scope - The seed's scope
 * @param files - Root-relative path to content
 * @returns A run of one query over the tree, returning every warning it logged
 */
function queriedTree(scope: SeedScope, files: Readonly<Record<string, string>>, statement?: string): () => Promise<ActResult> {
  return queriedTreeAt(scope, files, statement).query;
}

/**
 * {@link queriedTree}, with the committed tree's root: for a seed that edits the tree between runs.
 *
 * @param scope - The seed's scope
 * @param files - The tree, written and committed
 * @returns The root, and the query act
 */
function queriedTreeAt(
  scope: SeedScope,
  files: Readonly<Record<string, string>>,
  statement = 'SELECT 1 AS x',
): { root: string; query: () => Promise<ActResult> } {
  // First, so the parse cache (under the temp directory) and every directory
  // below start empty: a parse cache another run filled would turn a dispatch
  // into a hit.
  const tmp = scratchTmpdirEnv('vat-work-seed-tmp-');
  tmp.enter();
  scope.defer(() => tmp.leave());
  const root = scope.dir();
  for (const [name, content] of Object.entries(files)) writeFileSync(safePath.join(root, name), content, 'utf8');
  commitTestFixture(root);
  vi.stubEnv(VAT_CACHE_DIR_ENV, scope.dir());
  // Tag the cache root here, unmeasured: its once-per-process guard walks the
  // current directory's chain from the filesystem root (`fs.lstat`), a count set
  // by where the checkout lives, not by the population the act measures.
  markVatCacheRoot();
  return {
    root,
    query: async () => {
      const lines: string[] = [];
      await withQueriedProjection(
        { root, logger: recordingLogger(lines), statements: [statement], base: undefined },
        (ask) => {
          lines.push(JSON.stringify(ask(statement)));
        },
      );
      return lines.join('\n');
    },
  };
}

/**
 * One document admitted from disk: stated, read, keyed and parsed once, on a
 * private parse cache so the parse is a dispatch, never another run's hit.
 *
 * @param label - Makes the document unique to this seed
 * @returns The seed
 */
function admissionSeed(label: string): Seed {
  const content = uniqueDocument(label);
  return {
    prepare: (scope) => {
      const root = scope.dir();
      const file = safePath.join(root, 'admitted.md');
      writeFileSync(file, content, 'utf8');
      const registry = new ResourceRegistry({
        baseDir: root,
        parseCache: new ParseCache({ cacheDir: scope.dir(), enabled: true }),
      });
      return async () => {
        await registry.addResource(file);
        return undefined;
      };
    },
    // The stat follows the file's chain first: one lstat, the file itself below the root.
    delta: {
      ...readAndKeyed(content),
      'fs.stat': 1,
      'fs.lstat': 1,
      'parse.dispatched': 1,
      'parse.cache.written': 1,
      'registry.admitted': 1,
    },
  };
}

/** One plain document: what every population seed's tree holds. */
const PLAIN_TREE = { 'a.md': '# A\n\nPlain.\n' };

/**
 * A memory file importing a document: the harness pass derives a pair for each. Bytes no other
 * seed holds, so no earlier seed's parse entry in this process answers one of them.
 */
const IMPORTING_TREE = { 'a.md': '# Imported\n\nPlain.\n', 'CLAUDE.md': '# Memory\n\n@a.md\n' };

/**
 * A document with a reference of each kind: a markdown link (an AST form) and an `@` import (a
 * lexical form). Bytes no other seed holds.
 */
const REFERENCING_TREE = { 'a.md': '# Referencing\n\nSee [b](./b.md) and @b.md.\n', 'b.md': '# B of the referencing tree\n' };

/** The references {@link REFERENCING_TREE} stores: its AST row and its lexical row. */
const REFERENCING_ROWS = { ast: 1, lexical: 1 } as const;

/** Two documents of their own bytes, the second edited after the prime, so only its key is uncovered. */
const EDITED_TREE = { 'a.md': '# Kept\n\nPlain.\n', 'b.md': '# Edited\n\nBefore.\n' };

/** `b.md`'s bytes after the edit. */
const EDITED_B = '# Edited\n\nAfter.\n';

export const POPULATION_SEEDS: Readonly<Record<PopulationCounter, Seed>> = {
  // A cold population: the one document parsed and keyed, the extent derived
  // and written to the store, and git asked for the tree: the key's snapshot,
  // its flag listing and its LFS attribute listing (`check-attr`), then the write
  // path's fresh three: two snapshots. The
  // statement names no relation, so the run database is hydrated with none. The
  // miss reads the blob tier once in derivation, to reuse covered keys; an empty
  // store covers none.
  'extent.derived': {
    prepare: (scope) => queriedTree(scope, PLAIN_TREE),
    delta: {
      'store.reads.extent': 1,
      'store.reads.blob': 1,
      'store.writes.persistent': 2,
      'store.rows.written.persistent': 13,
      'statement.explained': explained({ handles: 1, gatedCalls: 1 }),
      'extent.derived': 1,
      'parse.dispatched': 1,
      'parse.cache.written': 1,
      ...readAndKeyed(PLAIN_TREE['a.md']),
      'git.calls': 8,
      'git.snapshots': 2,
      'fs.lstat': GIT_MARKER_LSTATS + FIRST_POPULATION_LSTATS,
    },
  },
  // The same tree again: the extent served from the store, nothing parsed,
  // nothing hashed, three git calls (the key's snapshot, its flag listing and its
  // LFS attribute listing): one snapshot, no fresh one, since nothing is written.
  'extent.served': {
    prepare: async (scope) => {
      const query = queriedTree(scope, PLAIN_TREE);
      await query();
      return query;
    },
    delta: {
      'store.rows.decoded.persistent': 13,
      'store.reads.extent': 1,
      'store.reads.blob': 1,
      'statement.explained': explained({ handles: 1, gatedCalls: 1 }),
      'extent.served': 1,
      'git.calls': 3,
      'git.snapshots': 1,
      'fs.lstat': GIT_MARKER_LSTATS,
    },
  },
  // A cold population over a memory file that imports the plain document: the
  // harness pass derives the memory file's pair and the imported document's,
  // and everything else is the cold `extent.derived` seed's over two documents.
  'harness.pairsDerived': {
    prepare: (scope) => queriedTree(scope, IMPORTING_TREE),
    delta: {
      'store.reads.extent': 1,
      'store.reads.blob': 1,
      'store.writes.persistent': 2,
      'store.rows.written.persistent': 26,
      'statement.explained': explained({ handles: 1, gatedCalls: 1 }),
      'extent.derived': 1,
      'harness.pairsDerived': 2,
      'parse.dispatched': 2,
      'parse.cache.written': 2,
      'content.read': 2,
      'content.hashed': 2,
      'content.hashedBytes': Buffer.byteLength(IMPORTING_TREE['a.md'] + IMPORTING_TREE['CLAUDE.md'], 'utf8'),
      'git.calls': 8,
      'git.snapshots': 2,
      'fs.lstat': GIT_MARKER_LSTATS + FIRST_POPULATION_LSTATS,
    },
  },
  // A written miss after a prime, one file edited: the tree moves, so the extent
  // misses, and the unedited document's key is served from the stored blob tier:
  // read once in derivation, its 3 rows decoded and not written again, and no
  // parse lookup for it. Both documents are still read and keyed by the crawl.
  'blob.storeServed': {
    prepare: async (scope) => {
      const { root, query } = queriedTreeAt(scope, EDITED_TREE);
      await query();
      writeFileSync(safePath.join(root, 'b.md'), EDITED_B, 'utf8');
      return query;
    },
    delta: {
      'store.reads.extent': 1,
      'store.reads.blob': 1,
      'store.rows.decoded.persistent': 3,
      'store.writes.persistent': 2,
      'store.rows.written.persistent': 16,
      'statement.explained': explained({ handles: 1, gatedCalls: 1 }),
      'extent.derived': 1,
      'blob.storeServed': 1,
      'parse.dispatched': 1,
      'parse.cache.written': 1,
      'content.read': 2,
      'content.hashed': 2,
      'content.hashedBytes': Buffer.byteLength(EDITED_TREE['a.md'] + EDITED_B, 'utf8'),
      'git.calls': 8,
      'git.snapshots': 2,
      'fs.lstat': GIT_MARKER_LSTATS,
    },
  },
  // A refusal no store holds forces the whole population again on the second
  // run: re-derived, the cyclic one dispatched and refused again, the stored
  // document's key served from the blob tier the miss reads, and the key's
  // snapshot and the write path's fresh one taken. Two blob reads: the hit reads
  // the AST reference forms, and the derivation, through the same reader, reads the
  // key again whole (`stored-reads.ts`), so a key's rows come from one transaction.
  // The hit's 3 rows are decoded again: `store.rows.decoded.repeated` 3, the cost of
  // a hit turned miss, which a store eviction can tear otherwise.
  'store.miss.refusedPairs': {
    prepare: async (scope) => {
      const query = queriedTree(scope, { ...PLAIN_TREE, 'deep.md': CYCLIC_FRONTMATTER });
      await query();
      return query;
    },
    delta: {
      'store.rows.decoded.persistent': 19,
      'store.rows.decoded.repeated': 3,
      'store.reads.extent': 1,
      'store.reads.blob': 2,
      'store.writes.persistent': 2,
      'store.rows.written.persistent': 13,
      'statement.explained': explained({ handles: 1, gatedCalls: 1 }),
      'extent.derived': 1,
      'store.miss.refusedPairs': 1,
      'blob.storeServed': 1,
      'parse.dispatched': 1,
      'parse.refused.keyDetermined': 1,
      'content.read': 2,
      'content.hashed': 2,
      'content.hashedBytes': Buffer.byteLength(PLAIN_TREE['a.md'] + CYCLIC_FRONTMATTER, 'utf8'),
      'git.calls': 8,
      'git.snapshots': 2,
      'fs.lstat': GIT_MARKER_LSTATS,
    },
    reported: (result) => Number(/store miss: (\d+) refused/u.exec(result ?? '')?.[1] ?? Number.NaN),
  },
  'hydration.writes': hydrationSeed(),
  'hydration.rows.written': hydrationSeed(),
  // A served query naming `blob_references`: the hit decodes the extent and the blob tier with the
  // AST references only, and the run database copies every reference form from the store inside
  // SQLite. `extent.served` below decodes 13 rows over a tree of one document with no reference;
  // this tree's decoded rows hold its one AST reference and none of its lexical ones, which reach
  // the answer through `hydration.rows.copied` alone.
  'hydration.rows.copied': {
    prepare: async (scope) => {
      const query = queriedTree(scope, REFERENCING_TREE, 'SELECT COUNT(*) AS n FROM blob_references');
      await query();
      return query;
    },
    delta: {
      'store.rows.decoded.persistent': 19 + REFERENCING_ROWS.ast,
      'store.reads.extent': 1,
      'store.reads.blob': 1,
      'hydration.writes': 1,
      'hydration.rows.copied': REFERENCING_ROWS.ast + REFERENCING_ROWS.lexical,
      'statement.explained': explained({ handles: 1, gatedCalls: 1 }),
      'extent.served': 1,
      'git.calls': 3,
      'git.snapshots': 1,
      'fs.lstat': GIT_MARKER_LSTATS,
    },
    reported: (result) => Number(/"n":(\d+)/u.exec(result ?? '')?.[1] ?? Number.NaN),
  },
  'statement.explained': explainedSeed(),
  // The registry's stat of the file it admits: the admission seed counts it too.
  'fs.stat': admissionSeed('stat'),
  // The chain walk before that stat: the admission seed counts it too.
  'fs.lstat': admissionSeed('lstat'),
  'registry.built': {
    prepare: () => () => {
      expect(new ResourceRegistry().size()).toBe(0);
      return undefined;
    },
    delta: { 'registry.built': 1 },
  },
  'registry.admitted': admissionSeed('admitted'),
  'git.calls': {
    prepare: () => () => {
      checkGitInstalled();
      return undefined;
    },
    delta: { 'git.calls': 1 },
  },
  // Two snapshot requests in one bracket: the memo miss takes the one snapshot
  // (one git call), and the hit takes none. The repository's root is found
  // before, unmeasured, so the act walks no chain.
  'git.snapshots': {
    prepare: (scope) => {
      const root = scope.dir();
      writeFileSync(safePath.join(root, 'a.md'), PLAIN_TREE['a.md'], 'utf8');
      commitTestFixture(root);
      gitTreeSnapshot({ cwd: root });
      return () => withGitSnapshotCache(() => {
        expect(gitTreeSnapshot({ cwd: root }).ok).toBe(true);
        expect(gitTreeSnapshot({ cwd: root }).ok).toBe(true);
        return undefined;
      });
    },
    delta: { 'git.calls': 1, 'git.snapshots': 1 },
  },
  'skillText.storeMiss': skillTextScanSeed(true),
  'skillText.noStore': skillTextScanSeed(false),
  'skillText.storeUnopened': skillTextStoreUnopenedSeed(),
  'skillText.outsideRoot': skillTextOutsideRootSeed(),
  // The gate judging a hit whose one member's tier holds one `blobs` row (whose
  // section rows are missing, so it declines): one row read, and no store counter.
  'checks.gate.rows.read': {
    prepare: () => async () => {
      const gate = createChecksOverlapGate({
        debug: false,
        cores: () => 2,
        childHomeKey: HOME_KEY,
        routing: parseRoutingFor(undefined, ROOT),
        spawn: () => Promise.reject(new Error('the seed never spawns')),
      });
      gate.onHomeSettled(HOME_KEY, hit({ [`${ROOT}/a.md`]: keyedRealization(BLOB_KEY) }, () => Promise.resolve(blobFactsReader(oneBlobRow()))));
      expect(await gate.decision).toEqual({ mode: 'sequential', declinedBy: { condition: 'member', member: 'a.md', route: 'readRoute' } });
      return undefined;
    },
    delta: { 'checks.gate.rows.read': 1 },
  },
};

/**
 * A run's stored-document question about a file outside its root, asked twice:
 * answered nothing once per file per run, opening nothing (its store would
 * refuse), and reading, keying or listing nothing to say so.
 */
function skillTextOutsideRootSeed(): Seed {
  return {
    prepare: (scope) => {
      const root = safePath.join(scope.dir(), 'home');
      const outside = safePath.join(scope.dir(), 'elsewhere', 'SKILL.md');
      return () => withRunPopulation({
        root,
        outputs: [],
        gitTracker: new GitTracker(root),
        cacheOf: () => Promise.reject(new Error('the run never opens its store for this')),
        questionCacheOf: () => Promise.reject(new Error('the question never opens its store for this')),
        holdsStore: true,
        collectionsFor: () => Promise.resolve(undefined),
        onHomeSettled: IGNORE_HOME_SETTLEMENT,
      }, async (population) => {
        await population.source.storedDocument(outside, 'markdown');
        await population.source.storedDocument(outside, 'markdown');
        return undefined;
      });
    },
    // Whether the file is inside the root walks its chain, and the root's, from the filesystem
    // root, since neither is beneath the other: the file and its absent directory (each the temp
    // directory, the seed directory and `elsewhere`), the seed directory, and the absent root's
    // parent (each the temp directory and the seed directory). Set by the temp directory's depth.
    delta: { 'skillText.outsideRoot': 1, 'fs.lstat': 2 * (TMP_DEPTH + 2) + 2 * (TMP_DEPTH + 1) },
  };
}

/**
 * A run's stored-document questions meeting a store that will not open (here,
 * another process's lock): two questions, one failed opening counted, and
 * nothing read, keyed or listed to answer either.
 */
function skillTextStoreUnopenedSeed(): Seed {
  return {
    prepare: (scope) => {
      const root = scope.dir();
      return () => withRunPopulation({
        root,
        outputs: [],
        gitTracker: new GitTracker(root),
        cacheOf: () => Promise.resolve(undefined),
        questionCacheOf: () => Promise.reject(new StoreQuestionUnavailableError(new Error('database is locked'))),
        holdsStore: true,
        collectionsFor: () => Promise.resolve(undefined),
        onHomeSettled: IGNORE_HOME_SETTLEMENT,
      }, async (population) => {
        await population.source.storedDocument(safePath.join(root, 'SKILL.md'), 'markdown');
        await population.source.storedDocument(safePath.join(root, 'guide.md'), 'markdown');
        return undefined;
      });
    },
    // Whether each file is inside the root walks it below the root: one component each.
    delta: { 'skillText.storeUnopened': 1, 'fs.lstat': 2 },
  };
}

/**
 * The skills lane reading a SKILL.md no store serves, twice in one run: the
 * file is read and keyed each time, parsed once and answered from the parse
 * cache the second time, and counted as scanned from its text once per run: a
 * store miss when the run has a store that does not serve it, `noStore` when
 * the run has none.
 *
 * @param holdsStore - Whether the run has a store to ask
 * @returns The seed
 */
function skillTextScanSeed(holdsStore: boolean): Seed {
  const content = `---\nname: seed\n---\n${uniqueDocument('skill text')}`;
  return {
    prepare: (scope) => {
      const skillPath = safePath.join(scope.dir(), 'SKILL.md');
      writeFileSync(skillPath, content);
      const run: SkillTextRun = {
        source: { storedDocument: () => Promise.resolve(undefined), holdsStore },
        dispatcher: dispatcherOf(scope),
        crawlOnce: (_key, crawl) => crawl(),
      };
      return async () => {
        await readSkillDocument(skillPath, run, 'source');
        await readSkillDocument(skillPath, run, 'source');
        return undefined;
      };
    },
    delta: {
      [holdsStore ? 'skillText.storeMiss' : 'skillText.noStore']: 1,
      'parse.dispatched': 1,
      'parse.cache.written': 1,
      'parse.cache.hit': 1,
      'content.read': 2,
      'content.hashed': 2,
      'content.hashedBytes': 2 * Buffer.byteLength(content, 'utf8'),
    },
  };
}

/**
 * Every counter's movement between two reads.
 *
 * @param before - The earlier read
 * @param after - The later read
 * @returns Every counter, zeros included
 */
function deltaOf(
  before: Readonly<Record<WorkCounter, number>>,
  after: Readonly<Record<WorkCounter, number>>,
): Record<WorkCounter, number> {
  return Object.fromEntries(WORK_COUNTER_NAMES.map((name) => [name, after[name] - before[name]])) as Record<
    WorkCounter,
    number
  >;
}
/**
 * A counter's second counting site: `PARSE_SEEDS` files one seed per counter,
 * so a counter counted in two places gets its other place here.
 */
export const PARSE_SITE_SEEDS: ReadonlyArray<readonly [label: string, counter: ParseCounter, seed: Seed]> = [
  [
    'parse.refused.keyDetermined on a cache hit',
    'parse.refused.keyDetermined',
    {
      // A run under no output cap files the entry; a run under a one-row cap
      // then hits it and refuses it, with no dispatch.
      prepare: async (scope: SeedScope) => {
        const cacheDir = scope.dir();
        const filer = new ParseDispatcher(new ParseCache({ cacheDir, enabled: true }), {});
        scope.defer(() => filer.shutdown());
        await parseOnce(THREE_LINKS, filer);
        const capped = new ParseDispatcher(new ParseCache({ cacheDir, enabled: true }), { limits: { outputRows: 1 } });
        scope.defer(() => capped.shutdown());
        return () => parseOnce(THREE_LINKS, capped);
      },
      delta: { ...keyed(THREE_LINKS), 'parse.cache.hit': 1, 'parse.refused.keyDetermined': 1 },
    },
  ],
  [
    'parse.cache.written at a worker\'s stored reply',
    'parse.cache.written',
    // Cache as transport: the worker files the entry, the parent counts its
    // stored reply and reads the entry back, with no write of its own.
    contentSeed(uniqueDocument('written by a worker'), { transport: 'cache' }, {
      'parse.dispatched': 1,
      'parse.cache.written': 1,
    }),
  ],
];

/** Every counter at zero, overlaid with a seed's named movements. */
function expectedDelta(moves: Partial<Record<WorkCounter, number>>): Record<WorkCounter, number> {
  return { ...deltaOf(readWorkCounters(), readWorkCounters()), ...moves };
}

/**
 * A scope for one suite's seeds, everything it made disposed after each test.
 * Call it inside the suite's `describe`, before its tests.
 *
 * @returns The scope
 */
export function seedScope(): SeedScope {
  const disposers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    // Newest first, one at a time: a store closes before its directory goes.
    await disposers
      .splice(0)
      .reverse()
      .reduce<Promise<void>>((previous, dispose) => previous.then(dispose), Promise.resolve());
  });
  return {
    dir: () => {
      const dir = createTempDir('vat-work-seed-');
      disposers.push(() => removeTempDir(dir));
      return dir;
    },
    defer: (dispose) => {
      disposers.push(dispose);
    },
  };
}

/**
 * One family's seeds, as `it.each` rows.
 *
 * @param seeds - The family's table
 * @returns Counter and seed pairs
 */
export function seedCases<K extends WorkCounter>(seeds: Readonly<Record<K, Seed>>): Array<[K, Seed]> {
  return Object.entries(seeds) as Array<[K, Seed]>;
}

/**
 * Run one seed's act between two reads of the counters and assert the movement
 * of every counter.
 *
 * @param scope - The suite's scope
 * @param counter - The counter the seed is filed under
 * @param seed - The seed
 */
export async function runSeed(scope: SeedScope, counter: WorkCounter, seed: Seed): Promise<void> {
  const act = await seed.prepare(scope);
  const before = readWorkCounters();
  const result = await act();
  const delta = deltaOf(before, readWorkCounters());

  if (seed.delta === 'moved') {
    expect(delta[counter]).toBeGreaterThan(0);
    return;
  }
  // The seed moves the counter it is filed under; a seed that moved nothing
  // of its own would pin every other counter and prove nothing about this one.
  expect(seed.delta[counter] ?? 0).toBeGreaterThan(0);
  expect(delta).toStrictEqual(expectedDelta(seed.delta));
  if (seed.reported !== undefined) expect(seed.reported(result)).toBe(delta[counter]);
}
