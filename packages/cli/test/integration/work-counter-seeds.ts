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

import { openEphemeralProjectionStore, openSqliteProjectionStore } from '@vibe-agent-toolkit/projection-sqlite';
import {
  type BlobScopedRows,
  computeContentKey,
  type ExtentScopedRows,
  ParseCache,
  ParseDispatcher,
  parseContentCached,
  type ParsePoolPolicy,
  readContentWithKey,
} from '@vibe-agent-toolkit/resources';
import { readWorkCounters, safePath, WORK_COUNTER_NAMES, type WorkCounter } from '@vibe-agent-toolkit/utils';
import { createTempDir, removeTempDir, scratchTmpdirEnv } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, expect, vi } from 'vitest';

import { checkGitInstalled } from '../../src/commands/doctor.js';
import type { Logger } from '../../src/utils/logger.js';
import { withQueriedProjection } from '../../src/utils/projection-query.js';
import { PROJECTION_STORE_DIR_ENV } from '../../src/utils/projection-store.js';
import { commitTestFixture } from '../test-helpers.js';

/** The store's lane counters. */
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

/** A content key the store seeds file rows under. */
const BLOB_KEY = 'markdown.seed';

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
      frontmatterError: null,
      wordCount: 1,
      proseCodeUnits: 1,
      codeBlockCodeUnits: 0,
      linkCount: 0,
      headingCount: 1,
      sectionCount: 1,
    }],
    blobReferences: [],
    blobSections: [],
    blobConditions: [],
    harnessBlobFacts: [],
    harnessBlobImports: [],
  } as unknown as BlobScopedRows;
}

/** An extent naming no rows: a write of the manifest row only. */
const EMPTY_EXTENT = {} as ExtentScopedRows;

/** The extent key the store seeds use. */
const EXTENT_KEY = { rootId: 'seed-root', treeHash: 'seed-tree' };

type Lane = 'persistent' | 'ephemeral';

/**
 * A store of one lane, closed after the seed.
 *
 * @param lane - Which store
 * @param scope - The seed's scope
 * @returns The open store
 */
function storeOf(lane: Lane, scope: SeedScope): ReturnType<typeof openSqliteProjectionStore> {
  const store = lane === 'persistent' ? openSqliteProjectionStore({ directory: scope.dir() }) : openEphemeralProjectionStore();
  scope.defer(() => store.close());
  return store;
}

/** A read of a store holding one row: one read, one row decoded. */
function decodeSeed(lane: Lane): Seed {
  return {
    prepare: async (scope) => {
      const store = storeOf(lane, scope);
      await store.writeBlobFacts(oneBlobRow());
      return async () => {
        await store.readBlobFacts([BLOB_KEY]);
        return undefined;
      };
    },
    delta: { [`store.reads.${lane}`]: 1, [`store.rows.decoded.${lane}`]: 1 },
  };
}

/** A read of an extent never written: one read, nothing decoded. */
function readMissSeed(lane: Lane): Seed {
  return {
    prepare: (scope) => {
      const store = storeOf(lane, scope);
      return async () => {
        await store.readExtent(EXTENT_KEY);
        return undefined;
      };
    },
    delta: { [`store.reads.${lane}`]: 1 },
  };
}

/** One write: of one blob row, or of an extent with no rows. */
function writeSeed(lane: Lane, rows: 'one blob row' | 'no rows'): Seed {
  return {
    prepare: (scope) => {
      const store = storeOf(lane, scope);
      return async () => {
        await (rows === 'one blob row' ? store.writeBlobFacts(oneBlobRow()) : store.writeExtent(EXTENT_KEY, EMPTY_EXTENT));
        return undefined;
      };
    },
    delta: rows === 'one blob row'
      ? { [`store.writes.${lane}`]: 1, [`store.rows.written.${lane}`]: 1 }
      : { [`store.writes.${lane}`]: 1 },
  };
}

