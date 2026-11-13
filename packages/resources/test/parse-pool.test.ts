/**
 * The parse pool is a TRANSPORT, so every test here is an equivalence test.
 *
 * A pool that returns plausible-looking parse facts is worse than no pool at
 * all: `vat claude context` files those facts into the projection, and a lane
 * that silently disagrees with the in-process parser cannot be told from a
 * corpus that genuinely differs. So the load-bearing assertion is
 * `toStrictEqual` against what `parseMarkdownContent` / `parseHtmlContent`
 * return for the same input — `content` included, no field exempted.
 *
 * The other three properties tested here are the ones the pool's docstrings
 * claim and which a green suite would otherwise not notice losing:
 *
 * - **Laziness.** Creating a pool must spawn nothing. Asserted against
 *   `process.report.getReport().workers`, which is Node's own view of the
 *   thread table rather than bookkeeping this module keeps about itself — the
 *   spawn-count-a-module-increments oracle proves only that the module agrees
 *   with itself. The counts are compared as DELTAS because the unit pool runs
 *   this file inside a vitest worker thread.
 * - **Clone safety.** The wire payload must survive `structuredClone`
 *   unchanged. A companion test pins the reason the payload is `ParseFacts` and
 *   not `ParseResult`: a `!!binary` frontmatter value is a `Buffer`, and
 *   structured clone lands it as a `Uint8Array`.
 * - **Termination.** Every pool is shut down in a `finally`. A leaked worker
 *   thread does not fail a test; it hangs the file, and then CI.
 */

import diagnosticsChannel from 'node:diagnostics_channel';
import { existsSync, promises as fs, rmSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { Worker } from 'node:worker_threads';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import {
  __resetWorkCountersForTest,
  __throwOnForbiddenWorkCountForTest,
  removeScratchDir,
} from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { computeContentKey, type KeyedContent } from '../src/content-key.js';
import { parseHtmlContent } from '../src/html-link-parser.js';
import { type ParseResult, parseMarkdownContent } from '../src/link-parser.js';
import type { DocumentParserKind } from '../src/mime-type.js';
import { isParserUnavailable, ParseCache } from '../src/parse-cache.js';
import {
  type HeapBounds,
  heapBounds,
  isParseLimitError,
  isParserThrewError,
  isParseWorkerDiedError,
  ParseLimitError,
  resolveParseLimits,
  reusedThreadHeapMb,
  v8HeapFlags,
  workerHeapCeilingMb,
  workerHeapGeometry,
} from '../src/parse-limits.js';
import {
  __closeParkedParseWorkersForTest,
  __parkedParseWorkerCountForTest,
  __setParseWorkerEntryForTest,
  createParsePool,
  describeParseFailure,
  HEAP_SAMPLE_INTERVAL_MS,
  PARKED_HEAP_MB,
  PARKED_IDLE_MS,
  type ParsePool,
  toParseWire,
} from '../src/parse-pool.js';
import {
  __readParseTimingSnapshot,
  __setParseTimingForTest,
  __writeParseTimingDumpForTest,
  type ParseTimingDump,
} from '../src/parse-timing.js';

import { stubParkingMachine, widestLiveWorkerThreads, workerThreadCount } from './test-helpers.js';

/** One document, and the parser it routes to. */
interface Fixture {
  name: string;
  kind: DocumentParserKind;
  content: string;
  /**
   * Deliberately NOT `content.length`. `sizeBytes` is a raw byte count the
   * caller supplies, and a pool that recomputed it from the decoded string
   * would still look right on ASCII fixtures.
   */
  byteLength: number;
}

const MARKDOWN_RICH = `---
title: Pool fixture
tags: [alpha, beta]
nested:
  count: 3
---

# Heading one

Prose with an [inline link](./other.md) and a [reference link][ref], plus a
[dangling one][nowhere] that resolves to nothing.

See @vibe-agent-toolkit/resources and \${HOME}/notes.md too.

## Heading two

\`\`\`ts
const notALink = '[notreally](alink)';
\`\`\`

<a id="anchor-one"></a>

[ref]: https://example.com/ref
`;

const HTML_RICH = `<!doctype html>
<html lang="en">
  <head><title>Pool fixture</title></head>
  <body>
    <h1 id="top">Heading</h1>
    <a href="./other.html">relative</a>
    <img src="pic.png" alt="pic">
    <p id="para">text</p>
  </body>
</html>
`;

/**
 * Unclosed tags and a stray end tag, so parse5 reports well-formedness errors.
 * That channel is `ParseResult.parseErrors`, and it must arrive as DATA rather
 * than as a rejected promise — see the pool's `parse` docstring.
 */
const HTML_MALFORMED = `<div><p>unclosed<span></div></p></body>`;

const MARKDOWN_BROKEN_FRONTMATTER = `---
title: [unclosed
---

# Still a document
`;

/**
 * `!!binary` decodes to a `Buffer`, which is the one frontmatter value that
 * does not survive structured clone as itself. It is here so the equivalence
 * test covers the case the design exists for.
 */
const MARKDOWN_BINARY_FRONTMATTER = `---
blob: !!binary aGVsbG8=
---

# Binary frontmatter
`;

const FIXTURES: readonly Fixture[] = [
  { name: 'rich markdown', kind: 'markdown', content: MARKDOWN_RICH, byteLength: Buffer.byteLength(MARKDOWN_RICH) },
  { name: 'rich html', kind: 'html', content: HTML_RICH, byteLength: Buffer.byteLength(HTML_RICH) },
  { name: 'malformed html', kind: 'html', content: HTML_MALFORMED, byteLength: Buffer.byteLength(HTML_MALFORMED) },
  {
    name: 'broken frontmatter',
    kind: 'markdown',
    content: MARKDOWN_BROKEN_FRONTMATTER,
    byteLength: Buffer.byteLength(MARKDOWN_BROKEN_FRONTMATTER),
  },
  {
    name: 'binary frontmatter',
    kind: 'markdown',
    content: MARKDOWN_BINARY_FRONTMATTER,
    byteLength: Buffer.byteLength(MARKDOWN_BINARY_FRONTMATTER),
  },
  { name: 'empty markdown', kind: 'markdown', content: '', byteLength: 0 },
  { name: 'empty html', kind: 'html', content: '', byteLength: 0 },
  {
    // A UTF-16BE source decodes to fewer characters than it had bytes, so a
    // pool deriving `sizeBytes` from `content` would report the wrong number.
    name: 'byte length that is not the string length',
    kind: 'markdown',
    content: '# Ünïcödé — ✨\n',
    byteLength: 999,
  },
];

/**
 * What the in-process parser returns — the oracle every equivalence assertion
 * is made against.
 *
 * @param fixture - The document to parse
 * @returns The parse result the shipped, single-threaded path produces
 */
function parseInProcess(fixture: Fixture): ParseResult {
  return fixture.kind === 'html'
    ? parseHtmlContent(fixture.content, fixture.byteLength)
    : parseMarkdownContent(fixture.content, fixture.byteLength);
}

// `workerThreadCount` is shared with `projection-blob-population-pool.test.ts`
// (see test-helpers.ts): both suites must read the same oracle, and the one that
// keeps a blind-oracle guard is `does spawn a worker thread once a parse is
// issued` below — a report that never populates `workers` fails THAT test, so
// the blindness surfaces as a red rather than as three greens that mean nothing.

/** Pools created by the running test, shut down in `afterEach` no matter what. */
const openPools: ParsePool[] = [];

/**
 * Create a pool the suite is guaranteed to shut down.
 *
 * Size 2 rather than the default: these tests care about the transport, and
 * every extra thread is another ~730 ms remark load charged to the file's
 * budget.
 *
 * @param size - Worker ceiling for this pool
 * @returns The pool, registered for teardown
 */
function trackedPool(size = 2): ParsePool {
  const pool = createParsePool({ size });
  openPools.push(pool);
  return pool;
}

/**
 * The wall clock a heap test's job is stopped at if the heap never decides it.
 *
 * A heap decision takes a handful of 50 ms samples once the thread is up, so
 * this is a backstop, never the decider: a sampler that stops deciding ends the
 * job as a `timeMs` refusal the test's assertion names, well inside the 60 s
 * test timeout. A clock no test reaches would instead hold the job open forever,
 * and the pool's drain-first shutdown with it — a hung `afterEach`, not a red.
 */
const HEAP_DECISION_BACKSTOP_MS = 20_000;

/** A heap test's pool: one thread, with the wall clock only as a backstop. */
const HEAP_TEST_POOL_OPTIONS = { size: 1, limits: { timeMs: HEAP_DECISION_BACKSTOP_MS } } as const;

/**
 * A pool for a heap test ({@link HEAP_TEST_POOL_OPTIONS}).
 *
 * @param size - Its threads
 * @returns The pool, shut down after the test
 */
function heapTestPool(size = 1): ParsePool {
  const pool = createParsePool({ ...HEAP_TEST_POOL_OPTIONS, size });
  openPools.push(pool);
  return pool;
}

/** Cache roots the running test created, removed in `afterEach`. */
const cacheRoots: string[] = [];

/**
 * A fresh cache root, and a pool whose workers file into it.
 *
 * The pairing is the point: a pool told a DIFFERENT root than the cache the test
 * reads would store every entry somewhere the assertion cannot see, the worker
 * would report success, and the parent's fallback would quietly make every test
 * here pass for the wrong reason.
 *
 * @returns A cache over a fresh root, and a pool that writes into the same one
 */
async function cacheBackedPool(): Promise<{ cache: ParseCache; pool: ParsePool }> {
  const root = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-pool-cache-'));
  cacheRoots.push(root);
  const pool = createParsePool({ size: 1, cacheDir: root });
  openPools.push(pool);
  return { cache: new ParseCache({ cacheDir: root, enabled: true }), pool };
}

/**
 * The `KeyedContent` a parent would hold for one fixture.
 *
 * The key is derived HERE, on the parent side, from the raw bytes — exactly as
 * `readContentWithKey` does and as the worker cannot: a worker receives a
 * decoded string, and the byte sequence is not recoverable from it.
 *
 * @param fixture - The document
 * @returns What the parent keys the bytes as
 */
function keyedFor(fixture: Fixture): KeyedContent {
  const bytes = Buffer.from(fixture.content, 'utf-8');
  return {
    content: fixture.content,
    decoding: { encoding: 'utf-8', encodingSource: 'assumed', replacementCharacters: 0 },
    key: computeContentKey(bytes, fixture.kind),
    parserKind: fixture.kind,
    byteLength: fixture.byteLength,
  };
}

/**
 * The release of every exit hold the running test made, run by the suite's `afterEach` before it
 * shuts any pool down ({@link holdThreadExits}).
 */
const heldExitReleases: Array<() => void> = [];

afterEach(async () => {
  // First: a pool's shutdown waits for every thread's exit, and a test that failed before its own
  // release would leave one held.
  for (const release of heldExitReleases.splice(0, heldExitReleases.length)) release();
  // A test that timed out mid-wait leaves the pool's clocks on fake timers, where they never fire,
  // and the drain-first shutdown below would wait for them for ever: every armed clock is run now,
  // and the clock goes back to the real one, on which whatever those re-arm runs.
  if (vi.isFakeTimers()) {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  }
  // Then: a spy a timed-out test left on `Worker.prototype` would otherwise be
  // captured as the "real" method by the next test's spy, which then calls itself.
  vi.restoreAllMocks();
  const pools = openPools.splice(0, openPools.length);
  await Promise.all(pools.map(async (pool) => pool.shutdown()));
  const roots = cacheRoots.splice(0, cacheRoots.length);
  await Promise.all(roots.map(async (root) => removeScratchDir(root)));
  __setParseWorkerEntryForTest(null);
  // Every test starts with no parked thread: one an earlier test left would serve its first pool.
  await __closeParkedParseWorkersForTest();
});

describe('the input cap', () => {
  it('parses a document of exactly the cap, and refuses one byte more before any thread sees it', async () => {
    const cap = 16;
    const pool = createParsePool({ size: 1, limits: { inputBytes: cap } });
    openPools.push(pool);
    const atCap = `# ${'a'.repeat(cap - 3)}\n`;
    const pastCap = `# ${'a'.repeat(cap - 2)}\n`;

    expect(Buffer.byteLength(atCap)).toBe(cap);
    expect(await outcomeOf(pool, atCap)).toBe('answered');
    const refused = await outcomeOf(pool, pastCap);
    // The cap alone, as every file lane says it: one sentence for one refusal, whichever lane made it.
    expect(isParseLimitError(refused) ? [refused.limit, refused.bound] : refused).toStrictEqual(['inputBytes', `${String(cap)} input bytes`]);
  });
});

describe('createParsePool', () => {
  it('spawns no worker thread until the first parse', () => {
    const before = workerThreadCount();
    const pool = trackedPool();

    expect(workerThreadCount()).toBe(before);
    expect(pool.size).toBeGreaterThanOrEqual(1);
  });

  it('spawns no worker thread for a pool created and shut down unused', async () => {
    const before = workerThreadCount();
    const pool = createParsePool({ size: 4 });

    // Checked BEFORE the shutdown as well: a pool that spawned eagerly and then
    // tidied up would pass an after-only assertion, which would make this test
    // unable to distinguish the property it exists to prove.
    expect(workerThreadCount()).toBe(before);
    await pool.shutdown();

    expect(workerThreadCount()).toBe(before);
  });

  it('does spawn a worker thread once a parse is issued', async () => {
    const before = workerThreadCount();
    const pool = trackedPool(1);

    await pool.parse('markdown', '# hi\n', 5);

    expect(workerThreadCount()).toBeGreaterThan(before);
  });

  it('defaults its size to availableParallelism minus one, capped', () => {
    const pool = createParsePool();
    openPools.push(pool);

    expect(pool.size).toBeGreaterThanOrEqual(1);
    expect(pool.size).toBeLessThanOrEqual(Math.max(1, availableParallelism() - 1));
  });

  it('caps any width it is asked for at what this machine\'s memory holds', () => {
    const pool = createParsePool({ size: 100_000 });
    openPools.push(pool);

    // Each default worker may grow to 2,048 MiB; 1,024 MiB stays with the main thread.
    const fits = Math.max(1, Math.floor((totalmem() / 1_048_576 - 1024) / 2048));
    expect(pool.size).toBe(fits);
  });
});

describe('ParsePool.parse', () => {
  it.each(FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    'returns exactly what the in-process parser returns for %s',
    async (_name, fixture) => {
      const pool = trackedPool();

      const actual = await pool.parse(fixture.kind, fixture.content, fixture.byteLength);

      expect(actual).toStrictEqual(parseInProcess(fixture));
    },
  );

  it('re-attaches the caller\'s own content rather than shipping it back', async () => {
    const pool = trackedPool();

    const result = await pool.parse('markdown', MARKDOWN_RICH, 4242);

    expect(result.content).toBe(MARKDOWN_RICH);
    expect(result.sizeBytes).toBe(4242);
  });

  it('carries HTML parse errors as data, not as a rejection', async () => {
    const pool = trackedPool();

    const result = await pool.parse('html', HTML_MALFORMED, Buffer.byteLength(HTML_MALFORMED));

    expect(result.parseErrors?.length ?? 0).toBeGreaterThan(0);
    expect(result.parseErrors).toStrictEqual(
      parseHtmlContent(HTML_MALFORMED, Buffer.byteLength(HTML_MALFORMED)).parseErrors,
    );
  });

  it('parses a batch concurrently without crossing results', async () => {
    const pool = trackedPool(3);
    const batch = [...FIXTURES, ...FIXTURES, ...FIXTURES];

    const results = await Promise.all(
      batch.map(async (fixture) => pool.parse(fixture.kind, fixture.content, fixture.byteLength)),
    );

    expect(results).toStrictEqual(batch.map((fixture) => parseInProcess(fixture)));
  });

  it('rejects clearly once the pool is shut down', async () => {
    const pool = createParsePool({ size: 1 });
    await pool.shutdown();

    await expect(pool.parse('markdown', '# hi\n', 5)).rejects.toThrow(/shut down/i);
  });

  it('rejects clearly when a worker dies unexpectedly', async () => {
    const directory = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-pool-death-'));
    const entry = safePath.join(directory, 'suicidal-worker.mjs');
    await fs.writeFile(
      entry,
      `import { parentPort } from 'node:worker_threads';\n${READY_LINE}\nparentPort.on('message', (request) => { ${DIES_PARSING} });\n`,
      'utf-8',
    );
    __setParseWorkerEntryForTest(entry);
    const pool = trackedPool(1);

    // Matched on the EXIT CODE, not on the word "worker": the unresolvable-entry
    // error says "parse worker" too, so a looser pattern would let this test
    // pass for a pool that never started a thread at all.
    await expect(pool.parse('markdown', '# hi\n', 5)).rejects.toThrow(
      /exited unexpectedly with code 3/,
    );

    await fs.rm(directory, { recursive: true, force: true });
  });
});

/** What a seeded worker entry posts once its module has loaded, as the real worker does. */
const READY_LINE = 'parentPort.postMessage({ ready: true, collector: true });';

/**
 * A seeded thread killed by the document it holds: its parser has loaded for `request` (said so,
 * as the real worker does before it parses), and the thread exits. One that exits before saying so
 * died before any parser ran over the document, which is never the document's death.
 */
const DIES_PARSING = 'parentPort.postMessage({ id: request.id, parserLoaded: request.kind }); process.exit(3);';

/** The built worker, which a seeded entry can import to answer real parses. */
const BUILT_WORKER = pathToFileURL(safePath.resolve(import.meta.dirname, '..', 'dist', 'parse-worker.js')).href;
const BUILT_LIMITS = pathToFileURL(safePath.resolve(import.meta.dirname, '..', 'dist', 'parse-limits.js')).href;

/**
 * @param body - The seeded entry's source
 * @returns The entry's path, already installed as the pool's worker entry
 */
async function seedWorkerEntry(body: string): Promise<string> {
  const directory = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-pool-seed-'));
  cacheRoots.push(directory);
  const entry = safePath.join(directory, 'seeded-worker.mjs');
  // Under {@link withoutHeapFlags}, cleared before anything below loads the real worker, which
  // reads them as its module loads.
  const hide = threadsWithoutHeapFlags
    ? [
      `const { v8HeapFlags: readHeapFlags } = await import(${JSON.stringify(BUILT_LIMITS)});`,
      `process.execArgv = (${String(withoutHeapFlagArgs)})(process.execArgv, readHeapFlags);`,
      "delete process.env['NODE_OPTIONS'];",
    ]
    : [];
  await fs.writeFile(entry, [...hide, body].join('\n'), 'utf-8');
  __setParseWorkerEntryForTest(entry);
  return entry;
}

/**
 * @param pool - The pool
 * @param content - One document
 * @returns What the parse rejected with, or the string `answered`
 */
async function outcomeOf(pool: ParsePool, content: string): Promise<unknown> {
  return pool.parse('markdown', content, Buffer.byteLength(content)).then(
    () => 'answered',
    (error: unknown) => error,
  );
}

/**
 * A worker that answers every job with the failure a test hands it.
 *
 * @param failure - The `failure` payload, as JSON source
 * @returns The seeded entry's source
 */
function failingWith(failure: string): string {
  return [
    "import { parentPort } from 'node:worker_threads';",
    READY_LINE,
    "parentPort.on('message', (request) => {",
    "  if (request?.type === 'shutdown') { parentPort.close(); return; }",
    `  parentPort.postMessage({ id: request.id, failure: ${failure} });`,
    '});',
  ].join('\n');
}

/** A worker that answers every job with the forbidden-count policy it was started with. */
const ECHOES_COUNT_POLICY = [
  "import { parentPort, workerData } from 'node:worker_threads';",
  READY_LINE,
  "parentPort.on('message', (request) => {",
  "  if (request?.type === 'shutdown') { parentPort.close(); return; }",
  '  parentPort.postMessage({ id: request.id, failure: { message: String(workerData.forbiddenCount) } });',
  '});',
].join('\n');

describe('a parse thread counts no work', () => {
  it('starts each thread with the policy the parent holds at that start', async () => {
    await seedWorkerEntry(ECHOES_COUNT_POLICY);
    __throwOnForbiddenWorkCountForTest();
    onTestFinished(() => {
      __resetWorkCountersForTest();
    });

    const policyOf = async (): Promise<string> => String((await outcomeOf(trackedPool(1), '# a\n') as Error).message);
    expect(await policyOf()).toBe('throw');

    __resetWorkCountersForTest();
    expect(await policyOf()).toBe('report');
  });

  it('parses through a real thread told to throw on a count, so a count there fails the parse', async () => {
    // The parent counts every job a thread runs; a count on the thread itself
    // would reach no dump. The thread is told the parent's policy at start, so
    // with the throw on here, any count it makes fails this parse.
    __throwOnForbiddenWorkCountForTest();
    onTestFinished(() => {
      __resetWorkCountersForTest();
    });
    const pool = trackedPool(1);
    const [fixture] = FIXTURES;
    if (fixture === undefined) throw new Error('no fixture');

    const actual = await pool.parse(fixture.kind, fixture.content, fixture.byteLength);

    expect(actual).toStrictEqual(parseInProcess(fixture));
  });
});

describe('who threw a failure', () => {
  it('revives a throw the worker branded as the parser\'s, its code kept', async () => {
    await seedWorkerEntry(failingWith("{ name: 'TypeError', message: 'bad bytes', code: 'ERR_X', fromDocument: true }"));
    const pool = trackedPool(1);

    const outcome = await outcomeOf(pool, '# a\n');

    expect(isParserThrewError(outcome)).toBe(true);
    expect(outcome).toMatchObject({ name: 'TypeError', message: 'bad bytes', code: 'ERR_X' });
  });

  it('never revives an unbranded failure as the parser\'s', async () => {
    await seedWorkerEntry(failingWith("{ name: 'Error', message: 'could not post the reply' }"));
    const pool = trackedPool(1);

    const outcome = await outcomeOf(pool, '# a\n');

    expect(outcome).toMatchObject({ message: 'could not post the reply' });
    expect(isParserThrewError(outcome)).toBe(false);
  });
});

/**
 * The worker side of the brand. `describeParseFailure` is what both of the
 * worker's catches post, and only the parser's own call is marked.
 */
describe('describeParseFailure', () => {
  it('brands only when told the parser threw it', () => {
    const error = Object.assign(new Error('boom'), { code: 'ERR_B' });

    expect(describeParseFailure(error, true)).toMatchObject({ message: 'boom', code: 'ERR_B', fromDocument: true });
    expect(describeParseFailure(error, false)).not.toHaveProperty('fromDocument');
    expect(describeParseFailure('thrown string', true)).toStrictEqual({ name: 'Error', message: 'thrown string', fromDocument: true });
  });
});

describe('a broken install is loud', () => {
  it('fails every job as parser-unavailable when the worker entry throws as its module loads', async () => {
    await seedWorkerEntry("throw Object.assign(new Error('seeded load failure'), { code: 'ERR_SEEDED_LOAD' });\n");
    const pool = trackedPool(2);

    const outcomes = await Promise.all(['# a\n', '# b\n', '# c\n'].map(async (content) => outcomeOf(pool, content)));

    for (const outcome of outcomes) expect(isParserUnavailable(outcome)).toBe(true);
    expect(String((outcomes[0] as Error).message)).toContain('ERR_SEEDED_LOAD');
  });

  it('calls three consecutive deaths with no answer between them a broken install', async () => {
    await seedWorkerEntry(`import { parentPort } from 'node:worker_threads';\n${READY_LINE}\nparentPort.on('message', (request) => { ${DIES_PARSING} });\n`);
    const pool = trackedPool(1);

    const first = await outcomeOf(pool, '# a\n');
    const second = await outcomeOf(pool, '# b\n');
    const third = await outcomeOf(pool, '# c\n');
    const fourth = await outcomeOf(pool, '# d\n');

    expect([first, second].map((outcome) => isParseWorkerDiedError(outcome))).toStrictEqual([true, true]);
    expect([third, fourth].map((outcome) => isParserUnavailable(outcome))).toStrictEqual([true, true]);
  });

  it('resets the count on any answer between deaths', async () => {
    await seedWorkerEntry([
      "import { parentPort } from 'node:worker_threads';",
      `await import(${JSON.stringify(BUILT_WORKER)});`,
      `parentPort.on('message', (request) => { if (request?.content?.startsWith?.('# DIE')) { ${DIES_PARSING} } });`,
    ].join('\n'));
    const pool = trackedPool(1);

    const outcomes: unknown[] = [];
    for (const content of ['# DIE 1\n', '# DIE 2\n', '# ok\n', '# DIE 3\n', '# DIE 4\n']) outcomes.push(await outcomeOf(pool, content));

    expect(outcomes.map((outcome) => (outcome === 'answered' ? 'answered' : isParseWorkerDiedError(outcome)))).toStrictEqual([
      true,
      true,
      'answered',
      true,
      true,
    ]);
  });

  it('never counts the death of a thread holding no job toward the three', async () => {
    // Each thread answers its document, then dies idle. No document was on it,
    // so no document can have caused it and none may be refused over it: three
    // such deaths are not a broken install, and the next document is parsed.
    await seedWorkerEntry([
      "import { parentPort } from 'node:worker_threads';",
      'const post = parentPort.postMessage.bind(parentPort);',
      'parentPort.postMessage = (message) => {',
      '  post(message);',
      "  if (typeof message?.id === 'number') setTimeout(() => process.exit(1), 50);",
      '};',
      `await import(${JSON.stringify(BUILT_WORKER)});`,
    ].join('\n'));
    const pool = trackedPool(3);
    const exits: Promise<void>[] = [];
    const onWorker = (message: unknown): void => {
      exits.push(new Promise((resolve) => (message as { worker: Worker }).worker.once('exit', () => resolve())));
    };
    diagnosticsChannel.subscribe('worker_threads', onWorker);
    let answers: unknown[];
    try {
      answers = await Promise.all(['# a\n', '# b\n', '# c\n'].map(async (content) => outcomeOf(pool, content)));
      await Promise.all(exits);
    } finally {
      diagnosticsChannel.unsubscribe('worker_threads', onWorker);
    }

    expect({ answers, idleDeaths: exits.length }).toStrictEqual({ answers: ['answered', 'answered', 'answered'], idleDeaths: 3 });
    expect(await outcomeOf(pool, '# d\n')).toBe('answered');
  });

  it('counts a thread stopped before its parser loaded toward the same three, running the document again each time', async () => {
    // A worker that starts and then never loads a parser (a parser import that hangs) is a broken
    // install: without this, each document waits out its whole `timeMs` in turn and is blamed for
    // it. The stop is the thread's, never the document's, so the document runs again on a fresh
    // thread; three stops in a row with no answer between them fail the run loud.
    //
    // 🔑 The clock is the test's (see the next test): the deadline is advanced only once each
    // thread's `ready` has reached the pool, and `performance` is faked with the timers, so the
    // pool never reads the stop as a late parent's.
    vi.useFakeTimers(TEST_CLOCK);
    const entry = await seedWorkerEntry(neverAnswering());
    const pool = createParsePool({ size: 1, limits: { timeMs: 150 } });
    openPools.push(pool);

    const outcomes: unknown[] = [];
    try {
      const outcome = outcomeOf(pool, '# a\n');
      for (let stop = 0; stop < 3; stop += 1) {
        await consumeMarker(readyMarker(entry));
        vi.advanceTimersByTime(150);
      }
      outcomes.push(await outcome);
      // The install is broken by now: no thread starts, so there is nothing to wait for.
      outcomes.push(await outcomeOf(pool, '# b\n'));
    } finally {
      vi.useRealTimers();
    }

    expect(outcomes.map((outcome) => isParserUnavailable(outcome))).toStrictEqual([true, true]);
  });

  it('does not count a time breach on a thread whose parser loaded', async () => {
    // 🔑 The clock is the test's, not the machine's. The pool's deadline is a
    // `setTimeout` armed at dispatch, so with timers faked it fires only when the
    // test advances them — and the test advances them only once the thread has
    // posted `parserLoaded` and the pool has read it. Each thread also takes
    // 350 ms (a real timer, in the worker) to load, past the 300 ms limit: on a
    // real clock a slow load under CI load was charged as a load that never
    // finished, and three of them called the install broken.
    //
    // Three breaches IN A ROW, no answer between them: an answer resets the
    // count, so a run broken up by answers cannot tell counted from uncounted.
    vi.useFakeTimers(TEST_CLOCK);
    const entry = await seedWorkerEntry([
      "import { writeFileSync } from 'node:fs';",
      "import { parentPort } from 'node:worker_threads';",
      // A job posted meanwhile waits in the port: no listener is attached yet.
      'await new Promise((resolve) => setTimeout(resolve, 350));',
      // The real worker's own listener, wrapped: a SLOW document is announced as a
      // loaded parser, as the real worker does before parsing, then blocks the thread
      // unanswered. The marker is written AFTER the post, so seeing it means the post is queued.
      'const on = parentPort.on.bind(parentPort);',
      "parentPort.on = (event, listener) => on(event, event === 'message' ? (request) => {",
      "  if (!request?.content?.startsWith?.('# SLOW')) return listener(request);",
      '  parentPort.postMessage({ id: request.id, parserLoaded: request.kind });',
      "  writeFileSync(new URL(`./${request.content.trim().replace('# ', '').replace(' ', '-')}`, import.meta.url), '');",
      '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
      '} : listener);',
      `await import(${JSON.stringify(BUILT_WORKER)});`,
    ].join('\n'));
    const pool = createParsePool({ size: 1, limits: { timeMs: 300 } });
    openPools.push(pool);

    const outcomes: unknown[] = [];
    try {
      for (const content of ['# SLOW 1\n', '# SLOW 2\n', '# SLOW 3\n', '# ok\n']) {
        const outcome = outcomeOf(pool, content);
        if (content.startsWith('# SLOW')) {
          await announcedParserLoaded(safePath.join(safePath.resolve(entry, '..'), content.trim().replace('# ', '').replace(' ', '-')));
          vi.advanceTimersByTime(300);
        }
        outcomes.push(await outcome);
      }
    } finally {
      vi.useRealTimers();
    }

    expect(outcomes.map((outcome) => (isParseLimitError(outcome) ? outcome.limit : outcome))).toStrictEqual([
      'timeMs', 'timeMs', 'timeMs', 'answered',
    ]);
  });
});

/**
 * Wait, on no clock, until a seeded thread's `parserLoaded` has reached the pool.
 *
 * The thread writes `marker` after posting it, so once the marker exists the
 * message is in the port's queue; the port delivers its queue in the poll phase,
 * which every turn of the loop below passes through before its `setImmediate`.
 *
 * @param marker - The file the thread writes after its post
 */
async function announcedParserLoaded(marker: string): Promise<void> {
  while (!(await fs.stat(marker).then(() => true, () => false))) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));
}

