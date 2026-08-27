/**
 * A worker-thread pool that runs VAT's document parsers off the main thread.
 *
 * ## Why this exists
 *
 * Measured with the lab's `parse` facet, cold, on a 103-skill adopter monorepo:
 *
 * ```text
 * vat claude context      16,055.6 ms wall
 *   inside the parser     10,659.0 ms   (66% of wall, 1,781 documents)
 *     remark-parse         8,890.2 ms   (55% of wall)
 *   process CPU               112.9%    on a 10-core box
 * ```
 *
 * That is a serial, CPU-bound majority of a command's wall clock on a machine
 * with nine idle cores. Nothing about it is I/O — the content is already in
 * memory when the parser is called. A thread pool is the only lever that moves
 * it, and this module is that lever and nothing else: it does not decide *what*
 * to parse, does not read files, and does not cache. Its single job is to make
 * `parseContent` run somewhere other than here and come back byte-identical.
 *
 * ## The four properties this module is accountable for
 *
 * **1. Content travels, paths do not.** {@link ParsePool.parse} takes the
 * decoded string, never a path. The projection's `RunContentCache` guarantees
 * each file is read exactly once per run; a worker that re-read by path would
 * quietly break that invariant, double the I/O the crawl was designed to avoid,
 * and — because a file can change between the two reads — occasionally parse
 * bytes nobody else in the run ever saw.
 *
 * **2. `content` does NOT come back.** A `ParseResult` carries the whole
 * document string. The caller already holds those bytes — it just handed them
 * over — so returning them would double the structured-clone traffic for zero
 * information. The worker returns {@link ParseFacts} (the same shape the parse
 * cache persists, for the same reason), and this module re-attaches `content`
 * and `sizeBytes` on the parent side, so callers observe a `ParseResult` that is
 * `toStrictEqual` to what the in-process parser returns.
 *
 * `frontmatter` does not come back either, and that one is a **correctness**
 * requirement rather than a size one: `ParseResult.frontmatter` is whatever
 * `yaml` decoded, and structured clone is not the identity on it. Verified —
 * `blob: !!binary aGVsbG8=` decodes to a `Buffer` and arrives on the other side
 * as a `Uint8Array`, which `deepStrictEqual` rejects. So the source travels and
 * `parseFrontmatterSource` re-derives the object here, exactly as
 * `parse-cache.ts`'s `rehydrate` does on a cache hit. Everything else in
 * `ParseFacts` is plain JSON-shaped data — it has to be, because the parse cache
 * already round-trips it through JSON — and `parse-pool.test.ts` pins that with
 * a `structuredClone` identity check over every fixture.
 *
 * **3. Nothing happens until the first parse.** `parse-cache.ts`'s `parseKeyed`
 * keeps its `loadParser` call below the cache-hit return because that position
 * is "the ONLY reason a fully warm run loads no parser at all", and notes the
 * hoist has regressed twice at ~730 ms of remark load apiece. This pool inherits
 * that discipline literally: {@link createParsePool} allocates an object and
 * spawns nothing. The first {@link ParsePool.parse} spawns the first thread; the
 * worker then loads its parser through the same lazy `loadParser`. A pool that
 * is created and never used costs one object.
 *
 * **4. A failed document is data; a failed thread is an error.** A document that
 * parse5 finds malformed comes back as `ParseResult.parseErrors`, off-thread
 * exactly as on-thread — never as a rejection. A parser module that cannot be
 * loaded comes back as a rejection carrying the original `name`, `message` and
 * `code`, so `isParserUnavailable` (which matches on `code`, not only on
 * `instanceof`) still classifies it as a broken install. A thread that dies
 * without answering rejects its job with an error that says so.
 *
 * ## ⚠️ `shutdown()` is not optional — it is what collects the timings
 *
 * Worker threads get their own module instance of `parse-timing.ts`, so each
 * accumulates its own sub-phase timings. Those come back HERE:
 * {@link SHUTDOWN_REQUEST} makes a worker post its counters as a
 * {@link ParseWorkerTimingReport} and then close its port, and this pool hands
 * them to `recordThreadTiming` so the ONE dump this process writes carries every
 * thread. See `ParseTimingDump` in `parse-timing.ts` for why the process writes
 * once rather than every thread writing for itself.
 *
 * A worker's numbers are therefore across the boundary as soon as it ANSWERS the
 * shutdown, not when it exits — which matters, because `terminate()` (measured
 * on Node 24.13.1: exit code 1, `exit` listeners skipped) is the escape this
 * pool takes from a thread still alive after
 * {@link GRACEFUL_EXIT_TIMEOUT_MS}. Only a thread wedged badly enough never to
 * answer at all goes unreported, and it goes unreported visibly, as a thread
 * count below the pool's width.
 *
 * A pool that is never shut down reports no worker timings, because nothing ever
 * asks the threads for them. Idle workers are `unref`'d so a forgotten pool
 * cannot HANG a CLI, but that is damage control, not a substitute: call
 * `shutdown()` in a `finally`.
 */

