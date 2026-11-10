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
 * are reported by it; input size is refused before dispatch. A kill is proved by
 * Node's own thread table returning to its baseline BEFORE the pool is asked
 * again — the pool spawns lazily, so the old thread is gone, not merely
 * abandoned while it keeps parsing.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ParseLimitName,
  type ParseLimits,
  isParseLimitError,
  resolveParseLimits,
} from '../../src/parse-limits.js';
import { createParsePool, type ParsePool } from '../../src/parse-pool.js';
import {
  deeplyNestedList,
  deeplyNestedQuote,
  manyLinks,
  TIGHT_LIMITS,
} from '../parse-limit-fixtures.js';
import { countFilesUnder, widestLiveWorkerThreads, workerThreadCount } from '../test-helpers.js';

const openPools: ParsePool[] = [];

afterEach(async () => {
  await Promise.all(openPools.splice(0, openPools.length).map(async (pool) => pool.shutdown()));
});

function limitedPool(limits: Partial<ParseLimits> = {}): ParsePool {
  const pool = createParsePool({ size: 1, limits: { ...TIGHT_LIMITS, ...limits } });
  openPools.push(pool);
  return pool;
}

/**
 * Parse `content` and return the limit it was stopped at, failing if it was not.
 *
 * @returns The limit's name and how long the rejection took
 */
async function breach(pool: ParsePool, content: string): Promise<{ limit: ParseLimitName; ms: number }> {
  const startedAt = performance.now();
  const error: unknown = await pool.parse('markdown', content, Buffer.byteLength(content)).then(
    () => new Error('the parse completed; it was meant to be stopped at a limit'),
    (rejection: unknown) => rejection,
  );
  const ms = performance.now() - startedAt;
  if (!isParseLimitError(error)) throw error;
  return { limit: error.limit, ms };
}

/**
 * The breached thread really died: Node's thread table is back to `baseline`.
 * The pool spawns only on demand, so a replacement cannot mask a survivor.
 */
async function expectWorkerKilled(baseline: number): Promise<void> {
  await vi.waitFor(() => {
    expect(workerThreadCount()).toBe(baseline);
  }, { timeout: 5000, interval: 25 });
}

/** The pool still answers an ordinary document after a breach. */
async function expectPoolStillParses(pool: ParsePool): Promise<void> {
  const result = await pool.parse('markdown', '# ok\n\n[a](./b.md)\n', 21);
  expect(result.links).toHaveLength(1);
}

/**
 * @param anchored - The YAML flow value to anchor
 * @param aliases - How many keys alias it
 * @returns A markdown document whose frontmatter writes `anchored` once and aliases it `aliases` times
 */
function aliasedFrontmatter(anchored: string, aliases: number): string {
  const keys = Array.from({ length: aliases }, (_, index) => `k${String(index)}: *x`);
  return `---\nanchor: &x ${anchored}\n${keys.join('\n')}\n---\n\n# Body\n`;
}