/** The timers and clock a test drives by hand: the pool's deadline, its heap sampler, and the clock it judges lateness on. */
const TEST_CLOCK = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] } as const satisfies Parameters<typeof vi.useFakeTimers>[0];

/**
 * @param entry - A seeded worker entry
 * @returns The marker {@link announcingReady} writes beside it
 */
function readyMarker(entry: string): string {
  return safePath.join(safePath.resolve(entry, '..'), 'ready');
}

/**
 * A seeded worker that posts `ready`, then writes {@link readyMarker} — after
 * the post, so seeing the marker means `ready` is in the port — and never answers.
 *
 * @returns The entry's source
 */
function neverAnswering(): string {
  return [
    "import { writeFileSync } from 'node:fs';",
    "import { parentPort } from 'node:worker_threads';",
    READY_LINE,
    "writeFileSync(new URL('./ready', import.meta.url), '');",
    "parentPort.on('message', () => undefined);",
  ].join('\n');
}

/**
 * Wait, on no clock, until `marker` exists and the post before it has reached
 * the pool, then remove it, so the next thread's marker is its own.
 *
 * @param marker - A file a seeded thread writes after a post
 */
async function consumeMarker(marker: string): Promise<void> {
  await announcedParserLoaded(marker);
  await fs.rm(marker);
}

/**
 * Block this thread — the pool's own — until `done` holds, as a parent busy
 * with synchronous work does. Bounded, so a seed that never satisfies it fails
 * loud instead of hanging the suite.
 *
 * @param done - Read on every spin
 */
function blockUntil(done: () => boolean): void {
  const giveUpAt = performance.now() + 30_000;
  while (!done()) {
    if (performance.now() > giveUpAt) throw new Error('blockUntil: the condition never held');
  }
}

