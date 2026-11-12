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
 * `frontmatter` does not come back as an object either, and that one is a
 * **correctness** requirement rather than a size one: `ParseResult.frontmatter`
 * is whatever `yaml` decoded, and structured clone is not the identity on it.
 * Verified — `blob: !!binary aGVsbG8=` decodes to a `Buffer` and arrives on the
 * other side as a `Uint8Array`, which `deepStrictEqual` rejects. Nor may this
 * side re-decode the source: a deep block overflows the main thread's stack, so
 * YAML is decoded only in the worker, under its limits. So the worker's decode
 * travels as `frontmatterValue` (`frontmatter-codec.ts`) and is rebuilt here,
 * exactly as `parse-cache.ts`'s `rehydrate` does on a cache hit. Everything else in
 * `ParseFacts` is plain JSON-shaped data — it has to be, because the parse cache
 * already round-trips it through JSON — and `parse-pool.test.ts` pins that with
 * a `structuredClone` identity check over every fixture.
 *
 * **3. Nothing happens until the first parse.** A dispatcher builds its pool
 * only past the cache-hit return, because that position is the only reason a
 * fully warm run loads no parser at all (a parser-load hoist has regressed twice
 * at ~730 ms of remark load apiece). This pool keeps the same discipline: {@link createParsePool} allocates an object and
 * spawns nothing. The first {@link ParsePool.parse} spawns the first thread; the
 * worker then loads its parser through the lazy `loadParser` (`parser-loader.ts`). A pool that
 * is created and never used costs one object.
 *
 * **4. A failed document is data; a failed thread is an error.** A document that
 * parse5 finds malformed comes back as `ParseResult.parseErrors`, off-thread
 * exactly as on-thread — never as a rejection. A parser module that cannot be
 * loaded comes back as a rejection carrying the original `name`, `message` and
 * `code`, so `isParserUnavailable` (which matches on `code`, not only on
 * `instanceof`) still classifies it as a broken install. A thread that dies
 * without answering rejects its job with a `ParseWorkerDiedError` — a per-run
 * outcome beside the limit breaches, never stored as a failure of the bytes.
 *
 * ## What a breach does to the worker
 *
 * Time and heap breaches kill and replace the worker: the job cannot be
 * interrupted any other way. Stack and output breaches are reported by the
 * worker itself, which stays in the pool. Input size is refused before
 * dispatch, so no worker sees the document at all.
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
 * While timings are recorded, shutdown closes every thread; otherwise it parks
 * the healthy idle ones for the next pool (see `parkedWorkers`), and a parked
 * thread is `unref`'d like any idle one and closes itself after `PARKED_IDLE_MS`.
 *
 * A pool that is never shut down reports no worker timings, because nothing ever
 * asks the threads for them. Idle workers are `unref`'d so a forgotten pool
 * cannot HANG a CLI, but that is damage control, not a substitute: call
 * `shutdown()` in a `finally`.
 */