import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { parseFrontmatterSource } from './frontmatter-source.js';
import type { ParseResult } from './link-parser.js';
import type { DocumentParserKind } from './mime-type.js';
import {
  type ParseThreadTiming,
  parseTimingStart,
  recordThreadTiming,
  recordTierPass,
  TierPass,
} from './parse-timing.js';

/**
 * Upper bound on the size {@link defaultParsePoolSize} will pick for itself.
 *
 * ## 🔑 Four is where the MEASURED width curve stops paying
 *
 * Cold `vat resources validate` on a 103-skill adopter, 10-core Mac, against a
 * measured 261 ms noise floor for that regime:
 *
 * ```text
 * width 1   +723.2 ms   a LOSS — the pool's whole fixed cost, bought and unused
 * width 3   -46.9%      the knee's shoulder
 * width 4   -528 ms against width 3   2.0x the floor — REAL
 * width 8    -83 ms against width 4   0.3x the floor — indistinguishable
 * ```
 *
 * So the fourth thread earns its keep and the fifth through eighth do not. What
 * they do cost is unambiguous: each worker loads the full remark/unified stack
 * into its own isolate (~730 ms, not shared between isolates) and then holds its
 * own copy of that heap. Four of those is the most this command has been shown
 * to convert into wall clock.
 *
 * The measured command is also 66% parser, so Amdahl caps the achievable speedup
 * near 3x however many threads are added — four already puts the parallel
 * remainder under the serial one, which is the same place the curve flattens.
 *
 * ⚠️ **Taken on a 10-core box.** On a 4-core machine this cap is every core the
 * `availableParallelism() - 1` rule leaves, so the two bounds meet and nothing
 * here has been separated from the platform.
 *
 * ## What is NOT a reason to cap, so nobody re-derives it
 *
 * The parent's structured clone of each document's content is **not** a
 * bottleneck at any width this cap could reach: cold, 1,677 dispatched
 * documents, 31.9 MB, the `wire-dispatch` tier row reads **18.3 ms total, 0.011
 * ms per document** — 0.7% of the parent's own tier work and 0.16% of the
 * command's wall clock.
 *
 * The cap is deliberately NOT the core count. A `vat` invocation is frequently
 * one of several phases a CI job or a pre-commit hook is running, and a pool
 * that sizes itself to the whole machine competes with its own siblings.
 * `availableParallelism() - 1` leaves the parent a core; the cap keeps a
 * 64-core build agent from spawning 63 remark instances to parse 1,781 files.
 *
 * An explicit `size` is honoured above this — a caller who names a number knows
 * something this default cannot.
 */
const DEFAULT_POOL_SIZE_CAP = 4;

/**
 * How long a graceful worker close may take before {@link ParsePool.shutdown}
 * resorts to `terminate()`.
 *
 * Reaching it costs that worker's parse-timing dump (see the module docstring),
 * so it is set well above any honest close: a worker with no job left has only
 * to drain an empty event loop. A thread still alive after this is wedged, and a
 * hung `shutdown()` would hang the command.
 */
const GRACEFUL_EXIT_TIMEOUT_MS = 5000;

/** The parse job that crosses to a worker. Plain data — see property 2 above. */
interface ParseWorkerParseRequest {
  type: 'parse';
  /** Correlates the response. Unique within one pool. */
  id: number;
  kind: DocumentParserKind;
  content: string;
  byteLength: number;
  /**
   * Content key to file the facts under, when the CACHE is to be the transport.
   *
   * Present means: parse, write the entry yourself, and answer with the key
   * rather than the facts — the parent will read them back off disk. Absent
   * means the facts travel over the wire, which is what {@link ParsePool.parse}
   * asks for.
   *
   * The parent supplies the key rather than the worker deriving one, and that is
   * not a convenience: the key is a function of the RAW BYTES and the parser
   * kind (see `content-key.ts`), and the worker never sees the raw bytes — it
   * receives a decoded string, from which the byte sequence is not recoverable.
   * A worker that re-derived a key would file entries under a key no reader ever
   * looks up, and every run would stay silently cold.
   */
  cacheKey?: string;
}

