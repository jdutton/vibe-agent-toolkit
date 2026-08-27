/**
 * Where a parse runs, how wide the fan-out may be, and how facts come back.
 *
 * ## Why this is its own module rather than part of either lane
 *
 * VAT crawls one corpus down **two** lanes — the incumbent `ResourceRegistry`
 * and the projection's `populateBlobs` — and both must reach the same verdict
 * about whether a worker pool is worth having, how wide it is, and how a
 * worker's facts get home. All of it lived inside `blob-population.ts` while
 * that was the only lane a pool could reach, and the parse-heaviest command
 * (`vat resources validate`) runs on the OTHER one: 1,566 documents, strictly
 * one at a time, zero workers. A second copy of this policy is how the two lanes
 * start disagreeing about a switch that has already been measured once.
 *
 * ## Why the DRIVE loop is here too
 *
 * It is the other half of the same decision, and it is where the approved
 * map-reduce design's PULL hand-out lands: a target is claimed the moment a slot
 * frees, so the tail is bounded by one preparation rather than by a whole slice
 * of them. One copy means that change lands once, for both lanes. Two copies
 * mean it lands twice — or, far more likely, on one lane only.
 */

import {
  DOCUMENT_PARSER_KINDS,
  NO_PARSER_KIND,
  type ParsableContent,
  type ParserKind,
} from './content-key.js';
import type { ParseResult } from './link-parser.js';
import type { DocumentParserKind } from './mime-type.js';
import { type ParseCache, parseKeyed } from './parse-cache.js';
import {
  createParsePool,
  defaultParsePoolSize,
  type ParsePool,
  type ParsePoolOptions,
} from './parse-pool.js';
import { recordParseCacheHit, recordParseCacheMiss } from './parse-timing.js';

/**
 * How a worker's parse facts get back to the thread that asked for them.
 *
 * The two arms of an open question, and they are genuine alternatives rather
 * than a fast path and a slow one:
 *
 * - **`wire`** — the worker sends the fact graph back over `postMessage` and the
 *   PARENT writes the cache entry. The parent pays a structured-clone
 *   deserialization plus a `JSON.stringify` per document, both on the one thread
 *   that cannot be parallelized.
 * - **`cache`** — the worker writes the entry itself and sends back only the
 *   key. The parent pays a `readFile` plus a `JSON.parse` plus schema
 *   validation, and the stringify moves onto the worker where it runs in
 *   parallel.
 *
 * ## 🔑 MEASURED 2026-08-25 — `cache` does what it promised and LOSES anyway
 *
 * Cold, `vat claude context` on a 103-skill adopter (1,805 documents, 31.9 MB,
 * 8 workers, 3 repeats, APFS), `wire` → `cache`:
 *
 * ```text
 * parent-thread tier work   2,449.2 ms  ->  1,346.5 ms   -45%   ✅ as designed
 *   of which cache-write    1,936.4 ms  ->     83.6 ms   -96%   (moved to workers)
 *   of which wire-attach      202.1 ms  ->      0.0 ms  -100%   (nothing to attach)
 *   new: cache-read-io+decode   292.4 ms  ->  1,243.4 ms         (the read-back)
 * process wall             11,666.9 ms  -> 12,635.2 ms   +8.3%  ❌
 * process CPU              34,350.9 ms  -> 37,906.4 ms  +10.3%  ❌
 * ```
 *
 * The mechanism, and it is not the transport of facts:
 *
 * 1. **The parent was never the bottleneck.** Its 2.4 s of tier work sat inside
 *    an 11.7 s run and overlapped worker parses the whole time. Halving it buys
 *    nothing while the command is waiting on workers.
 * 2. **A cache write costs MORE from eight threads than from one** — 1.1 ms/call
 *    to 1.6 ms/call, +45%, on the same 1,805 writes. Moving work off the parent
 *    was not cost-neutral; the filesystem charged for the concurrency.
 * 3. **And it moved onto the critical path.** `worker-job` rose 17,909.8 ms to
 *    22,422.1 ms (+25%), and `wire-roundtrip` tracked it almost exactly
 *    (+4,353.7 ms against +4,512.2 ms) — the parent simply waited longer.
 *
 * ⇒ **`wire` stays the shipped behaviour**, and `cache` stays buildable behind
 * the switch rather than being deleted: the verdict is a property of a pool
 * whose workers are the bottleneck, and the known ~20% worker utilization is
 * exactly what a later change is meant to fix. When the parent DOES become the
 * critical path, `cache-write on main` is a measured 1,936 ms sitting there
 * waiting to be moved, and this arm is how it gets moved. Re-run the A/B then;
 * do not re-derive it.
 *
 * ⚠️ One filesystem, one corpus, one machine. APFS on a 10-core box — the
 * concurrency penalty in (2) is the part most likely to differ elsewhere, and
 * it is also a function of WIDTH: the reading above is eight concurrent writers,
 * which is twice what `DEFAULT_POOL_SIZE_CAP` now allows a pool to size itself
 * to. Half the writers is less filesystem contention, so re-running this A/B
 * costs a pinned `VAT_PARSE_POOL_SIZE` if it is to be compared with the above.
 */
export type ParseTransport = 'wire' | 'cache';

