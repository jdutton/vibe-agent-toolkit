/**
 * Wiring the parse pool into the blob stage — the four properties that decide
 * whether the wiring is worth having at all.
 *
 * `createParsePool` was already correct and already tested as a TRANSPORT
 * (`parse-pool.test.ts`). What was missing was a call site that dispatches more
 * than one document at a time: `populateBlobs` awaited each blob in turn, so a
 * pool bolted underneath it would have added structured-clone traffic to a
 * strictly serial loop and made the command SLOWER. So every test here is about
 * the LOOP, not the transport:
 *
 * - **Order.** Concurrency lives in the prepare half; emission is strictly
 *   sequential in content-key order. A projection whose row order depended on
 *   which thread finished first would differ between two runs on one machine,
 *   which is worse than being slow.
 * - **Boundedness.** The fan-out is `pool.size` wide and never the whole target
 *   list. The loop it replaced was sequential *because* "one file handle per
 *   corpus blob in flight is how a large corpus meets EMFILE", and a bounded
 *   fan-out is what preserves that argument.
 * - **Activation on MISSES.** A fully warm run — every document served from the
 *   parse cache — must spawn no thread at all, exactly as it loads no parser at
 *   all. The cold arm of that test exists so the oracle cannot be blind: a
 *   counter that never rises would pass the warm assertion for the wrong reason.
 * - **Shutdown.** A pool that is not shut down loses every worker's parse-timing
 *   dump, because a process exiting with live threads runs none of their exit
 *   listeners. That has to hold on the throw path too, which is where a
 *   `finally` is the only thing that can hold it.
 */

import { mkdir, writeFile } from 'node:fs/promises';

import { compareCodeUnits, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ParseCache } from '../src/parse-cache.js';
import { __setParseWorkerEntryForTest, createParsePool, defaultParsePoolSize, type ParsePool } from '../src/parse-pool.js';
import { BLOB_PARSE_FAILED, BLOB_PARSE_WORKER_DIED, populateBlobs, type BlobPopulationResult } from '../src/projection/blob-population.js';
import { describeBlobRefusals } from '../src/projection/blob-refusals.js';
import type { Projection } from '../src/projection/projection.js';

import { baseBuilderForRoot, conditionsWithCode } from './blob-fixture-population.js';
import { fakePool } from './parse-pool-fixture.js';
import { setupSubdirTestSuite, workerThreadCount } from './test-helpers.js';

/**
 * A cache that never touches disk, for every test whose subject is the loop.
 *
 * A disk-backed cache would serve the second run of a fixture from the first
 * one's entries, so "the pool parsed these documents" and "nothing parsed
 * anything" would produce identical projections.
 */
const NO_CACHE = new ParseCache({ enabled: false });

/** Files written under the suite root. */
interface CorpusFile {
  path: string;
  content: string;
}

/** How many markdown documents the loop fixtures carry. */
const DOC_COUNT = 9;

/**
 * A corpus of distinct markdown documents plus one of every other blob shape.
 *
 * Distinct bytes per document is the load-bearing part: blobs are
 * content-addressed, so two files with equal bytes are ONE target and a fixture
 * of nine copies would exercise a fan-out of one.
 */
const LOOP_CORPUS: readonly CorpusFile[] = [
  ...Array.from({ length: DOC_COUNT }, (_unused, index) => ({
    path: `doc-${String(index)}.md`,
    content: `# Doc ${String(index)}\n\nSee [next](./doc-${String(index + 1)}.md).\n`,
  })),
  // The HTML route, so the dispatcher is proven to carry the kind rather than
  // assuming markdown.
  { path: 'page.html', content: '<h1 id="top">Page</h1>\n<a href="./doc-0.md">doc</a>\n' },
  // The `none` route: typed `text/x-typescript`, so no document parser runs and
  // the pool must never see it.
  { path: 'build.ts', content: '// see ./doc-0.md for the rest\nexport const target = 1;\n' },
];

/** A NUL inside the first block: refused as binary before any parser is asked. */
const BINARY_FIXTURE = 'blob.bin';

/**
 * A tail rich enough in BYTES to buy two workers at the shipped break-even.
 *
 * The sizing prices the remainder in serial parse milliseconds — markdown at a
 * measured ~370 ms/MB — and one worker's share is ~1,000 ms, so two of them need
 * upwards of 5.4 MB of markdown. 200 documents at 32 KB is ~6.4 MB, which clears
 * it with margin at every point the activation could fire.
 *
 * ⭐ Both numbers are written out rather than imported. A test that derived its
 * fixture from the constants under test would keep passing if those constants
 * were changed to something absurd.
 */
const LONG_TAIL_DOCS = 200;

/** Bytes per tail document — see {@link LONG_TAIL_DOCS} for why it is not tiny. */
const TAIL_DOCUMENT_BYTES = 32_768;