/**
 * Asks a worker to hand back its parse-timing counters and close its port.
 *
 * Both halves matter: the counters are final only once the thread has no job
 * left, and closing the port is what drains the event loop so the thread
 * actually exits.
 */
interface ParseWorkerShutdownRequest {
  type: 'shutdown';
}

/** Everything the parent sends a worker. */
export type ParseWorkerRequest = ParseWorkerParseRequest | ParseWorkerShutdownRequest;

/**
 * A thrown parser failure, flattened to plain data.
 *
 * `code` is carried because `isParserUnavailable` in `parse-cache.ts` matches on
 * it as well as on `instanceof` — an `Error` reconstructed here is not the same
 * class, so without the code a broken install would stop being recognised as
 * one the moment parsing moved off-thread.
 */
export interface ParseWorkerFailure {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

/**
 * A `ParseResult` minus the three fields that must not cross the boundary.
 *
 * `content` and `sizeBytes` because the parent already holds them (property 2
 * in the module docstring); `frontmatter` because structured clone is not the
 * identity on it. What remains is plain JSON-shaped data — arrays of link and
 * heading records, strings and numbers — which `parse-pool.test.ts` pins with a
 * `structuredClone` identity check over every fixture.
 *
 * ## Why this is derived from `ParseResult` and NOT from the cache's `ParseFacts`
 *
 * The two shapes are all but identical, and reusing `dehydrate` was the obvious
 * move. It is the wrong one here for two independent reasons:
 *
 * - `dehydrate` names its fields one by one, so a field ADDED to `ParseResult`
 *   would silently stop travelling — the pool would return results missing it,
 *   and every equivalence test written before the field existed would stay
 *   green. {@link toParseWire}'s rest-destructure carries a new field
 *   automatically and can only fail loudly, at the type level.
 * - `ParseFacts` is inferred from a Zod schema, so its optional properties
 *   include `| undefined`. Under `exactOptionalPropertyTypes` that is not
 *   assignable back into `ParseResult`, which is precisely why `rehydrate`
 *   rebuilds field by field with conditional spreads. `Omit` on `ParseResult`
 *   preserves the exact optionality instead, so the round trip is two spreads.
 */
export type ParseWireFacts = Omit<ParseResult, 'content' | 'sizeBytes' | 'frontmatter'>;

/**
 * Everything a worker sends back.
 *
 * Three arms, and the middle one is the whole of "cache as transport": a
 * constant-size answer meaning *the facts are on disk under this key, go and
 * read them*. A worker asked for that transport answers `stored` when the write
 * succeeded and `facts` when it did not, so a cache that cannot be written to
 * (read-only mount, `VAT_CACHE=0`, a full disk) degrades the run to the wire
 * protocol instead of losing the parse. That fallback is why the two arms are a
 * union here rather than a second response TYPE: the parent asked for one and
 * must handle either.
 */
export type ParseWorkerResponse =
  | { id: number; facts: ParseWireFacts }
  | { id: number; stored: string }
  | { id: number; failure: ParseWorkerFailure }
  | ParseWorkerTimingReport;

/**
 * A worker's parse-timing counters, handed over in answer to
 * {@link SHUTDOWN_REQUEST} and belonging to no job.
 *
 * The one arm with no `id`, and deliberately so: it answers the SHUTDOWN
 * request, not a parse, and giving it a borrowed id would put it one careless
 * `in` check away from settling somebody's document. `settleJob` never sees it.
 */
export interface ParseWorkerTimingReport {
  timing: ParseThreadTiming;
}

/**
 * A wire payload that has not had the three parent-held fields removed yet.
 *
 * Naming the in-between state is what lets {@link toParseWire} narrow by
 * DELETION rather than by listing the fields to keep — and therefore what makes
 * a field added to `ParseResult` travel automatically instead of silently
 * staying behind.
 */
type ParseWireDraft = ParseWireFacts &
  Partial<Pick<ParseResult, 'content' | 'frontmatter' | 'sizeBytes'>>;

/**
 * Reduce a parse result to what actually crosses the thread boundary.
 *
 * Lives here rather than in the worker because this module owns the protocol,
 * and because a test must be able to check the wire shape without starting a
 * thread — `parse-worker.js` throws on the main thread by design.
 *
 * @param result - What the parser produced, in the worker
 * @returns The same facts minus `content`, `sizeBytes` and `frontmatter`
 */
export function toParseWire(result: ParseResult): ParseWireFacts {
  const wire: ParseWireDraft = { ...result };
  delete wire.content;
  delete wire.sizeBytes;
  delete wire.frontmatter;
  return wire;
}

/** The single shutdown message, allocated once. */
const SHUTDOWN_REQUEST: ParseWorkerShutdownRequest = { type: 'shutdown' };

/** A pool of worker threads that parse documents. */
export interface ParsePool {
  /**
   * Parse one document off-thread.
   *
   * @param kind - Which parser to run; the same value that keys a parse-cache entry
   * @param content - The decoded document, exactly as the in-process parser would receive it
   * @param byteLength - RAW byte count of what was read. Never derived from
   *   `content` — decoding is lossy on malformed UTF-8 and the source need not
   *   be UTF-8 at all. It becomes `ParseResult.sizeBytes` verbatim.
   * @returns The same `ParseResult` the in-process parser returns, `content` included
   * @throws If the parser module cannot be loaded, if the pool is shut down, or
   *   if the worker holding the job dies. A document that merely fails to parse
   *   is NOT an error — it comes back in `parseErrors`.
   */
  parse(kind: DocumentParserKind, content: string, byteLength: number): Promise<ParseResult>;
  /**
   * Parse one document off-thread and have the WORKER file it in the parse
   * cache, so the facts never cross the boundary.
   *
   * The other half of the transport question this pool exists to settle. Under
   * {@link ParsePool.parse} a cold run pays a structured clone of every fact
   * graph on the parent thread, then serializes the same graph again to write
   * the cache entry — both on the one thread that cannot be parallelized. Under
   * this method the worker writes the entry (in parallel, on its own thread) and
   * answers with the key, and the parent's cost becomes a `readFile` plus a
   * `JSON.parse` plus schema validation instead.
   *
   * Which is cheaper is a measurement, not a deduction, and it is what the tier
   * rows in `parse-timing.ts` exist to answer. Neither method is the default in
   * a way this module decides: the caller picks.
   *
   * ⚠️ **It was measured, and this one LOST** — it does move 96% of the parent's
   * cache-write cost onto the workers and still comes out 8.3% slower on wall
   * clock, because the parent was not the bottleneck and the workers were. The
   * full numbers and the mechanism are at `ParseTransport` in
   * `projection/blob-population.ts`; read them before reaching for this. It is
   * kept because the verdict is a property of a pool whose workers are starved,
   * which is a defect on the queue rather than a permanent fact.
   *
   * @param kind - Which parser to run; the same value that keys a cache entry
   * @param content - The decoded document
   * @param byteLength - RAW byte count of what was read. See {@link ParsePool.parse}.
   * @param cacheKey - The content key to file the entry under. Derived by the
   *   parent from the raw bytes, because the worker cannot — see
   *   {@link ParseWorkerParseRequest.cacheKey}.
   * @returns `null` when the worker stored the entry and the caller should read
   *   its own cache, or a full `ParseResult` when the worker could NOT store and
   *   sent the facts instead. Never both.
   * @throws On the same three conditions {@link ParsePool.parse} throws on.
   */
  parseIntoCache(
    kind: DocumentParserKind,
    content: string,
    byteLength: number,
    cacheKey: string,
  ): Promise<ParseResult | null>;
  /**
   * Close the pool. Queued and in-flight work is awaited first, then every
   * worker is closed gracefully so its parse-timing dump reaches disk. Safe to
   * call twice; the second call awaits the first.
   */
  shutdown(): Promise<void>;
  /**
   * The worker ceiling. Threads are spawned lazily up to it and never beyond,
   * so a pool that parses one document owns one thread regardless of this.
   */
  readonly size: number;
}

/** Options for {@link createParsePool}. */
export interface ParsePoolOptions {
  /**
   * Worker ceiling. Rounded down and floored at 1. Defaults to
   * {@link defaultParsePoolSize}, and an explicit value is NOT capped — see
   * {@link DEFAULT_POOL_SIZE_CAP}.
   */
  size?: number;
  /**
   * Parse-cache root the workers must file entries into, for
   * {@link ParsePool.parseIntoCache}.
   *
   * ⚠️ **Required for cache transport to work at all, and its absence fails
   * SILENTLY.** A worker isolate has its own module graph, so it builds its own
   * `ParseCache` — and one built from the default directory while the parent used
   * another writes entries the parent will never find. The parent then misses its
   * own read-back and re-parses on the main thread: slower than not pooling, with
   * every result still correct and every test still green. Passing the parent's
   * `ParseCache.directory` is what makes the two agree.
   *
   * Ignored by {@link ParsePool.parse}, which sends no key and stores nothing.
   */
  cacheDir?: string;
}

/** What a worker is told at construction. See {@link ParsePoolOptions.cacheDir}. */
export interface ParseWorkerData {
  /** Parse-cache root, or `undefined` to let the worker use the default. */
  cacheDir?: string;
}

/**
 * Overrides the worker entry for a test, or restores the real resolution.
 *
 * Exists so the "a worker died without answering" branch is reachable from a
 * unit test: nothing a *document* can contain kills a thread, so the only
 * honest way to exercise that path is to point the pool at a thread that dies.
 * Named after `parse-timing.ts`'s `__setParseTimingForTest`, and like it, it
 * never touches the real resolution's inputs.
 *
 * @param entry - A worker entry path, or `null` to restore the real one
 */
export function __setParseWorkerEntryForTest(entry: string | null): void {
  workerEntryOverride = entry;
  resolvedWorkerEntry = undefined;
}

let workerEntryOverride: string | null = null;
let resolvedWorkerEntry: string | undefined;

/**
 * Locate the worker entry, from `dist/` when shipped and from `../dist/` when
 * this module is the TypeScript source.
 *
 * ## Why the worker is ALWAYS the built JavaScript, even under vitest
 *
 * A `Worker` starts a fresh Node module graph. Vitest's transform pipeline does
 * not reach into it, and Node 24's own type stripping does not close the gap
 * either: verified, `import { hello } from './dep.js'` inside a `.ts` file fails
 * with `ERR_MODULE_NOT_FOUND` because stripping does not remap a `.js`
 * specifier onto a `.ts` file. Every module this package's source imports is
 * written that way (NodeNext requires it), so a worker started on
 * `src/parse-worker.ts` would die on its first import. There is no arrangement
 * of loaders here worth maintaining; the built worker is the only runnable one.
 *
 * So the resolution has exactly two candidates, tried in order:
 *
 * | This module is | `./parse-worker.js` | `../dist/parse-worker.js` |
 * |---|---|---|
 * | `dist/parse-pool.js` (shipped) | ✅ used | not reached |
 * | `src/parse-pool.ts` (vitest) | ✗ absent | ✅ used |
 *
 * ⚠️ The consequence, stated rather than hidden: under vitest the pool runs the
 * BUILT parser while the test's oracle runs the SOURCE parser. That is what
 * makes the equivalence test meaningful across the build boundary, and it is
 * also why a stale `dist/` produces a confusing red — run `tsc --build
 * packages/resources` before trusting a failure here.
 *
 * `dist` ships already (`package.json` `files` lists it), so the worker needs no
 * packaging change.
 *
 * @returns Absolute path to the worker entry
 * @throws If neither candidate exists — the build has not run
 */
function resolveWorkerEntry(): string {
  if (workerEntryOverride !== null) return workerEntryOverride;
  if (resolvedWorkerEntry !== undefined) return resolvedWorkerEntry;

  const candidates = ['./parse-worker.js', '../dist/parse-worker.js'].map((specifier) =>
    fileURLToPath(new URL(specifier, import.meta.url)),
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- both candidates are derived from import.meta.url; no caller input reaches this
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `Cannot locate VAT's parse worker. Looked for ${candidates.join(' and ')}. ` +
        'This is a broken or unbuilt VAT installation — run the package build.',
    );
  }
  resolvedWorkerEntry = found;
  return found;
}