describe('a parent late to its own deadline', () => {
  it('admits a document whose answer was already in the port when the late deadline fired', async () => {
    // The parent blocks past `timeMs` while a fast document is in flight; by the
    // time its loop turns, the timer is due AND the answer is queued. The timers
    // phase runs before the poll phase that delivers the port, so a deadline that
    // decides at once refuses a document that was answered in time.
    const entry = await seedWorkerEntry([
      "import { writeFileSync } from 'node:fs';",
      "import { parentPort } from 'node:worker_threads';",
      'const post = parentPort.postMessage.bind(parentPort);',
      "parentPort.postMessage = (message, transfer) => { post(message, transfer); if (typeof message?.id === 'number') writeFileSync(new URL('./answered', import.meta.url), ''); };",
      `await import(${JSON.stringify(BUILT_WORKER)});`,
    ].join('\n'));
    const answered = safePath.join(safePath.resolve(entry, '..'), 'answered');
    const pool = createParsePool({ size: 1, limits: { timeMs: 200 } });
    openPools.push(pool);

    const outcome = outcomeOf(pool, '# ok\n');
    const dispatchedAt = performance.now();
    blockUntil(() => existsSync(answered) && performance.now() > dispatchedAt + 400);

    expect(await outcome).toBe('answered');
  });

  it('never counts a stop it made late toward the broken-install breaker', async () => {
    // A thread that never loads its parser, stopped at `timeMs`, counts toward the three — but
    // only when the parent read the clock on time. A parent this late was starved itself; the
    // thread it judged may have been starved by the same load. The document runs again each time,
    // and after three late stops it ends as a parser-unavailable error of its own, never charged to
    // the document, so a starved host still terminates (I8); the pool is not judged broken, so the
    // next document reaches a thread of its own — started once an `answer` marker exists, which
    // answers at once (no real parser loads within this pool's 100 ms). Counted, the late stops
    // would have judged the pool broken, and the next document refused with no thread started.
    // Its own clock is real time: a runner too loaded to start a thread in 100 ms stops it on
    // time, three times, and that run is the breaker's to count — so the next document is judged
    // by the threads it reached, never by the machine's speed.
    const entry = await seedWorkerEntry([
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { parentPort } from 'node:worker_threads';",
      "if (existsSync(new URL('./answer', import.meta.url))) {",
      `  ${READY_LINE}`,
      "  parentPort.on('message', (request) => {",
      "    if (request?.type === 'shutdown') { parentPort.close(); return; }",
      "    parentPort.postMessage({ id: request.id, failure: { name: 'Error', message: 'seeded answer' } });",
      '  });',
      '} else {',
      `  ${READY_LINE}`,
      "  writeFileSync(new URL('./ready', import.meta.url), '');",
      "  parentPort.on('message', () => undefined);",
      '}',
    ].join('\n'));
    const pool = createParsePool({ size: 1, limits: { timeMs: 100 } });
    openPools.push(pool);

    // A stopped thread holds its slot until its `exit`, which needs the loop to turn: the
    // document is dispatched again only once the last thread is gone, so the pool spawns its
    // replacement at once and the block below cannot starve it.
    const exits: Promise<void>[] = [];
    const onWorker = (message: unknown): void => {
      exits.push(new Promise((resolve) => (message as { worker: Worker }).worker.once('exit', () => resolve())));
    };
    diagnosticsChannel.subscribe('worker_threads', onWorker);
    let outcome: unknown;
    try {
      const pending = outcomeOf(pool, '# a\n');
      for (let stop = 0; stop < 3; stop += 1) {
        const startedAt = performance.now();
        // Ready first, so the stop is the late parent's alone. The marker is removed before the
        // loop turns, while the stop has not happened yet, so the next marker is the next thread's.
        blockUntil(() => existsSync(readyMarker(entry)) && performance.now() > startedAt + 600);
        // Still blocked: the marker goes, and this thread's exit is taken, before the loop turns.
        rmSync(readyMarker(entry));
        const exited = exits.at(-1);
        await exited;
      }
      outcome = await pending;
    } finally {
      diagnosticsChannel.unsubscribe('worker_threads', onWorker);
    }
    await fs.writeFile(safePath.join(safePath.resolve(entry, '..'), 'answer'), '');

    expect(verdictOf(outcome)).toBe('unavailable');
    expect(outcome instanceof Error && outcome.message).toMatch(/could not start within 100 ms on 3 threads in a row/);
    let started = 0;
    const onNext = (): void => {
      started += 1;
    };
    diagnosticsChannel.subscribe('worker_threads', onNext);
    let next: unknown;
    try {
      next = await outcomeOf(pool, '# b\n');
    } finally {
      diagnosticsChannel.unsubscribe('worker_threads', onNext);
    }
    // Answered on a thread of its own; or, on a runner too loaded to start one in 100 ms, refused
    // by the breaker only after three threads of its own were stopped on time.
    if (next instanceof Error && next.message === 'seeded answer') {
      expect(started).toBeGreaterThanOrEqual(1);
    } else {
      expect(verdictOf(next)).toBe('unavailable');
      expect(started).toBe(3);
    }
  });
});

describe('a thread V8 stops at its own heap ceiling', () => {
  it('names V8\'s ceiling as the last sample read it, never the bound the sampler did not stop it at', async () => {
    // The thread dies as V8 kills a thread at its ceiling, but only once a heap
    // sample has landed and the pool has learned the bound it enforces: the
    // test watches the sampler's own call and lets the thread die after it (a
    // marker the thread polls for). The sampler never stopped it, so a refusal
    // naming the sampler's bound names a limit that did not apply. The bounds
    // are read off the sample the test watched land, never assumed from 1,024
    // MiB: a process-wide `--max-old-space-size` (CI sets 512) lowers them.
    const entry = await seedWorkerEntry([
      "import { existsSync } from 'node:fs';",
      "import { parentPort } from 'node:worker_threads';",
      READY_LINE,
      "const die = new URL('./die', import.meta.url);",
      "parentPort.on('message', (request) => { parentPort.postMessage({ id: request.id, parserLoaded: request.kind }); const poll = setInterval(() => { if (!existsSync(die)) return; clearInterval(poll); const error = new Error('out of memory'); error.code = 'ERR_WORKER_OUT_OF_MEMORY'; throw error; }, 5); });",
    ].join('\n'));
    let landed: HeapBounds | undefined;
    const sample = Worker.prototype.getHeapStatistics;
    const spy = vi.spyOn(Worker.prototype, 'getHeapStatistics').mockImplementation(function (this: Worker) {
      // The young generation is read while the thread lives: once it has exited `resourceLimits`
      // is empty, and a sample landing after the death (one the pool ignores) would read 0.
      const geometry = workerHeapGeometry(this.resourceLimits, v8HeapFlags(process.env['NODE_OPTIONS'], process.execArgv));
      // Recorded a turn later, so the pool's own `then`, chained after this one, has run. Only
      // the first sample counts: every in-job sample carries the same bounds (the young
      // generation is fixed at spawn and nothing raises `heap_size_limit`), and a later one may
      // land after the thread is gone.
      return sample.call(this).then((stats) => {
        setImmediate(() => {
          landed ??= heapBounds(stats, geometry, resolveParseLimits(undefined).heapMb);
        });
        return stats;
      });
    });
    const pool = heapTestPool();

    try {
      const refusal = pool.parse('markdown', '# hi\n', 5).then(() => undefined, (error: unknown) => error);
      await vi.waitFor(() => {
        expect(landed).toBeDefined();
      }, { timeout: 60_000, interval: 5 });
      await fs.writeFile(safePath.join(safePath.resolve(entry, '..'), 'die'), '');
      const bound = await refusal.then((error) => (isParseLimitError(error) && error.limit === 'heapMb' ? error.bound : error));

      expect(bound).toBe(ParseLimitError.heapCeiling(landed, resolveParseLimits(undefined).heapMb).bound);
      expect(bound).toMatch(/^V8's own heap ceiling, \d+ MiB heap — above the \d+ MiB the pool's heap sampler enforces/);
    } finally {
      spy.mockRestore();
    }
  });
});

const BYTES_PER_MIB = 1_048_576;

/** V8's ceiling an unflagged thread reads: a test's heap shape must not depend on the tier's `--max-old-space-size`. */
const UNFLAGGED = { ceilingMb: workerHeapCeilingMb(resolveParseLimits(undefined).heapMb) };

/**
 * Samples served past the end of a script before the job counts as undecided.
 * Counted in samples, never in wall clock, so a slow box cannot trip it.
 */
const UNDECIDED_AFTER_SAMPLES = 20;

/**
 * V8's ceiling a scripted heap reports: what the thread really reads, or a
 * fixed one. A process-wide `--max-old-space-size` (the Windows unit tier sets
 * 512) lowers the real one, and a young generation the Node version sizes
 * (on Node 26.7, 192 or 96 MiB by host; 192 on Node 24) decides whether a scripted shape fits
 * under it at all.
 */
type ScriptedCeiling = 'as-read' | { readonly ceilingMb: number };

/** What a scripted heap observed, read once the job has settled. */
interface ScriptedHeap {
  /** Samples served. */
  served: () => number;
  /** The bounds the script was written against. */
  bounds: () => HeapBounds | undefined;
  /** Why the script could not decide the job, if it could not: see {@link scriptedHeap}. */
  undecided: () => string | undefined;
}

/**
 * Serve every heap sample with a scripted used heap, under V8's bounds as
 * {@link ScriptedCeiling} names them.
 *
 * The script starts once the pool has taken the job's `parserLoaded` from a thread spawned under
 * it (until then each sample reads an empty heap): a breach on the job's load clock is the
 * thread's, never the document's, so a script served then would test the wrong clock.
 *
 * ⛔ Nothing here may throw into the pool: it treats a failed sample as a
 * thread already gone and ignores it, so an assertion thrown in a sample is
 * swallowed and the job waits forever. A script that refuses the bounds it was
 * given, or a pool still undecided {@link UNDECIDED_AFTER_SAMPLES} samples past
 * the script's end, is recorded instead, and every later sample serves a heap
 * past any stop so the job settles and the pool can shut down;
 * {@link heapRefusalUnder} then fails with the recorded reason.
 *
 * @param script - The used heap, in MiB, for each sample in turn (the last repeats), given the bounds the
 *   first sample reads
 * @param ceiling - See {@link ScriptedCeiling}
 * @returns What the scripted heap observed
 */
function scriptedHeap(script: (bounds: HeapBounds, youngMb: number) => number[], ceiling: ScriptedCeiling): ScriptedHeap {
  const sample = Worker.prototype.getHeapStatistics;
  let served = 0;
  let read: HeapBounds | undefined;
  let undecided: string | undefined;
  let usedMb: number[] = [];
  const loading = parserLoadedWatch();
  vi.spyOn(Worker.prototype, 'getHeapStatistics').mockImplementation(function (this: Worker) {
    return sample.call(this).then((stats) => {
      const geometry = workerHeapGeometry(this.resourceLimits, v8HeapFlags(process.env['NODE_OPTIONS'], process.execArgv));
      const youngMb = geometry.youngMb;
      const limitBytes = ceiling === 'as-read' ? stats.heap_size_limit : (ceiling.ceilingMb + youngMb) * BYTES_PER_MIB;
      if (loading(this)) return { ...stats, heap_size_limit: limitBytes, used_heap_size: 0 };
      if (read === undefined) {
        read = heapBounds({ heap_size_limit: limitBytes }, geometry, resolveParseLimits(undefined).heapMb);
        try {
          usedMb = script(read, youngMb);
        } catch (error) {
          undecided = `the script refused the bounds it read (${JSON.stringify(read)}, young ${youngMb} MiB): ${String(error)}`;
        }
      }
      if (undecided === undefined && served >= usedMb.length + UNDECIDED_AFTER_SAMPLES) {
        undecided = `the pool was still undecided ${UNDECIDED_AFTER_SAMPLES} samples past a ${usedMb.length}-sample script`;
      }
      const usedBytes = undecided === undefined ? (usedMb[Math.min(served, usedMb.length - 1)] ?? 0) * BYTES_PER_MIB : limitBytes;
      served += 1;
      return { ...stats, heap_size_limit: limitBytes, used_heap_size: usedBytes };
    });
  });
  return { served: () => served, bounds: () => read, undecided: () => undecided };
}

/**
 * Watch each thread spawned from here on for a `parserLoaded`, seen only once the pool's own
 * listener (registered first, so called first) has taken it.
 *
 * @returns Whether a thread is still loading its job's parser: false for one spawned before the watch
 */
function parserLoadedWatch(): (worker: Worker) => boolean {
  const watched = new WeakSet<Worker>();
  const loaded = new WeakSet<Worker>();
  const on = Worker.prototype.on;
  vi.spyOn(Worker.prototype, 'on').mockImplementation(function (this: Worker, event: string | symbol, listener: (...args: any[]) => void) {
    on.call(this, event, listener);
    if (event === 'message' && !watched.has(this)) {
      watched.add(this);
      on.call(this, 'message', (message: { parserLoaded?: unknown }) => {
        if (message.parserLoaded !== undefined) loaded.add(this);
      });
    }
    return this;
  });
  return (worker) => watched.has(worker) && !loaded.has(worker);
}

/**
 * One job on a thread that never answers, under a scripted heap ({@link scriptedHeap}).
 *
 * @param script - See {@link scriptedHeap}
 * @param ceiling - See {@link ScriptedCeiling}
 * @returns The heap refusal's bound (or the outcome, if not one), the samples served, and the bounds read
 * @throws When the scripted heap could not decide the job — see {@link scriptedHeap}
 */
async function heapRefusalUnder(
  script: (bounds: HeapBounds, youngMb: number) => number[],
  ceiling: ScriptedCeiling,
): Promise<{ bound: unknown; served: number; bounds: HeapBounds | undefined }> {
  await seedWorkerEntry([
    "import { parentPort } from 'node:worker_threads';",
    READY_LINE,
    "parentPort.on('message', (request) => { parentPort.postMessage({ id: request.id, parserLoaded: request.kind }); });",
  ].join('\n'));
  const heap = scriptedHeap(script, ceiling);
  try {
    const outcome = await outcomeOf(heapTestPool(), '# hi\n');
    const undecided = heap.undecided();
    if (undecided !== undefined) throw new Error(`The scripted heap did not decide the job: ${undecided}`);
    return {
      bound: isParseLimitError(outcome) && outcome.limit === 'heapMb' ? outcome.bound : outcome,
      served: heap.served(),
      bounds: heap.bounds(),
    };
  } finally {
    vi.restoreAllMocks();
  }
}

/**
 * `args` without a V8 heap flag, in either form: `--flag=<n>`, or `--flag <n>` (its value the next
 * token). Self-contained, taking its reader as a parameter: its source runs in a seeded thread
 * too ({@link withoutHeapFlags}).
 *
 * @param args - Command-line arguments
 * @param read - {@link v8HeapFlags}
 * @returns The arguments no heap flag reader takes a flag from
 */
function withoutHeapFlagArgs(args: readonly string[], read: typeof v8HeapFlags): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const next = args[index + 1] ?? '';
    const flags = (pair: readonly string[]): boolean => Object.values(read(undefined, pair)).some((value) => value !== undefined);
    if (!flags([arg, next]) || flags([next])) {
      kept.push(arg);
      continue;
    }
    if (!arg.includes('=')) index += 1;
  }
  return kept;
}

/** Whether a seeded thread starts with the process's heap flags hidden: see {@link withoutHeapFlags}. */
let threadsWithoutHeapFlags = false;

/**
 * Hide the process's V8 heap flags, for each test of the calling `describe`, from the reads a test
 * scripts — the pool's flag read (`#heapFlags`, read as it is built), the scripted sampler, and
 * every seeded thread ({@link seedWorkerEntry}), whose entry clears them before the real worker
 * loads: a `Worker` copies the process's ORIGINAL `execArgv`, never the parent's rewritten array.
 * Nothing else: a real `heap_size_limit` the parent reads unscripted still reflects the flag. So
 * a test seeded with an unflagged thread's ceiling is judged against that ceiling alone. The Windows
 * unit tier forks under `--max-old-space-size=512` (its `execArgv`), which the fail-closed ceiling
 * would otherwise take: there the stop sits 128 MiB above the bound and the reused-thread bound is
 * 56 MiB, not 152.
 */