/**
 * When a lane is allowed to hand parses to a worker pool, and how wide.
 *
 * Every field has a default that a command never has to set. The fields exist
 * because the three properties that make pooling *correct* here — that it stays
 * off on a warm run, that its fan-out is bounded, and that it is shut down —
 * are otherwise unobservable from outside, and a property nothing can observe is
 * a property nothing can keep.
 */
export interface ParsePoolPolicy {
  /**
   * Master switch. Defaults to **OFF**; set `VAT_PARSE_POOL=1` to opt in.
   *
   * ⛔ **THE 6.5× REGRESSION THIS DEFAULT WAS SET FOR NEVER EXISTED.** It was an
   * instrument artifact, and the table that used to stand here is deleted rather
   * than corrected in place, because a wrong measurement left visible gets cited.
   * Parse worker threads share their parent's PID, each filed its own timing dump
   * reporting the WHOLE PROCESS's `uptime()` and `cpuUsage()`, and the lab summed
   * them — 9 files, 1 pid, inflating both lifetime scalars by exactly 9×. The
   * A/B's true reading is a **~29% wall-clock IMPROVEMENT**. Both "tells" the
   * decision rested on were that same artifact: the per-document figure carried
   * the 9× through its divisor, and "only ONE process wrote a dump" is simply what
   * nine threads look like to a pid count. Closed at the source: a worker reports
   * its counters to the main thread, which writes ONE dump per process carrying
   * every thread, so a lifetime cannot be observed twice.
   *
   * 🚨 **The default stays OFF anyway, for a different and now-honest reason:**
   * the pool's shape is being reworked and the replacement is designed but not
   * built. The real defect the corrected numbers expose is **~20% worker
   * utilization** — the threads are starved, not contended — and separately the
   * parse-heaviest command (`vat resources validate`) never routes through this
   * pool at all, so the arm that most needs it is not the arm being measured.
   * Enabling by default is the LAST step of that work, after the shape is right,
   * not a flag flip available now.
   *
   * ⚠️ The per-call-lifetime hypothesis recorded here is also RETIRED, not merely
   * unconfirmed: `populateBlobs` runs ONCE per command, so a per-call dispatcher
   * builds one pool per run and there was never a repeated module load to pay for.
   *
   * ⭐ Kept, because it is the one lesson that survived: the pool's own unit tests
   * drive `populateBlobs` ONCE, so any per-call setup defect would have been
   * invisible to them by construction. A fixed cost paid per CALL looks free in
   * any test that calls once, and almost no unit test calls twice.
   *
   * The environment is read per call rather than at module load, matching
   * `ParseCache`'s handling of `VAT_CACHE`: a module-level read binds the
   * decision to import order, which no caller has reason to expect.
   */
  enabled?: boolean;
  /**
   * How parse facts get back from a worker. Defaults to `VAT_PARSE_TRANSPORT`,
   * and to `'wire'` when that names nothing.
   *
   * See {@link ParseTransport}. This is a knob to be MEASURED, not a preference:
   * the two arms move real cost between the serial parent and the parallel
   * workers in opposite directions, and which wins is a property of the corpus
   * and the filesystem rather than something this file can reason out.
   */
  transport?: ParseTransport;
  /**
   * Worker ceiling, honoured verbatim.
   *
   * Defaults to `VAT_PARSE_POOL_SIZE`, and failing that to one worker per
   * {@link PARSE_MS_PER_WORKER} of estimated serial parse time still to come,
   * capped by the pool's own `defaultParsePoolSize()` — see
   * {@link ParseDispatcher.considerActivation}.
   *
   * ⭐ Environment-reachable because a width has to be PINNED to be compared
   * across machines. Sized from the local core count, a 10-core box runs 4
   * workers and a 4-core box runs 3, so a cross-machine difference confounds
   * width with platform and neither reading can be attributed.
   */
  size?: number;
  /**
   * Parse-cache MISSES within this run before a pool is created.
   *
   * Floored at 1, so a fully warm run — every document a hit, nothing ever
   * parsed — can never reach it. Defaults to `VAT_PARSE_POOL_MIN_MISSES`, and
   * failing that to {@link PARSES_BEFORE_SIZING} — which see, because the
   * threshold is also the SAMPLE the width is estimated from, and lowering it
   * makes that estimate noisier as well as earlier.
   */
  missThreshold?: number;
  /**
   * How far preparation may run ahead of emission, in multiples of the width.
   *
   * Defaults to `VAT_PARSE_LOOK_AHEAD`, and failing that to
   * {@link PREPARATION_LOOK_AHEAD} — which see for what the number means and
   * what it trades. Environment-reachable for the reason that docstring gives:
   * it calls its own value provisional and the A/B that would settle it the next
   * step, and an experiment arm cannot vary a module constant.
   */
  lookAhead?: number;
  /**
   * Builds the pool. Defaults to `createParsePool`.
   *
   * The seam a test drives to observe activation and shutdown without owning a
   * thread, in the spirit of `parse-pool.ts`'s `__setParseWorkerEntryForTest` —
   * an option rather than a module global, because two suites running
   * concurrently in one vitest worker share module state and do not share
   * options.
   */
  createPool?: (options?: ParsePoolOptions) => ParsePool;
}

