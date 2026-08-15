/**
 * The `crawl` facet's body — where the time spent FINDING documents goes, per
 * contributor, stratum and fixpoint pass.
 *
 * ## Why this is its own facet and not more rows on `parse`
 *
 * `parse` attributes time inside a parser. Its axis is a closed enum of passes
 * belonging to a parser kind, and its whole body is built around that: documents,
 * bytes, a cache hit/miss split, a per-kind bracketing total, a `cold` default
 * because vat's parse cache short-circuits the parse function on a hit.
 *
 * None of that is true here. This facet's axis is `(contributorId, stratum,
 * pass)` and it is **open** — a corpus declares its own extents, so the ids come
 * out of config and are discovered at capture time. A crawl has no "documents
 * parsed", no cache split, and no closed pass list to emit at zero. Folding it
 * into `ParseBody` would mean a body where a `crawl` row carries permanently-null
 * documents and a `parse` row carries permanently-empty entries — precisely the
 * "costume with four permanently-zero rows in it" that vat's own parse seam
 * refused when it declined to force markdown and HTML into one pass list. It
 * would also have had to bump `PARSE_FACET_VERSION`, which refuses every parse
 * report captured to date against every one captured after.
 *
 * ## What the numbers are for
 *
 * VAT has two crawlers live at once — the incumbent `walkLinkGraph` and the
 * projection's `ClosureExtentContributor` — and the decision to flip a verb from
 * one to the other has never had a measurement under it, because neither
 * crawler's own work was attributed anywhere. Both now record through one seam,
 * on one clock, into one dump, which is what makes {@link CrawlCommandStats.strata}
 * a legitimate side-by-side: `crawl` is the incumbent walker's work, `closure` is
 * the projection's.
 *
 * ## Not every row is additive with every other, and this facet used to add them
 *
 * Some brackets are placed INSIDE others. The link walker's gitignore oracle is
 * charged from within the walk it belongs to; a closure contributor's own
 * `contribute` bracket sits inside the driver's bracket for that same
 * invocation, and its per-reference resolution sits inside `contribute`. Those
 * rows are a BREAKDOWN of time already charged, not more of it.
 *
 * This facet shipped summing a stratum's rows regardless, which inflated both
 * arms of the very comparison it exists to render — and inflated them by
 * different factors, since the two arms nest to different depths. The numbers
 * were individually true and the side-by-side was wrong, which is the shape of
 * finding nobody catches by reading output.
 *
 * So every row now carries a {@link CrawlRowRole}, {@link CrawlStratumStats}
 * totals only the additive ones, and the nested time is published beside them
 * rather than dropped: an absent number is indistinguishable from code that
 * never ran. A row this build cannot place goes to `unclassified` and is counted
 * in neither, because guessing its nesting is how a silently wrong total gets
 * built a second time. {@link crawlRowRole} states the rule.
 *
 * ## What is deliberately NOT summed
 *
 * {@link CrawlCommandStats.processes} is a LIST, one entry per dump, and this
 * facet publishes no total wall time anywhere. The `parse` facet sums
 * `process.wallMs` across dumps and that is a known, unfixed defect: under a
 * multi-process verb the parent orchestrator is alive for the whole run, so its
 * lifetime contains every child's and the sum double-counts real time while CPU
 * adds correctly — deflating the trust ratio a reader relies on. Nothing in a
 * dump says which pid is the parent, so there is no correct denominator to
 * publish; publishing the per-process lifetimes and letting the renderer show
 * the longest is the honest shape, and it makes the wrong total unconstructible
 * rather than merely undocumented.
 *
 * For the same reason the list has one entry per DUMP rather than per distinct
 * pid: pids are reused across a long multi-phase run, which is why vat's seam
 * carries a collision counter in the dump filename at all, and counting distinct
 * pids reports two real processes as one.
 */

import { z } from 'zod';

import { LoadReadingsSchema, measuredCommandShape } from '../../harness/schemas.js';
import type { CacheMode, LoadReadings } from '../../harness/types.js';

/** Stable name of this facet, as it appears in the envelope header. */
export const CRAWL_FACET = 'crawl';

/**
 * Version of this body schema.
 *
 * Bumped whenever the shape below changes. Two `crawl` reports at different body
 * versions are refused against each other, because differences across a schema
 * change belong to the schema rather than to the subject.
 *
 * 1 — first version.
 * 2 — rows carry a {@link CrawlRowRole}, and {@link CrawlStratumStats} and the
 *     command totals count only the additive ones. A v1 report's `elapsedMs`
 *     summed nested brackets into the same figure, so holding one against a v2
 *     report reads the correction as a speed-up in whichever arm nests deepest.
 */
export const CRAWL_FACET_VERSION = 2;