function withoutHeapFlags(): void {
  beforeEach(() => {
    const execArgv = process.execArgv;
    vi.stubEnv('NODE_OPTIONS', '');
    process.execArgv = withoutHeapFlagArgs(execArgv, v8HeapFlags);
    threadsWithoutHeapFlags = true;
    onTestFinished(() => {
      process.execArgv = execArgv;
      threadsWithoutHeapFlags = false;
      vi.unstubAllEnvs();
    });
  });
}

describe('the heap flags a test hides', () => {
  it('are dropped in either form, a flag\'s separate value with it, and nothing else', () => {
    expect(withoutHeapFlagArgs(
      ['--max-old-space-size=512', '--expose-gc', '--max-semi-space-size', '16', '--max_heap_size', '--conditions=x'],
      v8HeapFlags,
    )).toStrictEqual(['--expose-gc', '--max_heap_size', '--conditions=x']);
  });
});

describe('a heap past its bound', () => {
  withoutHeapFlags();

  it('is not stopped while it rises, only once a fall too deep for a scavenge shows what it still holds', async () => {
    // V8's ceiling is fixed at what an unflagged thread reads, the process's heap flags hidden
    // ({@link withoutHeapFlags}): under a 512 MiB flag Node 24's 192 MiB young generation would
    // leave no rise below the stop that a fall deeper than a scavenge can come back from.
    const { bound, served, bounds } = await heapRefusalUnder(({ appliedMb, stopMb }, youngMb) => {
      // The rise must stay below the stop, or the stop decides instead.
      expect(appliedMb + youngMb + 4).toBeLessThan(stopMb);
      return [appliedMb + 1, appliedMb + youngMb + 2, appliedMb + youngMb + 4, appliedMb + 1];
    }, UNFLAGGED);

    expect(bound).toBe(ParseLimitError.heap(bounds?.appliedMb ?? 0, resolveParseLimits(undefined).heapMb).bound);
    expect(served).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it('is stopped once the used heap passes the stop with no fall at all, and not a sample before', async () => {
    const { bound, served, bounds } = await heapRefusalUnder(({ appliedMb, stopMb }) => [appliedMb + 1, stopMb, stopMb + 1], 'as-read');

    expect(bound).toBe(ParseLimitError.heap(bounds?.appliedMb ?? 0, resolveParseLimits(undefined).heapMb).bound);
    expect(served).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('judges a job on a reused thread on the same stop as a fresh thread\'s, and not a sample before', async () => {
    const { pool } = await reusedHeapTestPool();
    const heap = scriptedHeap(({ appliedMb, stopMb }) => [appliedMb + 1, stopMb, stopMb + 1], 'as-read');

    const outcome = await outcomeOf(pool, '# held\n');

    expect(heap.undecided()).toBeUndefined();
    const expected = ParseLimitError.heap(heap.bounds()?.appliedMb ?? 0, resolveParseLimits(undefined).heapMb);
    expect(isParseLimitError(outcome) ? [outcome.limit, outcome.bound] : outcome).toStrictEqual(['heapMb', expected.bound]);
    expect(heap.served()).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('samples no job on a reused thread before the thread has settled its heap', async () => {
    // The thread's report is held: however long the parent's clock runs, the job is not sampled —
    // a sample then would read what an earlier job left. (That it is sampled once the report lands
    // is the same-stop test above, whose reused-thread job only a sample can stop.)
    const { pool, release } = await reusedHeapTestPool();
    const sample = vi.spyOn(Worker.prototype, 'getHeapStatistics');
    vi.useFakeTimers(TEST_CLOCK);
    let outcome: Promise<unknown>;
    try {
      outcome = outcomeOf(pool, '# check-held\n');
      vi.advanceTimersByTime(HEAP_SAMPLE_INTERVAL_MS * 10);
    } finally {
      vi.useRealTimers();
    }
    expect(sample).not.toHaveBeenCalled();

    await fs.writeFile(release, '');
    expect(await outcome).toBe('answered');
  }, 60_000);

  it('collects a reused thread holding garbage past the bound with a real full collection, and keeps it', async () => {
    // Real garbage, really collected: 200 MiB of large arrays, dropped just before the check, which
    // no scavenge reaches — past the 152 MiB bound on any thread. The thread is kept, and what it
    // holds after is within the bound.
    const { pool } = await reusedHeapTestPool();

    const { started, reuse } = await reuseChecksOf(async () => {
      expect(await outcomeOf(pool, '# garbage=200\n')).toBe('answered');
    });

    expect(started).toHaveLength(0);
    expect(reuse.rows).toStrictEqual({ check: 1, collect: 1, retire: 0 });
    expect(reuse.settledMibMax).toBeGreaterThan(0);
    expect(reuse.settledMibMax).toBeLessThanOrEqual(REUSED_BOUND_MB);
  }, 60_000);

  it('keeps a reused thread holding exactly the bound without collecting it, and runs the job on it', async () => {
    const { pool } = await reusedHeapTestPool();

    const { started, reuse } = await reuseChecksOf(async () => {
      expect(await outcomeOf(pool, `# heap=${String(REUSED_BOUND_MB * BYTES_PER_MIB)}\n`)).toBe('answered');
    });

    expect(started).toHaveLength(0);
    expect(reuse.rows).toStrictEqual({ check: 1, collect: 0, retire: 0 });
  }, 60_000);

  it('retires a reused thread still holding 1 byte past the bound after a collection, and runs the job on a fresh one', async () => {
    const { pool } = await reusedHeapTestPool();

    const { started, reuse } = await reuseChecksOf(async () => {
      expect(await outcomeOf(pool, `# heap=${String(REUSED_BOUND_MB * BYTES_PER_MIB + 1)}\n`)).toBe('answered');
    });

    expect(started).toHaveLength(1);
    expect(reuse.rows).toStrictEqual({ check: 1, collect: 1, retire: 1 });
  }, 60_000);

  it('checks a thread adopted from the parked set as a reused one', async () => {
    // Parked by one pool, adopted by the next: it carries what the first pool's jobs left, so its
    // first job here is checked, and a thread still past the bound is retired.
    await seedScriptedHeapEntry();
    stubParkingMachine();
    await parkOne(HEAP_TEST_POOL_OPTIONS);
    vi.restoreAllMocks();
    const pool = heapTestPool();

    const { started, reuse } = await reuseChecksOf(async () => {
      expect(await outcomeOf(pool, `# heap=${String(REUSED_BOUND_MB * BYTES_PER_MIB + 1)}\n`)).toBe('answered');
    });

    expect(started).toHaveLength(1);
    expect(reuse.rows).toStrictEqual({ check: 1, collect: 1, retire: 1 });
  }, 60_000);

  it('runs a job a reused thread was retired under only on a fresh thread, and lets the jobs behind it use an idle one meanwhile', async () => {
    // Two reused threads. The first job's thread is retired; the second holds the other thread
    // until released. Its retired thread's exit is held too, so the fresh job waits with an idle
    // reused thread beside it: that thread is not closed while another is still terminating, and
    // the job queued behind runs on it. Then the exit lands and the job gets a fresh thread.
    const { pool, release } = await reusedHeapTestPool(2);
    const exits = holdTerminations();
    const posted = vi.spyOn(Worker.prototype, 'postMessage');

    const started = await startedThreads(async () => {
      const retired = settledLater(outcomeOf(pool, `# heap=${String(REUSED_BOUND_MB * BYTES_PER_MIB + 1)}\n`));
      const held = outcomeOf(pool, '# held\n');
      const behind = settledLater(outcomeOf(pool, '# behind\n'));
      try {
        await until(() => exits.held() === 1);
        await fs.writeFile(release, '');
        expect(await held).toBe('answered');
        // The pump runs as that answer settles its job, before this await resumes: whatever it
        // dispatched or closed for that answer, it already has.
        expect(exits.held()).toBe(1);
        expect(posted.mock.calls.some(([message]) => (message as { content?: unknown } | undefined)?.content === '# behind\n')).toBe(true);
        expect(await behind.outcome).toBe('answered');
        expect(retired.settled()).toBeUndefined();
      } finally {
        exits.release();
      }
      expect(await retired.outcome).toBe('answered');
    });

    expect(started).toHaveLength(1);
  }, 60_000);
});

describe('a reused thread\'s check before its job', () => {
  withoutHeapFlags();

  it('is charged to no document\'s time limit: the parse clock starts once the check keeps the thread', async () => {
    // The check is held for 60% of `timeMs` from dispatch — the time a slow forced collection takes
    // — and the answer for 60% more: past `timeMs` from dispatch, within it from the check.
    const { pool, release } = await reusedHeapTestPool();
    const checks = reuseChecksSeen();
    vi.useFakeTimers(TEST_CLOCK);
    let outcome: Promise<unknown>;
    try {
      outcome = outcomeOf(pool, '# check-held answer-late\n');
      vi.advanceTimersByTime(HEAP_DECISION_BACKSTOP_MS * 0.6);
      await fs.writeFile(release, '');
      await until(() => checks() === 1);
      vi.advanceTimersByTime(HEAP_DECISION_BACKSTOP_MS * 0.6);
      // A clock that came due runs its decision a phase later (`#armClock`): let it.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      vi.useRealTimers();
    }
    await fs.writeFile(safePath.join(safePath.resolve(release, '..'), 'release-answer'), '');

    expect(await outcome).toBe('answered');
  }, 60_000);

  it('retires a thread with no collector past the reused-thread bound, and warns once, on a runtime that refuses the flag a collector needs', async () => {
    // `v8.setFlagsFromString` throws, as a runtime that forbids it would: the thread loads with no
    // collector. Held to its stop instead, a reused thread could carry up to the stop of earlier
    // jobs' garbage into a verdict; it is retired at the reused-thread bound, its job on a fresh
    // thread — a thread start, never a verdict — and the run is told once. A process run with
    // `--expose-gc` would leave `gc` on the thread's global, which is used: cleared (writable,
    // never configurable, so assigned rather than deleted).
    await seedScriptedHeapEntry([
      'globalThis.gc = undefined;',
      "v8.setFlagsFromString = () => { throw new Error('flags are not settable here'); };",
    ]);
    const warnings = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const pool = heapTestPool();
    expect(await outcomeOf(pool, '# earlier\n')).toBe('answered');

    const { started, reuse } = await reuseChecksOf(async () => {
      expect(await outcomeOf(pool, '# garbage=200\n')).toBe('answered');
    });

    expect(started).toHaveLength(1);
    expect(reuse.rows).toStrictEqual({ check: 1, collect: 0, retire: 1 });
    expect(warnings.mock.calls.filter(([message]) => String(message).includes('no full collection'))).toHaveLength(1);
  }, 60_000);

  it.each(['exit', 'oom'])('runs a job whose reused thread died before its check (%s) on a fresh thread, charged to no document', async (how) => {
    // The thread ran no parser for the job: its first post is its check, and it never made it.
    const { pool } = await reusedHeapTestPool();

    const started = await startedThreads(async () => {
      expect(await outcomeOf(pool, `# die-before-check=${how}\n`)).toBe('answered');
    });

    expect(started).toHaveLength(1);
  }, 60_000);

  it('never counts a thread lost in its heap check among the job\'s load stops, so two later losses still leave it a third thread', async () => {
    // Lost in its reused thread's check, then on two fresh threads before the parser loads: a
    // check loss counted would make three, and end the job as a broken install.
    const { pool } = await reusedHeapTestPool();

    const started = await startedThreads(async () => {
      expect(await outcomeOf(pool, '# die-before-check=exit die-loading=2\n')).toBe('answered');
    });

    expect(started).toHaveLength(3);
  }, 60_000);
});

/**
 * Count the reused-thread checks the pool has been handed, from now on.
 *
 * @returns How many have reached the pool: each counted once the pool's own listener has run
 */
function reuseChecksSeen(): () => number {
  let seen = 0;
  const emit = Worker.prototype.emit;
  vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event: string | symbol, ...args: unknown[]) {
    const handled = emit.call(this, event, ...args);
    const [message] = args;
    if (event === 'message' && typeof message === 'object' && message !== null && 'reuseCheck' in message) seen += 1;
    return handled;
  });
  return () => seen;
}

/** What a reused thread on a scripted heap worker may hold ({@link seedScriptedHeapEntry}): 152 MiB. */
const REUSED_BOUND_MB = reusedThreadHeapMb(resolveParseLimits(undefined).heapMb);

/**
 * Seed a worker that runs the real one, scripted by each job's content:
 *
 * - `heap=<bytes>` — the thread's own `v8.getHeapStatistics()` reports that much used heap from
 *   this job on, so the check a reused thread makes before the job (`settleReusedHeap`) reads it,
 *   before and after its collection alike. Absent, the real heap is read.
 * - `garbage=<MiB>` — that much garbage (large arrays, which no scavenge reaches) is allocated and
 *   dropped just before the job, so the check finds a heap only a full collection brings down.
 * - `held` — the job's answer is posted only once a `release` marker exists: the thread has
 *   settled its heap and run the job, and the job stays under the parent's heap sampler for as long
 *   as the test says, never as long as the machine takes.
 * - `check-held` — everything the thread posts for the job, its report of its settled heap first,
 *   is posted only once the marker exists.
 * - `answer-late` — the job's answer (never its check) is posted only once a `release-answer`
 *   marker exists too.
 * - `die-before-check=exit|oom` — handed the job as a reused thread, the thread dies before it
 *   checks its heap: it exits, or throws V8's out-of-memory error.
 * - `die-loading=<n>` — handed the job as a fresh thread, the thread exits before it loads a
 *   parser, on the first `n` fresh threads the job reaches (counted in a file beside the entry).
 *
 * Its own `heap_size_limit` always reads as an unflagged thread's; seeded under
 * {@link withoutHeapFlags}, whose entry clears the process's heap flags in the thread itself before
 * the real worker reads them, the bound it settles to is {@link REUSED_BOUND_MB}. Seeded without
 * it, under a process heap flag, the fail-closed ceiling takes the flag, and the bound is lower.
 *
 * @param preamble - Statements run before the real worker loads, after the imports above
 * @returns The `release` marker's path (absent on return); `release-answer` sits beside it
 */
async function seedScriptedHeapEntry(preamble: readonly string[] = []): Promise<string> {
  const entry = await seedWorkerEntry([
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "import v8 from 'node:v8';",
    "import { parentPort, resourceLimits } from 'node:worker_threads';",
    ...preamble,
    "const release = new URL('./release', import.meta.url);",
    "const releaseAnswer = new URL('./release-answer', import.meta.url);",
    "const loadingDeaths = new URL('./loading-deaths', import.meta.url);",
    'const read = v8.getHeapStatistics;',
    `const ceilingBytes = (${String(UNFLAGGED.ceilingMb)} + (resourceLimits.maxYoungGenerationSizeMb ?? 0)) * ${String(BYTES_PER_MIB)};`,
    'let usedBytes;',
    'v8.getHeapStatistics = () => ({ ...read(), heap_size_limit: ceilingBytes, ...(usedBytes === undefined ? {} : { used_heap_size: usedBytes }) });',
    'const held = new Set();',
    'const checkHeld = new Set();',
    'const answerLate = new Set();',
    'const post = parentPort.postMessage.bind(parentPort);',
    'parentPort.postMessage = (message) => {',
    "  const check = typeof message === 'object' && message !== null && 'reuseCheck' in message;",
    '  const markers = [];',
    '  if (checkHeld.has(message?.id) || (held.has(message?.id) && !check)) markers.push(release);',
    '  if (answerLate.has(message?.id) && !check) markers.push(releaseAnswer);',
    '  if (markers.length === 0) return post(message);',
    '  const poll = setInterval(() => { if (!markers.every((marker) => existsSync(marker))) return; clearInterval(poll); post(message); }, 5);',
    '};',
    'const on = parentPort.on.bind(parentPort);',
    "parentPort.on = (event, listener) => on(event, event === 'message' ? (request) => {",
    "  if (request?.type === 'shutdown') return listener(request);",
    String.raw`  const dies = /die-before-check=(exit|oom)/.exec(request.content);`,
    '  if (dies !== null && request.settleHeap) {',
    "    if (dies[1] === 'exit') process.exit(3);",
    "    const error = new Error('out of memory');",
    "    error.code = 'ERR_WORKER_OUT_OF_MEMORY';",
    '    throw error;',
    '  }',
    String.raw`  const diesLoading = /die-loading=(\d+)/.exec(request.content);`,
    '  if (diesLoading !== null && !request.settleHeap) {',
    "    const died = existsSync(loadingDeaths) ? Number(readFileSync(loadingDeaths, 'utf8')) : 0;",
    '    if (died < Number(diesLoading[1])) {',
    '      writeFileSync(loadingDeaths, String(died + 1));',
    '      process.exit(3);',
    '    }',
    '  }',
    String.raw`  const scripted = /heap=(\d+)/.exec(request.content);`,
    '  usedBytes = scripted === null ? undefined : Number(scripted[1]);',
    String.raw`  const garbage = /garbage=(\d+)/.exec(request.content);`,
    '  if (garbage !== null) {',
    '    let keep = [];',
    '    for (let mib = 0; mib < Number(garbage[1]); mib += 1) keep.push(new Array(131_072).fill(mib));',
    '    keep = null;',
    '  }',
    "  if (request.content.includes('check-held')) checkHeld.add(request.id);",
    "  else if (request.content.includes('held')) held.add(request.id);",
    "  if (request.content.includes('answer-late')) answerLate.add(request.id);",
    '  listener(request);',
    '} : listener);',
    `await import(${JSON.stringify(BUILT_WORKER)});`,
  ].join('\n'));
  return safePath.join(safePath.resolve(entry, '..'), 'release');
}

/**
 * A heap-test pool ({@link heapTestPool}) whose every thread has answered one job, so its next
 * job lands on a reused thread, on a seeded worker scripted by each job's content
 * ({@link seedScriptedHeapEntry}).
 *
 * @param size - The pool's threads, each reused on return
 * @returns The pool, and the `release` marker's path (absent on return)
 */
async function reusedHeapTestPool(size = 1): Promise<{ pool: ParsePool; release: string }> {
  const release = await seedScriptedHeapEntry();
  const pool = heapTestPool(size);
  const earlier = await Promise.all(Array.from({ length: size }, async (_, index) => outcomeOf(pool, `# earlier ${String(index)}\n`)));
  expect(earlier).toStrictEqual(Array.from({ length: size }, () => 'answered'));
  return { pool, release };
}

/** The reused-thread checks a body's jobs made, as the parse-timing seam counted them. */
interface ReuseChecks {
  /** The calls of the `reuse-check`, `reuse-collect` and `reuse-retire` tier rows. */
  rows: { check: number; collect: number; retire: number };
  /** The most a checked thread held as its job started, in MiB. */
  settledMibMax: number;
}

/**
 * Run `body` with the parse-timing seam on in this thread only, counting the reused-thread checks
 * its jobs made and the threads it started.
 *
 * @param body - The work to watch
 * @returns The threads started, and the checks counted
 */
async function reuseChecksOf(body: () => Promise<void>): Promise<{ started: Worker[]; reuse: ReuseChecks }> {
  const directory = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-pool-reuse-'));
  cacheRoots.push(directory);
  __setParseTimingForTest(directory);
  try {
    const started = await startedThreads(body);
    const snapshot = __readParseTimingSnapshot();
    const calls = (name: string): number => snapshot.tier.find((pass) => pass.pass === name)?.calls ?? -1;
    return {
      started,
      reuse: {
        rows: { check: calls('reuse-check'), collect: calls('reuse-collect'), retire: calls('reuse-retire') },
        settledMibMax: snapshot.reuseHeap.settledMibMax,
      },
    };
  } finally {
    __setParseTimingForTest(null);
  }
}

/**
 * Hold every `worker.terminate()` until released, so a stopped thread stays terminating — counted
 * against the pool's width — for as long as the test says.
 *
 * @returns How many terminations are held, and the release that runs them all, now and from then on
 */
function holdTerminations(): { held: () => number; release: () => void } {
  const terminate = Worker.prototype.terminate;
  const held: Array<() => void> = [];
  let released = false;
  vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
    return new Promise<number>((resolve, reject) => {
      const run = (): void => {
        terminate.call(this).then(resolve, reject);
      };
      if (released) run();
      else held.push(run);
    });
  });
  return {
    held: () => held.length,
    release: () => {
      released = true;
      for (const run of held.splice(0, held.length)) run();
    },
  };
}

/**
 * @param outcome - A job's outcome
 * @returns The outcome, and what it has settled to so far (`undefined` until it has)
 */
function settledLater(outcome: Promise<unknown>): { outcome: Promise<unknown>; settled: () => unknown } {
  let settled: unknown;
  outcome.then((value) => {
    settled = value;
  }, () => undefined);
  return { outcome, settled: () => settled };
}

/**
 * Wait until `condition` holds, polled on `setImmediate` (which no test's fake clock replaces);
 * bounded by the test's own timeout, never by a wall-clock budget of its own.
 *
 * @param condition - What to wait for
 */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setImmediate(resolve));
}