/**
 * How many documents of each parser kind a lane still has to hand over.
 *
 * Per KIND rather than as one total because the two kinds are nowhere near the
 * same amount of work per byte — see {@link MS_PER_MEGABYTE} — so a single count
 * cannot be converted into a cost. Always every kind, even at zero, so the
 * sizing never has to tell an absent kind from an empty one.
 */
export type ParsableRemainder = Readonly<Record<DocumentParserKind, number>>;

/**
 * Measured serial parse cost per megabyte, by parser kind.
 *
 * Both taken cold on a 10-core Mac, and the ratio between them is the finding
 * that put this file's sizing into bytes: **`remark-parse` costs roughly 24x per
 * byte what `parse5` costs**, so an HTML-heavy corpus is nearly free and a
 * markdown corpus is not. Measured consequence of ignoring that, at width 3: the
 * pool HALVES a 30 MB markdown adopter's cold wall clock and COSTS 5.5% on a
 * 145-document HTML-heavy tree.
 *
 * `markdown` is the low end of a measured 370–470 ms/MB range, deliberately: the
 * number decides whether to SPEND threads, and the conservative end of a range
 * buys fewer of them. It checks out against an independent reading — a 103-skill
 * adopter parsed 10,659.0 ms of markdown, and its 30.18 MB at this rate predicts
 * 11,167 ms, 4.8% high.
 *
 * ⚠️ One machine, one filesystem. A slower box parses slower AND loads modules
 * slower, so the two move together and the break-even moves less than either —
 * but nothing has measured that, and a platform whose ratio differs would want
 * its own reading rather than this one generalised to it.
 */
const MS_PER_MEGABYTE: Readonly<Record<DocumentParserKind, number>> = {
  markdown: 370,
  html: 42,
};

/** One megabyte, so the rates above can be read in the unit they were measured in. */
const BYTES_PER_MEGABYTE = 1_048_576;

/**
 * Serial parse milliseconds one worker must displace to be worth starting.
 *
 * ## The arithmetic
 *
 * A pool's fixed cost is one remark/unified module load — ~723 ms, measured
 * directly as the loss a width-1 pool takes. It is ONE load rather than N
 * because workers start concurrently, so their loads overlap in wall clock.
 * Against that, a pool of N threads removes a measured 0.729 of the serial parse
 * time it takes over, less the share it keeps for itself:
 *
 * ```text
 * net = 0.729 x P x (1 - 1/N) - 723 ms
 * ```
 *
 * which the model was fitted to at width 3 and then predicted on two corpora it
 * was not fitted to. At {@link MINIMUM_WORKERS} that breaks even at P ≈ 1,983 ms,
 * so a worker's share of it is ~992 ms, and 1,000 is that at the precision the
 * model's own coefficients justify.
 *
 * ⚠️ **Used as a divisor, so it is CONSERVATIVE above the minimum.** The model
 * says a wider pool breaks even SOONER — 1,322 ms at width 4 — because the fixed
 * cost does not grow with width. Dividing charges each worker a full share
 * anyway. That is deliberate: the model measures wall clock and says nothing
 * about the CPU a thread costs, and four remark heaps bought to save 50 ms is a
 * trade nothing here has measured. ⛔ The model also breaks down by N = 8; do not
 * extend it past the cap.
 */
const PARSE_MS_PER_WORKER = 1000;

/**
 * Parses this run must have done before the sizing may decide anything.
 *
 * Two jobs, and the second is why it cannot simply be 1:
 *
 * 1. **It proves the run is COLD.** A cache HIT costs no parse, so a run of
 *    10,000 warm documents has nothing for a thread to do. This is the same
 *    discipline `parseKeyed` keeps by putting its `loadParser` call *past* the
 *    cache-hit return — a position its docstring records as having regressed
 *    twice, at ~730 ms of remark load for a parse that never happens.
 * 2. ⭐ **It IS the sample the estimate is built from.** Nothing on either lane
 *    knows a remaining document's size — see {@link ParseDispatcher.considerActivation}
 *    — so the remainder is priced from the documents this run has already
 *    handled. 128 of them is a mean worth projecting; one of them is whichever
 *    document the corpus happened to order first.
 */
const PARSES_BEFORE_SIZING = 128;

/**
 * Tally what is left to parse, by kind, from a given position onwards.
 *
 * The sizing input both lanes supply, and one function rather than two because
 * they differ only in how a target names its kind: the registry routes a PATH
 * through its collection declarations, the projection reads a content KEY's own
 * prefix. Neither does any I/O — both inputs are already in memory, which is the
 * property that lets this answer without a `stat` and without a read.
 *
 * Documents that route to `none` are excluded because they never touch the pool.
 * On this repository that is not a rounding error: 6,967 of 8,713 documents
 * reach no parser at all.
 *
 * @param items - The targets, in the order they will be handed over
 * @param from - Index of the first target not yet emitted
 * @param kindOf - How a target names the parser it routes to
 * @returns The remaining count per document parser kind, always every kind
 */