/**
 * The worker count a pool picks when the caller names none.
 *
 * @returns One core less than the machine offers, floored at 1 and capped at
 *   {@link DEFAULT_POOL_SIZE_CAP}
 */
export function defaultParsePoolSize(): number {
  return Math.max(1, Math.min(DEFAULT_POOL_SIZE_CAP, availableParallelism() - 1));
}

/**
 * Rebuild a full `ParseResult` from what came back off-thread.
 *
 * The mirror of `parse-cache.ts`'s `rehydrate`, and deliberately the same
 * decision: `content`/`sizeBytes` come from the caller's own bytes, and
 * `frontmatter` is re-derived by `parseFrontmatterSource` — the *same function
 * the cold path runs* — so an off-thread parse and an in-process one cannot
 * disagree about it. It is not `rehydrate` itself only because that function
 * takes a `KeyedContent`, and a pool holds no bytes to key and no decode
 * provenance to report; fabricating those two fields to reach it would put a
 * lie in the data to save four lines.
 *
 * Spreading `facts` first is what keeps a stored `frontmatterError` that has no
 * `frontmatterSource` beside it — `rehydrate`'s second branch — while a source
 * that IS present wins, because `derived` is spread after.
 *
 * @param facts - What the worker sent back
 * @param content - The caller's own bytes, decoded
 * @param byteLength - The caller's own raw byte count
 * @returns A parse result equal to the in-process parser's
 */
