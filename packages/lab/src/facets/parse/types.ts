/**
 * The `parse` facet's body — where the time inside vat's document parsing goes,
 * per parser kind.
 *
 * **Why this exists next to `perf` rather than inside it.** `perf` says a
 * command got slower; it cannot say which part of it did. A recent regression
 * hunt cost 24 cold measurement runs of bisecting precisely because sub-phase
 * attribution did not exist — every question of the form "was it the lexer or
 * the AST walk?" had to be answered by deleting code and re-timing the whole
 * command. This facet answers it from one run, because vat itself brackets each
 * pass and writes the timings out.
 *
 * ## Three things a reader has to be able to tell apart
 *
 * A parse report is dangerous in exactly the way an `io` report is: every number
 * it can print is plausible. Four states produce a well-formed body, and only
 * one of them is a measurement — see {@link ParseAttribution}. Conflating them
 * is the failure mode this facet exists to prevent, so the state is a field
 * rather than something a reader is expected to infer from a zero.
 *
 * ## Why the cache mode is not a detail
 *
 * vat's parse cache short-circuits the parse function entirely on a hit, so a
 * warm run charges no passes at all. Sub-phase attribution only exists on cache
 * misses, which is why this facet defaults to `cold` and why a row that parsed
 * nothing says so instead of publishing nine zeroes that read as "free".
 *
 * ## Why the body is grouped by parser kind
 *
 * vat parses more than one kind of document, and the kinds share no passes.
 * Attributing only one of them was a generalisation from one corpus: on a
 * markdown-dominant tree the other kind is a rounding error, and on a tree
 * dominated by the other kind the same instrument attributes almost nothing and
 * still emits a confident, well-formed breakdown. So each kind is its own
 * {@link ParseKindStats}, with its own documents, its own passes, its own total
 * and its own remainder — and the renderer is required to say which kind
 * dominates before it shows any breakdown at all.
 *
 * ## What the numbers are, and are not
 *
 * `elapsedMs` is summed across every process that wrote a dump. A vat command
 * spawns a child per phase, so this is the time spent in that pass across the
 * whole run — **not** wall time, and not comparable to a `perf` median. Its
 * value is the *share*: which pass owns its kind's parse budget, which kind owns
 * the command's, and how much of either nothing owns.
 *
 * Every pass figure is WALL time, which is the right instrument at that
 * granularity — a `process.cpuUsage()` around every pass over 1,400+ documents
 * is ~12,000 syscalls and becomes the cost it set out to measure. The price is
 * that a pass figure silently includes any time the process spent not running.
 * That is what {@link ParseCommandStats.wallMs} and its CPU siblings are for:
 * one reading per process, at exit, so the report can say when the wall figures
 * above it are worth less than they look.
 */

import { z } from 'zod';

import { LoadReadingsSchema, measuredCommandShape } from '../../harness/schemas.js';
import type { CacheMode, LoadReadings } from '../../harness/types.js';

/** Stable name of this facet, as it appears in the envelope header. */
export const PARSE_FACET = 'parse';

/**
 * Version of this body schema.
 *
 * Bumped whenever the shape below changes. Two `parse` reports at different body
 * versions are refused against each other, because differences across a schema
 * change belong to the schema rather than to the subject.
 *
 * 2 — passes and documents grouped per parser kind (each with its own total and
 * remainder), the uncached remainder, and process wall/CPU time.
 */
export const PARSE_FACET_VERSION = 2;

/**
 * What a row's numbers actually describe.
 *
 * Five states, and four of them are ways a body full of zeroes can be produced
 * without anything being wrong with the code being measured. A reader who cannot
 * tell them apart will read "every pass took 0 ms" as "parsing is free", which
 * is the most reassuring possible way to be wrong.
 *
 * - **`measured`** — documents were parsed and the passes describe them.
 * - **`all-cache-hits`** — no document reached the parser because every one was
 *   served from vat's parse cache. There is nothing to attribute, and the run
 *   was probably warm. Not a defect; not a measurement either.
 * - **`uninstrumented-only`** — the cache missed, but no instrumented parser
 *   reported a document. Both of vat's parsers report today, so this now means
 *   either a parser kind the measured build's seam does not instrument, or
 *   parses that threw. It stays a distinct state because folding it into
 *   "nothing was parsed" is exactly how an invisible parser stays invisible.
 * - **`nothing-parsed`** — no documents, no hits, no misses. The command reached
 *   the parse path zero times, which is far more suspicious than a warm cache
 *   and must not be rendered as one: it usually means the command did not do
 *   what the caller thought it did.
 * - **`not-measured`** — the row failed, so there is no reading at all. The
 *   commonest cause is a vat build with no timing seam compiled in, which is
 *   exactly what an A/B against an older baseline will hand you.
 */
export type ParseAttribution =
  | 'measured'
  | 'all-cache-hits'
  | 'uninstrumented-only'
  | 'nothing-parsed'
  | 'not-measured';