import { availableParallelism, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { followedKindSync } from '@vibe-agent-toolkit/utils';

import { decodeFrontmatterValue, encodeFrontmatterValue } from './frontmatter-codec.js';
import type { ParseResult } from './link-parser.js';
import type { DocumentParserKind } from './mime-type.js';
import { type ParserModuleKind, ParserUnavailableError } from './parse-cache.js';
import {
  exceedsHeapLimit,
  FRESH_THREAD_HEAP_MB,
  heapBounds,
  heapBreached,
  type HeapBounds,
  inputBytesBreach,
  memoryBoundedPool,
  parkedThreadRoom,
  type ParseLimitName,
  type ParseLimits,
  ParseDecodeDefectError,
  ParseLimitError,
  reviveParserThrow,
  ParseWorkerDiedError,
  resolveParseLimits,
  type ReuseCheck,
  v8HeapFlags,
  type V8HeapFlags,
  workerHeapCeilingMb,
  workerHeapGeometry,
} from './parse-limits.js';
import {
  type ParseThreadTiming,
  parseTimingEnabled,
  parseTimingStart,
  recordReuseCheck,
  recordThreadTiming,
  recordTierPass,
  TierPass,
} from './parse-timing.js';
import type { HarnessContentFacts, HarnessId } from './projection/harness/profile.js';

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

/**
 * How often the parent samples a busy worker's heap against its limit.
 *
 * The ONE enforcer of `heapMb`. V8's own ceiling (`resourceLimits`) is set
 * past it, because reaching that ceiling can kill the whole process (see
 * `workerHeapCeilingMb`), and a process-wide `--max-old-space-size` (in
 * `NODE_OPTIONS`, as CI often sets it) overrides it anyway: it is a V8 global
 * flag, and measured on Node 26, a worker given a 48 MiB limit under
 * `--max-old-space-size=4096` reports a 4,192 MiB heap limit. `Worker.getHeapStatistics()`
 * answers from the worker's own isolate even mid-way through a synchronous
 * parse (measured: 1 ms), so the limit holds whatever flags the process runs
 * under. Which sample stops a job is `heapBreached`'s call; the sample interval
 * bounds how far past that point a job can allocate
 * before it is stopped.
 */
export const HEAP_SAMPLE_INTERVAL_MS = 50;

/**
 * Threads that may die in a row, with no answer from any thread between them,
 * before the pool calls the install broken and fails every job as
 * parser-unavailable.
 *
 * One death is a per-run outcome of one document (`ParseWorkerDiedError`). A
 * thread that loads and then dies on every job is not the documents' doing,
 * and without a breaker it would blame each file in the corpus in turn. Three,
 * because two documents that each kill a thread back to back are conceivable
 * and three are not; any answer between deaths resets the count.
 *
 * Threads stopped at their load clock ({@link JobClock}) in a row are judged by the same number,
 * counted apart and per parser kind: see {@link LoadStopRun}.
 */
const DEATHS_BEFORE_UNAVAILABLE = 3;

/**
 * How late past its scheduled time a deadline may fire and still have its stop
 * count toward {@link DEATHS_BEFORE_UNAVAILABLE}: one heap-sample interval.
 *
 * A thread stopped at its load clock (see `JobClock`) is counted as a death
 * on the inference that the parser had the whole of `timeMs` to load and did
 * not. A parent whose own timer fires late was itself blocked or starved for
 * that long — synchronous work, or a host too loaded to schedule it — and the
 * same load may have starved the thread it is judging, so the inference fails.
 * The pool already assumes its loop turns within one sample interval: the heap
 * sampler is armed at that period, and a parent later than that reads the heap
 * late too (the hazard register's heap-flag row). So the same bound marks a
 * parent too late to judge a parser load. Such a stop neither counts nor resets
 * the count, so a broken install on a starved host is still called broken at its
 * first on-time stops; the job runs again, and one stopped late every time ends as
 * a `ParserUnavailableError` of its own, never charged to its document (`#stopAtLoadDeadline`).
 */
const LATE_DEADLINE_MS = HEAP_SAMPLE_INTERVAL_MS;

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
 * A harness's memory-file read that crosses to a worker: what the harness does
 * with one file's bytes (`HarnessContentFacts`), run by the reader the worker
 * resolves from `harness` — a function cannot cross the boundary, an id can.
 * The facts always travel over the wire: nothing caches them but the
 * projection store, per blob and harness.
 */
interface ParseWorkerHarnessRequest {
  type: 'harness';
  /** Correlates the response. Unique within one pool. */
  id: number;
  harness: HarnessId;
  content: string;
  /** Bytes of what the worker is handed; held to the input cap before dispatch. */
  byteLength: number;
}

/** A job a worker runs: a document parse, or a harness's memory-file read. */
type ParseWorkerJobRequest = ParseWorkerParseRequest | ParseWorkerHarnessRequest;

/**
 * The module a job needs loaded on its worker before it runs: its parser kind,
 * or its harness.
 *
 * @param request - The job
 * @returns What {@link ParseWorkerParserLoaded} names once that module is loaded
 */
function moduleKindOf(request: ParseWorkerJobRequest): ParserModuleKind {
  return request.type === 'parse' ? request.kind : request.harness;
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

/**
 * A job as posted to one thread: the job, and whether that thread settles its heap before running
 * it.
 *
 * `settleHeap` is the parent's word on whether the thread is reused (`PoolWorker.reused`) — the one
 * place that is known — so the worker never keeps a second idea of it. Set, the worker runs
 * `settleReusedHeap` first and posts a {@link ParseWorkerReuseCheck}; retired, it runs nothing.
 */
type ParseWorkerDispatch = ParseWorkerJobRequest & { readonly settleHeap: boolean };

/** Everything the parent sends a worker. */
export type ParseWorkerRequest = ParseWorkerDispatch | ParseWorkerShutdownRequest;

/**
 * Posted by a reused thread before it runs a job (`ParseWorkerDispatch.settleHeap`): what it holds
 * once settled ({@link ReuseCheck}). Retired, the thread has not run the job and never will; the
 * parent runs it again on a fresh thread. Kept, the job runs now, and the parent starts sampling it.
 */
interface ParseWorkerReuseCheck {
  id: number;
  reuseCheck: ReuseCheck;
}

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
  /**
   * Set only when the PARSER threw this over the document's bytes — never for a
   * loader, cache or protocol failure. The parent revives a branded failure as
   * a branded throw (`reviveParserThrow`), the one failure a lane may store as the document's.
   */
  fromDocument?: true;
}

/**
 * Flatten a thrown value into something structured clone can carry.
 *
 * `code` is the load-bearing field: `isParserUnavailable` matches on it as well
 * as on `instanceof`, and an error rebuilt in the parent is necessarily a plain
 * `Error`. Dropping the code would silently downgrade a broken VAT install into
 * an ordinary per-document failure — the exact defect `ParserUnavailableError`
 * exists to close.
 *
 * @param error - Whatever the worker caught
 * @param fromDocument - Whether the PARSER threw it over the bytes — see {@link ParseWorkerFailure.fromDocument}
 * @returns The failure as plain data, with no undefined-valued keys
 */
export function describeParseFailure(error: unknown, fromDocument: boolean): ParseWorkerFailure {
  const brand = fromDocument ? { fromDocument: true as const } : {};
  if (!(error instanceof Error)) return { name: 'Error', message: String(error), ...brand };

  const code: unknown = (error as { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(typeof code === 'string' ? { code } : {}),
    ...brand,
  };
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
export type ParseWireFacts = Omit<ParseResult, 'content' | 'sizeBytes' | 'frontmatter'> & {
  /** The decoded frontmatter mapping, encoded by `frontmatter-codec.ts`. Absent when there is none. */
  frontmatterValue?: string;
};

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
  | { id: number; harnessFacts: HarnessContentFacts }
  | { id: number; failure: ParseWorkerFailure }
  | { id: number; breach: ParseLimitName; found?: number }
  | ParseWorkerReuseCheck
  | ParseWorkerReady
  | ParseWorkerParserLoaded
  | ParseWorkerTimingReport;

/**
 * Posted once by a worker whose module graph has loaded. A thread that dies
 * before posting it could not even start, which no document can cause: the
 * install is broken, and the pool fails every job as parser-unavailable.
 */
export interface ParseWorkerReady {
  ready: true;
  /**
   * Whether the thread has a full collection to settle its heap with before a reused job
   * (`parse-collector.ts`). A runtime that refuses it is told once per process: a reused thread past
   * its bound is retired rather than collected, a thread start where a collection would do.
   */
  collector: boolean;
}

/**
 * Posted by a worker the first time a parser of `parserLoaded`'s kind has
 * loaded on it, BEFORE that parser runs. It moves the job from its load clock
 * to its parse clock (see `JobClock`): a thread stopped before it is a load
 * that hangs, which no document can cause, so the job runs again and the stop
 * counts toward the broken-install count; one stopped after is a slow
 * document, which never does.
 */
export interface ParseWorkerParserLoaded {
  /** The job the parser loaded for: only that job's clock moves. */
  id: number;
  parserLoaded: ParserModuleKind;
}

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
 * `frontmatter` travels as `frontmatterValue`, the worker's decode encoded by
 * `frontmatter-codec.ts` — a string, so neither the structured clone nor the
 * parent ever meets its depth, and the parent never decodes YAML.
 *
 * @param result - What the parser produced, in the worker
 * @returns The same facts minus `content` and `sizeBytes`, the mapping encoded
 */
export function toParseWire(result: ParseResult): ParseWireFacts {
  const wire: ParseWireDraft = { ...result };
  delete wire.content;
  delete wire.sizeBytes;
  delete wire.frontmatter;
  if (result.frontmatter !== undefined) wire.frontmatterValue = encodeFrontmatterValue(result.frontmatter);
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
   * @throws If the parser module cannot be loaded or the pool is shut down. A
   *   document that merely fails to parse is NOT an error — it comes back in
   *   `parseErrors`. A {@link ParseLimitError} when the job breached one of its
   *   limits: time and heap breaches kill and replace the worker, stack and
   *   output breaches are reported by it, and input size is refused before
   *   dispatch. A `ParseWorkerDiedError` when the worker holding the job died.
   *   Either way nothing is cached, and the caller refuses the file (I6, I8).
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
   * @throws On the same conditions {@link ParsePool.parse} throws on.
   */
  parseIntoCache(
    kind: DocumentParserKind,
    content: string,
    byteLength: number,
    cacheKey: string,
  ): Promise<ParseResult | null>;
  /**
   * Run a harness's memory-file read off-thread, under the same limits as a
   * parse — the reader is a parser too (`marked` and a YAML decode), and a
   * pathological memory file hangs, exhausts or overflows it the same way.
   *
   * @param harness - The harness whose reader runs; the worker resolves it by id
   * @param content - The decoded file
   * @param byteLength - Bytes of what is handed over, held to the input cap
   * @returns What the harness does with those bytes
   * @throws On the same conditions {@link ParsePool.parse} throws on: a
   *   {@link ParseLimitError}, a `ParseWorkerDiedError`, a parser-unavailable
   *   error for a broken install
   */
  harnessFacts(harness: HarnessId, content: string, byteLength: number): Promise<HarnessContentFacts>;
  /**
   * Close the pool. Queued and in-flight work is awaited first; then each
   * healthy idle thread is parked for the next pool of the same shape (never
   * while parse timing is recorded, nor from a pool judged broken, nor past the
   * memory left beside a bounded pool — see `parkedWorkers`; a parked thread
   * closes itself after `PARKED_IDLE_MS`), and every other one is closed gracefully so its
   * parse-timing dump reaches disk. Safe to call twice; the second call awaits
   * the first. Never rejects, and never changes what any parse returned: a
   * thread whose close fails is terminated, and when it settles every thread
   * it started that is not parked has exited.
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
  /**
   * Limits tighter (or looser) than `DEFAULT_PARSE_LIMITS`, per limit. Every job
   * runs under the resolved set; a breach rejects that job with a
   * `ParseLimitError` and never the pool. See `parse-limits.ts`.
   */
  limits?: Partial<ParseLimits>;
}

/** What a worker is told at construction. */
export interface ParseWorkerData {
  /** Parse-cache root, or `undefined` to let the worker use the default. See {@link ParsePoolOptions.cacheDir}. */
  cacheDir?: string;
  /** The limits the worker checks its own output against. Heap, stack and time are enforced from outside it. */
  limits: ParseLimits;
  /** The lock every thread takes its collector under: {@link COLLECTOR_LOCK}. */
  collectorLock: SharedArrayBuffer;
}

/**
 * The one lock, per copy of this module, under which a parse thread sets V8's `--expose-gc`, takes
 * its collector and clears the flag (`parse-collector.ts`): handed to every thread every pool
 * starts, so no two threads of this copy clear the flag from under one another. One `Int32`: 0
 * free, else the holder's `threadId`. Shared memory, so `workerKey` serialises it as `{}`: it never
 * tells two threads apart.
 */
const COLLECTOR_LOCK = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);

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
  // VAT's OWN installed files, never a crawled path: each candidate is its own `within` (`link-following.ts`).
  const found = candidates.find((candidate) => followedKindSync(candidate, candidate) !== 'absent');
  if (found === undefined) {
    throw new Error(
      `Cannot locate VAT's parse worker. Looked for ${candidates.join(' and ')}. ` +
        'This is a broken or unbuilt VAT installation — run the package build.',
    );
  }
  resolvedWorkerEntry = found;
  return found;
}

/** The worker entry's file name, named in a verdict when it could not be resolved at all. */
const WORKER_ENTRY_NAME = 'parse-worker.js';

/**
 * The verdict every job fails with once the install is judged broken.
 *
 * @param job - A job the verdict lands on, to name the parser it needed; none names markdown
 * @param entry - The worker entry that could not start, or its file name when none resolved
 * @param cause - What failed
 * @returns A parser-unavailable error, which every lane rethrows loud (`isParserUnavailable`)
 */
function unavailableFor(job: PendingJob | undefined, entry: string, cause: unknown): ParserUnavailableError {
  return new ParserUnavailableError(job === undefined ? 'markdown' : moduleKindOf(job.request), entry, cause);
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
 * `frontmatter` is rebuilt from `frontmatterValue` — the worker's own decode,
 * encoded — so this thread never decodes YAML (ADR I8: a deep block would
 * overflow the main thread's stack). It is not `rehydrate` itself only because
 * that function takes a `KeyedContent`, and a pool holds no bytes to key and no
 * decode provenance to report.
 *
 * @param facts - What the worker sent back
 * @param content - The caller's own bytes, decoded
 * @param byteLength - The caller's own raw byte count
 * @returns A parse result equal to the in-process parser's
 */
function attachContent(facts: ParseWireFacts, content: string, byteLength: number): ParseResult {
  const { frontmatterValue, ...rest } = facts;
  return {
    ...rest,
    ...(frontmatterValue !== undefined && { frontmatter: decodeFrontmatterValue(frontmatterValue) }),
    content,
    sizeBytes: byteLength,
  };
}

/**
 * Rebuild a thrown parser failure on this side of the boundary — branded only
 * when the worker says the parser threw it from the bytes ({@link reviveParserThrow}).
 *
 * @param failure - The flattened failure
 * @returns An error the toolkit's existing classifiers still recognise
 */
function reviveFailure(failure: ParseWorkerFailure): Error {
  return reviveParserThrow(failure, failure.fromDocument === true);
}

/**
 * What a job settles to: a parse (`null` for a cache-transport job the worker
 * stored — see {@link ParsePool.parseIntoCache}), or a harness's facts.
 */
type JobAnswer =
  | { readonly type: 'parse'; readonly result: ParseResult | null }
  | { readonly type: 'harness'; readonly facts: HarnessContentFacts };

/** One queued or in-flight job. */
interface PendingJob {
  request: ParseWorkerJobRequest;
  resolve: (answer: JobAnswer) => void;
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
  /**
   * The wall-clock timer in force: until the job's parser has loaded on its thread and a reused
   * thread's heap check has kept it, the {@link JobClock | load} clock; from then on, the parse
   * clock. Cleared when the job settles.
   */
  deadline?: ReturnType<typeof setTimeout>;
  /** Which clock {@link deadline} is: see {@link JobClock}. */
  clock: JobClock;
  /**
   * How many threads were stopped at the load clock holding this job. Each runs it again on a
   * fresh thread; see {@link #stopAtLoadDeadline} for what bounds them.
   */
  loadStops: number;
  /** When this job's current load clock started (`performance.now()`): see {@link LoadStopRun}. */
  loadClockFrom?: number;
  /**
   * The heap sampler — see {@link HEAP_SAMPLE_INTERVAL_MS}. Started at dispatch on a fresh thread,
   * and on a reused one only once its heap check has reported (`#afterReuseCheck`), so no job is
   * judged on what the job before it left; cleared with the deadline ({@link disarm}).
   */
  heapWatch?: ReturnType<typeof setInterval>;
  /** The used heap this job's last sample read, in bytes: a fall from it is a collection (`heapBreached`). */
  lastHeapUsed?: number;
  /**
   * Which thread the job may next be dispatched to: `fresh` once a reused thread was retired under
   * it (its {@link ParseWorkerReuseCheck}), so it is never handed to another reused thread; `any`
   * otherwise.
   */
  thread: 'any' | 'fresh';
}

/**
 * Which wall-clock limit a dispatched job is under.
 *
 * `load`: the job's thread has not yet loaded the job's parser (a fresh thread is still starting,
 * or loading it), or, on a reused thread, has not yet reported its heap check — the read and any
 * forced collection are the pool's work, never the document's (`#afterReuseCheck`). A stop there
 * is the THREAD's — no document can make a parser load slow — so it
 * never refuses the document: the job runs again on a fresh thread, and the stop counts toward
 * the broken-install breaker like a death ({@link DEATHS_BEFORE_UNAVAILABLE}), never alone.
 *
 * `parse`: the parser loaded, and a reused thread kept itself. `timeMs` runs from that moment, so a
 * document is given its whole limit to parse however long its thread took to start or to settle
 * its heap, and a stop there is the document's
 * per-run refusal, which never counts toward the breaker.
 *
 * Both are `timeMs` long: one bound on each, so every job still ends within a known time (I8). A
 * job stopped at its load clock on {@link DEATHS_BEFORE_UNAVAILABLE} threads ends as a
 * `ParserUnavailableError` whose cause says its parser could not start within `timeMs` that many
 * times: it fails the run loudly and blames no document (`#stopAtLoadDeadline`).
 */
type JobClock = 'load' | 'parse';

/**
 * One parser kind's run of load-clock stops counted toward {@link DEATHS_BEFORE_UNAVAILABLE}.
 *
 * Kept per kind, because only that parser loading anywhere ends it: an answer from a markdown
 * job says nothing about an HTML parser import that hangs, and a count any answer reset would
 * never reach three while markdown jobs kept answering between HTML stops. Kept apart from the
 * run of deaths, which any answer ends. A stop whose load clock overlapped the last counted one
 * is not counted at all (`#countLoadStop`).
 */
interface LoadStopRun {
  /** Counted stops since the parser last loaded. */
  readonly count: number;
  /** When the last counted stop was made (`performance.now()`). */
  readonly lastCountedAt: number;
}

/** One worker thread and the job it currently holds. */
interface PoolWorker {
  worker: Worker;
  /** The job in flight on this thread, or `null` when idle. */
  job: PendingJob | null;
  /** Set from the `exit` listener, so shutdown never awaits an exit that already happened. */
  exited: boolean;
  /** Resolves when the thread has exited, however it went. */
  gone: Promise<void>;
  /** Set once the thread posted {@link ParseWorkerReady}: its module graph loaded. */
  ready: boolean;
  /**
   * The parser kinds that have loaded on this thread ({@link ParseWorkerParserLoaded}):
   * a time breach on a job whose kind is not here is counted as a death.
   */
  parsersLoaded: Set<ParserModuleKind>;
  /**
   * Set once the pool is done with this thread — terminated at a limit, closed
   * at shutdown, or already counted as dead — so its later `error` or `exit`
   * is bookkeeping, never a second death.
   */
  retired: boolean;
  /** The entry the thread was started from, named when it cannot start. */
  entry: string;
  /**
   * The heap limit the pool enforces on this thread and V8's own ceiling
   * above it, in MiB, re-read from every heap sample — lower than `heapMb`
   * when a process-wide `--max-old-space-size` lowered V8's ceiling. Undefined
   * until a sample lands — never assumed from `heapMb`, because a flag may have
   * lowered them and a refusal must not name a limit nobody read. See `heapBounds`.
   */
  heapBounds: HeapBounds | undefined;
  /**
   * What makes this thread interchangeable with another — {@link workerKey}, taken when it was
   * started, because the environment it copied then is the one it runs under.
   */
  key: string;
  /**
   * Set when a reused thread — one adopted from the parked set included — is handed a job, until its
   * heap check for that job (`ParseWorkerReuseCheck` with the job's id) reaches the pool; nothing
   * else clears it. A thread stopped, dead, or stopped by V8 at its ceiling while it is set ran
   * nothing of the job's: what it held was earlier jobs' (or was left while it was parked), so the
   * job runs again on a fresh thread, and the stop counts toward no broken-install run.
   */
  heapCheckPending: boolean;
  /**
   * Set once the thread has answered a job, or when it was adopted from the parked set: it may
   * carry what earlier jobs left on its heap, so it settles that before each job it is handed
   * (`ParseWorkerDispatch.settleHeap`), and is retired when it cannot. A fresh thread is never
   * checked: what it holds is its own start-up heap.
   */
  reused: boolean;
  /** Removes this pool's listeners, so a parked thread answers to nobody's bookkeeping. */
  detach: () => void;
}

/**
 * The pool. Constructed only through {@link createParsePool}, which is what
 * keeps its laziness a property of the type rather than of a call site.
 */
class WorkerParsePool implements ParsePool {
  readonly size: number;

  readonly #workerData: ParseWorkerData;
  readonly #limits: ParseLimits;
  readonly #workers: PoolWorker[] = [];
  /**
   * Threads told to terminate (a time or heap breach), or that died uncontrolled, that have not exited
   * yet. They count against {@link size} until they do, so a breach replaces
   * its thread without the pool ever running wider than its width.
   */
  readonly #terminating = new Set<PoolWorker>();
  readonly #queue: PendingJob[] = [];
  /** Threads that died in a row with no answer between: see {@link DEATHS_BEFORE_UNAVAILABLE}. */
  #consecutiveDeaths = 0;
  /** Each parser kind's run of counted load-clock stops: see {@link LoadStopRun}. */
  readonly #loadStopRuns = new Map<ParserModuleKind, LoadStopRun>();
  /** Set once the install is judged broken; every job after it fails with it. */
  #unavailable: Error | undefined;
  readonly #drainWaiters: (() => void)[] = [];

  #nextId = 0;
  #closed = false;
  #shutdown: Promise<void> | undefined;

  /** How many threads may stay parked once this pool shuts down: see {@link parkedThreadRoom}. */
  readonly #parkCap: number;
  /**
   * The process-wide V8 heap flags every thread of this pool runs under, read once: its threads
   * inherit this process's `execArgv` and environment. See `workerHeapGeometry`.
   */
  readonly #heapFlags: V8HeapFlags = v8HeapFlags(process.env['NODE_OPTIONS'], process.execArgv);

  constructor(size: number, workerData: ParseWorkerData, parkCap: number) {
    this.size = size;
    this.#workerData = workerData;
    this.#limits = workerData.limits;
    this.#parkCap = parkCap;
  }

  /** @inheritdoc */
  async parse(
    kind: DocumentParserKind,
    content: string,
    byteLength: number,
  ): Promise<ParseResult> {
    const result = parseAnswer(await this.#enqueue({ type: 'parse', kind, content, byteLength }));
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
    return parseAnswer(await this.#enqueue({ type: 'parse', kind, content, byteLength, cacheKey }));
  }

  /** @inheritdoc */
  async harnessFacts(harness: HarnessId, content: string, byteLength: number): Promise<HarnessContentFacts> {
    const answer = await this.#enqueue({ type: 'harness', harness, content, byteLength });
    if (answer.type !== 'harness') throw protocolMismatch(answer.type, 'harness');
    return answer.facts;
  }

  /**
   * Queue one job and pump, whichever job and transport the caller asked for.
   *
   * One body for every public method: they differ only in the request, and
   * every other concern — the shut-down guard, the input cap, the id, the
   * queue, the pump — is identical. Several copies would be several places for
   * the closed check to be forgotten.
   *
   * @param job - The request minus the id this pool owns
   * @returns What the worker answered
   */
  #enqueue(
    job: DistributiveOmit<ParseWorkerJobRequest, 'id'>,
  ): Promise<JobAnswer> {
    if (this.#closed) {
      return Promise.reject(new Error('This parse pool has been shut down; create a new one to parse again.'));
    }
    if (this.#unavailable !== undefined) return Promise.reject(this.#unavailable);
    // Refused before any thread sees it: the input cap is the one limit that is
    // a property of the request alone, so it costs no worker to enforce.
    const tooLarge = inputBytesBreach(job.byteLength, this.#limits.inputBytes);
    if (tooLarge !== undefined) return Promise.reject(tooLarge);

    this.#nextId += 1;
    const request: ParseWorkerJobRequest = { ...job, id: this.#nextId };

    return new Promise<JobAnswer>((resolve, reject) => {
      this.#queue.push({ request, resolve, reject, dispatchedAt: 0, clock: 'load', loadStops: 0, thread: 'any' });
      this.#pump();
    });
  }

  /** @inheritdoc */
  shutdown(): Promise<void> {
    this.#shutdown ??= this.#performShutdown();
    return this.#shutdown;
  }

  /**
   * Drain, then close every thread gracefully.
   *
   * The order is load-bearing: a worker closed while it still holds a job would
   * reject that job, and a worker closed with `terminate()` would lose its
   * parse-timing dump. See the module docstring.
   *
   * It never rejects: every job has settled by the time a thread is closed, so nothing a closing
   * thread does can change what the run answered, and a shutdown that rejected would replace that
   * answer in the caller's `finally` and leave the threads after it unawaited. A thread that cannot
   * be parked is closed; {@link closeWorker} settles on its `exit` whatever it raises on the way.
   */
  async #performShutdown(): Promise<void> {
    this.#closed = true;
    await this.#drained();

    const closing = this.#workers.splice(0, this.#workers.length);
    for (const poolWorker of closing) poolWorker.retired = true;
    // A pool judged broken parks nothing: its verdict is its own, and no thread it
    // ran is carried to a later pool. Nor does a timed run, whose counters a parked
    // thread would never hand back. Nor, past its cap, a pool on a machine with no memory to spare.
    const mayPark = this.#unavailable === undefined && !parseTimingEnabled() && this.#parkCap > 0;
    await Promise.all([
      ...closing.map(async (poolWorker) => {
        if (mayPark && (await this.#park(poolWorker).catch(() => false))) return;
        if (!poolWorker.exited) await closeWorker(poolWorker.worker);
      }),
      // A thread terminated at a limit is still exiting; shutdown is not done until it has.
      ...[...this.#terminating].map((poolWorker) => poolWorker.gone),
    ]);
  }

  /**
   * Leave a healthy idle thread for the next pool of the same shape, rather than close it.
   *
   * Only a thread that loaded, holds no job, is still alive, and whose used heap is at most
   * {@link PARKED_HEAP_MB}: a thread that breached or died was retired out of {@link #workers}
   * before shutdown ever saw it, and one filled by a large crawl would hold that memory idle. What
   * a parked thread carries never shortens a job's room by more than the reuse check allows: its
   * first job in the adopting pool settles its heap like any reused thread's (`settleReusedHeap`),
   * at every applied bound.
   *
   * @param poolWorker - A thread this pool is done with
   * @returns Whether it was parked; `false` leaves it to be closed
   */
  async #park(poolWorker: PoolWorker): Promise<boolean> {
    if (poolWorker.exited || !poolWorker.ready || poolWorker.job !== null) return false;
    // Re-`ref` it for the read, as `closeWorker` does for the close: an idle thread is unref'd, and
    // a heap read from an unref'd thread holds nothing open — a command whose last work is this
    // shutdown would exit, mid-shutdown and at code 0, before the read answered. `parkWorker`
    // unrefs it again once it is parked; a thread declined here is closed, which refs it anyway.
    poolWorker.worker.ref();
    // The read rejects only for a thread that has gone, which is closed, never parked.
    const heap = await poolWorker.worker.getHeapStatistics().catch(() => undefined);
    if (heap === undefined || poolWorker.exited) return false;
    if (exceedsHeapLimit(heap, PARKED_HEAP_MB)) return false;
    poolWorker.detach();
    await parkWorker(poolWorker.worker, poolWorker.key, poolWorker.parsersLoaded, this.#parkCap);
    return true;
  }

  /**
   * Assign queued jobs to idle threads, spawning up to {@link size} of them, in queue order.
   *
   * A job a reused thread was retired under waits for a slot a fresh thread can start in
   * ({@link #threadFor}); the jobs behind it may run on an idle thread meanwhile, which it could
   * not take. Any other job that finds no thread waits, and so does everything behind it: no
   * thread is free for them either.
   */
  #pump(): void {
    if (this.#unavailable !== undefined) {
      this.#failAll(this.#unavailable);
      return;
    }
    let index = 0;
    while (index < this.#queue.length) {
      const job = this.#queue[index];
      const target = job === undefined ? undefined : this.#threadFor(job);
      if (job === undefined || target === undefined) {
        if (job?.thread !== 'fresh') return;
        index += 1;
        continue;
      }
      this.#queue.splice(index, 1);
      this.#dispatch(target, job);
    }
  }

  /**
   * Hand one job to one thread, and start its limits.
   *
   * @param target - An idle thread, or one started for the job
   * @param job - The job, already taken off the queue
   */
  #dispatch(target: PoolWorker, job: PendingJob): void {
    target.job = job;
    target.worker.ref();
    const settleHeap = target.reused;
    target.heapCheckPending = settleHeap;
    const dispatch: ParseWorkerDispatch = { ...job.request, settleHeap };
    // The one parent-thread cost this design has always named and never
    // measured: `postMessage` serializes the whole content string HERE, on
    // the thread the pool exists to unburden. See DEFAULT_POOL_SIZE_CAP.
    const dispatchStartedAt = parseTimingStart();
    target.worker.postMessage(dispatch);
    recordTierPass(TierPass.WireDispatch, dispatchStartedAt);
    // After the post, so queue-wait time is never charged to the boundary.
    job.dispatchedAt = parseTimingStart();
    // The wall clock never runs while the job waits for a free worker — that is
    // the pool's time, not the document's — and the document's own `timeMs`
    // starts only once its parser has loaded on this thread and, on a reused
    // thread, its heap check has kept it (see JobClock).
    const parserReady = !settleHeap && target.parsersLoaded.has(moduleKindOf(job.request));
    this.#armClock(target, job, parserReady ? 'parse' : 'load');
    // A reused thread's job is sampled only once the thread has settled its heap and kept itself
    // (its `ParseWorkerReuseCheck`): a sample read before then reads what an earlier job left, and
    // a fall in it — the settling collection — would vouch for a heap that is not this job's.
    if (!settleHeap) this.#watchHeap(target, job);
  }

  /**
   * Start sampling a job's heap — see {@link HEAP_SAMPLE_INTERVAL_MS}; {@link disarm} stops it.
   *
   * @param poolWorker - The thread holding the job
   * @param job - The job
   */
  #watchHeap(poolWorker: PoolWorker, job: PendingJob): void {
    job.heapWatch = setInterval(() => {
      this.#sampleHeap(poolWorker, job);
    }, HEAP_SAMPLE_INTERVAL_MS);
  }

  /**
   * Arm a job's wall-clock limit — see {@link JobClock} — replacing any clock already armed.
   *
   * @param poolWorker - The thread holding the job
   * @param job - The job
   * @param clock - Which clock: `load` until the job's parser has loaded, `parse` from then on
   */
  #armClock(poolWorker: PoolWorker, job: PendingJob, clock: JobClock): void {
    clearTimeout(job.deadline);
    job.clock = clock;
    const armedAt = performance.now();
    if (clock === 'load') job.loadClockFrom = armedAt;
    const dueAt = armedAt + this.#limits.timeMs;
    job.deadline = setTimeout(() => {
      const lateMs = performance.now() - dueAt;
      // Decided a phase later: a parent that was busy when the timer came due
      // reaches this timers phase BEFORE the poll phase that delivers the
      // port, so an answer or `parserLoaded` the thread posted in time is
      // still queued. `setImmediate` runs after that poll phase, and an
      // answer read there has already settled the job — or a `parserLoaded`
      // has moved it to its parse clock, which this stale timer must not judge.
      setImmediate(() => {
        if (poolWorker.job !== job || job.clock !== clock) return;
        if (clock === 'load') this.#stopAtLoadDeadline(poolWorker, job, lateMs);
        else this.#terminate(poolWorker, new ParseLimitError('timeMs', this.#limits.timeMs));
      });
    }, this.#limits.timeMs);
  }

  /**
   * The thread `job` may be dispatched to now: an idle one, or one started for it — and for a job
   * a reused thread was retired under, only a thread started for it, never one adopted from the
   * parked set, which is reused too.
   *
   * When every slot is taken, such a job frees one by closing an idle reused thread — only while
   * no other thread is terminating, whose `exit` frees a slot anyway, so the pool closes one thread
   * at a time, never every idle one; the `exit` pumps again. An idle thread is always a reused
   * one: every thread is started for the job it is handed, and one that loses it is terminated.
   *
   * @param job - A queued job
   * @returns The thread, or `undefined` when none is free yet
   */
  #threadFor(job: PendingJob): PoolWorker | undefined {
    if (job.thread === 'any') return this.#idleWorker() ?? this.#spawn('may-adopt');
    const fresh = this.#spawn('fresh');
    if (fresh !== undefined) return fresh;
    if (this.#terminating.size > 0) return undefined;
    const idle = this.#workers.find((candidate) => candidate.job === null && candidate.reused);
    if (idle !== undefined) this.#close(idle);
    return undefined;
  }

  /**
   * Close an idle thread to free its slot for a fresh one. It counts against {@link size} until
   * its `exit`, which pumps; it held no job, so nothing is settled or counted.
   *
   * @param poolWorker - An idle thread
   */
  #close(poolWorker: PoolWorker): void {
    poolWorker.retired = true;
    const index = this.#workers.indexOf(poolWorker);
    if (index !== -1) this.#workers.splice(index, 1);
    if (!poolWorker.exited) this.#terminating.add(poolWorker);
    // Referenced again, as `closeWorker` and `#park` do: an idle thread is unref'd, and its `exit`
    // — which frees the slot and pumps — must keep the process alive until it is delivered.
    poolWorker.worker.ref();
    poolWorker.worker.terminate().catch(() => undefined);
  }

  /**
   * Stop a job whose worker's heap has passed its limit. See {@link HEAP_SAMPLE_INTERVAL_MS}.
   *
   * A sample that fails (the thread is already gone) is ignored: its `exit`
   * settles the job.
   */
  #sampleHeap(poolWorker: PoolWorker, job: PendingJob): void {
    poolWorker.worker.getHeapStatistics().then(
      (heap) => {
        if (poolWorker.job !== job) return;
        // Each sample carries V8's ceiling, so the limit is known from the
        // first one, never left to a read that may land after the job starts.
        const geometry = workerHeapGeometry(poolWorker.worker.resourceLimits, this.#heapFlags);
        const bounds = heapBounds(heap, geometry, this.#limits.heapMb);
        poolWorker.heapBounds = bounds;
        const previousUsedBytes = job.lastHeapUsed;
        job.lastHeapUsed = heap.used_heap_size;
        if (!heapBreached(heap, previousUsedBytes, bounds, geometry.youngMb)) return;
        this.#heapBreach(poolWorker, job, bounds.appliedMb);
      },
      () => undefined,
    );
  }

  /**
   * A job's thread passed its heap bound. On the job's parse clock that is the document's refusal;
   * on its load clock no parser has run over the document's bytes yet (the sampler runs from
   * dispatch), so it is the thread's, charged as a load stop ({@link #chargeLoadStop}) and counted
   * toward its parser kind's run unless the thread was in its heap check.
   *
   * @param poolWorker - The thread
   * @param job - Its job
   * @param appliedMb - The bound it passed
   */
  #heapBreach(poolWorker: PoolWorker, job: PendingJob, appliedMb: number): void {
    const refusal = ParseLimitError.heap(appliedMb, this.#limits.heapMb);
    if (job.clock !== 'load') {
      this.#terminate(poolWorker, refusal);
      return;
    }
    const heapCheck = this.#inHeapCheck(poolWorker, job);
    const stop = new Error(`a parse thread's heap passed its bound before the ${moduleKindOf(job.request)} parser loaded`, { cause: refusal });
    this.#chargeLoadStop(poolWorker, job, stop, `before its heap passed ${String(appliedMb)} MiB`, !heapCheck);
  }

  /**
   * A job's thread did not load the job's parser within `timeMs`: stop the thread, and run the
   * job again on a fresh one. See {@link JobClock}.
   *
   * No document can make a thread slow to start or a parser slow to load, so the stop never
   * refuses the document. It counts toward its parser kind's {@link LoadStopRun} — a parser load
   * that hangs is a broken install, and {@link DEATHS_BEFORE_UNAVAILABLE} counted stops in a row
   * with that parser loaded nowhere between them fail the run loud — but never alone, even on a
   * thread that had not yet posted `ready`: a host too loaded to start one thread in time has not
   * shown the install broken. A stop the parent itself made late neither counts nor resets the
   * count ({@link LATE_DEADLINE_MS}); a job stopped at its load clock
   * {@link DEATHS_BEFORE_UNAVAILABLE} times ends as a `ParserUnavailableError` whose cause says its
   * parser could not start within `timeMs` that many times — the run fails loudly, and no document
   * is blamed — so a starved host still terminates (I8): a job ends within
   * {@link DEATHS_BEFORE_UNAVAILABLE} load clocks and one parse clock, about four `timeMs`, plus a
   * heap check (under a load clock) on each reused thread it was moved off, plus any time it waited
   * in the queue.
   *
   * @param poolWorker - The thread holding the job
   * @param job - The job, still on its load clock
   * @param lateMs - How long after it came due the deadline's timer fired
   */
  #stopAtLoadDeadline(poolWorker: PoolWorker, job: PendingJob, lateMs: number): void {
    const kind = moduleKindOf(job.request);
    const within = `within ${String(this.#limits.timeMs)} ms`;
    if (this.#inHeapCheck(poolWorker, job)) {
      // A reused thread still settling what earlier jobs left: slow at that, never at loading a parser.
      this.#chargeLoadStop(poolWorker, job, new Error(`a reused parse thread did not finish its heap check ${within}`), within, false);
      return;
    }
    const stop = new Error(`a parse thread did not load the ${kind} parser ${within}`);
    this.#chargeLoadStop(poolWorker, job, stop, within, lateMs <= LATE_DEADLINE_MS);
  }

  /**
   * Whether a job on its load clock is still waiting on its reused thread's heap check: the check
   * has not reached the pool, or the job's parser is already loaded there, so nothing else holds
   * its load clock.
   *
   * @param poolWorker - The thread holding the job
   * @param job - The job, on its load clock
   * @returns True when the thread has not yet kept itself for the job
   */
  #inHeapCheck(poolWorker: PoolWorker, job: PendingJob): boolean {
    return poolWorker.heapCheckPending || poolWorker.parsersLoaded.has(moduleKindOf(job.request));
  }

  /**
   * Charge a thread lost on a job's load clock — stopped there, or dead there — to the thread,
   * never the document: no parser has run over the document's bytes yet. The job runs again until
   * it has been lost so {@link DEATHS_BEFORE_UNAVAILABLE} times, when it ends as a
   * `ParserUnavailableError`. A loss in a reused thread's heap check is not one of those: it says
   * nothing of the job's parser, and it sends the job to a fresh thread, which has no check, so a
   * job is lost in at most one check per reused thread it reached and still ends.
   *
   * @param poolWorker - The thread lost
   * @param job - Its job, on its load clock
   * @param stop - What the loss was
   * @param how - How the parser could not start, for the job's final error: `within <timeMs> ms`, or `before its thread died`
   * @param counts - Whether the loss counts toward its parser kind's {@link LoadStopRun}
   */
  #chargeLoadStop(poolWorker: PoolWorker, job: PendingJob, stop: Error, how: string, counts: boolean): void {
    const kind = moduleKindOf(job.request);
    const heapCheck = this.#inHeapCheck(poolWorker, job);
    if (!heapCheck) job.loadStops += 1;
    if (counts) this.#countLoadStop(poolWorker, job, kind, stop);
    if (this.#unavailable === undefined && job.loadStops < DEATHS_BEFORE_UNAVAILABLE) {
      this.#requeue(poolWorker, heapCheck ? 'fresh' : 'any');
      this.#terminate(poolWorker, stop);
      return;
    }
    this.#terminate(poolWorker, this.#unavailable ?? unavailableFor(job, poolWorker.entry, new Error(
      `the ${kind} parser could not start ${how} on ${String(job.loadStops)} threads in a row`,
      { cause: stop },
    )));
  }

  /**
   * A thread that had posted `ready` died — exited, or was stopped by V8 at its ceiling — holding a
   * job still on its load clock: the job's parser had not loaded for it, so nothing of the
   * document's ran. Charged as a load stop ({@link #chargeLoadStop}), counted toward its parser
   * kind's run unless the thread was in its heap check, and never as a death of the document.
   *
   * Node delivers every message a thread posted before its `error` and `exit`, so a thread that
   * posted `parserLoaded` and then died is on its parse clock here, and its death is the document's.
   *
   * @param poolWorker - The thread
   * @param error - What it died of
   * @returns True when the death was charged so; false when it is not a load-clock death
   */
  #diedLoading(poolWorker: PoolWorker, error: Error): boolean {
    const job = poolWorker.job;
    if (job?.clock !== 'load' || !poolWorker.ready) return false;
    const heapCheck = this.#inHeapCheck(poolWorker, job);
    this.#chargeLoadStop(poolWorker, job, new Error(
      heapCheck ? 'a reused parse thread died in its heap check' : `a parse thread died before the ${moduleKindOf(job.request)} parser loaded`,
      { cause: error },
    ), 'before its thread died', !heapCheck);
    return true;
  }

  /**
   * Stop a thread at a limit: reject its job, and terminate it.
   *
   * The thread moves from the pool to {@link #terminating} rather than
   * vanishing, so it still counts against {@link size} until its `exit`; only
   * then does {@link #pump} start its replacement.
   */
  #terminate(poolWorker: PoolWorker, error: Error): void {
    poolWorker.retired = true;
    if (!poolWorker.exited) this.#terminating.add(poolWorker);
    this.#abandon(poolWorker, error);
    poolWorker.worker.terminate().catch(() => undefined);
  }

  /**
   * A thread the pool did not stop has died: its `error` or `exit`, whichever
   * came first. Counted once.
   *
   * A thread that never posted {@link ParseWorkerReady} could not load its own
   * module graph, which no document can cause; nor can
   * {@link DEATHS_BEFORE_UNAVAILABLE} deaths in a row with no answer between
   * them be the documents' doing — a death counts only while the thread held a
   * job (or had not loaded), never one that died idle. Either way the install is broken: every job,
   * held, queued or yet to come, fails with a parser-unavailable error, which
   * every lane rethrows loud. Anything less is one per-run death of one job.
   */
  #died(poolWorker: PoolWorker, error: Error): void {
    poolWorker.retired = true;
    // Reported by its `error`, the thread is still exiting: it counts against
    // `size` until its `exit`, like a thread terminated at a limit.
    if (!poolWorker.exited) this.#terminating.add(poolWorker);
    // Only a thread that held a job, or never loaded, says anything about the
    // install. One that died idle took no document with it and is simply
    // replaced; counting it would let three idle deaths refuse a document
    // nothing was wrong with. Nor is a death before the job's parser loaded the document's
    // (`#diedLoading`).
    if (this.#diedLoading(poolWorker, error)) return;
    if (poolWorker.job !== null || !poolWorker.ready) this.#countDeath(poolWorker, error, !poolWorker.ready);
    this.#abandon(poolWorker, this.#unavailable ?? error);
    if (this.#unavailable !== undefined) this.#failAll(this.#unavailable);
  }

  /**
   * Put a thread's job back at the head of the queue, unanswered and unlimited, for
   * {@link #abandon}'s pump to dispatch afresh.
   *
   * @param poolWorker - A thread the pool is giving up on through no fault of its job: a reused one
   *   that died before it posted anything for it, one stopped at its load clock, or one retired for what
   *   earlier jobs left on it
   * @param thread - `fresh` for a job a reused thread was retired under, which must not land on
   *   another reused one; `any` otherwise
   */
  #requeue(poolWorker: PoolWorker, thread: PendingJob['thread']): void {
    const job = poolWorker.job;
    if (job === null) return;
    poolWorker.job = null;
    poolWorker.heapCheckPending = false;
    disarm(job);
    delete job.lastHeapUsed;
    job.thread = thread;
    this.#queue.unshift(job);
  }

  /**
   * Count one death toward {@link DEATHS_BEFORE_UNAVAILABLE}, and judge the
   * install broken when it is one too many, or when the thread could not start at all.
   *
   * @param poolWorker - The thread that died: before posting `ready`, or holding a job whose parser had loaded
   * @param error - What it died of
   * @param couldNotStart - The thread itself died before posting `ready`: its own module graph
   *   would not load, which no document and no load on the host can cause. Never a thread the pool
   *   stopped at its load clock, which only shows it was slow.
   */
  #countDeath(poolWorker: PoolWorker, error: Error, couldNotStart: boolean): void {
    this.#consecutiveDeaths += 1;
    if (couldNotStart) {
      this.#unavailable ??= this.#brokenInstall(poolWorker, error);
    } else if (this.#consecutiveDeaths >= DEATHS_BEFORE_UNAVAILABLE) {
      this.#unavailable ??= this.#brokenInstall(poolWorker, new Error(
        `${String(this.#consecutiveDeaths)} parse workers in a row died with no answer between them; the last: ${error.message}`,
      ));
    }
  }

  /**
   * Count one load-clock stop, or death on the load clock, toward its parser kind's {@link LoadStopRun}, and judge the install
   * broken when the run reaches {@link DEATHS_BEFORE_UNAVAILABLE}.
   *
   * A stop counts only when its job's load clock started at or after the run's last counted stop.
   * Threads whose load clocks overlapped were slow over one interval, and a host starved through
   * that interval stops every one of them at once: counted apart, a pool of three fresh threads
   * on such a host would be judged broken by its first stall. Counted once, the run needs three
   * intervals in a row in which the parser loaded nowhere.
   *
   * @param poolWorker - The thread stopped
   * @param job - Its job, whose load clock ran out
   * @param kind - The parser the thread did not load
   * @param stop - What the stop was
   */
  #countLoadStop(poolWorker: PoolWorker, job: PendingJob, kind: ParserModuleKind, stop: Error): void {
    const run = this.#loadStopRuns.get(kind);
    if (run !== undefined && (job.loadClockFrom ?? 0) < run.lastCountedAt) return;
    const count = (run?.count ?? 0) + 1;
    this.#loadStopRuns.set(kind, { count, lastCountedAt: performance.now() });
    if (count < DEATHS_BEFORE_UNAVAILABLE) return;
    this.#unavailable ??= this.#brokenInstall(poolWorker, new Error(
      `${String(count)} parse threads in a row were stopped or died before the ${kind} parser loaded, with it loaded nowhere between them; the last: ${stop.message}`,
    ));
  }

  /**
   * @param poolWorker - The thread that could not start, or the last of a run of deaths or load stops
   * @param cause - Why the install is judged broken
   * @returns The parser-unavailable error every job fails with from now on
   */
  #brokenInstall(poolWorker: PoolWorker, cause: Error): ParserUnavailableError {
    return unavailableFor(poolWorker.job ?? this.#queue[0], poolWorker.entry, cause);
  }

  #idleWorker(): PoolWorker | undefined {
    return this.#workers.find((candidate) => candidate.job === null);
  }

  /**
   * Start one more thread, or answer `undefined` when the ceiling is reached.
   *
   * A worker entry that cannot be resolved, or a thread that cannot be
   * constructed, is not transient — no later job would fare better — and it is
   * the install's fault, never a document's: the pool is judged unavailable,
   * so every job held, queued or yet to come fails with a parser-unavailable
   * error every lane rethrows loud. A plain `Error` here was once stored as
   * `BLOB_PARSE_FAILED` against every document in the corpus.
   *
   * @param source - `may-adopt` to take a thread a shut-down pool parked when one fits, `fresh` to
   *   start a new thread whatever is parked
   */
  #spawn(source: 'fresh' | 'may-adopt'): PoolWorker | undefined {
    if (this.#workers.length + this.#terminating.size >= this.size) return undefined;

    let worker: Worker;
    let entry: string | undefined;
    let key: string;
    try {
      entry = resolveWorkerEntry();
      key = workerKey(entry, this.#workerData);
      const parked = source === 'may-adopt' ? adoptParkedWorker(key) : undefined;
      if (parked !== undefined) return this.#track(parked.worker, entry, key, parked.parsersLoaded);
      // The stack is enforced by V8 itself, per thread: a breach throws a
      // `RangeError` (bare, or wrapped by `yaml`) the worker itself reports,
      // and the thread stays in the pool. The heap is NOT left to V8: reaching
      // V8's ceiling can kill the whole process, so the sampler enforces
      // `heapMb` and V8's ceiling is headroom past it (`workerHeapCeilingMb`).
      worker = new Worker(entry, {
        workerData: this.#workerData,
        resourceLimits: {
          maxOldGenerationSizeMb: workerHeapCeilingMb(this.#limits.heapMb),
          stackSizeMb: this.#limits.stackMb,
        },
      });
    } catch (error) {
      this.#unavailable ??= unavailableFor(this.#queue[0], entry ?? WORKER_ENTRY_NAME, error);
      this.#failAll(this.#unavailable);
      return undefined;
    }
    return this.#track(worker, entry, key, undefined);
  }

  /**
   * Take a thread into this pool: one just started, or one a shut-down pool parked.
   *
   * @param worker - The thread
   * @param entry - The entry it was started from
   * @param key - Its {@link workerKey}
   * @param loaded - The parser kinds a parked thread already loaded; `undefined` for a new thread,
   *   which has posted nothing yet. A parked thread posted {@link ParseWorkerReady} to the pool it came from.
   * @returns The tracked thread
   */
  #track(worker: Worker, entry: string, key: string, loaded: ReadonlySet<ParserModuleKind> | undefined): PoolWorker {
    let markGone: () => void = () => undefined;
    const gone = new Promise<void>((resolve) => {
      markGone = resolve;
    });
    const poolWorker: PoolWorker = {
      worker,
      job: null,
      exited: false,
      gone,
      ready: loaded !== undefined,
      parsersLoaded: new Set(loaded),
      retired: false,
      entry,
      heapBounds: undefined,
      key,
      heapCheckPending: false,
      // A parked thread ran jobs in the pool it came from, and carries what they left.
      reused: loaded !== undefined,
      detach: () => undefined,
    };
    const onMessage = (response: ParseWorkerResponse): void => {
      this.#settle(poolWorker, response);
    };
    // A thread that dies holding a job never answered it: a heap breach when V8
    // stopped it at its heap, otherwise a worker death. Both are per-run
    // outcomes, never stored as a failure of the bytes (I6). `error` precedes
    // `exit`, so a thread that threw is reported by what it threw.
    const onError = (error: Error): void => {
      if (poolWorker.retired) return;
      // A thread that never posted `ready` could not start, whatever stopped it (`#died`).
      if (poolWorker.ready && (error as { code?: unknown }).code === 'ERR_WORKER_OUT_OF_MEMORY') {
        // Before the job's parser loaded, what V8 stopped was not the document's (`#diedLoading`).
        if (this.#diedLoading(poolWorker, error)) return;
        // V8 stopped it, not the sampler: the refusal names V8's ceiling.
        this.#terminate(poolWorker, ParseLimitError.heapCeiling(poolWorker.heapBounds, this.#limits.heapMb));
        return;
      }
      this.#died(poolWorker, poolWorker.ready ? new ParseWorkerDiedError({ cause: error }) : error);
    };
    const onExit = (exitCode: number): void => {
      poolWorker.exited = true;
      markGone();
      if (this.#terminating.delete(poolWorker)) {
        // A slot came free: the replacement may start now, and shutdown may finish.
        this.#pump();
        this.#notifyDrained();
        return;
      }
      if (!poolWorker.retired) this.#died(poolWorker, new ParseWorkerDiedError({ exitCode }));
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    poolWorker.detach = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };

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
    if ('parserLoaded' in response) {
      this.#parserLoaded(poolWorker, response);
      return;
    }
    if ('reuseCheck' in response) {
      // Counted for every check a thread reports, from a thread the pool has stopped since too.
      recordReuseCheck(response.reuseCheck);
      const held = poolWorker.job;
      if (!poolWorker.retired && held?.request.id === response.id) {
        poolWorker.heapCheckPending = false;
        this.#afterReuseCheck(poolWorker, held, response.reuseCheck.retire);
      }
      return;
    }
    // A thread the pool is done with — stopped at a limit, counted dead, or closing — holds no job
    // of this pool, and nothing else it says is bookkeeping any more: an answer it posted is for a
    // job already settled or queued again, which the id check below would drop too.
    if (poolWorker.retired) return;
    if ('ready' in response) {
      poolWorker.ready = true;
      if (!response.collector) warnNoCollector();
      return;
    }

    // An answer is credited only to the job it was posted for. Any other id answers nothing this
    // thread holds, so it settles nothing, frees nothing and says nothing about the install.
    const job = poolWorker.job;
    if (job?.request.id !== response.id) return;

    // An answer: whatever killed the threads before it was not the install. One that is not a
    // failure also shows its parser ran, so a run of load stops waiting for that parser is over; a
    // failure may be the parser's own load failing, which shows nothing of the kind.
    this.#consecutiveDeaths = 0;
    if (!('failure' in response)) this.#loadStopRuns.delete(moduleKindOf(job.request));
    poolWorker.job = null;
    poolWorker.reused = true;
    poolWorker.worker.unref();
    disarm(job);
    recordTierPass(TierPass.WireRoundtrip, job.dispatchedAt);
    settleJob(job, response, this.#limits);

    this.#pump();
    this.#notifyDrained();
  }

  /**
   * A thread says a parser loaded on it: see {@link ParseWorkerParserLoaded}.
   *
   * @param poolWorker - The thread
   * @param loaded - What it posted
   */
  #parserLoaded(poolWorker: PoolWorker, loaded: ParseWorkerParserLoaded): void {
    // That parser loads on this install, whichever thread says so — a retired one too (one stopped
    // at its load clock, whose `parserLoaded` was still queued): it was slow, and the install is
    // sound, so a run of stops waiting for that parser is over. That is load evidence only: a
    // retired thread is never credited with an answer.
    this.#loadStopRuns.delete(loaded.parserLoaded);
    // A thread the pool is done with holds no job of this pool: nothing it says arms a clock.
    if (poolWorker.retired) return;
    poolWorker.parsersLoaded.add(loaded.parserLoaded);
    const held = poolWorker.job;
    // The document's own clock starts now, for the job the parser loaded for: see JobClock.
    if (held?.request.id === loaded.id && held.clock === 'load' && moduleKindOf(held.request) === loaded.parserLoaded) {
      this.#armClock(poolWorker, held, 'parse');
    }
  }

  /**
   * Act on a reused thread's settled heap: kept, its job runs now and is sampled from here;
   * retired, the job runs again on a fresh thread.
   *
   * A retirement is the pool's, never the document's: the thread has not run the job, so it counts
   * toward nothing, the job keeps its place at the head of the queue and goes to a fresh thread
   * only (`PendingJob.thread`), and the thread counts against {@link size} until it has exited,
   * like any stopped one.
   *
   * @param poolWorker - A reused thread, holding `job`
   * @param job - The job it settled its heap for
   * @param retire - Whether it still holds more than `reusedThreadHeapMb` after a collection
   */
  #afterReuseCheck(poolWorker: PoolWorker, job: PendingJob, retire: boolean): void {
    if (!retire) {
      // The document's own clock starts now, if its parser is already loaded here; otherwise once
      // it has (`parserLoaded`). The check ran on the load clock: see JobClock.
      if (job.clock === 'load' && poolWorker.parsersLoaded.has(moduleKindOf(job.request))) this.#armClock(poolWorker, job, 'parse');
      this.#watchHeap(poolWorker, job);
      return;
    }
    this.#requeue(poolWorker, 'fresh');
    this.#terminate(poolWorker, new Error('a reused parse thread held more than its reused-thread bound after a full collection'));
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
    if (job !== null) {
      disarm(job);
      job.reject(error);
    }

    this.#pump();
    this.#notifyDrained();
  }

  /**
   * Reject everything outstanding once the install is judged broken: every
   * queued job, and every job a live thread still holds (its thread is
   * stopped, since nothing it answers can be trusted over the verdict).
   *
   * @param error - The pool's parser-unavailable verdict
   */
  #failAll(error: Error): void {
    for (const job of this.#queue.splice(0, this.#queue.length)) job.reject(error);
    // Re-entrant: stopping one thread pumps, which lands back here, so each
    // holder is re-checked for its job rather than trusted from the snapshot
    // (`#terminate` removes threads from `#workers` as it goes).
    for (const poolWorker of this.#workers.filter((candidate) => candidate.job !== null)) {
      if (poolWorker.job !== null) this.#terminate(poolWorker, error);
    }
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
  #drained(): Promise<void> {
    if (this.#isDrained()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
    });
  }
}

