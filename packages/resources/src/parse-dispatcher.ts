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

import { type FsSide, withFsFault } from '@vibe-agent-toolkit/utils';

import {
  DOCUMENT_PARSER_KINDS,
  type KeyedContent,
  NO_PARSER_KIND,
  type ParsableContent,
  keyContent,
  type ParserKind,
  readContentWithKey,
} from './content-key.js';
import type { ParseResult } from './link-parser.js';
import type { DocumentParserKind } from './mime-type.js';
import { defaultParseCache, type ParseCache } from './parse-cache.js';
import { ParseLimitError, type ParseLimits, resolveParseLimits } from './parse-limits.js';
import {
  createParsePool,
  defaultParsePoolSize,
  type ParsePool,
  type ParsePoolOptions,
} from './parse-pool.js';
import { recordParseCacheHit, recordParseCacheMiss } from './parse-timing.js';
import type { HarnessContentFacts, HarnessId } from './projection/harness/profile.js';

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
 * ## 🔑 MEASURED — `cache` does what it promised and LOSES anyway
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
   * Limits tighter (or looser) than `DEFAULT_PARSE_LIMITS`, per limit, for
   * every job this dispatcher's pool runs. Programmatic only — there is no
   * config or environment surface for parse limits; see `parse-limits.ts`.
   *
   * ⛔ **There is no `enabled`.** Every parse runs in the bounded pool, because a
   * parse on the run's own thread cannot be stopped at a limit (ADR I8). The
   * old `VAT_PARSE_POOL=0` opt-out and the below-threshold in-process route are
   * gone; a small corpus pays one worker, never an unbounded parse.
   */
  limits?: Partial<ParseLimits>;
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
   *
   * "Verbatim" means a positive whole number: anything else is refused on this
   * route exactly as it is on the environment's, because `NaN < 1` is false and
   * a pool of `NaN` workers would otherwise be built rather than declined. See
   * {@link resolveKnob}.
   */
  size?: number;
  /**
   * Parse-cache MISSES within this run before a pool is created.
   *
   * At least 1, so a fully warm run — every document a hit, nothing ever parsed
   * — can never reach it. Defaults to `VAT_PARSE_POOL_MIN_MISSES`, and failing
   * that to {@link PARSES_BEFORE_SIZING} — which see, because the threshold is
   * also the SAMPLE the width is estimated from, and lowering it makes that
   * estimate noisier as well as earlier.
   *
   * ⚠️ That minimum used to be a `Math.max(1, Math.floor(...))` clamp, which
   * does not hold it: `Math.max(1, NaN)` is `NaN`, and a `NaN` threshold
   * compares false against every count, so it did not raise the bar but removed
   * it — the fully warm run this sentence promises cannot activate was buying a
   * pool. {@link resolveKnob} refuses the value instead of clamping it.
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
   *
   * ⛔ **`0` is not "no look-ahead", it is a HANG** — `driveInOrder` claims
   * nothing, so nothing ever settles and nothing is ever emitted. Refused, along
   * with every other value that is not a positive whole, on this route and on
   * the environment's alike; see {@link resolveKnob}.
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
 *    discipline the pool keeps by being built only *past* the
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
 * The value, if it is a positive whole number, and `undefined` for anything else.
 *
 * ⚠️ Anything that is not one is `undefined` rather than a coerced value. A pool
 * built with `NaN` workers is not a smaller pool but an unusable one; a
 * threshold of `NaN` compares false against every count, so it does not raise
 * the bar but REMOVES it, buying a pool for a fully warm run that has parsed
 * nothing; and a look-ahead of `0` or `NaN` makes `claimed - emitted < width x
 * lookAhead` false on the first claim, so `driveInOrder` claims no target, its
 * in-flight map stays empty and the race it awaits never settles — the command
 * hangs FOREVER. Every one of those surfaces far from the value that caused it.
 *
 * @param value - The candidate, from any route
 * @returns The value, or `undefined` when it is not a positive whole number
 */