describe('the pool\'s bookkeeping is never a verdict', () => {
  it('starts a job\'s time limit once its parser has loaded, so a thread slow to START is neither the document\'s refusal nor a broken install', async () => {
    // The first thread never posts `ready` (a start starved by a loaded host); it is stopped at
    // `timeMs`. That stop is the thread's, not the document's, and one stop is not three: the job
    // runs again on a fresh thread, which starts normally and answers. The clock is the test's,
    // advanced only once the first thread has written its marker.
    vi.useFakeTimers(TEST_CLOCK);
    const entry = await seedWorkerEntry([
      "import { existsSync, writeFileSync } from 'node:fs';",
      "const started = new URL('./started', import.meta.url);",
      'if (existsSync(started)) {',
      `  await import(${JSON.stringify(BUILT_WORKER)});`,
      '} else {',
      "  writeFileSync(started, '');",
      // Alive and never ready: a thread whose loop empties would exit, which is a death, not a slow start.
      '  setInterval(() => undefined, 1000);',
      '}',
    ].join('\n'));
    const pool = createParsePool({ size: 1, limits: { timeMs: 150 } });
    openPools.push(pool);

    let outcome: unknown;
    try {
      const pending = outcomeOf(pool, '# a\n');
      await announcedParserLoaded(safePath.join(safePath.resolve(entry, '..'), 'started'));
      vi.advanceTimersByTime(150);
      outcome = await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(outcome).toBe('answered');
  });

  it('matches every answer to the job it was posted for, and credits no other', async () => {
    // Each thread posts an answer under an id no job of this pool holds, then dies holding its
    // job. The stray answer settles nothing and resets nothing: two deaths, then a broken install.
    await seedWorkerEntry([
      "import { parentPort } from 'node:worker_threads';",
      READY_LINE,
      "parentPort.on('message', (request) => {",
      "  if (request?.type === 'shutdown') { parentPort.close(); return; }",
      '  parentPort.postMessage({ id: request.id, parserLoaded: request.kind });',
      '  parentPort.postMessage({ id: request.id + 1000, facts: { links: [], headings: [], estimatedTokenCount: 0 } });',
      '  setTimeout(() => process.exit(3), 20);',
      '});',
    ].join('\n'));
    const pool = trackedPool(1);

    const outcomes: unknown[] = [];
    for (const content of ['# a\n', '# b\n', '# c\n']) outcomes.push(await outcomeOf(pool, content));

    expect(outcomes.map((outcome) => verdictOf(outcome))).toStrictEqual(['died', 'died', 'unavailable']);
  });

  it('settles its shutdown, closing every thread, when a thread errors on the way out', async () => {
    // Each thread throws as it is asked to close. Shutdown must still close them all and resolve:
    // a rejection there replaces an answered run's result in the caller's `finally`. The heap read
    // is held past what a thread may be parked with, so both are closed rather than parked.
    stubParkingMachine({ usedBytes: (PARKED_HEAP_MB + 1) * BYTES_PER_MIB });
    // Intercepted inside the real worker's own listener, never ahead of it: a listener registered
    // before the real worker loads starts the port, and under a slow load could take a job first.
    await seedWorkerEntry(intercepting("request?.type === 'shutdown'", ["throw new Error('seeded close failure');"]));
    const before = workerThreadCount();
    const pool = createParsePool({ size: 2 });

    const { widest } = await widestLiveWorkerThreads(async () => {
      expect(await Promise.all([outcomeOf(pool, '# a\n'), outcomeOf(pool, '# b\n')])).toStrictEqual(['answered', 'answered']);
      await expect(pool.shutdown()).resolves.toBeUndefined();
    });

    expect(widest).toBe(2);
    expect(workerThreadCount()).toBe(before);
  });

  it('settles its shutdown only once a thread stopped at a limit has exited', async () => {
    // The stopped thread's job is already settled and the pool holds no thread of its own, so the
    // stopped thread's exit, held here, is all its shutdown still has to wait for.
    vi.useFakeTimers(TEST_CLOCK);
    const entry = await seedWorkerEntry(intercepting(contentStartsWith('# SLOW'), [
      'parentPort.postMessage({ id: request.id, parserLoaded: request.kind });',
      "process.getBuiltinModule('node:fs').writeFileSync(new URL('./slow', import.meta.url), '');",
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
    ]));
    const exits = holdTerminations();
    const pool = createParsePool({ size: 1, limits: { timeMs: 300 } });
    openPools.push(pool);

    let outcome: unknown;
    try {
      const pending = outcomeOf(pool, '# SLOW\n');
      await announcedParserLoaded(safePath.join(safePath.resolve(entry, '..'), 'slow'));
      vi.advanceTimersByTime(300);
      outcome = await pending;
    } finally {
      vi.useRealTimers();
    }
    const shutdown = settledLater(pool.shutdown().then(() => 'shut down'));
    try {
      await until(() => exits.held() === 1);
      for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(shutdown.settled()).toBeUndefined();
    } finally {
      exits.release();
    }

    expect(isParseLimitError(outcome) ? outcome.limit : outcome).toBe('timeMs');
    expect(await shutdown.outcome).toBe('shut down');
  });
});

/**
 * A seeded worker whose thread dies, the first `dying` times, on being handed a parse — after it
 * posted `ready`, before the job's parser loads: it exits, or throws V8's out-of-memory error.
 *
 * @param how - `exit` or `oom`
 * @param dying - How many threads die so; every later one runs the real worker
 * @returns The entry's source
 */
function diesWhileLoading(how: 'exit' | 'oom', dying: number): string {
  return intercepting("request?.type === 'parse'", [
    "const fs = process.getBuiltinModule('node:fs');",
    "const tally = new URL('./deaths', import.meta.url);",
    "const deaths = fs.existsSync(tally) ? fs.readFileSync(tally, 'utf-8').length : 0;",
    `if (deaths >= ${String(dying)}) return listener(request);`,
    "fs.appendFileSync(tally, 'x');",
    how === 'exit'
      ? 'process.exit(3);'
      : "{ const error = new Error('out of memory'); error.code = 'ERR_WORKER_OUT_OF_MEMORY'; throw error; }",
  ]);
}

/**
 * Hold every thread's `ready` back from the pool until the thread exits, and emit it where Node
 * drains the thread's messages on exit: after any `error`, before `exit`.
 *
 * Node carries a thread's uncaught `error` on its internal port and what the thread posted on its
 * public one, and orders the two only at `exit`, which drains the public port and then drops every
 * `message` listener. So a thread that posted `ready` and then threw may reach the pool `error`
 * first: measured at about one in three on an idle host. This forces that order, which is legal,
 * on every thread.
 */
function holdReadyUntilExit(): void {
  const emit = Worker.prototype.emit;
  const removeAll = Worker.prototype.removeAllListeners;
  const held = new WeakMap<Worker, unknown[]>();
  vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event: string | symbol, ...args: unknown[]) {
    const [payload] = args;
    if (event !== 'message' || typeof payload !== 'object' || payload === null || !('ready' in payload)) {
      return emit.call(this, event, ...args);
    }
    held.set(this, [...(held.get(this) ?? []), payload]);
    return true;
  });
  vi.spyOn(Worker.prototype, 'removeAllListeners').mockImplementation(function (this: Worker, event?: string | symbol) {
    if (event === 'message') {
      for (const message of held.get(this) ?? []) emit.call(this, 'message', message);
      held.delete(this);
    }
    return removeAll.call(this, event);
  });
}