describe('a parse job stopped at its limit', () => {
  it('kills a job that runs past its wall-clock limit, and replaces the worker', async () => {
    const baseline = workerThreadCount();
    // A heap roomy enough that the clock, not the heap, is what the nesting meets first.
    const pool = limitedPool({ heapMb: 1024 });

    const { limit, ms } = await breach(pool, deeplyNestedList());

    expect(limit).toBe('timeMs');
    // Near the bound, not when the parse would have finished (seconds later).
    expect(ms).toBeLessThan(TIGHT_LIMITS.timeMs + 5000);
    await expectWorkerKilled(baseline);
    await expectPoolStillParses(pool);
  });

  it('reports a job that recurses past its stack, and keeps its worker', async () => {
    const baseline = workerThreadCount();
    // The wall clock includes the worker's first parser load, which on a cold
    // thread can outlast the tight bound before the recursion is ever reached.
    // A heap roomy enough that the stack, not the heap, is what the recursion meets first.
    const pool = limitedPool({ timeMs: 30_000, heapMb: 512 });

    const { limit } = await breach(pool, deeplyNestedQuote());

    expect(limit).toBe('stackMb');
    // The worker reported the breach itself, so it is still the pool's one thread.
    expect(workerThreadCount()).toBe(baseline + 1);
    await expectPoolStillParses(pool);
  });

  it('kills a job whose allocation outgrows its heap, and replaces the worker', async () => {
    const baseline = workerThreadCount();
    const pool = limitedPool({ timeMs: 60_000, outputRows: 10_000_000, outputBytes: 1024 * 1024 * 1024 });

    const { limit } = await breach(pool, manyLinks(200_000));

    expect(limit).toBe('heapMb');
    await expectWorkerKilled(baseline);
    await expectPoolStillParses(pool);
  });

  it('refuses an oversize document without handing it to a worker', async () => {
    const before = workerThreadCount();
    const pool = limitedPool({ inputBytes: 1024 });

    const { limit } = await breach(pool, 'x'.repeat(2048));

    expect(limit).toBe('inputBytes');
    expect(workerThreadCount()).toBe(before);
  });

  it('counts nested rows: one heading over 20,000 subheadings breaches the default row cap', async () => {
    // Default limits but the clock: the tree has ONE top-level heading, so a
    // top-level count would see 1 row and let it through.
    const pool = limitedPool({ ...resolveParseLimits(undefined), timeMs: 60_000 });
    const subheadings = Array.from({ length: 20_000 }, (_, index) => `## h${String(index)}\n`);
    const document = ['# top\n', ...subheadings].join('\n');

    const { limit } = await breach(pool, document);

    expect(limit).toBe('outputRows');
    await expectPoolStillParses(pool);
  });

  it('reports a job whose output has more rows than its cap', async () => {
    const pool = limitedPool({ outputRows: 10 });

    const { limit } = await breach(pool, manyLinks(20));

    expect(limit).toBe('outputRows');
    await expectPoolStillParses(pool);
  });

  it('reports a job whose output serialises past its byte cap', async () => {
    const pool = limitedPool({ outputBytes: 512 });

    const { limit } = await breach(pool, manyLinks(20));

    expect(limit).toBe('outputBytes');
    await expectPoolStillParses(pool);
  });

  it('counts each frontmatter alias by its target: an anchor aliased 99 times breaches the row cap, and nothing is stored', async () => {
    // 20 items, written once and aliased 99 times: 2,000 rows expanded, over
    // the cap of 1,000; the encoding the worker sends shares the anchor, so a
    // count over what crosses the wire sees none of them.
    const cacheDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-alias-rows-'));
    const pool = createParsePool({ size: 1, cacheDir, limits: { ...TIGHT_LIMITS, timeMs: 30_000 } });
    openPools.push(pool);
    const document = aliasedFrontmatter('[' + Array.from({ length: 20 }, () => '1').join(', ') + ']', 99);

    const error: unknown = await pool.parseIntoCache('markdown', document, Buffer.byteLength(document), 'a'.repeat(64)).then(
      () => new Error('the parse completed; it was meant to be stopped at outputRows'),
      (rejection: unknown) => rejection,
    );

    expect(isParseLimitError(error) ? error.limit : error).toBe('outputRows');
    expect(await countFilesUnder(cacheDir)).toBe(0);
    rmSync(cacheDir, { recursive: true, force: true });
    await expectPoolStillParses(pool);
  });

  it('counts each frontmatter alias by its target: a list of one long string aliased 99 times breaches the byte cap', async () => {
    // A list, so the encoding shares it (a bare string is inlined at every
    // use): 400 kB expanded, over the cap of 256 KiB, in 100 rows, under the row cap.
    const pool = limitedPool({ timeMs: 30_000 });

    const { limit } = await breach(pool, aliasedFrontmatter(`[${'x'.repeat(4000)}]`, 99));

    expect(limit).toBe('outputBytes');
  });

  it('lets the same anchor through when it is aliased once', async () => {
    const pool = limitedPool({ timeMs: 30_000 });
    const document = aliasedFrontmatter('[' + Array.from({ length: 20 }, () => '1').join(', ') + ']', 1);

    const result = await pool.parse('markdown', document, Buffer.byteLength(document));

    expect(result.frontmatter?.['k0']).toHaveLength(20);
  });

  it('never runs wider than its size while every worker breaches at once and is replaced', async () => {
    const size = 3;
    const pool = createParsePool({ size, limits: { ...TIGHT_LIMITS, heapMb: 1024 } });
    openPools.push(pool);
    const { value: limits, widest } = await widestLiveWorkerThreads(async () => {
      // `size` jobs that each run past the clock, then ordinary ones queued behind them: each kill
      // frees a job for the queue, and its replacement must wait for the killed thread to exit.
      const stopped = Array.from({ length: size }, async () => breach(pool, deeplyNestedList()));
      const queued = Array.from({ length: size * 2 }, async () => pool.parse('markdown', '# ok\n', 5));
      const outcomes = await Promise.all(stopped);
      await Promise.all(queued);
      return outcomes;
    });

    expect(limits.map((outcome) => outcome.limit)).toStrictEqual(Array.from({ length: size }, () => 'timeMs'));
    expect(widest).toBe(size);
  });

  it('answers the other jobs in flight beside a breach', async () => {
    const pool = createParsePool({ size: 2, limits: { ...TIGHT_LIMITS, heapMb: 512 } });
    openPools.push(pool);

    const [stopped, answered] = await Promise.allSettled([
      pool.parse('markdown', deeplyNestedQuote(), 1),
      pool.parse('markdown', '[a](./b.md)\n', 12),
    ]);

    expect(stopped.status === 'rejected' && isParseLimitError(stopped.reason)).toBe(true);
    expect(answered.status === 'fulfilled' ? answered.value.links : []).toHaveLength(1);
  });
});

/**
 * The BUILT pool, as a child process imports it — so the child's own heap flags
 * are the ones under test, never the test runner's.
 */