/**
 * Where the tail is written.
 *
 * Its OWN root, and that is load-bearing. The sizing prices the remainder from
 * the mean size of the documents this run has already read, and the loop corpus
 * above is a handful of ~60-byte stubs. Mixed into one root they would be
 * sampled in content-key order — a hash, so effectively at random — and the
 * decision would depend on which document the digest happened to sort first.
 */
const TAIL_DIR = 'tail';

const suite = setupSubdirTestSuite('blob-population-pool-');

/** Write the loop corpus, plus the binary fixture, beneath this test's root. */
async function writeLoopCorpus(): Promise<void> {
  await Promise.all(
    LOOP_CORPUS.map(async (file) =>
      writeFile(safePath.join(suite.tempDir, file.path), file.content, 'utf-8'),
    ),
  );
  await writeFile(
    safePath.join(suite.tempDir, BINARY_FIXTURE),
    Uint8Array.from([0x89, 0x50, 0x00, 0x4e, 0x47]),
  );
  await mkdir(safePath.join(suite.tempDir, 'empty-dir'), { recursive: true });
}

/**
 * Plant a tail of uniform markdown documents under {@link TAIL_DIR}.
 *
 * Each carries distinct bytes, because blobs are content-addressed: 200 copies
 * of one document is ONE target, and a fixture built that way would size the
 * pool for a corpus of one. Each is also the SAME LENGTH, so the mean the sizing
 * projects is the same whichever documents it happens to sample first.
 *
 * @param count - How many documents to write
 * @param byteLength - Bytes each one carries
 * @returns The root the tail was written under
 */
async function writeTail(count: number, byteLength: number): Promise<string> {
  const tailDir = safePath.join(suite.tempDir, TAIL_DIR);
  await mkdir(tailDir, { recursive: true });
  await Promise.all(
    Array.from({ length: count }, async (_unused, index) => {
      const filler = 'lorem ipsum dolor sit amet\n';
      const heading = `# Tail ${String(index)}\n\n`;
      const body = filler.repeat(Math.ceil(byteLength / filler.length));
      return writeFile(
        safePath.join(tailDir, `tail-${String(index)}.md`),
        (heading + body).slice(0, byteLength),
        'utf-8',
      );
    }),
  );
  return tailDir;
}

/** The four blob-keyed tables, in the order the stage emitted them. */
function blobTablesOf(projection: Projection): {
  blobs: Projection['blobs'];
  blobReferences: Projection['blobReferences'];
  blobSections: Projection['blobSections'];
  blobConditions: Projection['blobConditions'];
} {
  return {
    blobs: projection.blobs,
    blobReferences: projection.blobReferences,
    blobSections: projection.blobSections,
    blobConditions: projection.blobConditions,
  };
}

/**
 * Derive the loop corpus once.
 *
 * `size` is stated rather than left to the default on purpose: the default width
 * is derived from how many documents remain, and this fixture is deliberately
 * far too small to earn a second worker. A suite that let the default decide
 * would run one job at a time, and every order assertion below would pass
 * trivially.
 *
 * @param pool - The fake pool to force on, or `undefined` for the real pool
 * @returns The projection and the stage's counters
 */
async function derive(
  pool?: ParsePool,
): Promise<{ projection: Projection; counts: BlobPopulationResult }> {
  const builder = await baseBuilderForRoot(suite.tempDir);
  const counts = await populateBlobs(builder, {
    parseCache: NO_CACHE,
    // The fake arm states its width: the default stays at one thread for a
    // corpus this small, so a test that inherited it would never exercise the
    // concurrent half. The other arm is the shipped route — the real bounded
    // pool — because there is no unpooled route left to compare against.
    parsePool:
      pool === undefined
        ? {}
        : { missThreshold: 1, size: pool.size, createPool: (): ParsePool => pool },
  });
  return { projection: builder.build(), counts };
}