/** Set once this process has been told its parse threads have no full collection. */
let warnedNoCollector = false;

/**
 * Tell the process, once, that this runtime refused its parse threads a full collection
 * ({@link ParseWorkerReady.collector}): a reused thread past its bound is then replaced rather than
 * collected.
 */
function warnNoCollector(): void {
  if (warnedNoCollector) return;
  warnedNoCollector = true;
  process.emitWarning(
    'parse threads have no full collection on this runtime (it refused V8\'s --expose-gc): a reused thread past its bound is replaced instead of collected',
    { code: 'VAT_PARSE_NO_COLLECTOR' },
  );
}

/**
 * Stop a job's limit timers; it has settled, one way or another.
 *
 * @param job - The job
 */
function disarm(job: PendingJob): void {
  clearTimeout(job.deadline);
  clearInterval(job.heapWatch);
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
 * @param limits - The limits the job ran under, so a breach names its bound
 */
function settleJob(
  job: PendingJob,
  response: Exclude<ParseWorkerResponse, ParseWorkerTimingReport | ParseWorkerReady | ParseWorkerParserLoaded | ParseWorkerReuseCheck>,
  limits: ParseLimits,
): void {
  if ('breach' in response) {
    job.reject(new ParseLimitError(response.breach, limits[response.breach], response.found));
    return;
  }
  if ('failure' in response) {
    job.reject(reviveFailure(response.failure));
    return;
  }
  if ('stored' in response) {
    // The facts are on disk under the key the parent supplied. Nothing crossed
    // the boundary but that key, which is the entire point of this arm.
    job.resolve({ type: 'parse', result: null });
    return;
  }
  if ('harnessFacts' in response) {
    // Plain JSON the reader produced and the worker held to the output caps:
    // nothing to rebuild.
    job.resolve({ type: 'harness', facts: response.harnessFacts });
    return;
  }

  const attachStartedAt = parseTimingStart();
  let result: ParseResult;
  try {
    result = attachContent(response.facts, job.request.content, job.request.byteLength);
  } catch (error) {
    // Thrown in a `message` listener it would be uncaught, and this job would
    // never settle. The codec is loops end to end and the worker emits only a
    // plain-mapping root, so no input can make this decode throw: whatever did is VAT's defect, and every lane
    // rethrows it loud rather than blaming, or storing a failure of, the bytes.
    job.reject(new ParseDecodeDefectError(error));
    return;
  } finally {
    recordTierPass(TierPass.WireAttach, attachStartedAt);
  }
  job.resolve({ type: 'parse', result });
}

/** `Omit` over each member of a union, so the discriminant survives. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A worker answered one job type with another's arm: unreachable through the
 * protocol, since every arm answers the request that carried its id. Named
 * rather than cast away, so a protocol defect is loud where it happens.
 *
 * @param answered - The arm the worker sent
 * @param asked - The job type the pool asked for
 * @returns The error to throw
 */
function protocolMismatch(answered: JobAnswer['type'], asked: JobAnswer['type']): Error {
  return new Error(`VAT's parse worker answered a ${asked} job with a ${answered} answer.`);
}

/**
 * The parse a job settled to.
 *
 * @param answer - What the worker answered
 * @returns The parse, or `null` when the worker cached it instead
 * @throws When the worker answered with a harness's facts
 */
function parseAnswer(answer: JobAnswer): ParseResult | null {
  if (answer.type !== 'parse') throw protocolMismatch(answer.type, 'parse');
  return answer.result;
}

/**
 * Close one worker so its `exit` listeners run.
 *
 * `terminate()` is reached only when a thread ignores the close for
 * {@link GRACEFUL_EXIT_TIMEOUT_MS}, and costs that thread's parse-timing dump.
 *
 * @param worker - A live thread to close
 */
async function closeWorker(worker: Worker): Promise<void> {
  // Re-`ref` it: an idle worker is unref'd, and an unref'd thread cannot keep
  // the process alive long enough for its own exit to be observed.
  // Already gone (its `exit` delivered or pending): there is no `exit` left to wait for.
  if (worker.threadId < 0) return;
  worker.ref();
  // Settled by the `exit` alone, whatever the thread raises on the way out. An `error` while
  // closing is the thread's last word, not a verdict: the run's answers are already in, and a
  // close that rejected on it would leave the other threads unawaited and replace an answered
  // run's result in the caller's `finally`. The listener also keeps that `error` from crashing
  // the process, for a parked thread whose listeners were released.
  const ignoreClosingError = (): void => undefined;
  worker.on('error', ignoreClosingError);
  const exited = new Promise<void>((resolve) => {
    worker.once('exit', () => resolve());
  });
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
    worker.off('error', ignoreClosingError);
  }
}

