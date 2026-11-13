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
 * Every real pool in this file runs in a child process that must exit 0, never in
 * the test runner's own: a thread that reaches V8's own heap ceiling can abort its
 * whole process, and on Windows a thread that overflows its stack can die as an
 * access violation, either of which would take the runner's fork down and every
 * test in it unreported. The child prints what it saw; the test asserts on it. A
 * kill is proved BEFORE the pool is asked again, by the breached thread's own
 * `exit`, and the pool spawns lazily, so the old thread is gone, not merely
 * abandoned while it keeps parsing.
 *
 * A heap flag reaches a child on its command line (`node <flags> script.mjs`),
 * which a worker inherits as its execArgv; only the test that means NODE_OPTIONS
 * uses it, with a flag every platform allows there (Node refuses
 * `--max-heap-size` in NODE_OPTIONS on some).
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, inject, it } from 'vitest';

import { MIN_HEAP_MB, type ParseLimits, resolveParseLimits, workerHeapCeilingMb } from '../../src/parse-limits.js';
import { deeplyNestedList, deeplyNestedQuote, manyLinks, TIGHT_LIMITS } from '../parse-limit-fixtures.js';
import { countFilesUnder } from '../test-helpers.js';

/** How a child process is handed its V8 flags: on its command line, or through `NODE_OPTIONS`. */
interface ChildFlags {
  readonly execArgv: readonly string[];
  readonly nodeOptions: string;
}

/** No flag on either route: the child's own V8 defaults. */
const NO_FLAGS: ChildFlags = { execArgv: [], nodeOptions: '' };

/** @returns `flags` (space-separated) on the child's command line, `NODE_OPTIONS` cleared */
function onCommandLine(flags: string): ChildFlags {
  return { execArgv: flags.split(' '), nodeOptions: '' };
}