describe('a thread lost to its heap before the job\'s parser loaded', () => {
  it('charges a breach on the load clock to the thread, never the document it holds', async () => {
    // The thread posts `ready` and never loads the job's parser, and every sample reads its heap
    // at V8's ceiling, past any stop: the sampler stops it on the job's load clock, before any
    // parser has run over the document's bytes. That is the thread's, never a refusal of the
    // document: three threads lost so end the job as a broken install.
    await seedWorkerEntry(["import { parentPort } from 'node:worker_threads';", READY_LINE, "parentPort.on('message', () => undefined);"].join('\n'));
    const sample = Worker.prototype.getHeapStatistics;
    const spy = vi.spyOn(Worker.prototype, 'getHeapStatistics').mockImplementation(function (this: Worker) {
      return sample.call(this).then((stats) => ({ ...stats, used_heap_size: stats.heap_size_limit }));
    });
    const pool = heapTestPool();

    try {
      const outcome = await outcomeOf(pool, '# never loads\n');

      expect(verdictOf(outcome)).toBe('unavailable');
      expect(outcome instanceof Error && outcome.message).toMatch(/the last: a parse thread's heap passed its bound before the markdown parser loaded/);
    } finally {
      spy.mockRestore();
    }
  });

  it('treats V8\'s out-of-memory before the thread is ready as a thread that could not start, never a heap refusal', async () => {
    await seedWorkerEntry("{ const error = new Error('out of memory'); error.code = 'ERR_WORKER_OUT_OF_MEMORY'; throw error; }");
    const pool = createParsePool({ size: 1 });
    openPools.push(pool);

    const outcome = await outcomeOf(pool, '# never starts\n');

    expect(isParseLimitError(outcome)).toBe(false);
    expect(verdictOf(outcome)).toBe('unavailable');
  });
});

describe('a thread that dies while it loads the job\'s parser', () => {
  it.each(['exit', 'oom'] as const)('runs the job again on another thread, charged to no document (%s)', async (how) => {
    // Node may emit a thread's `error` before a `ready` it posted earlier: held here so it always
    // does, the order a loaded host produced.
    holdReadyUntilExit();
    await seedWorkerEntry(diesWhileLoading(how, 1));
    const pool = createParsePool({ size: 1 });
    openPools.push(pool);

    expect(verdictOf(await outcomeOf(pool, '# loads\n'))).toBe('answered');
  });

  it('ends the job as a broken install, never the document\'s death, once it dies so on three threads in a row', async () => {
    await seedWorkerEntry(diesWhileLoading('exit', 99));
    const pool = createParsePool({ size: 1 });
    openPools.push(pool);

    const outcome = await outcomeOf(pool, '# never loads\n');

    expect(verdictOf(outcome)).toBe('unavailable');
    expect(outcome instanceof Error && outcome.message).toMatch(/died before the markdown parser loaded/);
  });

  it('is still the document\'s death once the parser has loaded and the parse begun', async () => {
    // The thread dies as it would answer: its `parserLoaded` reached the pool first.
    await seedWorkerEntry([
      "import { parentPort } from 'node:worker_threads';",
      'const post = parentPort.postMessage.bind(parentPort);',
      "parentPort.postMessage = (message) => { if (typeof message?.id === 'number' && !('reuseCheck' in message) && !message.parserLoaded) process.exit(3); post(message); };",
      `await import(${JSON.stringify(BUILT_WORKER)});`,
    ].join('\n'));
    const pool = createParsePool({ size: 1 });
    openPools.push(pool);

    expect(verdictOf(await outcomeOf(pool, '# dies parsing\n'))).toBe('died');
  });
});

describe('the clocks and the breaker', () => {
  it('starts the parse clock when the parser has loaded, never at dispatch', async () => {
    // The thread holds its job until a `go` marker, so its load runs 0.9 × timeMs on the load
    // clock; once `parserLoaded` has reached the pool, the parse runs another 0.9 × timeMs and
    // answers. A clock armed at dispatch would have stopped it at timeMs. Past a whole timeMs of
    // parse clock, it is refused at timeMs.
    const deadline = settleDeadline();
    vi.useFakeTimers(TEST_CLOCK);
    const entry = await seedWorkerEntry(heldLoadAndAnswer());
    const dir = safePath.resolve(entry, '..');
    const outcomes: unknown[] = [];
    try {
      for (const parseMs of [270, 300]) {
        const pool = createParsePool({ size: 1, limits: { timeMs: 300 } });
        openPools.push(pool);
        const outcome = outcomeOf(pool, '# held\n');
        await consumeMarker(safePath.join(dir, 'dispatched'));
        vi.advanceTimersByTime(270);
        await fs.writeFile(safePath.join(dir, 'go'), '');
        await consumeMarker(safePath.join(dir, 'loaded'));
        await fs.rm(safePath.join(dir, 'go'));
        vi.advanceTimersByTime(parseMs);
        await fs.writeFile(safePath.join(dir, 'answer'), '');
        outcomes.push(await settledBy(outcome, deadline));
        await fs.rm(safePath.join(dir, 'answer'));
      }
    } finally {
      // A clock the pool armed on the fake timers fires only on them: past timeMs, whatever is
      // still held is stopped, and every later clock runs on the real ones, so teardown drains.
      vi.advanceTimersByTime(300);
      vi.useRealTimers();
    }

    expect(outcomes.map((outcome) => (isParseLimitError(outcome) ? outcome.limit : outcome))).toStrictEqual(['answered', 'timeMs']);
  });

  it('counts the load stops of threads that started together as one, so a starved host is not a broken install', async () => {
    // Three fresh threads, none of which starts until a `release` marker exists: all three load
    // clocks run out at once. Counted apart, that one stall is three stops in a row; counted once,
    // the jobs run again on fresh threads, which start, and every document is answered.
    vi.useFakeTimers(TEST_CLOCK);
    const entry = await seedWorkerEntry([
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { threadId } from 'node:worker_threads';",
      "if (existsSync(new URL('./release', import.meta.url))) {",
      `  await import(${JSON.stringify(BUILT_WORKER)});`,
      '} else {',
      "  writeFileSync(new URL(`./starved-${threadId}`, import.meta.url), '');",
      '  setInterval(() => undefined, 1000);',
      '}',
    ].join('\n'));
    const dir = safePath.resolve(entry, '..');
    const pool = createParsePool({ size: 3, limits: { timeMs: 150 } });
    openPools.push(pool);

    let outcomes: unknown[];
    try {
      const pending = ['# a\n', '# b\n', '# c\n'].map(async (content) => outcomeOf(pool, content));
      while ((await fs.readdir(dir)).filter((name) => name.startsWith('starved-')).length < 3) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await fs.writeFile(safePath.join(dir, 'release'), '');
      vi.advanceTimersByTime(150);
      outcomes = await Promise.all(pending);
    } finally {
      vi.useRealTimers();
    }

    expect(outcomes).toStrictEqual(['answered', 'answered', 'answered']);
  });

  it('counts a hung parser load per parser kind, so answers of another kind never reset it', async () => {
    // The HTML parser never loads; markdown parses. One HTML document is stopped at its load clock
    // three times, a markdown document answered between each stop. Any answer ending the run would
    // leave the HTML document a per-run death and the install judged sound. A reused thread passes
    // its heap check first: the load hangs, never the check, whose loss is no load stop.
    const deadline = settleDeadline();
    vi.useFakeTimers(TEST_CLOCK);
    const entry = await seedWorkerEntry(intercepting("request?.kind === 'html'", [
      'if (request.settleHeap) parentPort.postMessage({ id: request.id, reuseCheck: { usedBytes: 0, collectMs: null, checkMs: 0, retire: false } });',
      "process.getBuiltinModule('node:fs').writeFileSync(new URL('./html', import.meta.url), '');",
    ]));
    const htmlMarker = safePath.join(safePath.resolve(entry, '..'), 'html');
    const pool = createParsePool({ size: 2, limits: { timeMs: 150 } });
    openPools.push(pool);

    const answers: unknown[] = [];
    let html: unknown;
    try {
      const pending = pool.parse('html', '<p>hung</p>', 11).then(() => 'answered', (error: unknown) => error);
      for (let stop = 0; stop < 3; stop += 1) {
        await consumeMarker(htmlMarker);
        answers.push(await settledBy(outcomeOf(pool, `# between ${String(stop)}\n`), deadline));
        vi.advanceTimersByTime(150);
      }
      html = await settledBy(pending, deadline);
    } finally {
      vi.useRealTimers();
    }

    expect(answers).toStrictEqual(['answered', 'answered', 'answered']);
    expect(verdictOf(html)).toBe('unavailable');
    // The breaker's own verdict, never the job's three load clocks: the run was counted through
    // the markdown answers between the stops.
    expect(html instanceof Error && html.message).toMatch(/3 parse threads in a row were stopped or died before the html parser loaded/);
  });

  it('ends a run of load stops on a parserLoaded, even one a thread posts after it was stopped, and arms no clock with it', async () => {
    // The HTML parser loads only on a thread handed a `go` marker. The first thread is stopped at
    // its load clock, kept alive past its stop (its terminate held), and then handed `go`: its
    // `parserLoaded` reaches the pool from a thread the pool is done with. The HTML document is
    // stopped twice more, on threads that never load, and ends as parser-unavailable of its own.
    // Had the late `parserLoaded` been dropped, those three stops would be a run, the install
    // judged broken, and the markdown document after them refused.
    const deadline = settleDeadline();
    vi.useFakeTimers(TEST_CLOCK);
    const entry = await seedWorkerEntry(htmlLoadsOnGo());
    const marker = (name: string): string => safePath.join(safePath.resolve(entry, '..'), name);
    const terminate = Worker.prototype.terminate;
    let held: Worker | undefined;
    vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
      if (held !== undefined) return terminate.call(this);
      held = this;
      return new Promise<number>(() => undefined);
    });
    const pool = createParsePool({ size: 1, limits: { timeMs: 150 } });
    openPools.push(pool);

    let html: unknown;
    let after: unknown;
    try {
      const pending = pool.parse('html', '<p>slow</p>', 11).then(() => 'answered', (error: unknown) => error);
      await consumeMarker(marker('html'));
      vi.advanceTimersByTime(150);
      while (held === undefined) await new Promise((resolve) => setImmediate(resolve));
      await fs.writeFile(marker('go'), '');
      await consumeMarker(marker('loaded'));
      await terminate.call(held);
      for (let stop = 1; stop < 3; stop += 1) {
        await consumeMarker(marker('html'));
        vi.advanceTimersByTime(150);
      }
      html = await settledBy(pending, deadline);
      after = await settledBy(outcomeOf(pool, '# after\n'), deadline);
    } finally {
      vi.advanceTimersByTime(150);
      vi.useRealTimers();
    }

    expect(verdictOf(html)).toBe('unavailable');
    expect(html instanceof Error && html.message).toMatch(/could not start within 150 ms on 3 threads in a row/);
    expect(after).toBe('answered');
  });

  it('never ends a run of load stops on a failure answer, which shows nothing of the parser loading', async () => {
    // Two threads stopped at their load clock holding an HTML document; the third answers it with a
    // failure, as a thread whose parser import failed would. A second HTML document's stop is then
    // the third of the run, the install is judged broken, and a markdown document is refused.
    const deadline = settleDeadline();
    vi.useFakeTimers(TEST_CLOCK);
    const entry = await seedWorkerEntry(intercepting("request?.kind === 'html'", [
      // The thread that answered the failure is reused for the next document: it checks its heap and
      // keeps itself first, as the real worker does, so its stop is a parser load that hangs.
      "if (request.settleHeap) parentPort.postMessage({ id: request.id, reuseCheck: { usedBytes: 0, collectMs: null, checkMs: 0, retire: false } });",
      "const fs = process.getBuiltinModule('node:fs');",
      "const fail = new URL('./fail', import.meta.url);",
      "if (fs.existsSync(fail)) { fs.rmSync(fail); parentPort.postMessage({ id: request.id, failure: { name: 'Error', message: 'seeded parser load failure' } }); return; }",
      "fs.writeFileSync(new URL('./html', import.meta.url), '');",
    ]));
    const marker = (name: string): string => safePath.join(safePath.resolve(entry, '..'), name);
    const pool = createParsePool({ size: 1, limits: { timeMs: 150 } });
    openPools.push(pool);

    let first: unknown;
    let after: unknown;
    try {
      const pending = pool.parse('html', '<p>a</p>', 8).then(() => 'answered', (error: unknown) => error);
      await consumeMarker(marker('html'));
      vi.advanceTimersByTime(150);
      await consumeMarker(marker('html'));
      // The next thread answers with a failure: armed while this one holds the document.
      await fs.writeFile(marker('fail'), '');
      vi.advanceTimersByTime(150);
      first = await settledBy(pending, deadline);
      const second = pool.parse('html', '<p>b</p>', 8).then(() => 'answered', (error: unknown) => error);
      await consumeMarker(marker('html'));
      vi.advanceTimersByTime(150);
      await settledBy(second, deadline);
      after = await settledBy(outcomeOf(pool, '# after\n'), deadline);
    } finally {
      vi.advanceTimersByTime(150);
      vi.useRealTimers();
    }

    expect(first instanceof Error && first.message).toBe('seeded parser load failure');
    expect(verdictOf(after)).toBe('unavailable');
  });
});

/**
 * A seeded worker on which an HTML job loads its parser only once a `go` marker exists, which the
 * thread that sees it removes; every other thread holds its HTML job for ever. It writes `html`
 * when an HTML job reaches it, and `loaded` after posting `parserLoaded`.
 *
 * @returns The entry's source
 */
function htmlLoadsOnGo(): string {
  return [
    "import { existsSync, rmSync, writeFileSync } from 'node:fs';",
    "import { parentPort } from 'node:worker_threads';",
    "const marker = (name) => new URL(`./${name}`, import.meta.url);",
    'const post = parentPort.postMessage.bind(parentPort);',
    "parentPort.postMessage = (message, transfer) => { post(message, transfer); if (message?.parserLoaded) writeFileSync(marker('loaded'), ''); };",
    'const on = parentPort.on.bind(parentPort);',
    "parentPort.on = (event, listener) => on(event, event === 'message' ? (request) => {",
    "  if (request?.kind !== 'html') return listener(request);",
    "  writeFileSync(marker('html'), '');",
    "  const poll = setInterval(() => { if (!existsSync(marker('go'))) return; clearInterval(poll); rmSync(marker('go')); listener(request); }, 5);",
    '} : listener);',
    `await import(${JSON.stringify(BUILT_WORKER)});`,
  ].join('\n');
}

/**
 * The wall-clock time one clock test's waits share, in ms: under the unit tier's test timeout, so a
 * job that never settles reaches the test's assertion as `unsettled` rather than timing the test
 * out — and leaving the pool's clocks on fake timers for teardown to drain.
 */
const SETTLE_BUDGET_MS = 10_000;

/**
 * @returns When a clock test's shared wait budget ({@link SETTLE_BUDGET_MS}), started now, runs out
 */
function settleDeadline(): number {
  return Date.now() + SETTLE_BUDGET_MS;
}

/**
 * Wait, on no fake clock, for `outcome` — until `deadline` at the latest.
 *
 * @param outcome - A job's outcome
 * @param deadline - When the test's shared budget runs out ({@link settleDeadline})
 * @returns What it settled to, or `unsettled`
 */