/** One pass of the parse pipeline, as the report carries it. */
export interface ParsePassStats {
  /** The seam's own name for this pass — `remark-parse`, `lexical-references`. */
  readonly pass: string;
  /** How many times the pass ran. Zero is a real reading and not the same as absent. */
  readonly calls: number;
  /**
   * Time spent in this pass, summed across every process that dumped.
   *
   * Unrounded on purpose, all the way from the seam: rounding to three decimals
   * can make the attributed passes sum to *more* than the total and break the
   * bracketing invariant inside the file itself. Round at render time or not at
   * all.
   */
  readonly elapsedMs: number;
}

/**
 * One parser kind's numbers within a command.
 *
 * The unit of honest attribution. Passes belong to a kind and to no other, their
 * shares are shares of {@link ParseKindStats.totalMs} and never of the command's
 * total, and the remainder is this kind's own — which is what makes it
 * impossible to state a share of the wrong denominator.
 */
export interface ParseKindStats {
  /** The seam's name for the parser — `markdown`, `html`. Never pinned by this build. */
  readonly kind: string;
  /** Documents this parser ran over. */
  readonly documents: number;
  /** Their total size in bytes. */
  readonly bytes: number;
  /**
   * This kind's attributed passes, in the order the seam emitted them — pipeline
   * order, which is more useful than a sort by cost and stays stable between
   * reports.
   *
   * The bracketing total is deliberately **not** in here; it would double-count
   * every sum taken over this list.
   */
  readonly passes: readonly ParsePassStats[];
  /** Calls to this parser — its bracketing total's call count. */
  readonly totalCalls: number;
  /** Time inside this parser: the denominator of every share in `passes`. */
  readonly totalMs: number;
  /** `totalMs` minus this kind's attributed passes. Signed; see the command's own field. */
  readonly unattributedMs: number;
}

/** The measured result for one command. */
export interface ParseCommandStats {
  /** Stable artifact name, appearing in the report and any diff. */
  readonly name: string;
  /** Arguments as actually run, so the report records what produced the number. */
  readonly args: readonly string[];
  readonly cache: CacheMode;
  /**
   * How many times the command actually ran.
   *
   * **Every repeat counts, and none is discarded.** `io` drops its first repeat
   * as a warm-up because it wants the steady state; this facet must not, because
   * in `warm` mode the first repeat is the *only* one that parses anything and
   * discarding it would leave nothing to attribute.
   */
  readonly runs: number;
  /**
   * Whether every repeat did the same parse work — or `null` when fewer than two
   * repeats ran and nothing could have disagreed.
   *
   * Compares the deterministic half of the observable only: document counts,
   * bytes, the cache split and each pass's call count. `elapsedMs` is excluded
   * because it always varies, and a flag that folded it in would be permanently
   * `false` and therefore useless.
   *
   * **`null` is not `true`.** Below two repeats determinism was never tested, and
   * a boolean would assert a property no one measured.
   */
  readonly stable: boolean | null;
  /** See {@link ParseAttribution}. Read this before reading anything below it. */
  readonly attribution: ParseAttribution;
  /**
   * How many distinct PIDs wrote a dump for the reported repeat.
   *
   * A vat command spawns a child per phase, so more than one is normal and is
   * why `elapsedMs` is a sum rather than a duration.
   */
  readonly processes: number;
  /**
   * Per parser kind: what it parsed, what it cost, and how it broke down.
   *
   * The unit a reader must read FIRST when the corpus is mixed. Every aggregate
   * below is a sum across these, and a sum across kinds describes the shape of
   * no single parser — on a tree dominated by one kind, the other kind's
   * breakdown describes a few per cent of the cost and must never be presented
   * as the shape of the whole.
   */
  readonly kinds: readonly ParseKindStats[];
  /** Documents that reached a parser, across every kind. */
  readonly documents: number;
  /** Their total size in bytes, so `ms/byte` is available as well as `ms/document`. */
  readonly bytes: number;
  /**
   * Parse-cache hits, across **every parser kind**.
   *
   * Deliberately not comparable to {@link ParseCommandStats.documents}:
   * `documents === cacheMisses` is **not** an invariant and nothing here derives
   * one from the other. Every parser kind is counted now, so the two populations
   * are at least about the same thing — but several call sites reach a parser
   * without consulting the cache at all, which is published as
   * {@link ParseCommandStats.uncachedParses} rather than left to arithmetic.
   */
  readonly cacheHits: number;
  /** Parse-cache misses, across every parser kind. See {@link ParseCommandStats.cacheHits}. */
  readonly cacheMisses: number;
  /**
   * Parses that never consulted the cache: `documents - cacheMisses`.
   *
   * **A remainder of measured counters, not a counter of its own** — the reason
   * the parse counts and the cache counts differ, and one no counter can name,
   * because the call sites that skip the cache never touch it. Signed and never
   * clamped: negative means more misses were counted than parses completed,
   * which is a parse that threw, and a reader has to see it.
   */
  readonly uncachedParses: number;
  /** Calls to a parser, across every kind — the sum of the per-kind totals' calls. */
  readonly totalCalls: number;
  /**
   * Time inside a parser, across every kind — the whole parse budget.
   *
   * The denominator for "which KIND owns this tree's parse cost". It is **not**
   * the denominator for a pass's share: a pass belongs to one kind and is a
   * share of that kind's own total, which is why each {@link ParseKindStats}
   * carries its own.
   *
   * **This is also the scalar the `ab` verb compares**, and the sum is chosen
   * deliberately. `ab` reduces a capture to one number per command; a number
   * that meant one kind's total would be blind in exactly the way the per-kind
   * grouping exists to fix — an arm that moved work between parsers, or that
   * changed the dominant kind on a corpus made of the other one, would read as
   * unchanged. The sum moves whenever any parse work does, and its unit says
   * "all kinds" so nobody reads it as one parser's.
   */
  readonly totalMs: number;
  /**
   * Every kind's unattributed remainder, summed.
   *
   * **The number that says whether the attribution is complete.** A facet that
   * only listed the passes it knew about would make an incomplete instrument
   * look like a finished explanation; this is what stops that. A small negative
   * here is float noise from summing unrounded values; a large one means the
   * bracketing is broken and the report says so rather than clamping it away.
   */
  readonly unattributedMs: number;
  /**
   * Every repeat's `totalMs`, in capture order.
   *
   * The spread that qualifies the reported figures. Everything else on this row
   * comes from ONE repeat — the one whose total is the median — so that the
   * shares are internally consistent and each number describes a run that
   * actually happened. Averaging the passes across repeats would produce a
   * breakdown no single run ever exhibited.
   */
  readonly totalMsSamples: readonly number[];
  /**
   * Process lifetime wall clock, summed across every process that dumped.
   *
   * **Not a parse duration and not comparable to `totalMs`** — it covers each
   * process from start to exit, most of which is not parsing. It exists as the
   * denominator for the CPU readings below: the passes are wall-timed, so
   * `cpuUserMs + cpuSystemMs` well under this is what tells a reader the process
   * spent its life waiting and the per-pass figures carry that waiting inside
   * them.
   */
  readonly wallMs: number;
  /** User CPU across every process that dumped. See {@link ParseCommandStats.wallMs}. */
  readonly cpuUserMs: number;
  /** System CPU across every process that dumped. See {@link ParseCommandStats.wallMs}. */
  readonly cpuSystemMs: number;
  /**
   * True when this command produced no usable measurement — a failed repeat, or
   * a repeat whose dumps could not be read.
   *
   * A failed command keeps its row so the report says what happened, but a
   * comparator must not read a delta from it.
   */
  readonly failed: boolean;
  /** Why it failed, when it did. */
  readonly failure: string | null;
}