describe('the blob stage under a parse pool', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  beforeEach(writeLoopCorpus);

  it('emits rows in content-key order however the pool answers', async () => {
    // The fake pool answers in REVERSE dispatch order. If any `builder.*` call
    // moved into the concurrent half, the rows would land in completion order
    // and this assertion would read the fixture back inside out.
    const { pool } = fakePool(DOC_COUNT + 2, { reverseCompletion: true });

    const { projection } = await derive(pool);

    const emitted = projection.blobs.map((row) => row.contentKey);
    expect(emitted.length).toBeGreaterThan(1);
    expect(emitted).toStrictEqual([...emitted].sort(compareCodeUnits));
  });

  it('produces the same rows, in the same order, on two runs', async () => {
    const first = await derive(fakePool(4, { reverseCompletion: true }).pool);
    const second = await derive(fakePool(4, { reverseCompletion: true }).pool);

    expect(blobTablesOf(second.projection)).toStrictEqual(blobTablesOf(first.projection));
    expect(second.counts).toStrictEqual(first.counts);
  });

  it('derives exactly what the shipped bounded pool derives', async () => {
    const shipped = await derive();
    const pooled = await derive(fakePool(3).pool);

    expect(blobTablesOf(pooled.projection)).toStrictEqual(blobTablesOf(shipped.projection));
    expect(pooled.counts).toStrictEqual(shipped.counts);
  });

  it('never fans out wider than the pool', async () => {
    // Three-wide pool, nine-plus documents: an unbounded `Promise.all` over the
    // target list would show every remaining document in flight at once, which
    // is exactly the file-handle pressure the sequential loop existed to avoid.
    const { pool, record } = fakePool(3);

    await derive(pool);

    expect(record.calls).toBeGreaterThan(3);
    expect(record.maxInFlight).toBeGreaterThan(1);
    expect(record.maxInFlight).toBeLessThanOrEqual(3);
  });

  it('never dispatches a blob that routes to no parser', async () => {
    const { pool, record } = fakePool(4);

    const { counts } = await derive(pool);

    // `build.ts` is a `none.` key: it has a row and its lexical references, and
    // it must not cost a structured clone across a thread boundary. `blob.bin`
    // is refused as binary ahead of the kind split, so it is not dispatched
    // either.
    expect(counts.blobsWithoutParser).toBe(1);
    expect(counts.blobsNotText).toBe(1);
    // Every parsable blob is dispatched — there is no in-process route.
    expect(record.calls).toBe(DOC_COUNT + 1);
  });

  it('shuts the pool down on the success path', async () => {
    const { pool, record } = fakePool(4);

    await derive(pool);

    expect(record.shutdowns).toBe(1);
  });

  it('shuts the pool down when population throws', async () => {
    // A parser-load failure is the one error the stage propagates rather than
    // recording per document, so it is the only way out of the loop that is not
    // a return — and therefore the only path a `finally` is needed for.
    const failure: Error & { code?: string } = new Error('parser module missing');
    failure.code = 'VAT_PARSER_UNAVAILABLE';
    const { pool, record } = fakePool(4, { failWith: (): Error => failure });

    await expect(derive(pool)).rejects.toThrow(/parser module missing/);

    expect(record.shutdowns).toBe(1);
  });
});