/**
 * The most used heap a thread may hold and still be parked, in MiB: 48, twice
 * {@link FRESH_THREAD_HEAP_MB}.
 *
 * A parked thread carries whatever its last jobs left on its heap, and holds it while it waits.
 * Adopted, it is a reused thread like any other: it settles its heap before its first job, and is
 * retired if a full collection cannot bring it within `reusedThreadHeapMb` — so this cap decides
 * no verdict. It keeps the parked set from holding, unused, what a large crawl filled a thread with:
 * measured on Node 26 (`used_heap_size`, three runs), a thread holds 142–268 MiB after fifty 15 KiB
 * documents; a thread that parsed a few small documents — every pool of a cold `vat build` — stays
 * under it, and one a large crawl filled is closed, and its pool's successor starts its own.
 */
export const PARKED_HEAP_MB = FRESH_THREAD_HEAP_MB * 2;

/**
 * How long a parked thread waits for a pool to adopt it before it closes itself: 5 s.
 *
 * A command's pools follow one another within milliseconds, so a few seconds keeps every hand-off
 * one run makes, and a long-lived host (a server, a watcher) that stops parsing gets the threads'
 * memory back with nothing to call. The timer is `unref`'d, so it never keeps a process alive,
 * and adoption cancels it.
 */
export const PARKED_IDLE_MS = 5000;