/**
 * What a row's numbers actually describe.
 *
 * - **`measured`** — at least one bracket was charged, and the entries describe it.
 * - **`nothing-crawled`** — vat's seam wrote a dump and it had no rows in it. The
 *   command never reached a contributor or a link walk. Distinct from a failure
 *   because the instrument worked perfectly; it is a fact about the command, and
 *   very often it means the command did not do what the caller assumed.
 * - **`not-measured`** — the row failed, so there is no reading. The commonest
 *   cause is a vat build with no crawl seam compiled in, which is exactly what an
 *   A/B against an older baseline hands you.
 *
 * Three states rather than `parse`'s five: there is no cache to short-circuit
 * this work, so `all-cache-hits` and `uninstrumented-only` have no analogue.
 */
export type CrawlAttribution = 'measured' | 'nothing-crawled' | 'not-measured';

/**
 * Whether a row's time adds to its stratum's total, or is already inside it.
 *
 * - **`additive`** — a top-level span. Nothing else in the dump brackets this
 *   work, so it adds.
 * - **`nested`** — charged from inside a bracket that is itself charged. Real
 *   time, already counted once by the row containing it; adding it again
 *   double-counts. Published so the breakdown stays visible.
 * - **`unclassified`** — this build cannot say which of the two it is. Counted
 *   in NEITHER total, and said out loud, because the alternative is a total
 *   whose meaning depends on a guess. The realistic cause is a vat that grew a
 *   bracket this lab has never heard of.
 *
 * See {@link crawlRowRole} for how a row is placed.
 */
export type CrawlRowRole = 'additive' | 'nested' | 'unclassified';

/** One `(contributorId, stratum, pass)` row exactly as the seam dumped it. */
export interface CrawlSeamRow {
  /** A contributor's id, or one of the seam's synthetic crawler ids. */
  readonly contributorId: string;
  /**
   * Which layer the work belongs to — `base`, `closure`, `crawl`.
   *
   * A string and **not pinned** to the three this build knows: a vat that grows a
   * fourth stratum must not make every dump unreadable. What is pinned is that
   * rows carry one.
   */
  readonly stratum: string;
  /**
   * The fixpoint pass, or `0` for a bracket placed inside the measured work.
   *
   * The merge driver numbers its passes from 1 and is the only participant that
   * knows which one is running; a contributor's own body and a link walk do not,
   * so their rows aggregate across passes and say so by carrying `0`.
   */
  readonly pass: number;
  /** How many invocations were charged here. */
  readonly calls: number;
  /**
   * Their summed wall time, in milliseconds, across every process that dumped.
   *
   * Unrounded on purpose, all the way from the seam — see `parse`'s twin field.
   * **Not** wall time for the command: a vat command spawns a child per phase and
   * their milliseconds add.
   */
  readonly elapsedMs: number;
}

/** One `(contributorId, stratum, pass)` row, as the report carries it. */
export interface CrawlEntryStats extends CrawlSeamRow {
  /**
   * Whether this row adds to its stratum's total or is already inside it.
   *
   * Derived by the reader, not dumped by the seam: nesting is a fact about how
   * the brackets are placed in the vat under measurement, and the seam would
   * have to carry it on every row of every dump for a reader that can work it
   * out from `(stratum, pass, contributorId)`.
   */
  readonly role: CrawlRowRole;
}

/** A `(calls, elapsedMs)` pair for one class of row. */
export interface CrawlRoleTotals {
  readonly calls: number;
  readonly elapsedMs: number;
}

/**
 * One stratum's rollup.
 *
 * **The unit the two crawlers are compared in.** A reader asking "which crawler
 * costs more?" is asking for `crawl` against `closure`, and deriving it from the
 * entries requires knowing which synthetic ids belong to which crawler — a
 * mapping the report would rather state once than expect every reader to
 * reconstruct.
 *
 * `calls` and `elapsedMs` count the **additive** rows only, because those are
 * the numbers the side-by-side is taken over. The other two classes are beside
 * them rather than folded in or dropped — see {@link CrawlRowRole}.
 */
export interface CrawlStratumStats {
  readonly stratum: string;
  /** Additive invocations. See {@link CrawlRowRole}. */
  readonly calls: number;
  /** Their summed wall time — **this stratum's cost**, with no row counted twice. */
  readonly elapsedMs: number;
  /**
   * Rows charged from inside an additive one.
   *
   * A breakdown of the time above, never an addition to it. Present so that
   * "the walk spent 14 of its 30 ms in the gitignore oracle" stays answerable.
   */
  readonly nested: CrawlRoleTotals;
  /**
   * Rows this build could not place.
   *
   * In neither total. Non-zero here means the numbers above are an
   * UNDER-count by an unknown amount, and the renderer says so.
   */
  readonly unclassified: CrawlRoleTotals;
}

/**
 * One process's lifetime, exactly as it dumped.
 *
 * Never summed with another's — see this module's header.
 */
export interface CrawlProcessStats {
  readonly pid: number;
  /** Wall clock from process start to exit. Not a crawl duration. */
  readonly wallMs: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
}