function attachContent(facts: ParseWireFacts, content: string, byteLength: number): ParseResult {
  const { frontmatterSource } = facts;
  const derived = frontmatterSource === undefined ? {} : parseFrontmatterSource(frontmatterSource);

  return { ...facts, ...derived, content, sizeBytes: byteLength };
}

/**
 * Rebuild a thrown parser failure on this side of the boundary.
 *
 * Not the original class — structured clone cannot carry one — but it wears the
 * original `name`, `message`, `stack` and, critically, `code`. See
 * {@link ParseWorkerFailure}.
 *
 * @param failure - The flattened failure
 * @returns An error the toolkit's existing classifiers still recognise
 */
function reviveFailure(failure: ParseWorkerFailure): Error {
  const error: Error & { code?: string } = new Error(failure.message);
  error.name = failure.name;
  if (failure.stack !== undefined) error.stack = failure.stack;
  if (failure.code !== undefined) error.code = failure.code;
  return error;
}

/** One queued or in-flight parse. */
interface PendingJob {
  request: ParseWorkerParseRequest;
  /** `null` resolves a cache-transport job the worker stored — see {@link ParsePool.parseIntoCache}. */
  resolve: (result: ParseResult | null) => void;
  reject: (error: Error) => void;
  /**
   * `performance.now()` when the request was POSTED, not when it was queued.
   *
   * Brackets {@link TierPass.WireRoundtrip}, and the distinction matters: time a
   * job spends waiting for a free worker is the pool being too narrow, not the
   * boundary being expensive, and charging it here would make a starved pool
   * look like a serialization problem. `0` until dispatch.
   */
  dispatchedAt: number;
}