function positiveWhole(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * A positive whole number named by the environment, or `undefined`.
 *
 * @param name - The variable to read
 * @returns The value, or `undefined` when absent, empty or not a positive whole
 */
function positiveWholeFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  return positiveWhole(Number(raw));
}

/**
 * Resolve one numeric knob: policy, then environment, then the default.
 *
 * ⭐ **One validation step, on every route's value.** Each knob is reachable
 * twice — a caller's {@link ParsePoolPolicy} and an environment variable — and
 * checking only at the entry point that happened to be written first is how
 * `lookAhead` shipped guarded on the environment and unguarded on the policy: a
 * config carrying `parsePool: { lookAhead: 0 }` hung the command forever while
 * `VAT_PARSE_LOOK_AHEAD=0` was quietly refused. Routing every route through
 * `positiveWhole` here means a THIRD route — a config file, a CLI flag — is
 * guarded by construction rather than by whoever adds it remembering to be.
 *
 * A refused value falls THROUGH to the next source rather than clamping to a
 * legal one: the routes disagree about who decided, and coercing a typo into a
 * working number is exactly how a value nobody chose ends up in a measurement.
 *
 * @param fromPolicy - What the caller named, if anything
 * @param envName - The variable the lab varies this knob through
 * @param fallback - The measured default, when no route names a usable value
 * @returns The value in force
 */