/** A healthy idle thread a shut-down pool left for the next pool of the same {@link workerKey}. */
interface ParkedWorker {
  readonly worker: Worker;
  readonly key: string;
  /** The parser kinds it loaded, so the adopting pool's death count reads its stops right. */
  readonly parsersLoaded: ReadonlySet<ParserModuleKind>;
  /** Removes the parked listeners and cancels the idle timer ({@link PARKED_IDLE_MS}). */
  readonly release: () => void;
}

/**
 * Parked threads, oldest first.
 *
 * ## 🔑 Why a process keeps threads between pools
 *
 * Every parse runs in a pool (ADR I8), and a command builds one per lane and one per
 * single-file parse, not one per run: a cold `vat build` of one skill built eleven, and
 * each started a thread and loaded its parser (about 110 ms) for one or two documents.
 * Parking hands the next pool the thread the last one finished with, so a process pays one
 * start per concurrent thread rather than one per pool.
 *
 * A parked thread is `unref`'d, so it never keeps the process alive; one that dies while
 * parked is dropped here and counted against no pool. Limits are the adopting pool's, per
 * job, exactly as for a thread it started: the key carries every input a thread is started
 * with, so a thread only ever serves a pool that would have started an identical one.
 */
const parkedWorkers: ParkedWorker[] = [];