/** One worker thread and the job it currently holds. */
interface PoolWorker {
  worker: Worker;
  /** The job in flight on this thread, or `null` when idle. */
  job: PendingJob | null;
  /** Set from the `exit` listener, so shutdown never awaits an exit that already happened. */
  exited: boolean;
}

/**
 * The pool. Constructed only through {@link createParsePool}, which is what
 * keeps its laziness a property of the type rather than of a call site.
 */
class WorkerParsePool implements ParsePool {
  readonly size: number;

  readonly #workerData: ParseWorkerData;
  readonly #workers: PoolWorker[] = [];
  readonly #queue: PendingJob[] = [];
  readonly #drainWaiters: (() => void)[] = [];

  #nextId = 0;
  #closed = false;
  #shutdown: Promise<void> | undefined;

  constructor(size: number, workerData: ParseWorkerData) {
    this.size = size;
    this.#workerData = workerData;
  }

  /** @inheritdoc */
  async parse(
    kind: DocumentParserKind,
    content: string,
    byteLength: number,
  ): Promise<ParseResult> {
    const result = await this.#enqueue({ kind, content, byteLength });
    if (result === null) {
      // Unreachable through the protocol: a worker answers `stored` only to a
      // request carrying a `cacheKey`, and this method never sends one. Named
      // rather than cast away, because the alternative to a throw here is a
      // `ParseResult` that is actually `null` reaching a caller that will read
      // `.links` off it far from the cause.
      throw new Error(
        "VAT's parse worker answered a wire-transport request as if it had cached the facts.",
      );
    }
    return result;
  }

  /** @inheritdoc */
  async parseIntoCache(
    kind: DocumentParserKind,
    content: string,
    byteLength: number,
    cacheKey: string,
  ): Promise<ParseResult | null> {
    return this.#enqueue({ kind, content, byteLength, cacheKey });
  }