const BUILT_POOL = pathToFileURL(safePath.resolve(import.meta.dirname, '..', '..', 'dist', 'parse-pool.js')).href;

/**
 * Run the built pool in a child process under `nodeOptions`, parsing a document
 * that outgrows its heap, and report the limit it was stopped at.
 *
 * @param nodeOptions - The child's `NODE_OPTIONS`
 * @param heapMb - The pool's `heapMb`
 * @param stallMs - How long the child's own thread blocks at a time, back to
 *   back, while the job runs (0: never) — so the heap sampler, which runs on
 *   that thread, reads late
 * @returns The limit's name, its bound, and how long the rejection took
 */
function heapBreachUnder(nodeOptions: string, heapMb: number, stallMs: number): { limit: string; bound: string; ms: number } {
  const script = [
    `const { createParsePool } = await import(${JSON.stringify(BUILT_POOL)});`,
    String.raw`const doc = Array.from({ length: 200000 }, (_, i) => '[link ' + i + '](./t-' + i + '.md)\n').join('\n');`,
    `const pool = createParsePool({ size: 1, limits: { heapMb: ${String(heapMb)}, timeMs: 60000, outputRows: 1e9, outputBytes: 1e10, inputBytes: 1e9 } });`,
    `const stall = ${String(stallMs)} > 0 ? setInterval(() => { const until = performance.now() + ${String(stallMs)}; while (performance.now() < until); }, 1) : undefined;`,
    'const startedAt = performance.now();',
    "const outcome = await pool.parse('markdown', doc, doc.length).then(() => ({ limit: 'none', bound: '' }), (error) => ({ limit: error.limit ?? String(error), bound: error.bound ?? '' }));",
    'if (stall !== undefined) clearInterval(stall);',
    'console.log(JSON.stringify({ ...outcome, ms: performance.now() - startedAt }));',
    'await pool.shutdown();',
  ].join('\n');
  // A script FILE, not `--eval`: a worker inherits its parent's execArgv,
  // and `--input-type` is refused by a worker started from a file.
  const directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-heap-flag-'));
  const entry = safePath.join(directory, 'heap-flag.mjs');
  writeFileSync(entry, script, 'utf-8');
  const child = spawnSync(process.execPath, [entry], {
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
    encoding: 'utf-8',
  });
  rmSync(directory, { recursive: true, force: true });

  expect(child.stderr).toBe('');
  return JSON.parse(child.stdout) as { limit: string; bound: string; ms: number };
}

describe('a process-wide heap flag', () => {
  it('cannot lift a job\'s heap limit', () => {
    // A process-wide `--max-old-space-size` (NODE_OPTIONS, common in CI) is a V8
    // global flag, and it overrides a worker's `resourceLimits`: measured, under
    // 4096 a worker given 48 MiB reports a 4,192 MiB heap limit and a runaway
    // allocation runs until the wall clock stops it. The job must still be
    // stopped at its HEAP limit, well before its wall-clock one.
    const outcome = heapBreachUnder('--max-old-space-size=4096', 48, 0);

    expect(outcome.limit).toBe('heapMb');
    expect(outcome.bound).toBe('48 MiB heap');
    expect(outcome.ms).toBeLessThan(30_000);
  });

  it('is named in the refusal when it lowers the limit', () => {
    // Lower than `heapMb`, the flag caps V8's ceiling, and the pool stops the
    // job at half of it, so the refusal names that value, not the configured one.
    const outcome = heapBreachUnder('--max-old-space-size=64', 1024, 0);

    expect(outcome.limit).toBe('heapMb');
    expect(outcome.bound).toContain('32 MiB heap');
    expect(outcome.bound).toContain('--max-old-space-size');
  });
});

describe('a heap breach while the parent thread stalls', () => {
  it('is still stopped at the applied limit when every stall is shorter than the window', () => {
    // The sampler runs on the parent's event loop, so a parent blocked
    // synchronously reads the worker's heap late. Under a 512 MiB flag the job
    // is stopped at 256 MiB, and V8's ceiling is 512: a sample up to about two
    // stalls late (400 ms back to back, so at most ~800 ms) still lands before
    // the worker reaches it. Measured on Node 26: 600 ms stalls let V8 stop the
    // worker first. See the hazard register's heap-flag row.
    const outcome = heapBreachUnder('--max-old-space-size=512', 1024, 400);

    expect(outcome.limit).toBe('heapMb');
    expect(outcome.bound).toContain('256 MiB heap');
  });
});

describe('a heap breach with no process-wide flag', () => {
  it('never takes the process down', () => {
    // Measured on Node 26: a worker that reaches V8's OWN ceiling under fast
    // allocation dies with a FATAL out-of-memory that kills the whole process
    // (3 runs in 4 at 64 MiB), so the pool must stop the job before V8 does.
    // Three breaches in a row, so a pool that leaves the race to V8 loses it.
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = heapBreachUnder('', 64, 0);

      expect(outcome.limit).toBe('heapMb');
      expect(outcome.bound).toBe('64 MiB heap');
    }
  });
});