/**
 * Everything that makes one parse thread interchangeable with another: its entry, its
 * `workerData` (cache directory and limits — the heap and stack `resourceLimits` derive from
 * them), the process's `execArgv` it inherits, and the environment it copied at start.
 *
 * @param entry - The worker entry
 * @param workerData - What the thread is told at construction
 * @returns A string equal for two threads exactly when either may serve the other's pool
 */
function workerKey(entry: string, workerData: ParseWorkerData): string {
  const env = Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([entry, workerData, process.execArgv, env]);
}

/**
 * Release a parked thread and close it; it is no pool's, so a failed close is nobody's to report.
 *
 * @param parked - A thread taken out of {@link parkedWorkers}
 * @returns Resolves once it has exited
 */
async function closeParked(parked: ParkedWorker): Promise<void> {
  parked.release();
  await closeWorker(parked.worker).catch(() => undefined);
}

/**
 * Park a thread, closing the oldest parked ones past `cap`.
 *
 * @param worker - A healthy idle thread whose pool has detached from it
 * @param key - Its {@link workerKey}
 * @param parsersLoaded - The parser kinds it loaded
 * @param cap - The parking pool's cap: {@link defaultParsePoolSize}, lowered to what memory
 *   leaves beside a bounded pool ({@link parkedThreadRoom})
 * @returns Resolves once any thread evicted for it has closed
 */