  /**
   * Queue one job and pump, whichever transport the caller asked for.
   *
   * One body for both public methods: they differ only in whether a `cacheKey`
   * rides along, and every other concern — the shut-down guard, the id, the
   * queue, the pump — is identical. Two copies would be two places for the
   * closed check to be forgotten.
   *
   * @param job - The request minus the fields this pool owns
   * @returns The parse, or `null` when the worker cached it instead
   */
  async #enqueue(
    job: Omit<ParseWorkerParseRequest, 'type' | 'id'>,
  ): Promise<ParseResult | null> {
    if (this.#closed) {
      throw new Error('This parse pool has been shut down; create a new one to parse again.');
    }

    this.#nextId += 1;
    const request: ParseWorkerParseRequest = { type: 'parse', id: this.#nextId, ...job };

    return new Promise<ParseResult | null>((resolve, reject) => {
      this.#queue.push({ request, resolve, reject, dispatchedAt: 0 });
      this.#pump();
    });
  }

  /** @inheritdoc */
  async shutdown(): Promise<void> {
    this.#shutdown ??= this.#performShutdown();
    return this.#shutdown;
  }

  /**
   * Drain, then close every thread gracefully.
   *
   * The order is load-bearing: a worker closed while it still holds a job would
   * reject that job, and a worker closed with `terminate()` would lose its
   * parse-timing dump. See the module docstring.
   */
  async #performShutdown(): Promise<void> {
    this.#closed = true;
    await this.#drained();

    const closing = this.#workers.splice(0, this.#workers.length);
    await Promise.all(closing.map(async (poolWorker) => closeWorker(poolWorker)));
  }

  /** Assign queued jobs to idle threads, spawning up to {@link size} of them. */
  #pump(): void {
    while (this.#queue.length > 0) {
      const target = this.#idleWorker() ?? this.#spawn();
      if (target === undefined) return;

      const job = this.#queue.shift();
      if (job === undefined) return;
      target.job = job;
      target.worker.ref();
      // The one parent-thread cost this design has always named and never
      // measured: `postMessage` serializes the whole content string HERE, on
      // the thread the pool exists to unburden. See DEFAULT_POOL_SIZE_CAP.
      const dispatchStartedAt = parseTimingStart();
      target.worker.postMessage(job.request);
      recordTierPass(TierPass.WireDispatch, dispatchStartedAt);
      // After the post, so queue-wait time is never charged to the boundary.
      job.dispatchedAt = parseTimingStart();
    }
  }

  #idleWorker(): PoolWorker | undefined {
    return this.#workers.find((candidate) => candidate.job === null);
  }

  /**
   * Start one more thread, or answer `undefined` when the ceiling is reached.
   *
   * A worker entry that cannot be resolved is not transient — no later job
   * would fare better — so it fails every queued job rather than being retried
   * once per document.
   */
  #spawn(): PoolWorker | undefined {
    if (this.#workers.length >= this.size) return undefined;

    let worker: Worker;
    try {
      worker = new Worker(resolveWorkerEntry(), { workerData: this.#workerData });
    } catch (error) {
      this.#failQueue(error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }

    const poolWorker: PoolWorker = { worker, job: null, exited: false };
    worker.on('message', (response: ParseWorkerResponse) => {
      this.#settle(poolWorker, response);
    });
    worker.on('error', (error: Error) => {
      this.#abandon(poolWorker, error);
    });
    worker.on('exit', (code: number) => {
      poolWorker.exited = true;
      this.#abandon(
        poolWorker,
        new Error(`VAT's parse worker exited unexpectedly with code ${String(code)}.`),
      );
    });

    this.#workers.push(poolWorker);
    return poolWorker;
  }

  /** Hand one worker's answer to the job that asked for it. */
  #settle(poolWorker: PoolWorker, response: ParseWorkerResponse): void {
    if ('timing' in response) {
      // Answers the SHUTDOWN request, not a parse. Handled before anything
      // touches `poolWorker.job`, because this thread may well still be holding
      // one — clearing it here would strand that document forever.
      recordThreadTiming(response.timing);
      return;
    }

    const job = poolWorker.job;
    poolWorker.job = null;
    poolWorker.worker.unref();

    if (job !== null) {
      recordTierPass(TierPass.WireRoundtrip, job.dispatchedAt);
      settleJob(job, response);
    }

    this.#pump();
    this.#notifyDrained();
  }

  /**
   * A thread died or errored. Its job, if any, can never be answered — reassign
   * nothing and reject it, because a document that killed a thread would kill
   * the next one too.
   */
  #abandon(poolWorker: PoolWorker, error: Error): void {
    const index = this.#workers.indexOf(poolWorker);
    if (index !== -1) this.#workers.splice(index, 1);

    const job = poolWorker.job;
    poolWorker.job = null;
    job?.reject(error);

    this.#pump();
    this.#notifyDrained();
  }

  /** Reject everything outstanding — used when no thread can ever be started. */
  #failQueue(error: Error): void {
    for (const job of this.#queue.splice(0, this.#queue.length)) job.reject(error);
    this.#notifyDrained();
  }

  #isDrained(): boolean {
    return this.#queue.length === 0 && this.#workers.every((candidate) => candidate.job === null);
  }

  #notifyDrained(): void {
    if (!this.#isDrained()) return;
    for (const waiter of this.#drainWaiters.splice(0, this.#drainWaiters.length)) waiter();
  }

  /** Resolves once nothing is queued and no thread holds a job. */
  async #drained(): Promise<void> {
    if (this.#isDrained()) return;
    return new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
    });
  }
}