function resolveKnob(fromPolicy: number | undefined, envName: string, fallback: number): number {
  return positiveWhole(fromPolicy) ?? positiveWholeFromEnv(envName) ?? fallback;
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
  readonly #limits: Partial<ParseLimits> | undefined;
  /** The input cap, resolved from {@link #limits} once, at construction: see {@link inputBytes}. */
  readonly #inputBytes: number;
  readonly #transport: ParseTransport;
  readonly #missThreshold: number;
  readonly #baselineHits: number;
  readonly #baselineMisses: number;
  /**
   * The width someone NAMED — policy first, then `VAT_PARSE_POOL_SIZE` — or
   * `undefined` when neither route named a usable one and the estimate decides.
   *
   * Both routes pass {@link positiveWhole} — the same test {@link resolveKnob}
   * applies to the eager knobs — at construction, so no unvalidated policy value
   * survives it: the raw policy is not held, which is what stops a later reader
   * from finding one.
   */
  readonly #pinnedSize: number | undefined;
  readonly #lookAhead: number;
  /** The pool factory in force — {@link ParsePoolPolicy.createPool}, or the real one. */
  readonly #createPool: (options?: ParsePoolOptions) => ParsePool;
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
    this.#limits = policy.limits;
    this.#inputBytes = resolveParseLimits(policy.limits).inputBytes;
    // Read per construction, not at module load. `'cache'` exactly,
    // so the shipped behaviour is the wire protocol unless someone names the
    // other one — this switch exists to be A/B'd, not to be guessed at.
    // A disabled cache cannot BE the transport — the worker's write is a no-op
    // and the parent's read-back finds nothing, so every document would parse
    // off-thread and then again on it. Fall back to the wire rather than let a
    // `VAT_CACHE=0` run silently do twice the work.
    const asked =
      policy.transport ?? (process.env['VAT_PARSE_TRANSPORT'] === 'cache' ? 'cache' : 'wire');
    this.#transport = cache.enabled ? asked : 'wire';
    // Explicit policy BEATS the environment, for every numeric knob: a caller
    // that has already decided must not have its decision overridden by an
    // ambient variable it never saw. Read per construction, matching the
    // transport above — and every one of them through the SAME validation, so a knob
    // cannot be guarded on one of its two routes and open on the other. See
    // {@link resolveKnob}.
    this.#missThreshold = resolveKnob(
      policy.missThreshold,
      'VAT_PARSE_POOL_MIN_MISSES',
      PARSES_BEFORE_SIZING,
    );
    this.#lookAhead = resolveKnob(policy.lookAhead, 'VAT_PARSE_LOOK_AHEAD', PREPARATION_LOOK_AHEAD);
    // The size has no eager default — the width it falls back to is priced from
    // a sample this run has not taken yet — so its two named routes resolve here
    // and `considerActivation` estimates only when neither named one.
    this.#pinnedSize = positiveWhole(policy.size) ?? positiveWholeFromEnv('VAT_PARSE_POOL_SIZE');
    this.#createPool = policy.createPool ?? createParsePool;
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
   * The input cap every parse on this dispatcher runs under, in bytes: a caller that reads a file
   * only to parse it hands this to the read (`readContentWithKey`), so a file past it is refused
   * by its size before it is read. {@link parse} refuses the same bytes again, before its cache,
   * for content handed over in memory, which no read preceded. Resolved once, as the dispatcher is constructed — from the same
   * named limits its pool resolves — so a named cap that is not a positive number is refused there,
   * not at the first read, and no read re-derives it.
   *
   * @returns The resolved `inputBytes` limit
   */
  get inputBytes(): number {
    return this.#inputBytes;
  }

  /**
   * Parse one document, off-thread once a pool is active.
   *
   * Every document that passes through here is also the sizing's SAMPLE — see
   * {@link considerActivation}. Recorded for hits as well as misses, because
   * what is being sampled is how big this corpus's documents are, and a cached
   * document is as good a witness to that as a parsed one.
   *
   * Content past {@link inputBytes} is refused BEFORE the cache is consulted: content handed over
   * in memory had no read to refuse it, and an entry a run under a larger cap filed would
   * otherwise answer it — a verdict that depended on what an earlier run cached.
   *
   * @param keyed - The confirmed read, narrowed to a kind that has a parser
   * @returns The parse, identical either way
   * @throws A `ParseLimitError` (`inputBytes`) for content past the cap
   */
  parse(keyed: ParsableContent): Promise<ParseResult> {
    if (keyed.byteLength > this.#inputBytes) return Promise.reject(new ParseLimitError('inputBytes', this.#inputBytes));
    const seen = this.#observed[keyed.parserKind];
    seen.documents += 1;
    seen.bytes += keyed.byteLength;

    return parseKeyedInPool(keyed, this.#cache, () => this.#poolForMiss(), this.#transport);
  }

  /**
   * Run a harness's memory-file read on the run's pool, under its limits —
   * the harness facts lane's {@link parse}. Never cached here: the projection
   * store files the facts per blob and harness, so a read reaching this is one
   * the store could not answer. It builds the pool if no miss has yet.
   *
   * @param harness - The harness whose reader runs
   * @param content - The decoded file
   * @returns What the harness does with those bytes
   * @throws A `ParseLimitError` / `ParseWorkerDiedError` when the worker
   *   refuses the file, and a parser-unavailable error for a broken install
   */
  async harnessFacts(harness: HarnessId, content: string): Promise<HarnessContentFacts> {
    const facts = await this.#poolForMiss().harnessFacts(harness, content, Buffer.byteLength(content, 'utf8'));
    return facts;
  }

  /**
   * The pool, built on the first MISS and never before.
   *
   * Built at its ceiling — the named size, or the machine's default — because
   * the pool spawns threads only as concurrent jobs demand them, and that
   * demand is {@link width}: 1 until {@link considerActivation} decides
   * otherwise. So a small or mostly warm run owns one thread, and a fully warm
   * one, which never misses, builds no pool at all.
   *
   * @returns The run's one pool
   * @throws If the dispatcher was shut down
   */
  #poolForMiss(): ParsePool {
    if (this.#closed) throw new Error('This parse dispatcher has been shut down.');
    if (this.#pool === null) {
      const create = this.#createPool;
      // `cacheDir` unconditionally, not only under cache transport: the
      // transport is read per document. It costs one string in `workerData`.
      this.#pool = create({
        size: this.#pinnedSize ?? defaultParsePoolSize(),
        cacheDir: this.#cache.directory,
        ...(this.#limits !== undefined && { limits: this.#limits }),
      });
    }
    return this.#pool;
  }

  /**
   * Widen the pool, if this run has proved cold enough and rich enough.
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
   * The registry hands over paths in its admission order — sorted by resolved
   * path, on every lane (`admissionOrder()` in `resource-registry.ts`) — so a
   * tree whose first documents by path are unlike its last ones is mis-sampled,
   * whichever lane enumerated it. Being wrong costs at most the
   * pool's fixed cost in one direction and a pool not started in the other;
   * being wrong about kind, which the old document count was by construction,
   * cost a measured 5.5% on an HTML tree.
   *
   * Until this decides, the width is 1: every miss runs in the pool's one
   * thread. Widening only lets more jobs be outstanding at once, so the pool
   * spawns more threads; a decline leaves the width at 1.
   *
   * @param remainingParsable - Tallies what is still to be parsed, by kind. A
   *   callback, not a value, because the tally is an O(remaining) scan and every
   *   call before the threshold is met — one per emission — would otherwise pay
   *   for it. It runs at most ONCE per run, and not at all when a caller named a
   *   width.
   */
  considerActivation(remainingParsable: () => ParsableRemainder): void {
    if (this.#closed || this.#decided) return;
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

    // `#pinnedSize` is already a positive whole or absent. `workersFor` answers
    // 0 for a remainder too small to pay for a second thread: the width then
    // stays at the one thread every miss already runs in.
    const size =
      this.#pinnedSize ?? workersFor(this.#estimateRemainingParseMs(remainingParsable()));
    if (size < 1) return;
    this.#width = Math.min(size, this.#pool?.size ?? size);
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
   * Close the pool, if a miss ever built one.
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
 * Run `work` with one {@link ParseDispatcher}, and shut it down however `work`
 * ends — or with the caller's own, which this call then neither builds nor
 * shuts down (a run-scoped dispatcher a caller passed down).
 *
 * The run-scoped dispatcher a caller that parses many files holds — a skill's
 * link walk, packaging, discovery over many `SKILL.md`, an inventory: ONE pool
 * for the run, so a cold run pays one worker start and one ~700 ms remark load,
 * not one per file. A fully warm run builds no pool at all: the pool is built on
 * the first cache MISS ({@link ParseDispatcher.parse}).
 *
 * @param work - What to do with the dispatcher
 * @param options - `dispatcher`: a run's dispatcher to reuse (its owner shuts
 *   it down); otherwise `cache`, the store, defaulting to the process-wide one,
 *   and `policy`, the pool policy (`size: 1` for a single-file call)
 * @returns Whatever `work` returns
 */
export async function withParseDispatcher<T>(
  work: (dispatcher: ParseDispatcher) => Promise<T>,
  options: { dispatcher?: ParseDispatcher | undefined; cache?: ParseCache; policy?: ParsePoolPolicy } = {},
): Promise<T> {
  if (options.dispatcher !== undefined) return work(options.dispatcher);
  const dispatcher = new ParseDispatcher(options.cache ?? defaultParseCache(), options.policy ?? {});
  try {
    return await work(dispatcher);
  } finally {
    await dispatcher.shutdown();
  }
}

/** Where a single parse runs: a run's dispatcher, or a one-thread pool of its own. */
export interface ParseRoute {
  /**
   * The run's dispatcher, when the caller parses many documents. Omitted, the
   * call builds a pool of ONE thread — only on a cache miss — and shuts it down
   * before it returns.
   */
  dispatcher?: ParseDispatcher;
  /**
   * The store a call without a `dispatcher` consults, defaulting to the
   * process-wide one. A `dispatcher` brings its own.
   */
  cache?: ParseCache;
}

/**
 * Parse one keyed document on the bounded route: the run's dispatcher, or a
 * one-thread pool built for this call.
 *
 * @param keyed - The confirmed read
 * @param route - The run's dispatcher, or the cache a one-shot pool files into
 * @returns The parse
 */
function parseOnRoute(keyed: ParsableContent, route: ParseRoute): Promise<ParseResult> {
  if (route.dispatcher !== undefined) return route.dispatcher.parse(keyed);
  return withParseDispatcher(
    (dispatcher) => dispatcher.parse(keyed),
    { ...(route.cache !== undefined && { cache: route.cache }), policy: { size: 1 } },
  );
}

/**
 * Read, key and parse a file, consulting the cache — the one route by which a
 * caller outside a crawl parses a file.
 *
 * A hit costs no thread and no parser load. A miss parses in the bounded worker
 * pool, under its limits (ADR I8): there is no other route, and nothing parses
 * on the calling thread.
 *
 * ⚠ `parserKind` states which parser runs — it is **not** derived from the
 * path, because at least one shipped caller deliberately parses `.html`
 * documents as markdown. Pass the kind you actually parse with, or the entry
 * lands under a key another lane will read (see content-key.ts).
 *
 * `sizeBytes` is the length of the bytes this call read: the byte count of what
 * was actually parsed, and the number the key covers.
 *
 * @param filePath - Absolute path to the document
 * @param parserKind - The parser to hand the content to
 * @param options - The {@link ParseRoute}, and `side`: which side of the calling
 *   verb the document is on — `source` (the default: an input the verb reads) or
 *   `destination` / `environment` when the caller re-reads VAT's own output or
 *   staging. Only the caller knows; this function never infers it from the path.
 * @returns The parse result, from an entry or from the worker
 * @throws A `ParseLimitError` / `ParseWorkerDiedError` when the worker refuses
 *   the document (nothing filed), `ParserUnavailableError` for a broken install,
 *   `FsFaultError` on `side` (origin `content` for a source) when the OS refuses
 *   the read — the caller still decides what it means (`isPathAbsentError` and
 *   `fsFaultOf` read the errno down the `cause` chain) — and `TextTooLargeError`
 *   for a file too large to decode, as `readContentWithKey` does
 */
export async function parseFileCached(
  filePath: string,
  parserKind: DocumentParserKind,
  options: ParseRoute & { side?: FsSide } = {},
): Promise<ParseResult> {
  const side = options.side ?? 'source';
  const keyed = await withFsFault({ side, origin: 'content', action: `read ${filePath}`, path: filePath }, () =>
    readContentForParse(filePath, parserKind, options),
  );
  return parseOnRoute(keyed, options);
}

/**
 * Read a file a parse follows — whole, or only its frontmatter block, as the skill lanes parse a
 * `SKILL.md` — held to the route's parse input cap by its size before a byte is read: the cap the
 * route's dispatcher runs under, or the default one. The one read every lane that parses a file
 * makes, so a file past the cap is the same `ParseLimitError` on each, never read and refused
 * later by the length of what was handed over.
 *
 * @param filePath - Absolute path to the document
 * @param parserKind - The parser its content will be handed to
 * @param route - The {@link ParseRoute} the parse will take; `{}` for the default one
 * @returns The content, its key, and the parser it routes to
 * @throws A `ParseLimitError` (`inputBytes`) for a file past the cap, and whatever
 *   `readContentWithKey` throws otherwise
 */
export function readContentForParse<K extends DocumentParserKind>(
  filePath: string,
  parserKind: K,
  route: ParseRoute,
): Promise<KeyedContent<K>> {
  return readContentWithKey(filePath, parserKind, route.dispatcher?.inputBytes ?? resolveParseLimits(undefined).inputBytes);
}

/**
 * Parse a document the caller already holds as a string, consulting the cache —
 * {@link parseFileCached} for content that is on no disk (a frontmatter block, a
 * git blob, a ZIP entry).
 *
 * The key is over the string's UTF-8 bytes (`keyContent`), and `sizeBytes` is
 * their count.
 *
 * @param content - The document
 * @param parserKind - The parser to hand it to
 * @param route - The run's dispatcher, or the cache a one-shot pool files into
 * @returns The parse result, from an entry or from the worker
 * @throws A `ParseLimitError` / `ParseWorkerDiedError` when the worker refuses
 *   the document (nothing filed), and `ParserUnavailableError` for a broken install
 */
export function parseContentCached(
  content: string,
  parserKind: DocumentParserKind,
  route: ParseRoute = {},
): Promise<ParseResult> {
  return parseOnRoute(keyContent(content, parserKind), route);
}

/**
 * The one parse route: the cache, and on a miss the bounded pool.
 *
 * The hit path costs no thread, no clone and no parser load — the pool is not
 * even built until the first miss. On a miss the parse runs in a worker under
 * the pool's limits; there is no other route.
 *
 * A parse stopped at a limit rejects out of here with a `ParseLimitError`
 * BEFORE `cache.set`, so nothing is filed for it (ADR I6) and the next run
 * misses and re-attempts it.
 *
 * The two `parse-timing` calls are not bookkeeping: without them a pooled run's
 * sub-phase dump would report zero cache activity and read as a dead seam.
 *
 * @param keyed - The confirmed read, of a kind that has a parser
 * @param cache - The store to consult and file into
 * @param poolForMiss - The pool, built on the first miss — so a hit builds none
 * @param transport - How a worker's facts come back
 * @returns Parse facts equal to what the parser produces
 */
async function parseKeyedInPool(
  keyed: ParsableContent,
  cache: ParseCache,
  poolForMiss: () => ParsePool,
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
  const pool = poolForMiss();
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

  // The worker answered `stored` only after its `setByKey` returned true, so
  // reaching here means the entry was written and then removed, or written in a
  // form this read refuses — a concurrent `vat cache clear`, the OS purging its
  // temp directory mid-run, or a torn write. Rare, real, and recoverable — in
  // the pool again, under its limits, never on this thread.
  const result = await pool.parse(keyed.parserKind, keyed.content, keyed.byteLength);
  await cache.set(keyed, result);
  return result;
}

/**
 * The smallest widening worth deciding: **two**.
 *
 * Every miss already runs in one worker — the bounded route has no alternative
 * — so the question {@link ParseDispatcher.considerActivation} answers is only
 * whether a SECOND thread pays. Width 1 prepares one blob at a time; overlap
 * begins at two. The one-worker floor's own cost against the retired in-process
 * route is measured in `docs/architecture/fact-extractors-limits.md`.
 */
const MINIMUM_WORKERS = 2;

/**
 * How many workers a remaining workload can pay for.
 *
 * Integer division by {@link PARSE_MS_PER_WORKER}, floored at
 * {@link MINIMUM_WORKERS} in the sense that anything below it answers **0** and
 * the width stays at the one thread every miss already runs in. The cap is the pool's own default,
 * which keeps a 64-core build agent from starting 63 remark instances.
 *
 * @param estimatedSerialMs - Serial parse time the remainder is worth
 * @returns The width to widen to, or 0 for "stay at one thread"
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
 * At width 1 — a run whose corpus never paid for a pool, which is the common
 * case on a small tree — this is inert: only one preparation can be in flight,
 * and it is always the head, so nothing is ever buffered.
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

  /** One round: emit what is ready, claim more, wait for the next settle, repeat. */
  async function pump(): Promise<void> {
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
    if (emitted >= targets.length) return;

    claim();
    // `claim` has just taken the head if nothing else had — both bounds are
    // slack when nothing is outstanding — so something is always in flight here.
    await Promise.race(inFlight.values());
    return pump();
  }

  if (emitted < targets.length) await pump();
}
