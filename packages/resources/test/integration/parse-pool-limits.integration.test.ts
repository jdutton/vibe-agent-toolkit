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
import { describe, expect, it, vi } from 'vitest';

import {
  type ParseLimitName,
  isParseLimitError,
  resolveParseLimits,
} from '../../src/parse-limits.js';
import type { ParsePool } from '../../src/parse-pool.js';
import {
  deeplyNestedList,
  deeplyNestedQuote,
  limitedPools,
  limitStoppedAt,
  manyLinks,
  TIGHT_LIMITS,
} from '../parse-limit-fixtures.js';
import { countFilesUnder, widestLiveWorkerThreads, workerThreadCount } from '../test-helpers.js';

const limitedPool = limitedPools();

/**
 * Parse `content` and return the limit it was stopped at, failing if it was not.
 *
 * @returns The limit's name and how long the rejection took
 */
async function breach(pool: ParsePool, content: string): Promise<{ limit: ParseLimitName; ms: number }> {
  const startedAt = performance.now();
  const limit = await limitStoppedAt(pool.parse('markdown', content, Buffer.byteLength(content)));
  return { limit, ms: performance.now() - startedAt };
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
    const pool = limitedPool({ timeMs: 30_000 }, { cacheDir });
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

  it.each([
    ['a !!set of 2,000 members', 's: !!set\n' + Array.from({ length: 2000 }, (_, index) => `  ? m${String(index)}`).join('\n')],
    ['a !!omap of 2,000 entries', 'm: !!omap\n' + Array.from({ length: 2000 }, (_, index) => `  - k${String(index)}: 1`).join('\n')],
  ])('counts every member the codec carries: %s breaches the row cap, though JSON writes it as {}', async (_label, frontmatter) => {
    const pool = limitedPool({ timeMs: 30_000 });

    const { limit } = await breach(pool, `---\n${frontmatter}\n---\n\n# Body\n`);

    expect(limit).toBe('outputRows');
    await expectPoolStillParses(pool);
  });

  it('lets the same anchor through when it is aliased once', async () => {
    const pool = limitedPool({ timeMs: 30_000 });
    const document = aliasedFrontmatter('[' + Array.from({ length: 20 }, () => '1').join(', ') + ']', 1);

    const result = await pool.parse('markdown', document, Buffer.byteLength(document));

    expect(result.frontmatter?.['k0']).toHaveLength(20);
  });

  it('never runs wider than its size while every worker breaches at once and is replaced', async () => {
    const size = 3;
    const pool = limitedPool({ heapMb: 1024 }, { size });
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
    const pool = limitedPool({ heapMb: 512 }, { size: 2 });

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

/** A stall that holds the child's thread from dispatch until the worker thread is gone: see {@link BLOCK_UNTIL_THE_WORKER_IS_GONE}. */
const UNTIL_THE_WORKER_IS_GONE = 'until-the-worker-is-gone';

/**
 * The child's thread blocks, from just after dispatch, until Node's own thread
 * table (`process.report`, read synchronously) has listed the worker and then
 * no longer lists it. The heap sampler runs on that thread, so no sample lands
 * while the job runs, whatever the host's speed: V8's ceiling is the only thing
 * that can stop the worker — on any clock — so the refusal must name it. A
 * fixed stall raced the sampler instead: the worker allocated to the 256 MiB
 * bound inside one stall's gap and the sampler stopped it first.
 */
const BLOCK_UNTIL_THE_WORKER_IS_GONE = [
  'const workers = () => process.report.getReport().workers.length;',
  'const pause = new Int32Array(new SharedArrayBuffer(4));',
  'const stall = setTimeout(() => {',
  '  const giveUpAt = performance.now() + 120000;',
  '  let seen = false;',
  '  while (!seen || workers() > 0) {',
  '    if (workers() > 0) seen = true;',
  "    if (performance.now() > giveUpAt) throw new Error('the worker never came and went');",
  '    Atomics.wait(pause, 0, 0, 20);',
  '  }',
  '}, 0);',
].join('\n');

/**
 * Run the built pool in a child process under `nodeOptions`, parsing a document
 * that outgrows its heap, and report the limit it was stopped at.
 *
 * @param nodeOptions - The child's `NODE_OPTIONS`
 * @param heapMb - The pool's `heapMb`
 * @param stall - How long the child's own thread blocks at a time, back to
 *   back, while the job runs (0: never) — so the heap sampler, which runs on
 *   that thread, reads late; or {@link UNTIL_THE_WORKER_IS_GONE}
 * @returns The limit's name, its bound, how long the rejection took, and the child's exit status
 */
function heapBreachUnder(nodeOptions: string, heapMb: number, stall: number | typeof UNTIL_THE_WORKER_IS_GONE): ChildOutcome {
  return parseInChild(
    nodeOptions,
    String.raw`Array.from({ length: 200000 }, (_, i) => '[link ' + i + '](./t-' + i + '.md)\n').join('\n')`,
    `{ heapMb: ${String(heapMb)}, timeMs: 60000, outputRows: 1e9, outputBytes: 1e10, inputBytes: 1e9 }`,
    stall,
  );
}

/** What a child process's one parse came to — see {@link parseInChild}. */
interface ChildOutcome {
  /** The limit it was stopped at, or `none` when it was admitted. */
  limit: string;
  bound: string;
  ms: number;
  status: number | null;
}

/**
 * Run the built pool in a child process under `nodeOptions`, parse one document
 * and report what became of it.
 *
 * @param nodeOptions - The child's `NODE_OPTIONS`
 * @param documentExpression - A JavaScript expression the child evaluates to the document
 * @param limitsLiteral - The pool's limits, as a JavaScript object literal
 * @param stall - See {@link heapBreachUnder}
 * @returns The limit's name (`none` when admitted), its bound, how long the parse took, and the child's exit status
 */
function parseInChild(
  nodeOptions: string,
  documentExpression: string,
  limitsLiteral: string,
  stall: number | typeof UNTIL_THE_WORKER_IS_GONE,
): ChildOutcome {
  const script = [
    `const { createParsePool } = await import(${JSON.stringify(BUILT_POOL)});`,
    `const doc = ${documentExpression};`,
    `const pool = createParsePool({ size: 1, limits: ${limitsLiteral} });`,
    'const startedAt = performance.now();',
    "const pending = pool.parse('markdown', doc, doc.length);",
    stall === UNTIL_THE_WORKER_IS_GONE ? BLOCK_UNTIL_THE_WORKER_IS_GONE : `const stall = ${String(stall)} > 0 ? setInterval(() => { const until = performance.now() + ${String(stall)}; while (performance.now() < until); }, 1) : undefined;`,
    "const outcome = await pending.then(() => ({ limit: 'none', bound: '' }), (error) => ({ limit: error.limit ?? String(error), bound: error.bound ?? '' }));",
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
  return { ...(JSON.parse(child.stdout) as { limit: string; bound: string; ms: number }), status: child.status };
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

  it('still admits an ordinary document when it is small: 128 MiB, which the pool applies as 96, not half', () => {
    // The sampler counts the whole used heap, young-generation garbage
    // included, and a cold worker parsing this 34 KB document peaks at 54 to
    // 68 MiB used (Node 26, see the limits record). At half of a 128 MiB flag
    // (64) about one parse in ten was refused; the bound is floored at the
    // young generation's 96 MiB while the ceiling leaves the sampler 32 above it.
    const ordinary = String.raw`Array.from({ length: 400 }, (_, i) => '## Section ' + i + '\n\nProse with a [link](./doc-' + i + '.md), \x60code\x60 and *emphasis*.\n\n- item ' + i + '\n').join('\n')`;

    const outcome = parseInChild('--max-old-space-size=128', ordinary, '{}', 0);

    expect(outcome.status).toBe(0);
    expect(outcome.limit, outcome.bound).toBe('none');
  });

  it('stops a breach at that floored bound before V8 does, three times in a row, and the process survives', () => {
    // The floor leaves 32 MiB between the bound and V8's ceiling, where half a
    // 128 MiB flag left 64: the sampler must still win the race V8 makes fatal.
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = heapBreachUnder('--max-old-space-size=128', 1024, 0);

      expect(outcome.status).toBe(0);
      expect(outcome.bound).toBe('96 MiB heap, lowered from 1024 MiB by a process-wide --max-old-space-size');
    }
  });
});

describe('a heap breach while the parent thread stalls', () => {
  it('is still stopped at the applied limit when every stall is shorter than the window', () => {
    // The sampler runs on the parent's event loop, so a parent blocked
    // synchronously reads the worker's heap late. Under a 512 MiB flag the job
    // is stopped at 256 MiB, and V8's ceiling is 512: a sample up to about two
    // stalls late (400 ms back to back, so at most ~800 ms) still lands before
    // the worker reaches it. A stall length is a race, not a seam: 600 ms stalls
    // once let V8 stop the worker first (3 of 3 runs), and on a later run of the
    // same host the sampler won every time, so the V8-first case below holds the
    // thread until the worker is gone instead. See the hazard register's heap-flag row.
    const outcome = heapBreachUnder('--max-old-space-size=512', 1024, 400);

    expect(outcome.limit).toBe('heapMb');
    // Exactly the sampler's bound: a refusal V8 made would name its ceiling.
    expect(outcome.bound).toBe('256 MiB heap, lowered from 1024 MiB by a process-wide --max-old-space-size');
  });

  it('names V8\'s ceiling, never the sampler\'s bound, when V8 stops the worker first — and the process survives', () => {
    // The child's thread is held from dispatch until the worker is gone, so no
    // heap sample lands and only V8's own ceiling (512 MiB) can stop the worker.
    // With no sample, the refusal says the ceiling is unknown (a process-wide
    // flag overrides it); never the 256 nobody stopped it at.
    const outcome = heapBreachUnder('--max-old-space-size=512', 1024, UNTIL_THE_WORKER_IS_GONE);

    expect(outcome.status).toBe(0);
    expect(outcome.limit).toBe('heapMb');
    expect(outcome.bound).toMatch(/^V8's own heap ceiling, reached before the pool's heap sampler read it: .*, unless a process-wide --max-old-space-size set it instead$/);
    expect(outcome.bound).not.toContain('256 MiB');
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
