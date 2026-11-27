/**
 * Every parse job is stopped at its limit, and the pool survives it (I8).
 *
 * Each breach is driven by a real document through the real built worker — see
 * `parse-limit-fixtures.ts` — and each test asserts: the job rejects with a
 * {@link ParseLimitError} naming the limit it crossed, it does so near that
 * bound rather than whenever the document would have finished, and the SAME
 * pool then parses an ordinary document, so a breach costs one job and never
 * the pool.
 *
 * Time and heap breaches kill and replace the worker; stack and output breaches
 * are reported by it; input size is refused before dispatch.
 *
 * Every real pool in this file runs in a child process (`parse-pool-child.ts`), so this is
 * the system tier. A kill is proved BEFORE the pool is asked again, by the breached thread's
 * own `exit`, and the pool spawns lazily, so the old thread is gone, not merely abandoned while
 * it keeps parsing. What a process-wide heap flag does to the pool is proved beside this file,
 * in `parse-pool-heap-flags.system.test.ts` and `parse-pool-semi-space-flags.system.test.ts`.
 */

import { mkdtempSync, rmSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { MIN_HEAP_MB, resolveParseLimits } from '../../src/parse-limits.js';
import { deeplyNestedList, deeplyNestedQuote, manyLinks, TIGHT_LIMITS } from '../parse-limit-fixtures.js';
import { countFilesUnder } from '../test-helpers.js';

import { heapBreachUnder, MANY_LINKS_EXPRESSION, NO_FLAGS, poolInChild, tight } from './parse-pool-child.js';

/**
 * @param anchored - The YAML flow value to anchor
 * @param aliases - How many keys alias it
 * @returns A markdown document whose frontmatter writes `anchored` once and aliases it `aliases` times
 */
function aliasedFrontmatter(anchored: string, aliases: number): string {
  const keys = Array.from({ length: aliases }, (_, index) => `k${String(index)}: *x`);
  return withFrontmatter(`anchor: &x ${anchored}\n${keys.join('\n')}`);
}

/** @returns A markdown document whose frontmatter is `frontmatter` */
function withFrontmatter(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n\n# Body\n`;
}

describe('a parse job stopped at its limit', () => {
  it('kills a job that runs past its wall-clock limit, and replaces the worker', () => {
    // A heap roomy enough that the clock, not the heap, is what the nesting meets first.
    const outcome = poolInChild(NO_FLAGS, [
      `const pool = openPool(${tight({ heapMb: 1024 })});`,
      'const { limit, parseMs } = await breach(pool, docs.nested);',
      'return { limit, parseMs, killed: await allExited(), links: await stillParses(pool) };',
    ], { nested: deeplyNestedList() }) as { limit: string; parseMs: number | null; killed: boolean; links: number };

    expect(outcome.limit).toBe('timeMs');
    // Near the bound, not when the parse would have finished (seconds later). Timed from the
    // thread's `parserLoaded`, where `timeMs` starts: the load before it runs on `loadMs`, and a
    // starved host's slow load is not the parse running long.
    expect(outcome.parseMs, 'no parser loaded for the job').not.toBeNull();
    expect(outcome.parseMs).toBeLessThan(TIGHT_LIMITS.timeMs + 5000);
    expect(outcome.killed, 'the breached thread never exited').toBe(true);
    expect(outcome.links).toBe(1);
  });

  it('reports a job that recurses past its stack, and keeps its worker', () => {
    // A clock roomy enough that a starved host's recursion meets the stack before the clock.
    // A heap roomy enough that the stack, not the heap, is what the recursion meets first.
    const outcome = poolInChild(NO_FLAGS, [
      `const pool = openPool(${tight({ timeMs: 30_000, heapMb: 512 })});`,
      'const { limit } = await breach(pool, docs.quote);',
      'return { limit, links: await stillParses(pool), exited: threads.exited };',
    ], { quote: deeplyNestedQuote() });

    // The worker reported the breach itself, so it is the pool's one thread, still alive.
    expect(outcome).toStrictEqual({ limit: 'stackMb', links: 1, exited: [false] });
  });

  it('kills a job whose allocation outgrows its heap, and replaces the worker', () => {
    // At the least bound a caller may name. The breach is the document's alone; a second thread
    // is started only once the breached one has exited; and the same pool answers on it.
    const outcome = poolInChild(NO_FLAGS, [
      `const pool = openPool(${tight({ heapMb: MIN_HEAP_MB, timeMs: 60_000, outputRows: 10_000_000, outputBytes: 1024 * 1024 * 1024 })});`,
      `const doc = ${MANY_LINKS_EXPRESSION};`,
      "const limit = await stoppedAt(pool.parse('markdown', doc, doc.length));",
      'return { limit, links: await stillParses(pool), startedAfterExits: threads.startedAfterExits };',
    ]);

    expect(outcome).toStrictEqual({ limit: 'heapMb', links: 1, startedAfterExits: [true, true] });
  });

  it('refuses an oversize document without handing it to a worker', () => {
    const outcome = poolInChild(NO_FLAGS, [
      `const pool = openPool(${tight({ inputBytes: 1024 })});`,
      "const { limit } = await breach(pool, 'x'.repeat(2048));",
      'return { limit, started: threads.exited.length };',
    ]);

    expect(outcome).toStrictEqual({ limit: 'inputBytes', started: 0 });
  });

  it('counts nested rows: one heading over 20,000 subheadings breaches the default row cap', () => {
    // Default limits but the clock: the tree has ONE top-level heading, so a
    // top-level count would see 1 row and let it through.
    const subheadings = Array.from({ length: 20_000 }, (_, index) => `## h${String(index)}\n`);
    const outcome = poolInChild(NO_FLAGS, [
      `const pool = openPool(${JSON.stringify({ ...resolveParseLimits(undefined), timeMs: 60_000 })});`,
      'const { limit } = await breach(pool, docs.headings);',
      'return { limit, links: await stillParses(pool) };',
    ], { headings: ['# top\n', ...subheadings].join('\n') });

    expect(outcome).toStrictEqual({ limit: 'outputRows', links: 1 });
  });

  it.each([
    ['has more rows than', { outputRows: 10 }, 'outputRows'],
    ['serialises past', { outputBytes: 512 }, 'outputBytes'],
  ])('reports a job whose output %s its cap', (_label, overrides, expected) => {
    const outcome = poolInChild(NO_FLAGS, [
      `const pool = openPool(${tight(overrides)});`,
      'const { limit } = await breach(pool, docs.links);',
      'return { limit, links: await stillParses(pool) };',
    ], { links: manyLinks(20) });

    expect(outcome).toStrictEqual({ limit: expected, links: 1 });
  });

  it('counts each frontmatter alias by its target: an anchor aliased 99 times breaches the row cap, and nothing is stored', async () => {
    // 20 items, written once and aliased 99 times: 2,000 rows expanded, over
    // the cap of 1,000; the encoding the worker sends shares the anchor, so a
    // count over what crosses the wire sees none of them.
    const cacheDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-alias-rows-'));
    const document = aliasedFrontmatter('[' + Array.from({ length: 20 }, () => '1').join(', ') + ']', 99);
    const outcome = poolInChild(NO_FLAGS, [
      `const pool = openPool(${tight({ timeMs: 30_000 })}, { cacheDir: ${JSON.stringify(cacheDir)} });`,
      "const limit = await stoppedAt(pool.parseIntoCache('markdown', docs.aliased, Buffer.byteLength(docs.aliased), 'a'.repeat(64)));",
      'return { limit, links: await stillParses(pool) };',
    ], { aliased: document });

    expect(outcome).toStrictEqual({ limit: 'outputRows', links: 1 });
    expect(await countFilesUnder(cacheDir)).toBe(0);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it.each([
    // A list, so the encoding shares it (a bare string is inlined at every use): 400 kB expanded,
    // over the cap of 256 KiB, in 100 rows, under the row cap.
    ['a list of one long string aliased 99 times breaches the byte cap', aliasedFrontmatter(`[${'x'.repeat(4000)}]`, 99), 'outputBytes'],
    ['a !!set of 2,000 members breaches the row cap, though JSON writes it as {}', withFrontmatter('s: !!set\n' + Array.from({ length: 2000 }, (_, index) => `  ? m${String(index)}`).join('\n')), 'outputRows'],
    ['a !!omap of 2,000 entries breaches the row cap, though JSON writes it as {}', withFrontmatter('m: !!omap\n' + Array.from({ length: 2000 }, (_, index) => `  - k${String(index)}: 1`).join('\n')), 'outputRows'],
  ])('counts every member the codec carries: %s', (_label, document, expected) => {
    const outcome = poolInChild(NO_FLAGS, [
      `const pool = openPool(${tight({ timeMs: 30_000 })});`,
      'const { limit } = await breach(pool, docs.document);',
      'return { limit, links: await stillParses(pool) };',
    ], { document });

    expect(outcome).toStrictEqual({ limit: expected, links: 1 });
  });

  it('lets the same anchor through when it is aliased once', () => {
    const outcome = poolInChild(NO_FLAGS, [
      `const pool = openPool(${tight({ timeMs: 30_000 })});`,
      "const result = await pool.parse('markdown', docs.aliased, Buffer.byteLength(docs.aliased));",
      "return result.frontmatter?.['k0']?.length;",
    ], { aliased: aliasedFrontmatter('[' + Array.from({ length: 20 }, () => '1').join(', ') + ']', 1) });

    expect(outcome).toBe(20);
  });

  it('never runs wider than its size while every worker breaches at once and is replaced', () => {
    const size = 3;
    const outcome = poolInChild(NO_FLAGS, [
      `const pool = openPool(${tight({ heapMb: 1024 })}, { size: ${String(size)} });`,
      // `size` jobs that each run past the clock, then ordinary ones queued behind them: each kill
      // frees a job for the queue, and its replacement must wait for the killed thread to exit.
      `const stopped = Array.from({ length: ${String(size)} }, () => breach(pool, docs.nested));`,
      String.raw`const queued = Array.from({ length: ${String(size * 2)} }, () => pool.parse('markdown', '# ok\n', 5));`,
      'const outcomes = await Promise.all(stopped);',
      'await Promise.all(queued);',
      'return { limits: outcomes.map((outcome) => outcome.limit), widest: threads.widest };',
    ], { nested: deeplyNestedList() });

    expect(outcome).toStrictEqual({ limits: Array.from({ length: size }, () => 'timeMs'), widest: size });
  });

  it('answers the other jobs in flight beside a breach', () => {
    const outcome = poolInChild(NO_FLAGS, [
      `const pool = openPool(${tight({ heapMb: 512 })}, { size: 2 });`,
      'const [stopped, answered] = await Promise.allSettled([',
      "  pool.parse('markdown', docs.quote, 1),",
      String.raw`  pool.parse('markdown', '[a](./b.md)\n', 12),`,
      ']);',
      "return { stoppedAtALimit: stopped.status === 'rejected' && isParseLimitError(stopped.reason), links: answered.status === 'fulfilled' ? answered.value.links.length : 0 };",
    ], { quote: deeplyNestedQuote() });

    expect(outcome).toStrictEqual({ stoppedAtALimit: true, links: 1 });
  });
});

describe('the least heapMb a caller may configure', () => {
  it('is more than a fresh thread really holds once it has loaded both parsers', () => {
    // The least bound a caller may name must leave a thread room to load its parsers: on a
    // runtime whose thread loads them in more, it could not load one. Measured on the thread that
    // parsed, through the pool, after a markdown and an HTML parse.
    const outcome = poolInChild(NO_FLAGS, [
      'const pool = openPool({});',
      String.raw`await pool.parse('markdown', '# loaded\n', 9);`,
      "await pool.parse('html', '<p>loaded</p>', 13);",
      // An idle pool thread is unreferenced, and its heap read does not hold the loop open.
      'const awake = setInterval(() => {}, 1000);',
      'const heap = await threads.workers[0]?.getHeapStatistics();',
      'clearInterval(awake);',
      'return { threads: threads.workers.length, usedMb: (heap?.used_heap_size ?? 0) / (1024 * 1024) };',
    ]) as { threads: number; usedMb: number };

    expect(outcome.threads).toBe(1);
    expect(outcome.usedMb).toBeGreaterThan(0);
    expect(outcome.usedMb).toBeLessThan(MIN_HEAP_MB);
  });

  it('is a bound a pool loads and runs both parsers under, and its process exits cleanly', () => {
    const outcome = poolInChild(NO_FLAGS, [
      `const pool = openPool({ heapMb: ${String(MIN_HEAP_MB)} });`,
      'const answered = (outcome) => outcome.then((result) => result.sizeBytes, (error) => String(error));',
      String.raw`const markdown = await answered(pool.parse('markdown', '# minimum\n', 10));`,
      "const html = await answered(pool.parse('html', '<p>minimum</p>', 14));",
      'return { markdown, html };',
    ]);

    expect(outcome).toStrictEqual({ markdown: 10, html: 14 });
  });
});

describe('a heap breach with no process-wide flag', () => {
  it('never takes the process down', () => {
    // Measured on Node 26: when V8's ceiling was `heapMb` itself (64 MiB), a worker
    // under fast allocation reached it before the sampler could stop it, and the
    // FATAL out-of-memory took the whole process down in 3 runs of 4; the ceiling
    // is now twice `heapMb`, so the pool must stop the job before V8 does. Three
    // breaches in a row at the least bound a caller may name, each in a child that
    // must exit 0, so a pool that leaves the race to V8 loses it.
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = heapBreachUnder(NO_FLAGS, MIN_HEAP_MB, 0);

      expect(outcome.limit).toBe('heapMb');
      expect(outcome.bound).toBe(`${String(MIN_HEAP_MB)} MiB heap`);
    }
  });
});