/** The `parse` facet's report body. */
export interface ParseBody {
  readonly commands: readonly ParseCommandStats[];
  /**
   * Machine load around the capture.
   *
   * Carried for the same reason `io` carries it: these are durations, so a
   * contaminated machine moves them, and a reader has to see that without
   * digging.
   */
  readonly load: LoadReadings;
}

/** The schema fields describing one pass, shared with the dump reader. */
export const parsePassShape = {
  pass: z.string().min(1),
  calls: z.number().int().nonnegative(),
  // No `.int()`, no precision bound: the seam emits raw `performance.now()`
  // deltas, and a schema that rounded or rejected them would break the very
  // bracketing invariant `unattributedMs` is computed from.
  elapsedMs: z.number().nonnegative(),
} as const;

/**
 * Runtime schema for {@link ParseBody}.
 *
 * Strict, not passthrough: this validates data *we* wrote. An unrecognised field
 * means a producer this build does not model, and reading it as a `parse` body
 * would be a guess.
 */
export const ParseBodySchema = z
  .object({
    commands: z.array(
      z
        .object({
          ...measuredCommandShape,
          stable: z.boolean().nullable(),
          attribution: z.enum([
            'measured',
            'all-cache-hits',
            'uninstrumented-only',
            'nothing-parsed',
            'not-measured',
          ]),
          processes: z.number().int().nonnegative(),
          kinds: z.array(
            z
              .object({
                kind: z.string().min(1),
                documents: z.number().int().nonnegative(),
                bytes: z.number().int().nonnegative(),
                passes: z.array(z.object(parsePassShape).strict()),
                totalCalls: z.number().int().nonnegative(),
                totalMs: z.number().nonnegative(),
                unattributedMs: z.number(),
              })
              .strict(),
          ),
          documents: z.number().int().nonnegative(),
          bytes: z.number().int().nonnegative(),
          cacheHits: z.number().int().nonnegative(),
          cacheMisses: z.number().int().nonnegative(),
          // Signed, like `unattributedMs` and for the same reason: a remainder
          // that comes out negative is a finding, not a value to clamp.
          uncachedParses: z.number().int(),
          totalCalls: z.number().int().nonnegative(),
          totalMs: z.number().nonnegative(),
          // Signed: a negative remainder is float noise at worst and a broken
          // bracketing at worst-worst, and both have to survive into the report.
          unattributedMs: z.number(),
          totalMsSamples: z.array(z.number().nonnegative()),
          wallMs: z.number().nonnegative(),
          cpuUserMs: z.number().nonnegative(),
          cpuSystemMs: z.number().nonnegative(),
        })
        .strict(),
    ),
    load: LoadReadingsSchema,
  })
  .strict();