export function tallyParsable<Target>(
  items: readonly Target[],
  from: number,
  kindOf: (item: Target) => ParserKind,
): ParsableRemainder {
  const remainder: Record<DocumentParserKind, number> = { markdown: 0, html: 0 };
  for (let index = from; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    const kind = kindOf(item);
    if (kind !== NO_PARSER_KIND) remainder[kind] += 1;
  }
  return remainder;
}

/**
 * A positive whole number named by the environment, or `undefined`.
 *
 * ⚠️ Anything that is not one is `undefined` rather than a coerced value. A pool
 * built with `NaN` workers is not a smaller pool but an unusable one, and a
 * threshold of `NaN` compares false against every count so the pool would never
 * activate at all — both failures surface far from the typo that caused them, as
 * a command that hangs or as an experiment arm that silently measured nothing.
 *
 * @param name - The variable to read
 * @returns The value, or `undefined` when absent, empty or not a positive whole
 */
function positiveWholeFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Chooses where each parse runs, and how wide the derivation window may be.
 *
 * ## Why the width lives here and not in the loop
 *
 * The two are one decision. A pool only pays if the call site dispatches
 * concurrently — awaiting one pooled document at a time is strictly worse than
 * parsing it here, because it adds a structured clone of the whole document to
 * a loop that was already serial. So the window width is a function of whether
 * a pool is active, and putting both behind one object is what keeps them from
 * being changed apart.
 *
 * Width is **1** until a pool exists, which makes the un-pooled path
 * byte-identical to the sequential loop each lane replaced: one target prepared,
 * one target emitted, in the lane's own output order.
 */