async function parkWorker(
  worker: Worker,
  key: string,
  parsersLoaded: ReadonlySet<ParserModuleKind>,
  cap: number,
): Promise<void> {
  const unpark = (): boolean => {
    const index = parkedWorkers.indexOf(record);
    if (index === -1) return false;
    parkedWorkers.splice(index, 1);
    return true;
  };
  const drop = (): void => {
    unpark();
    clearTimeout(idle);
  };
  const idle = setTimeout(() => {
    if (unpark()) closeParked(record).catch(() => undefined);
  }, PARKED_IDLE_MS);
  idle.unref();
  const record: ParkedWorker = {
    worker,
    key,
    parsersLoaded: new Set(parsersLoaded),
    release: () => {
      clearTimeout(idle);
      worker.off('error', drop);
      worker.off('exit', drop);
    },
  };
  // `error` as well as `exit`: an `error` with no listener would throw in this process.
  worker.on('error', drop);
  worker.on('exit', drop);
  worker.unref();
  parkedWorkers.push(record);

  const evicted = parkedWorkers.splice(0, Math.max(0, parkedWorkers.length - cap));
  await Promise.all(evicted.map((old) => closeParked(old)));
}

/**
 * Take the most recently parked thread with this key, if one is still running.
 *
 * @param key - The adopting pool's {@link workerKey}
 * @returns The thread, released from the parked set, or `undefined`
 */