async function settledBy(outcome: Promise<unknown>, deadline: number): Promise<unknown> {
  let settled: { value: unknown } | undefined;
  outcome.then((value) => {
    settled = { value };
  }, () => undefined);
  while (settled === undefined && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  return settled === undefined ? 'unsettled' : settled.value;
}

/**
 * @param outcome - What a parse settled to
 * @returns `answered`, `died` (a per-run worker death), `unavailable` (a broken install), or the outcome itself
 */
function verdictOf(outcome: unknown): unknown {
  if (isParserUnavailable(outcome)) return 'unavailable';
  if (isParseWorkerDiedError(outcome)) return 'died';
  return outcome;
}

/**
 * A seeded worker whose real worker runs each job only once a `go` marker exists, and whose
 * answer is posted only once an `answer` marker exists. It writes `dispatched` when a job reaches
 * it and `loaded` after posting `parserLoaded`, each after the post it follows.
 *
 * @returns The entry's source
 */
function heldLoadAndAnswer(): string {
  return [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { parentPort } from 'node:worker_threads';",
    "const marker = (name) => new URL(`./${name}`, import.meta.url);",
    'const whenExists = (name, run) => { const poll = setInterval(() => { if (!existsSync(marker(name))) return; clearInterval(poll); run(); }, 5); };',
    'const post = parentPort.postMessage.bind(parentPort);',
    'parentPort.postMessage = (message) => {',
    "  if (message?.parserLoaded) { post(message); writeFileSync(marker('loaded'), ''); return; }",
    "  if (typeof message?.id === 'number') { whenExists('answer', () => post(message)); return; }",
    '  post(message);',
    '};',
    'const on = parentPort.on.bind(parentPort);',
    "parentPort.on = (event, listener) => on(event, event === 'message' ? (request) => {",
    "  if (request?.type === 'shutdown') return listener(request);",
    "  writeFileSync(marker('dispatched'), '');",
    "  whenExists('go', () => listener(request));",
    '} : listener);',
    `await import(${JSON.stringify(BUILT_WORKER)});`,
  ].join('\n');
}

describe('a thread that dies uncontrolled', () => {
  it('counts against the pool\'s size until it has exited', async () => {
    // The thread throws, and its `exit` lags its `error` by a busy 400 ms, so a
    // pool that frees the slot at the error starts a replacement beside it.
    //
    // 🔑 The throw is intercepted inside the real worker's own listener (`intercepting`), never
    // ahead of it. A listener registered before the real worker's module loads starts the port, so
    // under a slow load the job reached it before the thread posted `ready`: a death before
    // `ready` is a module graph that could not load, and the pool rightly called the install
    // broken. The real worker registers its listener in the same turn as it posts `ready`, so this
    // thread has always loaded before it throws, however slowly its module loaded.
    await seedWorkerEntry([
      "process.on('exit', () => { const until = Date.now() + 400; while (Date.now() < until); });",
      intercepting(contentStartsWith('# DIE'), ['parentPort.postMessage({ id: request.id, parserLoaded: request.kind });', "throw new Error('seeded death');"]),
    ].join('\n'));
    const pool = trackedPool(1);

    const { value: outcomes, widest } = await widestLiveWorkerThreads(
      async () => Promise.all([outcomeOf(pool, '# DIE\n'), outcomeOf(pool, '# ok\n')]),
    );

    expect(isParseWorkerDiedError(outcomes[0])).toBe(true);
    expect(outcomes[1]).toBe('answered');
    expect(widest).toBe(1);
  });

  it('hands no job to a thread between its `error` and its `exit`, so the job runs on its replacement', async () => {
    const window = holdThreadExits();
    const pool = await poolWithIdleThreadDying(window);
    const posted = vi.spyOn(Worker.prototype, 'postMessage');

    // The thread is dead but still listed, idle: the job must wait for its slot, not take it. Handed
    // to the dead thread, it would be lost there and run again — answered, but dispatched twice.
    const next = outcomeOf(pool, '# next\n');
    window.release();

    expect(verdictOf(await next)).toBe('answered');
    const dispatches = posted.mock.calls.filter(([message]) => typeof (message as { id?: unknown } | undefined)?.id === 'number');
    expect(dispatches).toHaveLength(1);
  });

  it('references a thread once it has thrown, so its `exit` keeps the process alive for the job waiting on its slot', async () => {
    // An idle thread is unref'd. Skipped while dying, it is never handed the queued job, so
    // nothing but its own `error` listener can re-ref it before its `exit` frees the slot.
    const window = holdThreadExits();
    const ref = Worker.prototype.ref;
    const refsAfterError: Worker[] = [];
    vi.spyOn(Worker.prototype, 'ref').mockImplementation(function (this: Worker) {
      if (window.hasErrored(this)) refsAfterError.push(this);
      ref.call(this);
    });
    const pool = await poolWithIdleThreadDying(window);

    const next = outcomeOf(pool, '# next\n');
    const refsBeforeExit = refsAfterError.length;
    window.release();

    expect(refsBeforeExit).toBeGreaterThan(0);
    expect(verdictOf(await next)).toBe('answered');
  });

  it('parks no thread between its `error` and its `exit`, even when a heap read still answers', async () => {
    const window = holdThreadExits();
    const pool = await poolWithIdleThreadDying(window);
    vi.spyOn(Worker.prototype, 'getHeapStatistics').mockResolvedValue(PARKABLE_HEAP_READ);

    const { parked, outcome } = await shutDownWithExitsHeld(pool, window);

    expect(parked).toBe(0);
    expect(outcome).toBe('shut down');
  });

  it('parks no thread that starts dying while its heap is read for parking', async () => {
    const window = holdThreadExits();
    stubParkingMachine({ usedBytes: BYTES_PER_MIB });
    await seedWorkerEntry(intercepting("request?.type === 'die'", ["throw new Error('seeded death during the heap read');"]));
    const pool = trackedPool(1);
    expect(await outcomeOf(pool, '# alive\n')).toBe('answered');
    // The thread is alive when shutdown asks for its heap, and throws before the read answers.
    vi.spyOn(Worker.prototype, 'getHeapStatistics').mockImplementation(async function (this: Worker) {
      this.postMessage({ type: 'die' });
      await until(() => window.errored() === 1);
      return PARKABLE_HEAP_READ;
    });

    const { parked, outcome } = await shutDownWithExitsHeld(pool, window);

    expect(parked).toBe(0);
    expect(outcome).toBe('shut down');
  });
});

/** A heap read small enough that the thread it is taken from may be parked. */
const PARKABLE_HEAP_READ = { ...getHeapStatistics(), used_heap_size: BYTES_PER_MIB };

/**
 * Shut a pool down while a dead thread's `exit` is held, and count what it parked by the time it
 * either finished (it parked the thread) or asked the thread to close (it waits for the held `exit`).
 *
 * @param pool - The pool, holding one idle thread that has died or will die during the heap read
 * @param window - The held exits, released once the count is taken
 * @returns How many threads were parked then, and what the shutdown settled to
 */
async function shutDownWithExitsHeld(pool: ParsePool, window: ReturnType<typeof holdThreadExits>): Promise<{ parked: number; outcome: unknown }> {
  const closeAsked = vi.spyOn(Worker.prototype, 'postMessage');
  const asked = (): boolean => closeAsked.mock.calls.some(([message]) => (message as { type?: unknown } | undefined)?.type === 'shutdown');
  const shutdown = settledLater(pool.shutdown().then(() => 'shut down'));
  await until(() => shutdown.settled() !== undefined || asked());
  const parked = __parkedParseWorkerCountForTest();
  window.release();
  return { parked, outcome: await shutdown.outcome };
}

/** The part of Node's internal worker handle the exit hold wraps. */
interface WorkerExitHandle {
  onexit: (...args: unknown[]) => void;
}

/**
 * The handle Node keeps for a running worker thread: the own symbol-keyed property whose value
 * carries `onexit`, the callback Node runs once the thread has stopped. It is a Node internal
 * (`kHandle`), found so on Node 22.16, 24 and 26; a Node that keeps it otherwise fails the test here.
 *
 * @param worker - A thread that has not yet exited
 * @returns Its handle
 */
function exitHandleOf(worker: Worker): WorkerExitHandle {
  for (const key of Object.getOwnPropertySymbols(worker)) {
    const value: unknown = (worker as unknown as Record<symbol, unknown>)[key];
    if (typeof value === 'object' && value !== null && typeof (value as Partial<WorkerExitHandle>).onexit === 'function') {
      return value as WorkerExitHandle;
    }
  }
  throw new Error(`holdThreadExits: no own symbol property of this Worker carries \`onexit\` on Node ${process.version}; the seam must be updated for this Node`);
}

/**
 * Hold Node's whole exit handling of every thread started from now on until released: its handle's
 * `onexit`, which drains the thread's ports, disposes the handle, sets `threadId` to -1 and emits
 * `exit`. A thread that throws and stops is then dead with its `error` delivered — through the
 * thread's internal port, which stays live while `onexit` waits — and the pool sees what it sees in
 * production's window between `error` and `exit`: `threadId` still set, the handle live, no `exit`.
 *
 * `onexit` is wrapped as the thread is constructed (the `worker_threads` diagnostics channel), never
 * when its `error` arrives: Node may run `onexit` before it delivers the `error` (a parent busy
 * while the thread throws and stops sees both at once; measured so on Node 22.16, 24 and 26 with
 * the parent blocked), and `onexit` then emits the `error` from its drain with `exit` right after.
 * Wrapped at construction, the exit is held whichever comes first.
 *
 * A handle that cannot be found, or an `exit` emitted before the release by a thread started under
 * the hold, fails the test at the next {@link errored} or release: the seam never passes on a
 * weaker hold.
 *
 * @returns Whether a thread has emitted `error`, how many have, and the release that runs every held exit
 */
function holdThreadExits(): { hasErrored: (worker: Worker) => boolean; errored: () => number; release: () => void } {
  const emit = Worker.prototype.emit;
  const started = new Set<Worker>();
  const errored = new Set<Worker>();
  const held: Array<() => void> = [];
  let released = false;
  let runningHeld = false;
  let seamBroken: unknown;
  const hold = (worker: Worker): void => {
    const handle = exitHandleOf(worker);
    const onexit = handle.onexit;
    handle.onexit = (...exitArgs: unknown[]): void => {
      if (released) {
        onexit.apply(handle, exitArgs);
        return;
      }
      held.push(() => {
        runningHeld = true;
        try {
          onexit.apply(handle, exitArgs);
        } finally {
          runningHeld = false;
        }
      });
    };
  };
  const onStarted = (message: unknown): void => {
    const { worker } = message as { worker: Worker };
    started.add(worker);
    try {
      hold(worker);
    } catch (error) {
      seamBroken ??= error;
    }
  };
  diagnosticsChannel.subscribe('worker_threads', onStarted);
  vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event: string | symbol, ...args: unknown[]) {
    if (event === 'error') errored.add(this);
    if (event === 'exit' && started.has(this) && !released && !runningHeld) {
      seamBroken ??= new Error('holdThreadExits: a thread started under the hold exited unheld, so the test ran without its window');
    }
    return emit.call(this, event, ...args);
  });
  const check = (): void => {
    if (seamBroken !== undefined) throw seamBroken;
  };
  const runHeld = (): void => {
    released = true;
    diagnosticsChannel.unsubscribe('worker_threads', onStarted);
    for (const run of held.splice(0, held.length)) run();
  };
  const release = (): void => {
    runHeld();
    check();
  };
  // Not `onTestFinished`, which runs after `afterEach`: a test that fails before its release would
  // leave the exit held through the suite's shutdown, which waits on it until the hook times out.
  heldExitReleases.push(runHeld);
  return {
    hasErrored: (worker) => errored.has(worker),
    errored: () => {
      check();
      return errored.size;
    },
    release,
  };
}

/**
 * A one-thread pool whose thread answered one job and then threw while idle, with its exit held
 * ({@link holdThreadExits}): on return the thread is dead, its `error` delivered, and it is still
 * listed as the pool's idle thread.
 *
 * @param window - The hold, made by the caller so it can watch the thread from its `error` on
 * @returns The pool
 */
async function poolWithIdleThreadDying(window: ReturnType<typeof holdThreadExits>): Promise<ParsePool> {
  stubParkingMachine({ usedBytes: BYTES_PER_MIB });
  await seedWorkerEntry([
    "import { parentPort } from 'node:worker_threads';",
    'const dieAfter = new Set();',
    'const post = parentPort.postMessage.bind(parentPort);',
    'parentPort.postMessage = (message) => {',
    '  post(message);',
    "  if (!dieAfter.has(message?.id) || 'parserLoaded' in message || 'reuseCheck' in message) return;",
    "  setImmediate(() => { throw new Error('seeded idle death'); });",
    '};',
    'const on = parentPort.on.bind(parentPort);',
    "parentPort.on = (event, listener) => on(event, event === 'message' ? (request) => {",
    `  if (${contentStartsWith('# DIE IDLE')}) dieAfter.add(request.id);`,
    '  listener(request);',
    '} : listener);',
    `await import(${JSON.stringify(BUILT_WORKER)});`,
  ].join('\n'));
  const pool = trackedPool(1);
  expect(await outcomeOf(pool, '# DIE IDLE\n')).toBe('answered');
  await until(() => window.errored() === 1);
  return pool;
}

describe('ParsePool.parseIntoCache', () => {
  it.each(FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    'files %s under the parent\'s key, so the parent finds what the parser produced',
    async (_name, fixture) => {
      const { cache, pool } = await cacheBackedPool();
      const keyed = keyedFor(fixture);

      const sent = await pool.parseIntoCache(
        fixture.kind,
        fixture.content,
        fixture.byteLength,
        keyed.key,
      );

      // `null` is the contract's way of saying "it is on disk, go and read it".
      expect(sent).toBeNull();
      // And what is on disk is what the single-threaded path produces. This is
      // the equivalence the wire transport gets from `toStrictEqual` on the
      // returned value; cache transport has to earn it through a real round trip
      // to disk and back, because that round trip IS the transport.
      await expect(cache.read(keyed)).resolves.toStrictEqual(parseInProcess(fixture));
    },
  );

  it('sends the facts instead when the entry cannot be stored', async () => {
    // A cache root that is a regular FILE: `mkdir` of a shard under it fails
    // with ENOTDIR on POSIX and Windows alike. This is the shape of a read-only
    // mount or a full disk, and `ParseCache` is fail-soft, so nothing throws —
    // the only evidence a write failed is that the entry is not there.
    const root = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-pool-nocache-'));
    cacheRoots.push(root);
    const blocked = safePath.join(root, 'not-a-directory');
    await fs.writeFile(blocked, 'occupied', 'utf-8');

    const pool = createParsePool({ size: 1, cacheDir: blocked });
    openPools.push(pool);
    const fixture = FIXTURES[0];
    if (fixture === undefined) throw new Error('the fixture table is empty');
    const keyed = keyedFor(fixture);

    const sent = await pool.parseIntoCache(
      fixture.kind,
      fixture.content,
      fixture.byteLength,
      keyed.key,
    );

    // NOT null, and equal to the in-process parse: an un-writable cache degrades
    // to the wire protocol rather than losing the parse. Without this the parent
    // would be sent to read an entry that is not there and would re-parse the
    // document on the one thread the pool exists to keep free.
    expect(sent).toStrictEqual(parseInProcess(fixture));
  });
});

describe('ParsePool.shutdown', () => {
  it('is safe to call twice', async () => {
    const pool = createParsePool({ size: 1 });
    await pool.parse('markdown', '# hi\n', 5);

    await pool.shutdown();
    await expect(pool.shutdown()).resolves.toBeUndefined();
  });

  it('leaves no worker thread behind but the ones it parked', async () => {
    stubParkingMachine();
    const before = workerThreadCount();
    const pool = createParsePool({ size: 2 });
    await Promise.all([pool.parse('markdown', '# a\n', 4), pool.parse('html', '<p>b</p>', 8)]);

    await pool.shutdown();

    const parked = __parkedParseWorkerCountForTest();
    expect(parked).toBeGreaterThan(0);
    expect(workerThreadCount()).toBe(before + parked);
    await __closeParkedParseWorkersForTest();
    expect(workerThreadCount()).toBe(before);
  });
  it('closes a thread whose park throws, and still settles', async () => {
    stubParkingMachine();
    const before = workerThreadCount();
    const pool = createParsePool({ size: 1 });
    expect(await outcomeOf(pool, '# a\n')).toBe('answered');
    // Thrown, not rejected, and only now: a sampler reading it mid-job would throw out of its timer.
    vi.spyOn(Worker.prototype, 'getHeapStatistics').mockImplementation(() => {
      throw new Error('seeded park failure');
    });

    await expect(pool.shutdown()).resolves.toBeUndefined();

    expect(__parkedParseWorkerCountForTest()).toBe(0);
    expect(workerThreadCount()).toBe(before);
  });

  it('settles over a thread that exited unseen, waiting for no exit that will never come', async () => {
    // The thread exits on its own once it has answered, and its `exit` is held from the pool, as an
    // exit not yet delivered is: the pool still holds it as idle and alive. Its `threadId` reads -1
    // by then, and a close that waited for its `exit` would wait forever.
    await seedWorkerEntry([
      "import { parentPort } from 'node:worker_threads';",
      'const post = parentPort.postMessage.bind(parentPort);',
      'parentPort.postMessage = (message) => {',
      '  post(message);',
      "  if (typeof message?.id === 'number') setTimeout(() => process.exit(0), 20);",
      '};',
      `await import(${JSON.stringify(BUILT_WORKER)});`,
    ].join('\n'));
    let thread: Worker | undefined;
    const onWorker = (message: unknown): void => {
      const worker = (message as { worker: Worker }).worker;
      thread = worker;
      const emit = worker.emit.bind(worker);
      vi.spyOn(worker, 'emit').mockImplementation((event, ...args) => event !== 'exit' && emit(event, ...args));
    };
    const pool = createParsePool({ size: 1 });
    diagnosticsChannel.subscribe('worker_threads', onWorker);
    try {
      expect(await outcomeOf(pool, '# a\n')).toBe('answered');
    } finally {
      diagnosticsChannel.unsubscribe('worker_threads', onWorker);
    }
    await vi.waitFor(() => {
      expect(thread?.threadId).toBe(-1);
    }, { timeout: 10_000, interval: 5 });

    let hung: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      pool.shutdown().then(() => 'settled'),
      new Promise((resolve) => {
        hung = setTimeout(() => resolve('still waiting'), 8000);
      }),
    ]);
    clearTimeout(hung);

    expect(settled).toBe('settled');
  });
});

/**
 * Run `body`, collecting every worker thread STARTED while it ran (the
 * `worker_threads` diagnostics channel publishes one per construction).
 *
 * @param body - The work to watch
 * @returns The threads started
 */
async function startedThreads(body: () => Promise<void>): Promise<Worker[]> {
  const started: Worker[] = [];
  const onWorker = (message: unknown): void => {
    started.push((message as { worker: Worker }).worker);
  };
  diagnosticsChannel.subscribe('worker_threads', onWorker);
  try {
    await body();
  } finally {
    diagnosticsChannel.unsubscribe('worker_threads', onWorker);
  }
  return started;
}

/**
 * One pool's whole life: a parse, then shutdown.
 *
 * @param options - The pool's options
 * @returns What the parse settled to
 */
async function oneParse(options: Parameters<typeof createParsePool>[0]): Promise<unknown> {
  const pool = createParsePool(options);
  openPools.push(pool);
  try {
    return await outcomeOf(pool, '# parked\n');
  } finally {
    await pool.shutdown();
  }
}

/**
 * A seeded entry whose real worker sees every request but the ones `intercept` handles: each
 * line is the body run for a request `matches` accepts, inside the message listener.
 *
 * @param matches - JS expression over `request` choosing which requests to intercept
 * @param intercept - JS statements run for such a request instead of the real listener
 * @returns The entry's source
 */
function intercepting(matches: string, intercept: string[]): string {
  return [
    "import { parentPort } from 'node:worker_threads';",
    'const on = parentPort.on.bind(parentPort);',
    "parentPort.on = (event, listener) => on(event, event === 'message' ? (request) => {",
    `  if (!(${matches})) return listener(request);`,
    ...intercept.map((line) => `  ${line}`),
    '} : listener);',
    `await import(${JSON.stringify(BUILT_WORKER)});`,
  ].join('\n');
}

/** A request whose content starts with `prefix`, as a JS expression for {@link intercepting}. */
function contentStartsWith(prefix: string): string {
  return `request?.content?.startsWith?.(${JSON.stringify(prefix)})`;
}

/**
 * Park one thread from a pool of `options`, and prove it parked: the precondition every
 * reuse test stands on, asserted rather than assumed so a runner that parks nothing fails
 * here with that name, not later with a misleading verdict.
 *
 * @param options - The pool's options
 * @returns The thread now parked
 */
async function parkOne(options: Parameters<typeof createParsePool>[0]): Promise<Worker> {
  const [thread, ...more] = await startedThreads(async () => {
    expect(await oneParse(options)).toBe('answered');
  });
  expect(more, 'one pool of one parse starts one thread').toHaveLength(0);
  expect(__parkedParseWorkerCountForTest(), 'precondition: the thread was parked').toBe(1);
  if (thread === undefined) throw new Error('precondition: the pool started a thread');
  return thread;
}