export class ParseDispatcher {
  readonly #cache: ParseCache;
  readonly #policy: ParsePoolPolicy;
  readonly #enabled: boolean;
  readonly #transport: ParseTransport;
  readonly #missThreshold: number;
  readonly #baselineHits: number;
  readonly #baselineMisses: number;
  /** `VAT_PARSE_POOL_SIZE`, read once; `undefined` when it names nothing usable. */
  readonly #envSize: number | undefined;
  readonly #lookAhead: number;
  /**
   * Documents this dispatcher has handed to {@link parse}, and their bytes, by
   * kind. The sample {@link considerActivation} prices the remainder from.
   */
  readonly #observed: Record<DocumentParserKind, { documents: number; bytes: number }> = {
    markdown: { documents: 0, bytes: 0 },
    html: { documents: 0, bytes: 0 },
  };

  #pool: ParsePool | null = null;
  #width = 1;
  #closed = false;
  /** Whether the one sizing decision this run gets has been taken. */
  #decided = false;

  constructor(cache: ParseCache, policy: ParsePoolPolicy) {
    this.#cache = cache;
    this.#policy = policy;
    // Opt-IN, not opt-out. NOT because the pool loses — the 6.5x that decided
    // that was an instrument artifact and the truth is a ~29% improvement; see
    // {@link ParsePoolPolicy.enabled}. It stays opt-in because the shape is being
    // reworked. `'1'` exactly, so a stray truthy value cannot silently enable it.
    this.#enabled = policy.enabled ?? process.env['VAT_PARSE_POOL'] === '1';
    // Read per construction for the same reason `enabled` is. `'cache'` exactly,
    // so the shipped behaviour is the wire protocol unless someone names the
    // other one — this switch exists to be A/B'd, not to be guessed at.
    // A disabled cache cannot BE the transport — the worker's write is a no-op
    // and the parent's read-back finds nothing, so every document would parse
    // off-thread and then again on it. Fall back to the wire rather than let a
    // `VAT_CACHE=0` run silently do twice the work.
    const asked =
      policy.transport ?? (process.env['VAT_PARSE_TRANSPORT'] === 'cache' ? 'cache' : 'wire');
    this.#transport = cache.enabled ? asked : 'wire';
    // Explicit policy BEATS the environment, for both knobs: a caller that has
    // already decided must not have its decision overridden by an ambient
    // variable it never saw. Read per construction, matching `enabled` above.
    this.#missThreshold = Math.max(
      1,
      Math.floor(
        policy.missThreshold ??
          positiveWholeFromEnv('VAT_PARSE_POOL_MIN_MISSES') ??
          PARSES_BEFORE_SIZING,
      ),
    );
    this.#envSize = positiveWholeFromEnv('VAT_PARSE_POOL_SIZE');
    this.#lookAhead =
      policy.lookAhead ?? positiveWholeFromEnv('VAT_PARSE_LOOK_AHEAD') ?? PREPARATION_LOOK_AHEAD;
    // DELTAS, because `ParseCacheStats` is cumulative for the cache instance's
    // life and the default instance is process-wide: absolute counts would let
    // an earlier lane's misses activate this run's pool, and would price this
    // run's remainder off another lane's hit rate.
    this.#baselineHits = cache.stats.hits;
    this.#baselineMisses = cache.stats.misses;
  }

  /**
   * How many targets may be prepared concurrently right now.
   *
   * Read on every claim rather than held, so activation reaches the very next
   * target instead of the next run — see {@link driveInOrder}.
   *
   * It is the pool's width because a preparation's whole reason to be
   * outstanding is that a worker is busy with it: fewer in flight than there are
   * threads and the pool starves; more and the surplus only queues. It is also
   * the bound on open file handles, which is the property the sequential loop
   * these lanes used to run was defending.
   */
  get width(): number {
    return this.#width;
  }

  /**
   * How far preparation may run ahead of emission, as a multiple of the width.
   *
   * Fixed for the dispatcher's life, unlike {@link width}, which moves when a
   * pool activates: this bounds *outstanding prepared results* rather than
   * in-flight work, and that budget is about memory, which activation does not
   * change. See {@link PREPARATION_LOOK_AHEAD}.
   */
  get lookAhead(): number {
    return this.#lookAhead;
  }

  /**
   * Parse one document, off-thread once a pool is active.
   *
   * Every document that passes through here is also the sizing's SAMPLE — see
   * {@link considerActivation}. Recorded for hits as well as misses, because
   * what is being sampled is how big this corpus's documents are, and a cached
   * document is as good a witness to that as a parsed one.
   *
   * @param keyed - The confirmed read, narrowed to a kind that has a parser
   * @returns The parse, identical either way
   */
  async parse(keyed: ParsableContent): Promise<ParseResult> {
    const seen = this.#observed[keyed.parserKind];
    seen.documents += 1;
    seen.bytes += keyed.byteLength;

    const pool = this.#pool;
    if (pool !== null) return parseKeyedInPool(keyed, this.#cache, pool, this.#transport);
    return parseKeyed(keyed, this.#cache);
  }

  /**
   * Create the pool, if this run has proved cold enough and rich enough.
   *
   * Both halves of the test are load-bearing, and they measure different things.
   * The MISS count says the run is genuinely parsing rather than replaying a
   * cache; the priced REMAINDER says there is enough parse time left for a
   * thread to earn its module load. Neither implies the other — a run can pass
   * the threshold on its second-to-last document — and the width, which is what
   * the cost actually scales with, is a function only of the second.
   *
   * ## 🔑 Why the remainder is ESTIMATED rather than measured
   *
   * The quantity that decides is remaining serial parse TIME, which tracks
   * parsable bytes weighted by kind ({@link MS_PER_MEGABYTE}). **Neither lane
   * holds those bytes, and no enumeration route produces them.** `crawlDirectory`
   * returns paths; `readdir` gives dirents without sizes; the projection's
   * `resource_realizations` table has no size column, by design. The registry
   * learns a file's size from the `stat` inside its own admission — after the
   * target has been claimed, which is far too late to size a pool with.
   *
   * So asking the filesystem would mean an O(remaining) `stat` storm on the main
   * thread at exactly the moment the run is trying to get faster — 1,777 of them
   * on the measured adopter, to answer one question, once. Instead the remainder
   * is priced from the sample this run has already read: {@link parse} records
   * every document's kind and byte length, and by the time the miss threshold is
   * reached ({@link PARSES_BEFORE_SIZING}) that is a mean worth projecting onto a
   * count the lanes CAN supply for free.
   *
   * ⚠️ **It is a projection, and it can be wrong in one direction that matters.**
   * The registry hands over paths in crawl order, which is filesystem order, so a
   * tree whose first documents are unlike its last ones is mis-sampled. The
   * projection lane is content-key ordered — a hash — so its sample is
   * effectively random and this does not apply. Being wrong costs at most the
   * pool's fixed cost in one direction and a pool not started in the other;
   * being wrong about kind, which the old document count was by construction,
   * cost a measured 5.5% on an HTML tree.
   *
   * `createParsePool` spawns nothing, so this is an allocation; the first thread
   * starts on the first dispatched document. That is why activating mid-run is
   * cheap enough to be gated on evidence rather than guessed at up front.
   *
   * @param remainingParsable - Tallies what is still to be parsed, by kind. A
   *   callback, not a value, because the tally is an O(remaining) scan and every
   *   call before the threshold is met — one per emission — would otherwise pay
   *   for it. It runs at most ONCE per run, and not at all when a caller named a
   *   width.
   */
  considerActivation(remainingParsable: () => ParsableRemainder): void {
    if (!this.#enabled || this.#closed || this.#decided) return;
    if (this.#cache.stats.misses - this.#baselineMisses < this.#missThreshold) return;

    // ⛔ ONE decision per run, taken here, whichever way it goes — and the flag
    // is set BEFORE the answer is known because a DECLINE has to stick too.
    // Without it, a run that clears the threshold and is then told "not worth a
    // pool" asks again at every remaining emission, and each ask is an
    // O(remaining) scan: O(n²) over the corpus, for an answer that cannot
    // change in the direction that matters, since the remainder only shrinks.
    // Byte-sized corpora decline far more often than counted ones did, so this
    // is the common path rather than the exotic one.
    this.#decided = true;

    const size =
      this.#policy.size ??
      this.#envSize ??
      workersFor(this.#estimateRemainingParseMs(remainingParsable()));
    if (size < 1) return;

    const create = this.#policy.createPool ?? createParsePool;
    // `cacheDir` unconditionally, not only under cache transport: a pool is
    // built once and the transport is read per document, so a pool told nothing
    // would be the wrong pool the moment either changes. It costs one string in
    // `workerData` and `parse()` ignores it.
    this.#pool = create({ size, cacheDir: this.#cache.directory });
    this.#width = this.#pool.size;
  }

  /**
   * Price the remainder in serial parse milliseconds.
   *
   * Per kind, `remaining x meanObservedBytes x msPerByte`, discounted by this
   * run's own MISS rate. The discount is not a refinement: a warm run that
   * changed 200 files out of 10,000 clears the miss threshold honestly and still
   * has almost nothing left to parse, and counting every remaining parsable
   * document as a parse would buy it a pool for work the cache is about to
   * answer for free. Measured: 50.3% of a warm crawl re-keys files it does not
   * reparse.
   *
   * ⛔ **A kind with no sample contributes NOTHING.** Inventing a size for it
   * would buy threads on evidence this run has not seen, and the failure is
   * asymmetric: guessing high starts a pool for a corpus that cannot pay for it,
   * while guessing nothing at worst declines one that could. The threshold makes
   * this rare — a kind absent from 128 consecutive documents is a kind the
   * remainder is unlikely to be made of.
   *
   * @param remaining - What the lane says is left, by kind
   * @returns Estimated milliseconds of serial parse still to come
   */
  #estimateRemainingParseMs(remaining: ParsableRemainder): number {
    const hits = this.#cache.stats.hits - this.#baselineHits;
    const misses = this.#cache.stats.misses - this.#baselineMisses;
    const lookups = hits + misses;
    // The threshold above guarantees `misses >= 1`, so `lookups` is never zero.
    const missRate = misses / lookups;

    let estimatedMs = 0;
    for (const kind of DOCUMENT_PARSER_KINDS) {
      const seen = this.#observed[kind];
      if (seen.documents === 0) continue;
      const meanBytes = seen.bytes / seen.documents;
      const msPerByte = MS_PER_MEGABYTE[kind] / BYTES_PER_MEGABYTE;
      estimatedMs += remaining[kind] * missRate * meanBytes * msPerByte;
    }
    return estimatedMs;
  }

  /**
   * Close the pool, if one was ever created.
   *
   * ⚠️ MUST be reached on the throw path as well. A pool that is not shut down
   * loses every worker's parse-timing dump — a process exiting with live threads
   * runs none of their `exit` listeners — so an un-shut-down pool blinds the
   * instrument that justified building it. See `parse-pool.ts`.
   */
  async shutdown(): Promise<void> {
    this.#closed = true;
    const pool = this.#pool;
    this.#pool = null;
    this.#width = 1;
    if (pool !== null) await pool.shutdown();
  }
}

/**
 * `parseKeyed`, with the parser call on a worker thread.
 *
 * Deliberately not a flag inside `parseKeyed` itself: that function's shape is
 * load-bearing — its `loadParser` sits past the cache-hit return, and its
 * docstring records that hoisting it has regressed twice — so the pooled variant
 * lives here rather than adding a branch to the one hot path in the package that
 * must not grow one. The cache lookup and the `set` are the same two calls in
 * the same order; only the middle line differs, and the hit path still costs no
 * thread, no clone and no parser load.
 *
 * The two `parse-timing` calls are not bookkeeping: without them a pooled run's
 * sub-phase dump would report zero cache activity and read as a dead seam.
 *
 * @param keyed - The confirmed read, of a kind that has a parser
 * @param cache - The store to consult and file into
 * @param pool - The worker pool to hand the parse to
 * @returns Parse facts equal to what the in-process parser would have produced
 */
async function parseKeyedInPool(
  keyed: ParsableContent,
  cache: ParseCache,
  pool: ParsePool,
  transport: ParseTransport,
): Promise<ParseResult> {
  const hit = await cache.get(keyed);
  if (hit !== null) {
    recordParseCacheHit();
    return hit;
  }
  recordParseCacheMiss();

  // Content, never a path: `RunContentCache` guarantees one read per file per
  // run, and a worker re-reading by path would break that and could parse bytes
  // nobody else in the run ever saw.
  if (transport === 'cache') return parseThroughCache(keyed, cache, pool);

  const result = await pool.parse(keyed.parserKind, keyed.content, keyed.byteLength);
  await cache.set(keyed, result);
  return result;
}

/**
 * The cache-as-transport half of {@link parseKeyedInPool}.
 *
 * The worker parses, writes the entry and answers with the key; the parent reads
 * its own cache. Two costs move off this thread — the fact graph's structured
 * clone and the entry's `JSON.stringify` — and one moves onto it: a `readFile`
 * plus `JSON.parse` plus schema validation. Whether that trade pays is a
 * measurement, and `parse-timing.ts`'s tier rows are how it is taken.
 *
 * ⛔ **The fallback is not defensive padding.** A worker answers with the facts
 * whenever it could not store them, and this function must use those facts
 * rather than re-parsing or failing: `ParseCache` is fail-soft by design, so a
 * read-only mount or a full disk produces no error to notice — only an entry
 * that is not there. Without the fallback, cache transport would turn every
 * un-writable cache into a run that parsed everything and kept none of it.
 *
 * @param keyed - The confirmed read, of a kind that has a parser
 * @param cache - The store the worker filed into and this thread reads back
 * @param pool - The worker pool
 * @returns Parse facts equal to what the in-process parser would have produced
 */
async function parseThroughCache(
  keyed: ParsableContent,
  cache: ParseCache,
  pool: ParsePool,
): Promise<ParseResult> {
  const sent = await pool.parseIntoCache(
    keyed.parserKind,
    keyed.content,
    keyed.byteLength,
    keyed.key,
  );
  if (sent !== null) return sent;

  // `read`, not `get`: this document is a miss that was just parsed off-thread,
  // and counting the read-back as a hit would make a cold run's cache
  // statistics describe a warm one. See `ParseCache.read`.
  const stored = await cache.read(keyed);
  if (stored !== null) return stored;

  // The worker read the entry back before answering `stored`, so reaching here
  // means it was removed between that read and this one — a concurrent `vat
  // cache clear`, or the OS purging its temp directory mid-run. Rare, real, and
  // recoverable on this thread rather than worth failing a whole population for.
  return parseKeyed(keyed, cache);
}
/**
 * The smallest pool worth having: **two**.
 *
 * A one-worker pool parallelizes nothing, and the window is why. Width is the
 * pool's size, so a pool of one prepares one blob at a time — the main thread
 * hands over a document, then waits for a thread to do work it could have done
 * itself, having first paid a structured clone each way and a remark load once.
 * Measured: sized at 1 for a 177-document tail, `vat claude context` over this
 * repository went from 2.27 s to 2.45 s. Overlap begins at two.
 */
const MINIMUM_WORKERS = 2;

/**
 * How many workers a remaining workload can pay for.
 *
 * Integer division by {@link PARSE_MS_PER_WORKER}, floored at
 * {@link MINIMUM_WORKERS} in the sense that anything below it answers **0** and
 * no pool is created at all — the two ways of spending nothing are "no pool" and
 * "a pool that helps", and there is no third. The cap is the pool's own default,
 * which keeps a 64-core build agent from starting 63 remark instances.
 *
 * @param estimatedSerialMs - Serial parse time the remainder is worth
 * @returns The worker count to ask for, or 0 for "do not start a pool"
 */
function workersFor(estimatedSerialMs: number): number {
  const affordable = Math.min(
    defaultParsePoolSize(),
    Math.floor(estimatedSerialMs / PARSE_MS_PER_WORKER),
  );
  return affordable < MINIMUM_WORKERS ? 0 : affordable;
}

/**
 * The two members {@link driveInOrder} reads off a dispatcher.
 *
 * Named, and narrow, so the loop is drivable by a test double: `ParseDispatcher`
 * owns a real cache, a real pool factory and an activation policy, and a suite
 * that had to build all three to ask *"was the next target claimed when a slot
 * freed?"* would be asking through three other subsystems. Private class members
 * are not in `keyof`, so a plain object literal satisfies this.
 */
export type ParseWindow = Pick<ParseDispatcher, 'width' | 'lookAhead' | 'considerActivation'>;

/**
 * How far preparation may run ahead of emission, in multiples of the width.
 *
 * ## What it is for, and why it is not simply the width
 *
 * Emission is in target order, so a slow target at the head holds every finished
 * preparation behind it. If the claim side were bounded by distance-from-the-head
 * alone, that straggler would idle the pool exactly as the stepped window it
 * replaced did — the loop would be pull-shaped and starve anyway. Letting
 * preparation run some distance ahead is what keeps a worker fed while the head
 * is still out.
 *
 * The distance cannot be unbounded, and the reason is memory rather than
 * handles: everything prepared past the head is a full parse-fact graph held
 * until its turn comes. Unbounded, one slow first document buffers the entire
 * corpus's facts. So the claim side answers to two separate bounds —
 * {@link ParseDispatcher.width} for what is *in flight* (file handles, and the
 * pool's own appetite) and this multiple of it for what is *outstanding*
 * (prepared results waiting on the head).
 *
 * ✅ **4 has survived its A/B.** It tolerates a head that runs roughly four times
 * the mean preparation before the claim side stalls, and costs at most
 * `width x 4` buffered fact graphs. Measured against the alternative that
 * removes the buffering entirely: **a look-ahead of 1 costs +21.9%**, because a
 * straggler at the head then idles the whole pool exactly as the stepped window
 * this loop replaced did. ⛔ Do not tune it against a guess — the instrument
 * brackets parses and boundary crossings, not the head-of-line stall itself, so
 * the only honest reading of a different value is another A/B.
 *
 * ⭐ This is the DEFAULT, not the value. `ParsePoolPolicy.lookAhead` and
 * `VAT_PARSE_LOOK_AHEAD` override it, so the sweep that would settle it can be
 * run from outside the process — the lab varies an arm's environment, and a
 * module constant is exactly what it cannot reach.
 *
 * At width 1 — no pool, which is what ships — this is inert: only one
 * preparation can be in flight, and it is always the head, so nothing is ever
 * buffered.
 */
const PREPARATION_LOOK_AHEAD = 4;

/** A finished preparation, or the failure it raised. */
type Settled<Prepared> = { readonly prepared: Prepared } | { readonly failure: unknown };

/**
 * Drive a target list: preparations pulled as slots free, emitted in order.
 *
 * ## The hand-out is PULL, and the barrier is why
 *
 * The loop this replaced stepped: it sliced `width` targets, awaited **all** of
 * them, emitted them, and only then touched the next slice. A slice is as long
 * as its slowest member, so every fast preparation in it sat finished while the
 * pool it feeds went idle — measured at roughly **20% worker utilization**, with
 * the threads starved rather than contended. Here a target is claimed the moment
 * a slot frees, so the tail is bounded by ONE preparation instead of by a whole
 * slice of them, and it self-levels without the loop predicting anything: a slot
 * that draws an expensive target simply asks for its next one later. That is
 * feedback from observed completion rather than a guess at cost up front, which
 * is why no byte-weighting of targets is needed to go with it.
 *
 * ## Why the fan-out is still bounded
 *
 * Each preparation reads and parses a whole file, and one file handle per corpus
 * document in flight is how a large corpus runs out of them — the EMFILE
 * argument that kept both lanes' loops strictly sequential for as long as they
 * were. That argument is not retired here, it is **bounded**: at most
 * {@link ParseDispatcher.width} preparations are in flight at once (4 at the
 * default cap, **1 when no pool is active**), and at most
 * {@link PREPARATION_LOOK_AHEAD} times that many are outstanding ahead of the
 * emitted head. Both are small constants rather than functions of corpus size.
 *
 * ## Why emission is sequential even though preparation is not
 *
 * Because output order must be a function of the corpus and of nothing else.
 * `crawlDirectory`'s directory route already returns filesystem order, which
 * differs between APFS, ext4 and NTFS; a lane whose output also depended on
 * which worker answered first would add a second source of machine-dependent
 * output on top of it. So `prepare` must touch no shared mutable state and must
 * decide everything as a VALUE, and every mutation happens in `emit`, here, in
 * target order.
 *
 * ⭐ At width 1 this is byte-identical to the sequential loop both lanes used to
 * run: one target prepared, one target emitted, before the next is touched. That
 * is what lets a lane carry it ahead of any decision to turn a pool on.
 *
 * @param targets - The work, in the order output must be produced in
 * @param window - Decides where each parse runs, and how many may be in flight
 * @param prepare - Concurrent half. Must not mutate anything shared. A rejection
 *   is caught and re-raised from `emit`'s position in target order, so which
 *   failure kills the run is never a function of completion order — but a lane
 *   that has more than one kind of failure should still carry them back as
 *   values, because only the lane can say which ones are findings.
 * @param emit - Sequential half. Every mutation the lane performs lives here.
 * @param remainingParsable - Which targets from the given index onwards will
 *   reach a parser, tallied by kind. A callback, not a value, because the tally
 *   is an O(remaining) scan and every emission before activation would otherwise
 *   pay for it; {@link ParseDispatcher.considerActivation} returns before calling
 *   it in every case but one, so it runs at most once per run.
 */
export async function driveInOrder<Target, Prepared>(
  targets: readonly Target[],
  window: ParseWindow,
  prepare: (target: Target) => Promise<Prepared>,
  emit: (prepared: Prepared) => void,
  remainingParsable: (from: number) => ParsableRemainder,
): Promise<void> {
  const source = targets.entries();
  const inFlight = new Map<number, Promise<void>>();
  const settled = new Map<number, Settled<Prepared>>();
  let claimed = 0;
  let emitted = 0;

  /**
   * Prepare one target, recording the outcome either way.
   *
   * Never rejects: a task whose rejection escaped would leave its siblings'
   * rejections unhandled and hand the run's fate to whichever settled first.
   *
   * @param index - Position in `targets`, which is emission order
   * @param target - The work
   */
  async function settle(index: number, target: Target): Promise<void> {
    try {
      settled.set(index, { prepared: await prepare(target) });
    } catch (failure) {
      settled.set(index, { failure });
    }
  }

  /** Take targets while a slot is free and the head is close enough behind. */
  function claim(): void {
    while (
      inFlight.size < window.width &&
      claimed - emitted < window.width * window.lookAhead
    ) {
      const next = source.next();
      if (next.done === true) return;
      const [index, target] = next.value;
      claimed = index + 1;
      // `.finally` rather than a `finally` block inside `settle`: a `prepare`
      // that throws SYNCHRONOUSLY would run that block before this `set`,
      // stranding the entry and shrinking the pool by one for the rest of the
      // run. A `then` callback cannot run before the expression it is attached
      // to has been assigned.
      inFlight.set(
        index,
        settle(index, target).finally(() => {
          inFlight.delete(index);
        }),
      );
    }
  }

  while (emitted < targets.length) {
    // Emit as far as the head allows BEFORE claiming anything more. The order of
    // these two is what keeps width 1 strictly sequential: claiming first would
    // let the look-ahead take the next target while the current one was still
    // waiting to be emitted, and an un-pooled crawl would stop being the loop it
    // replaced.
    for (let head = settled.get(emitted); head !== undefined; head = settled.get(emitted)) {
      settled.delete(emitted);
      emitted += 1;
      if ('failure' in head) throw head.failure;
      emit(head.prepared);
      window.considerActivation(() => remainingParsable(claimed));
    }
    if (emitted >= targets.length) break;

    claim();
    // `claim` has just taken the head if nothing else had — both bounds are
    // slack when nothing is outstanding — so something is always in flight here.
    await Promise.race(inFlight.values());
  }
}