/** The measured result for one command. */
export interface CrawlCommandStats {
  /** Stable artifact name, appearing in the report and any diff. */
  readonly name: string;
  /** Arguments as actually run, so the report records what produced the number. */
  readonly args: readonly string[];
  readonly cache: CacheMode;
  /** How many times the command actually ran. No repeat is discarded. */
  readonly runs: number;
  /**
   * Whether every repeat charged the same rows the same number of times — or
   * `null` when fewer than two repeats ran and nothing could have disagreed.
   *
   * Compares the deterministic half only: the row set and each row's call count.
   * `elapsedMs` is excluded because it always varies, and the process lifetimes
   * are excluded for the same reason.
   *
   * **`null` is not `true`.**
   */
  readonly stable: boolean | null;
  /** See {@link CrawlAttribution}. Read this before reading anything below it. */
  readonly attribution: CrawlAttribution;
  /** Every row, in the order the seam emitted them: stratum, then id, then pass. */
  readonly entries: readonly CrawlEntryStats[];
  /** Per-stratum rollups, in first-appearance order. See {@link CrawlStratumStats}. */
  readonly strata: readonly CrawlStratumStats[];
  /** Additive invocations, across every stratum. See {@link CrawlRowRole}. */
  readonly totalCalls: number;
  /**
   * Time inside a crawler, across every stratum — the whole crawl budget.
   *
   * Additive rows only, so no bracket is counted twice and the strata above sum
   * to exactly this. Nested and unclassified time is per stratum, on
   * {@link CrawlStratumStats}, and deliberately has no command-level total: a
   * reader who wants one is asking for a number that is not a duration of
   * anything.
   */
  readonly totalMs: number;
  /**
   * Every repeat's `totalMs`, in capture order.
   *
   * Everything else on this row comes from ONE repeat — the one whose total is
   * the median — so the rows are internally consistent and each number describes
   * a run that actually happened.
   */
  readonly totalMsSamples: readonly number[];
  /**
   * One entry per dump the reported repeat produced. Never reduced to a total.
   *
   * See this module's header: there is no honest sum of process lifetimes, so
   * this facet publishes none.
   */
  readonly processes: readonly CrawlProcessStats[];
  /**
   * True when this command produced no usable measurement.
   *
   * A failed command keeps its row so the report says what happened, but a
   * comparator must not read a delta from it.
   */
  readonly failed: boolean;
  /** Why it failed, when it did. */
  readonly failure: string | null;
}

/** The `crawl` facet's report body. */
export interface CrawlBody {
  readonly commands: readonly CrawlCommandStats[];
  /** Machine load around the capture. These are durations, so it matters. */
  readonly load: LoadReadings;
}

/** The schema fields describing one row as the seam dumped it. */
export const crawlSeamRowShape = {
  contributorId: z.string().min(1),
  stratum: z.string().min(1),
  pass: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  // No `.int()`, no precision bound: the seam emits raw `performance.now()`
  // deltas and a schema that rounded them would move the numbers it validates.
  elapsedMs: z.number().nonnegative(),
} as const;

/** Every {@link CrawlRowRole}, as the schemas and the renderer need them. */
export const CRAWL_ROW_ROLES = ['additive', 'nested', 'unclassified'] as const;

/**
 * The schema fields describing one entry as the REPORT carries it.
 *
 * The seam's row plus the role the reader placed it in. Deliberately not the
 * same shape as {@link crawlSeamRowShape}: a dump that carried a role would be
 * asserting a fact about bracket nesting that only the reader knows, and both
 * schemas are strict, so the two cannot quietly become each other.
 */
export const crawlEntryShape = {
  ...crawlSeamRowShape,
  role: z.enum(CRAWL_ROW_ROLES),
} as const;

/** The schema fields describing one class of row's totals. */
const crawlRoleTotalsShape = z
  .object({
    calls: z.number().int().nonnegative(),
    elapsedMs: z.number().nonnegative(),
  })
  .strict();

/** The schema fields describing one process's lifetime, shared with the dump reader. */
export const crawlProcessShape = {
  pid: z.number().int().nonnegative(),
  wallMs: z.number().nonnegative(),
  cpuUserMs: z.number().nonnegative(),
  cpuSystemMs: z.number().nonnegative(),
} as const;

/**
 * Runtime schema for {@link CrawlBody}.
 *
 * Strict, not passthrough: this validates data *we* wrote. An unrecognised field
 * means a producer this build does not model.
 */
export const CrawlBodySchema = z
  .object({
    commands: z.array(
      z
        .object({
          ...measuredCommandShape,
          stable: z.boolean().nullable(),
          attribution: z.enum(['measured', 'nothing-crawled', 'not-measured']),
          entries: z.array(z.object(crawlEntryShape).strict()),
          strata: z.array(
            z
              .object({
                stratum: z.string().min(1),
                calls: z.number().int().nonnegative(),
                elapsedMs: z.number().nonnegative(),
                nested: crawlRoleTotalsShape,
                unclassified: crawlRoleTotalsShape,
              })
              .strict(),
          ),
          totalCalls: z.number().int().nonnegative(),
          totalMs: z.number().nonnegative(),
          totalMsSamples: z.array(z.number().nonnegative()),
          processes: z.array(z.object(crawlProcessShape).strict()),
        })
        .strict(),
    ),
    load: LoadReadingsSchema,
  })
  .strict();
