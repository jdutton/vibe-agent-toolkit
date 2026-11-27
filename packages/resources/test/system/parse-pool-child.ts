/**
 * A real parse pool in a child process, for the system tests that drive it past its limits.
 *
 * Every real pool these tests start runs in a child process that must exit 0, never in the test
 * runner's own: a thread that reaches V8's own heap ceiling can abort its whole process, and on
 * Windows a thread that overflows its stack can die as an access violation, either of which would
 * take the runner's fork down and every test in it unreported. The child prints what it saw; the
 * test asserts on it.
 *
 * A heap flag reaches a child on its command line (`node <flags> script.mjs`), which a worker
 * inherits as its execArgv; only the test that means NODE_OPTIONS uses it, with a flag every
 * platform allows there (Node refuses `--max-heap-size` in NODE_OPTIONS on some).
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { expect, inject } from 'vitest';

import type { ParseLimits } from '../../src/parse-limits.js';
import { TIGHT_LIMITS } from '../parse-limit-fixtures.js';

/** How a child process is handed its V8 flags: on its command line, or through `NODE_OPTIONS`. */
interface ChildFlags {
  readonly execArgv: readonly string[];
  readonly nodeOptions: string;
}

/** No flag on either route: the child's own V8 defaults. */
export const NO_FLAGS: ChildFlags = { execArgv: [], nodeOptions: '' };

/** @returns `flags` (space-separated) on the child's command line, `NODE_OPTIONS` cleared */
export function onCommandLine(flags: string): ChildFlags {
  return { execArgv: flags.split(' '), nodeOptions: '' };
}

/** @returns {@link TIGHT_LIMITS} with `overrides` named over them, as a JavaScript literal */
export function tight(overrides: Partial<ParseLimits>): string {
  return JSON.stringify({ ...TIGHT_LIMITS, ...overrides });
}

/** A module the BUILT package ships, as a child process imports it — so the child's own flags are the ones under test. */
function built(module: string): string {
  return pathToFileURL(safePath.resolve(import.meta.dirname, '..', '..', 'dist', module)).href;
}

/** A stall that holds the child's thread from dispatch until the worker thread is gone: see {@link BLOCK_UNTIL_THE_WORKER_IS_GONE}. */
export const UNTIL_THE_WORKER_IS_GONE = 'until-the-worker-is-gone';

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
export const MANY_LINKS_EXPRESSION = String.raw`Array.from({ length: 200000 }, (_, i) => '[link ' + i + '](./t-' + i + '.md)\n').join('\n')`;

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
export function heapBreachUnder(flags: ChildFlags, heapMb: number, stall: number | typeof UNTIL_THE_WORKER_IS_GONE): ChildOutcome {
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
export function parseInChild(
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
 * `breach(pool, doc)` (`stoppedAt` a markdown parse of `doc`, with `ms`, how long it took from
 * submission, and `parseMs`, how long from the thread's `parserLoaded` for it, where the pool starts
 * the document's own `timeMs` clock; `null` if no parser loaded after submission);
 * `stillParses(pool)` (how many links an ordinary document parses to — 1 — or the error's text);
 * `allExited()` (whether every thread started has exited, waiting up to 5 s); `isParseLimitError`;
 * and `threads`, every thread the child started, read from the `worker_threads` diagnostics
 * channel: `exited[i]`, `startedAfterExits[i]` (had every earlier thread exited when thread `i`
 * started?), `workers[i]`, `widest`, the most ever alive at once, and `parserLoadedAt`, when a thread
 * last posted `parserLoaded`.
 *
 * @param flags - The child's V8 flags
 * @param body - The function's lines
 * @param documents - Documents the body reads as `docs`
 * @returns What the body returned
 */
export function poolInChild(flags: ChildFlags, body: readonly string[], documents: Readonly<Record<string, string>> = {}): unknown {
  return JSON.parse(runInChild(flags, [
    `const { createParsePool } = await import(${JSON.stringify(built('parse-pool.js'))});`,
    `const { isParseLimitError } = await import(${JSON.stringify(built('parse-limits.js'))});`,
    "const { subscribe } = await import('node:diagnostics_channel');",
    `const docs = ${JSON.stringify(documents)};`,
    'const threads = { workers: [], exited: [], startedAfterExits: [], live: 0, widest: 0, parserLoadedAt: undefined };',
    "subscribe('worker_threads', ({ worker }) => {",
    '  threads.startedAfterExits.push(threads.exited.every(Boolean));',
    '  const index = threads.exited.push(false) - 1;',
    '  threads.workers.push(worker);',
    '  threads.live += 1;',
    '  threads.widest = Math.max(threads.widest, threads.live);',
    "  worker.once('exit', () => { threads.exited[index] = true; threads.live -= 1; });",
    "  worker.on('message', (message) => { if (typeof message?.parserLoaded === 'string') threads.parserLoadedAt = performance.now(); });",
    '});',
    'const pools = [];',
    'const openPool = (limits, options = {}) => { const pool = createParsePool({ size: 1, ...options, limits }); pools.push(pool); return pool; };',
    "const stoppedAt = (job) => job.then(() => 'none', (error) => (isParseLimitError(error) ? error.limit : String(error)));",
    "const breach = async (pool, doc) => { const startedAt = performance.now(); const limit = await stoppedAt(pool.parse('markdown', doc, Buffer.byteLength(doc))); const endedAt = performance.now(); const loadedAt = threads.parserLoadedAt; return { limit, ms: endedAt - startedAt, parseMs: loadedAt === undefined || loadedAt < startedAt ? null : endedAt - loadedAt }; };",
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
export function runInChild(flags: ChildFlags, script: readonly string[]): string {
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
