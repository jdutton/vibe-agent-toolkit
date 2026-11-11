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
import { existsSync, promises as fs } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { removeScratchDir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  workerHeapCeilingMb,
} from '../src/parse-limits.js';
import {
  __closeParkedParseWorkersForTest,
  __parkedParseWorkerCountForTest,
  __setParseWorkerEntryForTest,
  createParsePool,
  describeParseFailure,
  MIN_PARKING_APPLIED_MB,
  PARKED_HEAP_MB,
  PARKED_IDLE_MS,
  type ParsePool,
  toParseWire,
} from '../src/parse-pool.js';
import {
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

/**
 * A one-thread pool for a heap test, with the wall clock only as a backstop.
 *
 * @returns The pool, shut down after the test
 */
function heapTestPool(): ParsePool {
  const pool = createParsePool({ size: 1, limits: { timeMs: HEAP_DECISION_BACKSTOP_MS } });
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

afterEach(async () => {
  // First: a spy a timed-out test left on `Worker.prototype` would otherwise be
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
      `import { parentPort } from 'node:worker_threads';\n${READY_LINE}\nparentPort.on('message', () => { process.exit(3); });\n`,
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
const READY_LINE = 'parentPort.postMessage({ ready: true });';

/** The built worker, which a seeded entry can import to answer real parses. */
const BUILT_WORKER = pathToFileURL(safePath.resolve(import.meta.dirname, '..', 'dist', 'parse-worker.js')).href;

/**
 * @param body - The seeded entry's source
 * @returns The entry's path, already installed as the pool's worker entry
 */
async function seedWorkerEntry(body: string): Promise<string> {
  const directory = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-pool-seed-'));
  cacheRoots.push(directory);
  const entry = safePath.join(directory, 'seeded-worker.mjs');
  await fs.writeFile(entry, body, 'utf-8');
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
    await seedWorkerEntry(`import { parentPort } from 'node:worker_threads';\n${READY_LINE}\nparentPort.on('message', () => { process.exit(3); });\n`);
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
      "parentPort.on('message', (request) => { if (request?.content?.startsWith?.('# DIE')) process.exit(1); });",
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

  it('counts a thread stopped at its time limit before its parser loaded toward the same three', async () => {
    // A worker that loads and then never answers (a parser import that hangs)
    // is a broken install too: without this, each document waits out its whole
    // `timeMs` in turn and is blamed for it.
    //
    // 🔑 The clock is the test's (see the next test). A thread that has not yet
    // posted `ready` when its deadline fires is a broken install at once, so on a
    // real clock a thread slow to START under CI load (past 150 ms) called the
    // install broken on the first document. The deadline is advanced only once
    // `ready` has reached the pool; `performance` is faked with the timers, so
    // the pool never reads the stop as a late parent's.
    vi.useFakeTimers(TEST_CLOCK);
    const entry = await seedWorkerEntry(neverAnswering());
    const pool = createParsePool({ size: 1, limits: { timeMs: 150 } });
    openPools.push(pool);

    const outcomes: unknown[] = [];
    try {
      for (const content of ['# a\n', '# b\n', '# c\n']) {
        const outcome = outcomeOf(pool, content);
        await consumeMarker(readyMarker(entry));
        vi.advanceTimersByTime(150);
        outcomes.push(await outcome);
      }
      // The install is broken by now: no thread starts, so there is nothing to wait for.
      outcomes.push(await outcomeOf(pool, '# d\n'));
    } finally {
      vi.useRealTimers();
    }

    expect(outcomes.map((outcome) => (isParseLimitError(outcome) ? outcome.limit : isParserUnavailable(outcome)))).toStrictEqual([
      'timeMs',
      'timeMs',
      true,
      true,
    ]);
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
      '  parentPort.postMessage({ parserLoaded: request.kind });',
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
    // A thread that never answers, stopped at `timeMs` before its parser loaded,
    // counts toward the three — but only when the parent read the clock on time.
    // A parent this late was starved itself; the thread it judged may have been
    // starved by the same load, so the stop is a per-run `timeMs` refusal only.
    const entry = await seedWorkerEntry(neverAnswering());
    const pool = createParsePool({ size: 1, limits: { timeMs: 100 } });
    openPools.push(pool);

    // A stopped thread holds its slot until its `exit`, which needs the loop to
    // turn: each document is dispatched only once the last thread is gone, so the
    // pool spawns its replacement at once and the block below cannot starve it.
    const exits: Promise<void>[] = [];
    const onWorker = (message: unknown): void => {
      exits.push(new Promise((resolve) => (message as { worker: Worker }).worker.once('exit', () => resolve())));
    };
    diagnosticsChannel.subscribe('worker_threads', onWorker);
    const outcomes: unknown[] = [];
    try {
      for (const content of ['# a\n', '# b\n', '# c\n', '# d\n']) {
        const outcome = outcomeOf(pool, content);
        const dispatchedAt = performance.now();
        // Ready first: a thread stopped before `ready` is a broken install outright.
        blockUntil(() => existsSync(readyMarker(entry)) && performance.now() > dispatchedAt + 600);
        outcomes.push(await outcome);
        await exits.at(-1);
        await fs.rm(readyMarker(entry));
      }
    } finally {
      diagnosticsChannel.unsubscribe('worker_threads', onWorker);
    }

    expect(outcomes.map((outcome) => (isParseLimitError(outcome) ? outcome.limit : outcome))).toStrictEqual([
      'timeMs', 'timeMs', 'timeMs', 'timeMs',
    ]);
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
      "parentPort.on('message', () => { const poll = setInterval(() => { if (!existsSync(die)) return; clearInterval(poll); const error = new Error('out of memory'); error.code = 'ERR_WORKER_OUT_OF_MEMORY'; throw error; }, 5); });",
    ].join('\n'));
    let landed: HeapBounds | undefined;
    const sample = Worker.prototype.getHeapStatistics;
    const spy = vi.spyOn(Worker.prototype, 'getHeapStatistics').mockImplementation(function (this: Worker) {
      // Recorded a turn later, so the pool's own `then`, chained after this one, has run.
      return sample.call(this).then((stats) => {
        setImmediate(() => {
          landed = heapBounds(stats, this.resourceLimits?.maxYoungGenerationSizeMb ?? 0, resolveParseLimits(undefined).heapMb);
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

/**
 * Samples served past the end of a script before the job counts as undecided.
 * Counted in samples, never in wall clock, so a slow box cannot trip it.
 */
const UNDECIDED_AFTER_SAMPLES = 20;

/**
 * V8's ceiling a scripted heap reports: what the thread really reads, or a
 * fixed one. A process-wide `--max-old-space-size` (the Windows unit tier sets
 * 512) lowers the real one, and a young generation the Node version sizes
 * (96 MiB on Node 26, 192 on Node 24) decides whether a scripted shape fits
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
  vi.spyOn(Worker.prototype, 'getHeapStatistics').mockImplementation(function (this: Worker) {
    return sample.call(this).then((stats) => {
      const youngMb = this.resourceLimits?.maxYoungGenerationSizeMb ?? 0;
      const limitBytes = ceiling === 'as-read' ? stats.heap_size_limit : (ceiling.ceilingMb + youngMb) * BYTES_PER_MIB;
      if (read === undefined) {
        read = heapBounds({ heap_size_limit: limitBytes }, youngMb, resolveParseLimits(undefined).heapMb);
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
    "parentPort.on('message', () => undefined);",
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

describe('a heap past its bound', () => {
  it('is not stopped while it rises, only once a fall too deep for a scavenge shows what it still holds', async () => {
    // V8's ceiling is fixed at what an unflagged thread reads, not the real one:
    // under the Windows unit tier's 512 MiB flag the stop sits 128 MiB above the
    // bound, and Node 24's 192 MiB young generation leaves no rise below the stop
    // that a fall deeper than a scavenge can come back from.
    const unflagged = { ceilingMb: workerHeapCeilingMb(resolveParseLimits(undefined).heapMb) };
    const { bound, served, bounds } = await heapRefusalUnder(({ appliedMb, stopMb }, youngMb) => {
      // The rise must stay below the stop, or the stop decides instead.
      expect(appliedMb + youngMb + 4).toBeLessThan(stopMb);
      return [appliedMb + 1, appliedMb + youngMb + 2, appliedMb + youngMb + 4, appliedMb + 1];
    }, unflagged);

    expect(bound).toBe(ParseLimitError.heap(bounds?.appliedMb ?? 0, resolveParseLimits(undefined).heapMb).bound);
    expect(served).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it('is stopped past the stop with no fall at all, and not a sample before', async () => {
    const { bound, served, bounds } = await heapRefusalUnder(({ appliedMb, stopMb }) => [appliedMb + 1, stopMb, stopMb, stopMb, stopMb + 1], 'as-read');

    expect(bound).toBe(ParseLimitError.heap(bounds?.appliedMb ?? 0, resolveParseLimits(undefined).heapMb).bound);
    expect(served).toBeGreaterThanOrEqual(5);
  }, 60_000);
});

describe('a thread that dies uncontrolled', () => {
  it('counts against the pool\'s size until it has exited', async () => {
    // The thread throws, and its `exit` lags its `error` by a busy 400 ms, so a
    // pool that frees the slot at the error starts a replacement beside it.
    await seedWorkerEntry([
      "import { parentPort } from 'node:worker_threads';",
      "process.on('exit', () => { const until = Date.now() + 400; while (Date.now() < until); });",
      // Registered before the real worker's listener, so its throw ends the
      // dispatch and the real worker never answers the job.
      "parentPort.on('message', (request) => { if (request?.content?.startsWith?.('# DIE')) throw new Error('seeded death'); });",
      `await import(${JSON.stringify(BUILT_WORKER)});`,
    ].join('\n'));
    const pool = trackedPool(1);

    const { value: outcomes, widest } = await widestLiveWorkerThreads(
      async () => Promise.all([outcomeOf(pool, '# DIE\n'), outcomeOf(pool, '# ok\n')]),
    );

    expect(isParseWorkerDiedError(outcomes[0])).toBe(true);
    expect(outcomes[1]).toBe('answered');
    expect(widest).toBe(1);
  });
});

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
      'parentPort.postMessage({ parserLoaded: request.kind });',
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
  // half. The used heap is left real, well under PARKED_HEAP_MB, so only the bound decides.
  it.each([
    { label: 'never at 192 MiB, where the leftover would be a large share of the room', ceilingMb: 192, parked: 0 },
    { label: 'never at 958 MiB, where it applies one MiB under the floor', ceilingMb: MIN_PARKING_APPLIED_MB * 2 - 2, parked: 0 },
    { label: 'still at 960 MiB, where it applies the floor exactly', ceilingMb: MIN_PARKING_APPLIED_MB * 2, parked: 1 },
    { label: 'still at 1,024 MiB (the integration tier), where it applies 512 MiB', ceilingMb: 1024, parked: 1 },
  ])('is parked under a lowered heap ceiling only while the applied bound keeps the leftover small: $label', async ({ ceilingMb, parked }) => {
    stubParkingMachine({ ceilingMb });

    expect(await oneParse({ size: 1 })).toBe('answered');

    expect(__parkedParseWorkerCountForTest()).toBe(parked);
  });

  it('owns its death once it has posted anything to the pool that adopted it', async () => {
    stubParkingMachine();
    // `DIE` loads a parser the parked thread never had, says so, then kills the thread: the
    // document's doing, on a thread proven alive after adoption, so nothing runs it again.
    await seedWorkerEntry(intercepting(contentStartsWith('<p>DIE'), [
      "parentPort.postMessage({ parserLoaded: 'html' });",
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
    // The first thread to load claims the marker and serves; the second fails to load, late
    // enough that the first has answered and sits idle when the pool is judged broken.
    const marker = safePath.join(await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-pool-claim-')), 'claimed');
    cacheRoots.push(safePath.resolve(marker, '..'));
    await seedWorkerEntry([
      "import { closeSync, openSync } from 'node:fs';",
      'let first = true;',
      `try { closeSync(openSync(${JSON.stringify(marker)}, 'wx')); } catch { first = false; }`,
      'if (!first) {',
      '  await new Promise((resolve) => setTimeout(resolve, 1500));',
      "  throw new Error('seeded second-thread load failure');",
      '}',
      `await import(${JSON.stringify(BUILT_WORKER)});`,
    ].join('\n'));
    const pool = createParsePool({ size: 2 });
    openPools.push(pool);

    const outcomes = await Promise.all([outcomeOf(pool, '# one\n'), outcomeOf(pool, '# two\n')]);
    await pool.shutdown();

    expect(outcomes.filter((outcome) => outcome === 'answered')).toHaveLength(1);
    expect(outcomes.filter((outcome) => isParserUnavailable(outcome))).toHaveLength(1);
    expect(__parkedParseWorkerCountForTest()).toBe(0);
  });

  it('brings the parsers it loaded, so a slow document on it is never a death', async () => {
    stubParkingMachine();
    // `# SLOW` blocks before the real worker sees it, so on a thread whose parser never loaded a
    // stop at `timeMs` is a death; on the adopted thread the parser loaded a pool ago. `<p>DIE`
    // kills a fresh thread mid-job: a death everywhere. Deadline long enough for a loaded runner.
    await seedWorkerEntry(intercepting(`${contentStartsWith('# SLOW')} || ${contentStartsWith('<p>DIE')}`, [
      "if (request.content.startsWith('<p>DIE')) setTimeout(() => process.exit(3), 100);",
      'else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
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