export const STORE_SEEDS: Readonly<Record<StoreLaneCounter, Seed>> = {
  'store.rows.decoded.persistent': decodeSeed('persistent'),
  'store.rows.decoded.ephemeral': decodeSeed('ephemeral'),
  'store.reads.persistent': readMissSeed('persistent'),
  'store.reads.ephemeral': readMissSeed('ephemeral'),
  'store.writes.persistent': writeSeed('persistent', 'no rows'),
  'store.writes.ephemeral': writeSeed('ephemeral', 'no rows'),
  'store.rows.written.persistent': writeSeed('persistent', 'one blob row'),
  'store.rows.written.ephemeral': writeSeed('ephemeral', 'one blob row'),
};

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
function dispatcherOf(scope: SeedScope, policy: ParsePoolPolicy = {}): ParseDispatcher {
  const dispatcher = new ParseDispatcher(new ParseCache({ cacheDir: scope.dir(), enabled: true }), policy);
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

/** What keying `content` adds: one hash over its UTF-8 bytes. */
function keyed(content: string): Partial<Record<WorkCounter, number>> {
  return { 'content.hashed': 1, 'content.hashedBytes': Buffer.byteLength(content, 'utf8') };
}

/** A parse on a pool whose limits the content breaches, or that runs it: one dispatch. */
function parseSeed(label: string, policy: ParsePoolPolicy, moves: Partial<Record<WorkCounter, number>>): Seed {
  const content = uniqueDocument(label);
  return {
    prepare: (scope) => {
      const dispatcher = dispatcherOf(scope, policy);
      return () => parseOnce(content, dispatcher);
    },
    delta: { ...keyed(content), ...moves },
  };
}

/** A document with three links: three output rows past a one-row cap. */
const THREE_LINKS = '# Links\n\n[a](./a.md) [b](./b.md) [c](./c.md)\n';

/** A list nested 1,000 levels deep: seconds of parse, refused at the parse clock. */
const DEEPLY_NESTED_LIST = Array.from({ length: 1000 }, (_, level) => ' '.repeat(level * 2) + '- x\n').join('');

/** Bytes a content key is computed over by the hashing seed. */
const HASHED = new TextEncoder().encode('# hashed\n');

export const PARSE_SEEDS: Readonly<Record<ParseCounter, Seed>> = {
  'parse.dispatched': parseSeed('dispatched', {}, { 'parse.dispatched': 1 }),
  'parse.cache.hit': (() => {
    const content = uniqueDocument('hit');
    return {
      prepare: async (scope: SeedScope) => {
        const dispatcher = dispatcherOf(scope);
        await parseOnce(content, dispatcher);
        return () => parseOnce(content, dispatcher);
      },
      delta: { ...keyed(content), 'parse.cache.hit': 1 },
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
  'parse.refused.inputCap.dispatch': parseSeed('input cap', { limits: { inputBytes: 4 } }, {
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
  'content.hashedBytes': parseSeed('hashed bytes', { limits: { inputBytes: 4 } }, {
    'parse.refused.inputCap.dispatch': 1,
  }),
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
function queriedTree(scope: SeedScope, files: Readonly<Record<string, string>>): () => Promise<ActResult> {
  // First, so the parse cache (under the temp directory) and every directory
  // below start empty: a parse cache another run filled would turn a dispatch
  // into a hit.
  const tmp = scratchTmpdirEnv('vat-work-seed-tmp-');
  tmp.enter();
  scope.defer(() => tmp.leave());
  const root = scope.dir();
  for (const [name, content] of Object.entries(files)) writeFileSync(safePath.join(root, name), content, 'utf8');
  commitTestFixture(root);
  vi.stubEnv(PROJECTION_STORE_DIR_ENV, scope.dir());
  return async () => {
    const lines: string[] = [];
    await withQueriedProjection(
      { root, logger: recordingLogger(lines), statements: ['SELECT 1 AS x'], base: undefined },
      (ask) => ask('SELECT 1 AS x'),
    );
    return lines.join('\n');
  };
}

/** One plain document: what every population seed's tree holds. */
const PLAIN_TREE = { 'a.md': '# A\n\nPlain.\n' };

export const POPULATION_SEEDS: Readonly<Record<PopulationCounter, Seed>> = {
  // A cold population: the one document parsed and keyed, the extent derived
  // and written to the store, loaded into the ephemeral one, and git asked for
  // the tree.
  'extent.derived': {
    prepare: (scope) => queriedTree(scope, PLAIN_TREE),
    delta: {
      'store.reads.persistent': 1,
      'store.writes.persistent': 2,
      'store.writes.ephemeral': 2,
      'store.rows.written.persistent': 12,
      'store.rows.written.ephemeral': 12,
      'extent.derived': 1,
      'parse.dispatched': 1,
      'content.hashed': 1,
      'content.hashedBytes': Buffer.byteLength(PLAIN_TREE['a.md'], 'utf8'),
      'git.calls': 4,
    },
  },
  // The same tree again: the extent served from the store, nothing parsed,
  // nothing hashed, one git call.
  'extent.served': {
    prepare: async (scope) => {
      const query = queriedTree(scope, PLAIN_TREE);
      await query();
      return query;
    },
    delta: {
      'store.rows.decoded.persistent': 12,
      'store.reads.persistent': 2,
      'store.writes.ephemeral': 2,
      'store.rows.written.ephemeral': 12,
      'extent.served': 1,
      'git.calls': 1,
    },
  },
  // A refusal no store holds forces the whole population again on the second
  // run: re-derived, both documents dispatched, the cyclic one refused again.
  'store.miss.refusedPairs': {
    prepare: async (scope) => {
      const query = queriedTree(scope, { ...PLAIN_TREE, 'deep.md': CYCLIC_FRONTMATTER });
      await query();
      return query;
    },
    delta: {
      'store.rows.decoded.persistent': 15,
      'store.reads.persistent': 2,
      'store.writes.persistent': 2,
      'store.writes.ephemeral': 2,
      'store.rows.written.persistent': 15,
      'store.rows.written.ephemeral': 16,
      'extent.derived': 1,
      'store.miss.refusedPairs': 1,
      'parse.dispatched': 2,
      'parse.refused.keyDetermined': 1,
      'content.hashed': 2,
      'content.hashedBytes': Buffer.byteLength(PLAIN_TREE['a.md'] + CYCLIC_FRONTMATTER, 'utf8'),
      'git.calls': 4,
    },
    reported: (result) => Number(/store miss: (\d+) refused/u.exec(result ?? '')?.[1] ?? Number.NaN),
  },
  'git.calls': {
    prepare: () => () => {
      checkGitInstalled();
      return undefined;
    },
    delta: { 'git.calls': 1 },
  },
};

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
