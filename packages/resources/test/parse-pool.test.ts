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

import { promises as fs } from 'node:fs';
import { availableParallelism } from 'node:os';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { computeContentKey, type KeyedContent } from '../src/content-key.js';
import { parseHtmlContent } from '../src/html-link-parser.js';
import { type ParseResult, parseMarkdownContent } from '../src/link-parser.js';
import type { DocumentParserKind } from '../src/mime-type.js';
import { ParseCache } from '../src/parse-cache.js';
import {
  __setParseWorkerEntryForTest,
  createParsePool,
  type ParsePool,
  toParseWire,
} from '../src/parse-pool.js';
import {
  __setParseTimingForTest,
  __writeParseTimingDumpForTest,
  type ParseTimingDump,
} from '../src/parse-timing.js';

import { workerThreadCount } from './test-helpers.js';

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
  const pools = openPools.splice(0, openPools.length);
  await Promise.all(pools.map(async (pool) => pool.shutdown()));
  const roots = cacheRoots.splice(0, cacheRoots.length);
  await Promise.all(
     
    roots.map(async (root) => fs.rm(root, { recursive: true, force: true })),
  );
  __setParseWorkerEntryForTest(null);
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path beneath this test's own mkdtemp root
    await fs.writeFile(
      entry,
      "import { parentPort } from 'node:worker_threads';\nparentPort.on('message', () => { process.exit(3); });\n",
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from this test's own mkdtemp root
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

  it('leaves no worker thread behind', async () => {
    const before = workerThreadCount();
    const pool = createParsePool({ size: 2 });
    await Promise.all([pool.parse('markdown', '# a\n', 4), pool.parse('html', '<p>b</p>', 8)]);

    await pool.shutdown();

    expect(workerThreadCount()).toBe(before);
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
      const pool = createParsePool({ size: 1 });
      await pool.parse('markdown', MARKDOWN_RICH, Buffer.byteLength(MARKDOWN_RICH));
      await pool.shutdown();

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtemp root
      const beforeWriting = await fs.readdir(directory);
      // The worker files nothing of its own. A second, partial file would report
      // this process's whole lifetime a second time.
      expect(beforeWriting.filter((name) => name.startsWith('parse-timing-'))).toEqual([]);

      const path = __writeParseTimingDumpForTest();
      expect(path).not.toBeNull();
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the path the seam just returned
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