describe('parse-pool activation', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  beforeEach(writeLoopCorpus);

  it('spawns a thread on a cold run and none at all on a fully warm one', async () => {
    // The differential is the whole test. The warm assertion alone would pass
    // for a `workers` report that is blind on this platform; the cold assertion
    // is what proves it is not.
    // OUTSIDE the corpus root: a cache written beneath `tempDir` would be
    // enumerated as corpus on the second run and change what is being derived.
    const cache = new ParseCache({ cacheDir: safePath.join(suite.suiteDir, 'parse-cache') });
    const before = workerThreadCount();
    const observed = { peak: before, pools: 0 };

    const createPool = (options?: { size?: number }): ParsePool => {
      observed.pools += 1;
      const real = createParsePool(options);
      return {
        size: real.size,
        parse: async (kind, content, byteLength) => real.parse(kind, content, byteLength),
        // Delegated rather than omitted: this wrapper stands in for a REAL pool,
        // and a member it silently lacks would make a cache-transport run fail
        // on the wrapper instead of on the thing under test.
        parseIntoCache: async (kind, content, byteLength, cacheKey) =>
          real.parseIntoCache(kind, content, byteLength, cacheKey),
        shutdown: async (): Promise<void> => {
          // Sampled BEFORE the close: this is the only moment at which a thread
          // the run started is guaranteed still to be in the thread table.
          observed.peak = Math.max(observed.peak, workerThreadCount());
          await real.shutdown();
        },
      };
    };
    const options = { parseCache: cache, parsePool: { missThreshold: 1, size: 1, createPool } };

    await populateBlobs(await baseBuilderForRoot(suite.tempDir), options);

    expect(observed.pools).toBe(1);
    expect(observed.peak).toBeGreaterThan(before);

    const cold = { ...observed };
    observed.pools = 0;
    observed.peak = workerThreadCount();

    await populateBlobs(await baseBuilderForRoot(suite.tempDir), options);

    // Every document is now a cache hit, so the run has no parse to hand
    // anywhere — and must therefore create no pool and spawn no thread, exactly
    // as `parseKeyed` loads no parser.
    expect(cold.pools).toBe(1);
    expect(observed.pools).toBe(0);
    expect(observed.peak).toBe(workerThreadCount());
  });

  it('leaves no worker thread behind after a real pooled run', async () => {
    const before = workerThreadCount();

    await populateBlobs(await baseBuilderForRoot(suite.tempDir), {
      parseCache: NO_CACHE,
      parsePool: { missThreshold: 1, size: 2 },
    });

    expect(workerThreadCount()).toBe(before);
  });

  it('widens the pool from the work that is left, once there is enough of it', async () => {
    // The other half of the differential. Without it, "does not widen" below
    // would be satisfied by a stage that never starts a pool under any corpus —
    // and the whole wiring would be dead code again, silently, with a green
    // suite.
    const tailDir = await writeTail(LONG_TAIL_DOCS, TAIL_DOCUMENT_BYTES);
    // `emptyFacts`, because the only assertion here is the WIDTH the stage
    // reached. This fake parses in-process, and the corpus is megabytes by
    // construction — running remark over all of it would cost seconds to derive
    // rows nothing below reads.
    const { pool, record } = fakePool(2, { emptyFacts: true });

    await populateBlobs(await baseBuilderForRoot(tailDir), {
      parseCache: NO_CACHE,
      parsePool: { missThreshold: 1, createPool: (): ParsePool => pool },
    });

    if (defaultParsePoolSize() < 2) {
      // A box with fewer than three cores cannot afford a second thread however
      // long the tail is, and must then stay at one. Asserted rather than
      // skipped: a skip on a small CI runner is a hole, and this is the same
      // claim taken from the other side.
      expect(record.maxInFlight).toBe(1);
      return;
    }
    expect(record.maxInFlight).toBe(2);
  });

  it('does not widen for the same document COUNT in stub documents', async () => {
    // 🔑 The unit is BYTES, and this is the lane-level proof of it. Same tail,
    // same count, same kinds — 60-byte documents instead of 32 KB ones. A stage
    // that had regressed to counting documents would widen the pool here and could
    // not be told apart from a correct one by the case above.
    const tailDir = await writeTail(LONG_TAIL_DOCS, 60);
    const { pool, record } = fakePool(2);

    await populateBlobs(await baseBuilderForRoot(tailDir), {
      parseCache: NO_CACHE,
      parsePool: { missThreshold: 1, createPool: (): ParsePool => pool },
    });

    // 200 documents at 60 bytes is 12 KB of markdown — four thousandths of a
    // second of parsing, against ~723 ms of module load per extra thread.
    expect(record.maxInFlight).toBe(1);
  });

  it('does not widen for a tail too short to pay for a second worker', async () => {
    // The measured regression this rule exists for: sized at the machine's
    // default, activation started workers for a 177-document tail and made
    // `vat claude context` on this repository SLOWER. A threshold cannot bound
    // that, because the cost scales with the WIDTH and the threshold says
    // nothing about width.
    const { pool, record } = fakePool(4);

    await populateBlobs(await baseBuilderForRoot(suite.tempDir), {
      parseCache: NO_CACHE,
      parsePool: { missThreshold: 1, createPool: (): ParsePool => pool },
    });

    // Ten short documents against a ~2,000 ms two-worker break-even: no second thread.
    expect(record.maxInFlight).toBe(1);
  });
});

/**
 * A REAL pool whose thread dies of an uncaught, coded error, and the route from that rejection to
 * the user: a per-run `BLOB_PARSE_WORKER_DIED` row naming the cause — never `BLOB_PARSE_FAILED`,
 * which would claim the BYTES failed — and the population warning naming it. Nothing a document
 * contains kills a thread, so the thread is pointed at an entry that throws, exactly as
 * `parse-pool.test.ts` does.
 */
describe('a real parse-pool rejection', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  beforeEach(writeLoopCorpus);

  const CODE = 'ERR_TEST_PARSE_WORKER_DIED';

  it('is a per-run worker death carrying its cause, and is named by the population warning', async () => {
    const entryDir = safePath.join(suite.suiteDir, 'dying-worker');
    await mkdir(entryDir, { recursive: true });
    const entry = safePath.join(entryDir, 'dying-worker.mjs');
    await writeFile(
      entry,
      `import { parentPort } from 'node:worker_threads';\nparentPort.on('message', () => { throw Object.assign(new Error('died'), { code: '${CODE}' }); });\n`,
      'utf-8',
    );
    __setParseWorkerEntryForTest(entry);
    try {
      const builder = await baseBuilderForRoot(suite.tempDir);
      await populateBlobs(builder, {
        parseCache: NO_CACHE,
        parsePool: { missThreshold: 1, size: 1, createPool: (): ParsePool => createParsePool({ size: 1 }) },
      });
      const projection = builder.build();

      expect(conditionsWithCode(projection, BLOB_PARSE_FAILED)).toHaveLength(0);
      const died = conditionsWithCode(projection, BLOB_PARSE_WORKER_DIED);
      expect(died.length).toBeGreaterThan(0);
      for (const row of died) expect(row.message).toContain(CODE);
      expect(describeBlobRefusals(projection)).toContain('parse worker died');
    } finally {
      __setParseWorkerEntryForTest(null);
    }
  });
});