/**
 * Hand one worker's answer to the job that asked for it, whichever arm it is.
 *
 * A free function rather than a method because it needs nothing from the pool —
 * and because keeping the three-arm decision in one small named place is what
 * stops a fourth arm being added to the union and silently falling through to
 * `facts` at the call site.
 *
 * 🪤 **`wire-attach` deliberately does NOT bracket the deserialization**, which
 * is the larger half of what receiving facts costs. Node deserializes a message
 * before it dispatches the `message` event, so by the time this function can
 * read a clock the work is already done and there is no seam left to bracket.
 * The row is named for what it does measure. See {@link TierPass} for what that
 * costs an A/B and why the asymmetry is stated rather than papered over.
 *
 * @param job - The job awaiting an answer
 * @param response - What the worker sent
 */
function settleJob(
  job: PendingJob,
  response: Exclude<ParseWorkerResponse, ParseWorkerTimingReport>,
): void {
  if ('failure' in response) {
    job.reject(reviveFailure(response.failure));
    return;
  }
  if ('stored' in response) {
    // The facts are on disk under the key the parent supplied. Nothing crossed
    // the boundary but that key, which is the entire point of this arm.
    job.resolve(null);
    return;
  }

  const attachStartedAt = parseTimingStart();
  const result = attachContent(response.facts, job.request.content, job.request.byteLength);
  recordTierPass(TierPass.WireAttach, attachStartedAt);
  job.resolve(result);
}

/**
 * Close one worker so its `exit` listeners run.
 *
 * `terminate()` is reached only when a thread ignores the close for
 * {@link GRACEFUL_EXIT_TIMEOUT_MS}, and costs that thread's parse-timing dump.
 *
 * @param poolWorker - The thread to close
 */
async function closeWorker(poolWorker: PoolWorker): Promise<void> {
  if (poolWorker.exited) return;

  const { worker } = poolWorker;
  // Re-`ref` it: an idle worker is unref'd, and an unref'd thread cannot keep
  // the process alive long enough for its own exit to be observed.
  worker.ref();
  const exited = once(worker, 'exit');
  worker.postMessage(SHUTDOWN_REQUEST);

  const escape = setTimeout(() => {
    // The pool has already stopped tracking this thread, so there is no caller
    // left to tell — and `terminate()` resolving late must not become an
    // unhandled rejection in a command that is on its way out.
    worker.terminate().catch(() => undefined);
  }, GRACEFUL_EXIT_TIMEOUT_MS);
  try {
    await exited;
  } finally {
    clearTimeout(escape);
  }
}

/**
 * Create a parse pool.
 *
 * Spawns nothing and loads no parser — see property 3 in the module docstring.
 * The first {@link ParsePool.parse} starts the first thread.
 *
 * @param options - Worker ceiling; defaults to {@link defaultParsePoolSize}
 * @returns A pool the caller MUST `shutdown()`, in a `finally`
 *
 * @example
 * ```typescript
 * const pool = createParsePool();
 * try {
 *   const result = await pool.parse('markdown', content, byteLength);
 * } finally {
 *   await pool.shutdown();
 * }
 * ```
 */
export function createParsePool(options?: ParsePoolOptions): ParsePool {
  const requested = options?.size;
  const size =
    requested === undefined ? defaultParsePoolSize() : Math.max(1, Math.floor(requested));
  const cacheDir = options?.cacheDir;
  // Conditional spread, never `{ cacheDir: undefined }`: `workerData` is
  // structured-cloned, and an own property valued `undefined` is not the same as
  // an absent one to the `in` check on the other side.
  return new WorkerParsePool(size, cacheDir === undefined ? {} : { cacheDir });
}