/** @returns {@link TIGHT_LIMITS} with `overrides` named over them, as a JavaScript literal */
function tight(overrides: Partial<ParseLimits>): string {
  return JSON.stringify({ ...TIGHT_LIMITS, ...overrides });
}

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
      'const { limit, ms } = await breach(pool, docs.nested);',
      'return { limit, ms, killed: await allExited(), links: await stillParses(pool) };',
    ], { nested: deeplyNestedList() }) as { limit: string; ms: number; killed: boolean; links: number };

    expect(outcome.limit).toBe('timeMs');
    // Near the bound, not when the parse would have finished (seconds later).
    expect(outcome.ms).toBeLessThan(TIGHT_LIMITS.timeMs + 5000);
    expect(outcome.killed, 'the breached thread never exited').toBe(true);
    expect(outcome.links).toBe(1);
  });

  it('reports a job that recurses past its stack, and keeps its worker', () => {
    // The wall clock includes the worker's first parser load, which on a cold
    // thread can outlast the tight bound before the recursion is ever reached.
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

/** A module the BUILT package ships, as a child process imports it — so the child's own flags are the ones under test. */
function built(module: string): string {
  return pathToFileURL(safePath.resolve(import.meta.dirname, '..', '..', 'dist', module)).href;
}

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

/** A document that outgrows any small heap, as a JavaScript expression a child evaluates. */
const MANY_LINKS_EXPRESSION = String.raw`Array.from({ length: 200000 }, (_, i) => '[link ' + i + '](./t-' + i + '.md)\n').join('\n')`;

/**
 * Run the built pool in a child process under `flags`, parsing a document
 * that outgrows its heap, and report the limit it was stopped at.
 *
 * @param flags - The child's V8 flags
 * @param heapMb - The pool's `heapMb`
 * @param stall - How long the child's own thread blocks at a time, back to
 *   back, while the job runs (0: never) — so the heap sampler, which runs on
 *   that thread, reads late; or {@link UNTIL_THE_WORKER_IS_GONE}
 * @returns The limit's name, its bound, and how long the rejection took (the child exited 0)
 */
function heapBreachUnder(flags: ChildFlags, heapMb: number, stall: number | typeof UNTIL_THE_WORKER_IS_GONE): ChildOutcome {
  return parseInChild(
    flags,
    MANY_LINKS_EXPRESSION,
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
}

/**
 * Run the built pool in a child process under `flags`, parse one document
 * and report what became of it.
 *
 * @param flags - The child's V8 flags
 * @param documentExpression - A JavaScript expression the child evaluates to the document
 * @param limitsLiteral - The pool's limits, as a JavaScript object literal
 * @param stall - See {@link heapBreachUnder}
 * @returns The limit's name (`none` when admitted), its bound, and how long the parse took (the child exited 0)
 */
function parseInChild(
  flags: ChildFlags,
  documentExpression: string,
  limitsLiteral: string,
  stall: number | typeof UNTIL_THE_WORKER_IS_GONE,
): ChildOutcome {
  return poolInChild(flags, [
    `const doc = ${documentExpression};`,
    `const pool = openPool(${limitsLiteral});`,
    'const startedAt = performance.now();',
    "const pending = pool.parse('markdown', doc, doc.length);",
    stall === UNTIL_THE_WORKER_IS_GONE ? BLOCK_UNTIL_THE_WORKER_IS_GONE : `const stall = ${String(stall)} > 0 ? setInterval(() => { const until = performance.now() + ${String(stall)}; while (performance.now() < until); }, 1) : undefined;`,
    "const outcome = await pending.then(() => ({ limit: 'none', bound: '' }), (error) => ({ limit: error.limit ?? String(error), bound: error.bound ?? '' }));",
    'if (stall !== undefined) clearInterval(stall);',
    'return { ...outcome, ms: performance.now() - startedAt };',
  ]) as ChildOutcome;
}

/**
 * Run `body` — the lines of an async function — in a child process that has imported the built
 * pool, and return what it returned, through JSON.
 *
 * The body sees: `docs` (the `documents` given here); `openPool(limits, options)` (a pool of one
 * thread unless `options.size` says otherwise, shut down after the body returns);
 * `stoppedAt(job)` (the limit a job was stopped at, `'none'` if it completed, or the error's text);
 * `breach(pool, doc)` (`stoppedAt` a markdown parse of `doc`, with how long it took);
 * `stillParses(pool)` (how many links an ordinary document parses to — 1 — or the error's text);
 * `allExited()` (whether every thread started has exited, waiting up to 5 s); `isParseLimitError`;
 * and `threads`, every thread the child started, read from the `worker_threads` diagnostics
 * channel: `exited[i]`, `startedAfterExits[i]` (had every earlier thread exited when thread `i`
 * started?), `workers[i]`, and `widest`, the most ever alive at once.
 *
 * @param flags - The child's V8 flags
 * @param body - The function's lines
 * @param documents - Documents the body reads as `docs`
 * @returns What the body returned
 */
function poolInChild(flags: ChildFlags, body: readonly string[], documents: Readonly<Record<string, string>> = {}): unknown {
  return JSON.parse(runInChild(flags, [
    `const { createParsePool } = await import(${JSON.stringify(built('parse-pool.js'))});`,
    `const { isParseLimitError } = await import(${JSON.stringify(built('parse-limits.js'))});`,
    "const { subscribe } = await import('node:diagnostics_channel');",
    `const docs = ${JSON.stringify(documents)};`,
    'const threads = { workers: [], exited: [], startedAfterExits: [], live: 0, widest: 0 };',
    "subscribe('worker_threads', ({ worker }) => {",
    '  threads.startedAfterExits.push(threads.exited.every(Boolean));',
    '  const index = threads.exited.push(false) - 1;',
    '  threads.workers.push(worker);',
    '  threads.live += 1;',
    '  threads.widest = Math.max(threads.widest, threads.live);',
    "  worker.once('exit', () => { threads.exited[index] = true; threads.live -= 1; });",
    '});',
    'const pools = [];',
    'const openPool = (limits, options = {}) => { const pool = createParsePool({ size: 1, ...options, limits }); pools.push(pool); return pool; };',
    "const stoppedAt = (job) => job.then(() => 'none', (error) => (isParseLimitError(error) ? error.limit : String(error)));",
    "const breach = async (pool, doc) => { const startedAt = performance.now(); const limit = await stoppedAt(pool.parse('markdown', doc, Buffer.byteLength(doc))); return { limit, ms: performance.now() - startedAt }; };",
    String.raw`const stillParses = (pool) => pool.parse('markdown', '# ok\n\n[a](./b.md)\n', 21).then((result) => result.links.length, (error) => String(error));`,
    'const allExited = async () => { const giveUpAt = performance.now() + 5000; while (!threads.exited.every(Boolean) && performance.now() < giveUpAt) await new Promise((resolve) => setTimeout(resolve, 25)); return threads.exited.every(Boolean); };',
    'const result = await (async () => {',
    ...body,
    '})();',
    'console.log(JSON.stringify(result));',
    'await Promise.all(pools.map((pool) => pool.shutdown()));',
  ]));
}

/** Windows exit statuses a thread's crash takes its whole process down with. */
const WINDOWS_CRASHES: Readonly<Record<number, string>> = {
  3_221_225_477: '0xC0000005, access violation',
  3_221_225_725: '0xC00000FD, stack overflow',
};

/** @returns How a child ended — status (named, if a Windows crash), signal and full stderr — for a failure message */
function howItEnded(child: SpawnSyncReturns<string>): string {
  const crash = child.status === null ? undefined : WINDOWS_CRASHES[child.status];
  const status = crash === undefined ? String(child.status) : `${String(child.status)} (${crash})`;
  return `status ${status}, signal ${String(child.signal)}, stderr:\n${child.stderr}`;
}

/**
 * Run `script` as an ES module in a child process under `flags`, so whatever a real pool's
 * thread does to its process — a fatal V8 abort or an access violation included — is that
 * child's, never the runner's.
 *
 * Every caller gets the same verdict on the child itself: it spawned, it was not killed, it did not
 * abort, and it exited 0. No caller expects anything else; one that does must say so here.
 *
 * @param flags - The child's V8 flags: its command line's, and its `NODE_OPTIONS`
 * @param script - The module's lines
 * @returns What it printed
 */
function runInChild(flags: ChildFlags, script: readonly string[]): string {
  // `spawnSync` blocks the loop the test's own timeout runs on, so a hung child is bounded here.
  // A script FILE, not `--eval`: a worker inherits its parent's execArgv,
  // and `--input-type` is refused by a worker started from a file.
  const directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-heap-flag-'));
  const entry = safePath.join(directory, 'heap-flag.mjs');
  writeFileSync(entry, script.join('\n'), 'utf-8');
  const child = spawnSync(process.execPath, [...flags.execArgv, entry], {
    env: { ...process.env, NODE_OPTIONS: flags.nodeOptions },
    encoding: 'utf-8',
    timeout: inject('tierTestTimeout'),
    killSignal: 'SIGKILL',
  });
  rmSync(directory, { recursive: true, force: true });

  // A hung child is killed at the tier timeout (`signal` and an ETIMEDOUT `error` both set), so
  // the signal is read first; a spawn that failed, or output past `maxBuffer`, is named after it.
  const ended = howItEnded(child);
  expect(child.signal, `the child was killed, hung past the tier timeout: ${ended}`).toBeNull();
  expect(child.error, `the child could not run: ${String(child.error)}; ${ended}`).toBeUndefined();
  // A benign process warning (`VAT_PARSE_NO_COLLECTOR` on a runtime with no collector) may be
  // there; an abort may not.
  expect(child.stderr, ended).not.toMatch(/FATAL|out of memory/i);
  expect(child.status, ended).toBe(0);
  return child.stdout;
}

describe('a process-wide heap flag', () => {
  it('cannot lift a job\'s heap limit', () => {
    // A process-wide `--max-old-space-size` (NODE_OPTIONS, common in CI) is a V8
    // global flag, and it overrides a worker's `resourceLimits`: measured, under
    // 4096 a worker given 48 MiB reports a 4,192 MiB heap limit and a runaway
    // allocation runs until the wall clock stops it. The job must still be
    // stopped at its HEAP limit, well before its wall-clock one. Through NODE_OPTIONS,
    // the route CI takes, which allows this flag on every platform.
    const outcome = heapBreachUnder({ execArgv: [], nodeOptions: '--max-old-space-size=4096' }, MIN_HEAP_MB, 0);

    expect(outcome.limit).toBe('heapMb');
    expect(outcome.bound).toBe(`${String(MIN_HEAP_MB)} MiB heap`);
    expect(outcome.ms).toBeLessThan(30_000);
  });

  it('is named in the refusal when it lowers the limit', () => {
    // Lower than `heapMb`, the flag caps V8's ceiling, and the pool stops the
    // job at half of it, so the refusal names that value, not the configured one.
    const outcome = heapBreachUnder(onCommandLine('--max-old-space-size=64'), 1024, 0);

    expect(outcome.limit).toBe('heapMb');
    expect(outcome.bound).toContain('32 MiB heap');
    expect(outcome.bound).toContain('--max-old-space-size');
  });

  it('still admits an ordinary document when it is small: 128 MiB, which the pool applies at its young-generation floor', () => {
    // The sampler counts the whole used heap, young-generation garbage
    // included, and a cold worker parsing this 34 KB document peaks at 54 to
    // 68 MiB used (Node 26, see the limits record). At half of a 128 MiB flag
    // (64) about one parse in ten was refused; the bound is floored at the
    // young generation (96 on Node 26) while the ceiling leaves the sampler 32 above it.
    const ordinary = String.raw`Array.from({ length: 400 }, (_, i) => '## Section ' + i + '\n\nProse with a [link](./doc-' + i + '.md), \x60code\x60 and *emphasis*.\n\n- item ' + i + '\n').join('\n')`;

    const outcome = parseInChild(onCommandLine('--max-old-space-size=128'), ordinary, '{}', 0);

    expect(outcome.limit, outcome.bound).toBe('none');
  });

  it('stops a breach at that floored bound before V8 does, three times in a row, and the process survives', () => {
    // The floor leaves 32 MiB between the bound and V8's ceiling, where half a
    // 128 MiB flag left 64: the sampler must still win the race V8 makes fatal.
    //
    // The floor is the young generation a thread really gets, which the runtime decides: 48 MiB on
    // Node 22 (so half the flag, 64, stands), 192 on Node 24 and 96 on Node 26 (so 96, the flag less
    // the headroom). It is measured here, in a child under the same flag, never assumed.
    const flag = onCommandLine('--max-old-space-size=128');
    const youngMb = Number(runInChild(flag, [
      "import { Worker } from 'node:worker_threads';",
      `const worker = new Worker('', { eval: true, resourceLimits: { maxOldGenerationSizeMb: ${String(workerHeapCeilingMb(1024))} } });`,
      "worker.once('online', () => { console.log(worker.resourceLimits.maxYoungGenerationSizeMb); void worker.terminate(); });",
    ]).trim());
    expect(youngMb).toBeGreaterThan(0);
    const appliedMb = Math.max(128 / 2, Math.min(youngMb, 128 - 32));

    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = heapBreachUnder(flag, 1024, 0);

      expect(outcome.bound).toBe(`${String(appliedMb)} MiB heap, lowered from 1024 MiB by a process-wide V8 heap flag (--max-old-space-size, --max-heap-size or --max-semi-space-size)`);
    }
  });
});

describe('a process-wide semi-space flag', () => {
  // `--max-semi-space-size` sizes every isolate's young generation at three of it, over a worker's
  // `resourceLimits`, which still report the size they were given (Node 26.7: 192 or 96, by host). Read from
  // `resourceLimits`, V8's ceiling under 512 and 128 read 704 for a real 512, and the stop sat at 528,
  // past it; under 128 and 16 the read was not positive and the pool fell back to its own 2,048.
  // Either way V8 reached its ceiling first, which under fast allocation kills the whole process.
  it.each([
    ['--max-old-space-size=512 --max-semi-space-size=128', '384 MiB heap'],
    ['--max-old-space-size=128 --max-semi-space-size=16', '64 MiB heap'],
    // V8 rounds the semi-space up to a power of two: 40 is a 192 MiB young generation, 100 a 384.
    // Read as 3 × the flag, the stop under 600 and 100 sat at 268 MiB, and V8 stopped the worker
    // near 203 MiB used.
    ['--max-heap-size=600 --max-semi-space-size=40', '204 MiB heap'],
    ['--max-heap-size=600 --max-semi-space-size=100', '184 MiB heap'],
  ])('under %s, stops a breach at the bound read from the real ceiling, three times in a row, and the process survives', (flags, bound) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = heapBreachUnder(onCommandLine(flags), 1024, 0);

      expect(outcome.limit).toBe('heapMb');
      expect(outcome.bound).toBe(`${bound}, lowered from 1024 MiB by a process-wide V8 heap flag (--max-old-space-size, --max-heap-size or --max-semi-space-size)`);
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
    const outcome = heapBreachUnder(onCommandLine('--max-old-space-size=512'), 1024, 400);

    expect(outcome.limit).toBe('heapMb');
    // Exactly the sampler's bound: a refusal V8 made would name its ceiling.
    expect(outcome.bound).toBe('256 MiB heap, lowered from 1024 MiB by a process-wide V8 heap flag (--max-old-space-size, --max-heap-size or --max-semi-space-size)');
  });

  it('names V8\'s ceiling, never the sampler\'s bound, when V8 stops the worker first — and the process survives', () => {
    // The child's thread is held from dispatch until the worker is gone, so no
    // heap sample lands and only V8's own ceiling (512 MiB) can stop the worker.
    // With no sample, the refusal says the ceiling is unknown (a process-wide
    // flag overrides it); never the 256 nobody stopped it at.
    const outcome = heapBreachUnder(onCommandLine('--max-old-space-size=512'), 1024, UNTIL_THE_WORKER_IS_GONE);

    expect(outcome.limit).toBe('heapMb');
    expect(outcome.bound).toMatch(/^V8's own heap ceiling, reached before the pool's heap sampler read it: .*, unless a process-wide V8 heap flag \(--max-old-space-size, --max-heap-size or --max-semi-space-size\) set it instead$/);
    expect(outcome.bound).not.toContain('256 MiB');
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