// Every test here holds the machine with `stubParkingMachine` (memory and the heap ceiling a
// thread reads), so whether a thread parks is the code's decision, never the runner's.
describe('a parked thread', () => {
  it('serves the next pool of the same shape, which starts none of its own', async () => {
    stubParkingMachine();
    await parkOne({ size: 1 });

    const second = await startedThreads(async () => {
      expect(await oneParse({ size: 1 })).toBe('answered');
    });

    expect(second).toHaveLength(0);
    expect(__parkedParseWorkerCountForTest()).toBe(1);
  });

  it('never serves a pool of another shape', async () => {
    stubParkingMachine();
    await parkOne({ size: 1 });

    const other = await startedThreads(async () => {
      expect(await oneParse({ size: 1, limits: { timeMs: 29_000 } })).toBe('answered');
    });

    expect(other).toHaveLength(1);
    // The cap is one (`stubParkingMachine`'s 6 GiB), so the other shape's thread replaced it.
    expect(__parkedParseWorkerCountForTest()).toBe(1);
  });

  it('is closed, oldest first, past the cap', async () => {
    stubParkingMachine();
    const before = workerThreadCount();
    await parkOne({ size: 1, limits: { timeMs: 20_000 } });
    await oneParse({ size: 1, limits: { timeMs: 20_001 } });

    expect(__parkedParseWorkerCountForTest()).toBe(1);
    expect(workerThreadCount()).toBe(before + 1);
    // The oldest shape was the one evicted: a pool of it starts its own thread again.
    const oldest = await startedThreads(async () => {
      await oneParse({ size: 1, limits: { timeMs: 20_000 } });
    });
    expect(oldest).toHaveLength(1);
  });

  it('is dropped if it dies while parked, and counted against no later pool', async () => {
    stubParkingMachine();
    const parked = await parkOne({ size: 1 });
    await parked.terminate();
    await vi.waitFor(() => {
      expect(__parkedParseWorkerCountForTest()).toBe(0);
    });

    const next = await startedThreads(async () => {
      expect(await oneParse({ size: 1 })).toBe('answered');
    });
    expect(next).toHaveLength(1);
  });

  it('is never a thread stopped at a limit', async () => {
    stubParkingMachine();
    await seedWorkerEntry(intercepting(contentStartsWith('# SLOW'), [
      'parentPort.postMessage({ id: request.id, parserLoaded: request.kind });',
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
    ]));
    // Long enough for a fresh thread on a loaded runner to load before its deadline.
    const pool = createParsePool({ size: 1, limits: { timeMs: 3000 } });
    openPools.push(pool);

    const outcome = await outcomeOf(pool, '# SLOW\n');
    await pool.shutdown();

    expect(isParseLimitError(outcome) ? outcome.limit : outcome).toBe('timeMs');
    expect(__parkedParseWorkerCountForTest()).toBe(0);
  });

  it.each([
    { label: 'one byte past', usedBytes: PARKED_HEAP_MB * BYTES_PER_MIB + 1, parked: 0 },
    { label: 'exactly at', usedBytes: PARKED_HEAP_MB * BYTES_PER_MIB, parked: 1 },
  ])('is parked only at or under PARKED_HEAP_MB of used heap: $label it', async ({ usedBytes, parked }) => {
    stubParkingMachine({ usedBytes });

    expect(await oneParse({ size: 1 })).toBe('answered');

    expect(__parkedParseWorkerCountForTest()).toBe(parked);
  });

  // V8's old-generation ceiling as a process `--max-old-space-size` leaves it; the pool applies
  // half. The used heap is left real, well under PARKED_HEAP_MB: what it carries into its next
  // pool is bounded by that pool's reuse check at every bound, so no lowered bound declines it.
  it.each([
    { label: 'at 192 MiB, where it applies the 96 MiB floor', ceilingMb: 192, parked: 1 },
    { label: 'at 1,024 MiB (the integration tier), where it applies 512 MiB', ceilingMb: 1024, parked: 1 },
  ])('is parked under a lowered heap ceiling too: $label', async ({ ceilingMb, parked }) => {
    stubParkingMachine({ ceilingMb });

    expect(await oneParse({ size: 1 })).toBe('answered');

    expect(__parkedParseWorkerCountForTest()).toBe(parked);
  });

  it('owns its death once it has posted anything to the pool that adopted it', async () => {
    stubParkingMachine();
    // `DIE` loads a parser the parked thread never had, says so, then kills the thread: the
    // document's doing, on a thread proven alive after adoption, so nothing runs it again.
    await seedWorkerEntry(intercepting(contentStartsWith('<p>DIE'), [
      "parentPort.postMessage({ id: request.id, parserLoaded: 'html' });",
      'setTimeout(() => process.exit(3), 200);',
    ]));
    await parkOne({ size: 1 });
    const pool = createParsePool({ size: 1 });
    openPools.push(pool);

    let outcome: unknown;
    const started = await startedThreads(async () => {
      const content = '<p>DIE</p>';
      outcome = await pool.parse('html', content, content.length).catch((error: unknown) => error);
    });

    expect(isParseWorkerDiedError(outcome)).toBe(true);
    expect(started).toHaveLength(0);
  });

  it('is closed without crashing the process when its thread errors on the way out', async () => {
    stubParkingMachine();
    await seedWorkerEntry(intercepting("request?.type === 'shutdown'", [
      "setImmediate(() => { throw new Error('seeded close failure'); });",
    ]));
    const thread = await parkOne({ size: 1 });
    const gone = new Promise((resolve) => thread.once('exit', resolve));

    await __closeParkedParseWorkersForTest();

    await gone;
    expect(__parkedParseWorkerCountForTest()).toBe(0);
  });

  it('closes itself once it has waited the idle timeout unadopted', async () => {
    stubParkingMachine();
    const pool = createParsePool({ size: 1 });
    openPools.push(pool);
    expect(await outcomeOf(pool, '# parked\n')).toBe('answered');
    // Faked only now, so the parse ran on real timers and the park arms a fake one.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await pool.shutdown();
      expect(__parkedParseWorkerCountForTest(), 'precondition: the thread was parked').toBe(1);

      vi.advanceTimersByTime(PARKED_IDLE_MS - 1);
      expect(__parkedParseWorkerCountForTest()).toBe(1);
      vi.advanceTimersByTime(1);
      expect(__parkedParseWorkerCountForTest()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is never closed by its idle timeout once a pool has adopted it', async () => {
    stubParkingMachine();
    const first = createParsePool({ size: 1 });
    openPools.push(first);
    expect(await outcomeOf(first, '# parked\n')).toBe('answered');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await first.shutdown();
      expect(__parkedParseWorkerCountForTest(), 'precondition: the thread was parked').toBe(1);
      const second = createParsePool({ size: 1 });
      openPools.push(second);
      const started = await startedThreads(async () => {
        expect(await outcomeOf(second, '# adopted\n')).toBe('answered');
        // Adoption cancelled the park's timer, and the answered job disarmed its own deadline.
        expect(vi.getTimerCount()).toBe(0);
        // Past the timeout the park armed: a timer adoption left running would close this thread.
        vi.advanceTimersByTime(PARKED_IDLE_MS * 2);
        expect(await outcomeOf(second, '# still here\n')).toBe('answered');
      });
      expect(started).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is never kept on a machine whose memory the bound already spent on a live pool', async () => {
    // 3 GiB: memory − 1,024 MiB fits exactly one worker at its 2,048 MiB ceiling, and nothing beside it.
    stubParkingMachine({ memoryMb: 3072 });

    expect(await oneParse({ size: 1 })).toBe('answered');

    expect(__parkedParseWorkerCountForTest()).toBe(0);
  });

  it('is never left by a pool judged broken, even a healthy idle one', async () => {
    stubParkingMachine();
    // The first thread to load claims the marker and serves; the second fails to load only once
    // the PARENT has settled the first answer — an event the test writes, never a sleep (a slow
    // Windows fork outlasted one) nor the worker's own post (a stalled parent may handle the
    // second thread's error first) — so the first sits idle when the pool is judged broken.
    const claimDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-pool-claim-'));
    cacheRoots.push(claimDir);
    const marker = safePath.join(claimDir, 'claimed');
    const answered = safePath.join(claimDir, 'answered');
    await seedWorkerEntry([
      "import { closeSync, existsSync, openSync } from 'node:fs';",
      'let first = true;',
      `try { closeSync(openSync(${JSON.stringify(marker)}, 'wx')); } catch { first = false; }`,
      'if (!first) {',
      `  while (!existsSync(${JSON.stringify(answered)})) await new Promise((resolve) => setTimeout(resolve, 20));`,
      "  throw new Error('seeded second-thread load failure');",
      '}',
      `await import(${JSON.stringify(BUILT_WORKER)});`,
    ].join('\n'));
    // A deadline far past any runner's cold load, so the second thread is judged by its own
    // load failure and never by a clock that started while the first was still loading.
    const pool = createParsePool({ size: 2, limits: { timeMs: 120_000 } });
    openPools.push(pool);
    // Whatever the first outcome, release the second thread: a failed first answer then reads
    // as the assertion below, not as a wait on the second thread's deadline.
    const settle = async (content: string): Promise<unknown> => {
      const outcome = await outcomeOf(pool, content);
      await fs.writeFile(answered, '');
      return outcome;
    };

    const outcomes = await Promise.all([settle('# one\n'), settle('# two\n')]);
    await pool.shutdown();

    expect(outcomes.filter((outcome) => outcome === 'answered')).toHaveLength(1);
    expect(outcomes.filter((outcome) => isParserUnavailable(outcome))).toHaveLength(1);
    expect(__parkedParseWorkerCountForTest()).toBe(0);
  });

  it('brings the parsers it loaded, so a slow document on it is never a death', async () => {
    stubParkingMachine();
    // `# SLOW` blocks once the real worker has checked its heap and kept itself, before it parses:
    // on the adopted thread the parser loaded a pool ago, so the job is on its parse clock, and a
    // stop there is the document's. `<p>DIE` kills a fresh thread mid-job: a death everywhere.
    // Deadline long enough for a loaded runner.
    await seedWorkerEntry(intercepting(`${contentStartsWith('# SLOW')} || ${contentStartsWith('<p>DIE')}`, [
      "if (request.content.startsWith('<p>DIE')) { parentPort.postMessage({ id: request.id, parserLoaded: request.kind }); setTimeout(() => process.exit(3), 100); return; }",
      'const post = parentPort.postMessage.bind(parentPort);',
      'parentPort.postMessage = (message) => {',
      '  post(message);',
      "  if (message?.id === request.id && 'reuseCheck' in message) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
      '};',
      'listener(request);',
    ]));
    const limits = { timeMs: 4000 };
    await parkOne({ size: 1, limits });
    const pool = createParsePool({ size: 1, limits });
    openPools.push(pool);

    const outcomes: unknown[] = [];
    const started = await startedThreads(async () => {
      // The adopted thread stopped, then two deaths on fresh threads: two in a row, one short of
      // the broken-install verdict — which charging the adopted thread's stop would reach.
      outcomes.push(await outcomeOf(pool, '# SLOW\n'));
      for (const content of ['<p>DIE one</p>', '<p>DIE two</p>']) {
        outcomes.push(await pool.parse('html', content, content.length).catch((error: unknown) => error));
      }
    });

    expect(started, 'precondition: the slow document ran on the adopted thread').toHaveLength(2);
    expect(outcomes.map((outcome) => {
      if (isParseLimitError(outcome)) return outcome.limit;
      return isParseWorkerDiedError(outcome) ? 'died' : outcome;
    })).toStrictEqual(['timeMs', 'died', 'died']);
  });

  it('runs its job again on another thread when it dies before answering, charged to no document', async () => {
    stubParkingMachine();
    await seedWorkerEntry(intercepting(contentStartsWith('# WAIT'), [
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);',
      'listener(request);',
    ]));
    const parked = await parkOne({ size: 1 });
    const pool = createParsePool({ size: 1 });
    openPools.push(pool);

    const started = await startedThreads(async () => {
      const outcome = outcomeOf(pool, '# WAIT\n');
      expect(__parkedParseWorkerCountForTest(), 'precondition: the pool adopted the parked thread').toBe(0);
      // Adopted and handed the job; it dies before it answers, as one dying while parked would.
      await parked.terminate();
      expect(await outcome).toBe('answered');
    });

    expect(started).toHaveLength(1);
  });

  it('carries no broken-install verdict to a later pool', async () => {
    stubParkingMachine();
    await parkOne({ size: 1 });
    await seedWorkerEntry("throw Object.assign(new Error('seeded load failure'), { code: 'ERR_SEEDED_LOAD' });\n");

    expect(isParserUnavailable(await oneParse({ size: 1 }))).toBe(true);
    expect(__parkedParseWorkerCountForTest()).toBe(1);

    __setParseWorkerEntryForTest(null);
    const healthy = await startedThreads(async () => {
      expect(await oneParse({ size: 1 })).toBe('answered');
    });
    // The thread parked before the broken pool served this one; that pool's verdict stayed its own.
    expect(healthy).toHaveLength(0);
  });
});

describe('the wire payload', () => {
  it('survives structuredClone unchanged for every fixture', () => {
    for (const fixture of FIXTURES) {
      const facts = toParseWire(parseInProcess(fixture));
      expect(structuredClone(facts)).toStrictEqual(facts);
    }
  });

  it('omits frontmatter because a full ParseResult does NOT survive the clone', () => {
    const result = parseInProcess({
      name: 'binary frontmatter',
      kind: 'markdown',
      content: MARKDOWN_BINARY_FRONTMATTER,
      byteLength: Buffer.byteLength(MARKDOWN_BINARY_FRONTMATTER),
    });

    // The premise: `yaml` decodes `!!binary` to a Buffer, which structured
    // clone lands as a Uint8Array. If this ever stops being true the pool may
    // ship `frontmatter` directly — but not before.
    expect(Buffer.isBuffer(result.frontmatter?.['blob'])).toBe(true);
    expect(structuredClone(result)).not.toStrictEqual(result);
  });
});

/**
 * How many markdown documents one thread's record says it parsed.
 *
 * @param dump - The dump the parent wrote
 * @param index - Which thread record, in the order the dump carries them
 * @returns That thread's markdown document count
 */
function markdownDocuments(dump: ParseTimingDump, index: number): number {
  const thread = dump.threads[index];
  if (thread === undefined) throw new Error(`dump carries no thread at index ${String(index)}`);
  const markdown = thread.kinds.find((group) => group.kind === 'markdown');
  if (markdown === undefined) throw new Error('thread record carries no markdown group');
  return markdown.documents.count;
}

describe('the parse-timing seam', () => {
  it('reports a worker thread’s counters to the parent, which writes the only dump', async () => {
    const directory = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-pool-timing-'));
    const previous = process.env['VAT_PARSE_TIMING'];
    // The worker reads this at ITS module load, from the copy of `process.env`
    // taken when the thread is constructed — which is the only channel a test
    // has to a gate the worker reads once and never again.
    process.env['VAT_PARSE_TIMING'] = directory;
    // This thread's gate was read at ITS module load, which `vitest.setup.js`
    // had already stripped, so it is armed through the seam's own escape. Both
    // sides have to be on: the parent drops a report it has nowhere to put.
    __setParseTimingForTest(directory);

    try {
      stubParkingMachine();
      const pool = createParsePool({ size: 1 });
      await pool.parse('markdown', MARKDOWN_RICH, Buffer.byteLength(MARKDOWN_RICH));
      await pool.shutdown();
      // A timed run parks nothing: a parked thread's counters would reach no dump.
      expect(__parkedParseWorkerCountForTest()).toBe(0);

      const beforeWriting = await fs.readdir(directory);
      // The worker files nothing of its own. A second, partial file would report
      // this process's whole lifetime a second time.
      expect(beforeWriting.filter((name) => name.startsWith('parse-timing-'))).toEqual([]);

      const path = __writeParseTimingDumpForTest();
      expect(path).not.toBeNull();
      const dump = JSON.parse(await fs.readFile(path ?? '', 'utf-8')) as ParseTimingDump;

      // Two records in ONE file: the writer, which dispatched but parsed
      // nothing, and the worker that did the parse.
      expect(dump.threads).toHaveLength(2);
      expect(markdownDocuments(dump, 0)).toBe(0);
      expect(markdownDocuments(dump, 1)).toBe(1);
      expect(dump.threads[1]?.threadId).toBeGreaterThan(0);
      // And one lifetime, because there is one process.
      expect(dump.process.wallMs).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env['VAT_PARSE_TIMING'];
      else process.env['VAT_PARSE_TIMING'] = previous;
      __setParseTimingForTest(null);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