function adoptParkedWorker(key: string): ParkedWorker | undefined {
  for (let index = parkedWorkers.length - 1; index >= 0; index -= 1) {
    const candidate = parkedWorkers[index];
    if (candidate?.key !== key) continue;
    parkedWorkers.splice(index, 1);
    candidate.release();
    // `threadId` stays ≥ 0 until the `exit` event is delivered, so a thread that has exited
    // natively but whose `exit` is still queued CAN be adopted here; its `exit` then reaches the
    // adopting pool, which treats it as any thread's death. Only one whose `exit` was delivered
    // (threadId -1) is dropped.
    if (candidate.worker.threadId < 0) continue;
    return candidate;
  }
  return undefined;
}

/**
 * Close every parked thread now, rather than at {@link PARKED_IDLE_MS} — for a test that counts
 * the threads a run starts, which a thread an earlier test parked would otherwise serve.
 *
 * @returns Resolves once every one has exited
 */
export async function __closeParkedParseWorkersForTest(): Promise<void> {
  await Promise.all(parkedWorkers.splice(0, parkedWorkers.length).map((parked) => closeParked(parked)));
}

/**
 * How many threads are parked — for a test of park, adopt and eviction.
 *
 * @returns The count
 */
export function __parkedParseWorkerCountForTest(): number {
  return parkedWorkers.length;
}

/**
 * The memory this process may use: a container's limit when one is set and
 * below the machine's, otherwise the machine's.
 *
 * `process.constrainedMemory()` answers 0 where no limit applies, and on some platforms
 * a huge sentinel, so it is only ever taken when it is the smaller.
 *
 * @returns Bytes
 */
function machineMemoryBytes(): number {
  const total = totalmem();
  const constrained = process.constrainedMemory();
  return constrained > 0 ? Math.min(constrained, total) : total;
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
  const requestedLimits = resolveParseLimits(options?.limits);
  // The one choke point every width passes, pinned or estimated: the pool's
  // worst-case heap is held inside this machine's memory (`memoryBoundedPool`).
  const memoryBytes = machineMemoryBytes();
  const bounded = memoryBoundedPool({ size, heapMb: requestedLimits.heapMb }, memoryBytes);
  const limits: ParseLimits = { ...requestedLimits, heapMb: bounded.heapMb };
  // Threads it parks are charged beside a pool as wide as this one or the default, whichever is
  // wider, so parking never spends the memory the bound above held for such a pool. A wider pool
  // pinned elsewhere in the process is not counted (see the hazard register).
  const widest = memoryBoundedPool({ size: Math.max(size, defaultParsePoolSize()), heapMb: requestedLimits.heapMb }, memoryBytes);
  const parkCap = Math.min(defaultParsePoolSize(), parkedThreadRoom(widest, memoryBytes));
  // Conditional spread, never `{ cacheDir: undefined }`: `workerData` is
  // structured-cloned, and an own property valued `undefined` is not the same as
  // an absent one to the `in` check on the other side.
  const collectorLock = COLLECTOR_LOCK;
  return new WorkerParsePool(bounded.size, cacheDir === undefined ? { limits, collectorLock } : { cacheDir, limits, collectorLock }, parkCap);
}
