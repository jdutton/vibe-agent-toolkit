/**
 * The `perf` facet's body — repeatable wall-clock measurement.
 *
 * vat already captures `wallMs` per command internally and then deliberately
 * zeroes it, because a correctness oracle must not flap on timing. This facet is
 * the other half of that decision: a separate report where timing is the point,
 * so the correctness artifacts can stay byte-exact.
 *
 * **A single sample is not a measurement.** Every number here is a statistic
 * over repeats, and the spread travels with it — a median without a spread
 * invites reading noise as a regression, which is exactly how a performance
 * gate loses its credibility.
 */

import { z } from 'zod';

import { LoadReadingsSchema, measuredCommandShape } from '../../harness/schemas.js';
import type { CacheMode, LoadReadings } from '../../harness/types.js';

/** Stable name of this facet, as it appears in the envelope header. */
export const PERF_FACET = 'perf';

/**
 * ⚠️ **This facet is where a MEANING-only change actually bit, so read this
 * before editing {@link PerfCommandStats.exitCode}.**
 *
 * A successful row once always published `0`; it now publishes the accepted code
 * the repeats actually produced, so an old row saying `0` and a new one saying
 * `0` are not the same claim — the old one could not have said `1`. The shape
 * did not move, so no schema and no derived digest can see it, and the integer
 * that used to sit here could not see it either: it had to be *told*, by a human
 * who remembered.
 *
 * Every report that predates this note is already refused, because the envelope
 * around it lost two fields and is strict. For the NEXT such change the remedies
 * are, in order: make the build **declare** the thing that moved so a reader
 * diffs capabilities (as `CrawlTimingDump.charges` does), or **invalidate
 * explicitly** — delete the stored reports. ⛔ Not a version integer; see
 * `envelope/envelope.ts`'s header for why one is prohibited here.
 */

/** The statistics every figure in a row carries: median with its spread, over the repeats. */
export interface PerfStats {
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly iqrMs: number;
}

/**
 * One vat process's record, exactly as `perf-probe.cts` writes it.
 *
 * Times are epoch milliseconds read from one clock, so two processes' records
 * order against each other. CPU is `process.resourceUsage()`, in microseconds,
 * read at exit.
 */
export const PerfProcessDumpSchema = z
  .object({
    pid: z.number().int(),
    ppid: z.number().int(),
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
    userCpuUs: z.number().nonnegative(),
    systemCpuUs: z.number().nonnegative(),
    /** Every `Surface:` banner this process wrote to stderr, in order; empty for a process that wrote none. */
    banners: z.array(z.object({ name: z.string().min(1), atMs: z.number().nonnegative() }).strict()),
  })
  .strict();

/** One vat process's record. */
export type PerfProcessDump = z.infer<typeof PerfProcessDumpSchema>;

/**
 * The first condition that kept `vat validate` from overlapping its checks child, as
 * the build names it. Only present on a build that writes a debug-facts dump.
 *
 * Mirrors the cli's `GateDecline` exactly (`packages/cli/src/commands/checks-overlap-gate.ts`):
 * a `member` decline carries the member and the route that sends it cold, a `rejected` one the
 * error it failed with, and every other condition nothing else.
 */
export const GateDeclinedBySchema = z.discriminatedUnion('condition', [
  z.object({ condition: z.enum(['debug', 'cores', 'not-hit', 'limits', 'disarmed', 'not-settled']) }).strict(),
  /** What a `rejected` judgment failed with, as the build words it. */
  z.object({ condition: z.literal('rejected'), error: z.string() }).strict(),
  z.object({ condition: z.literal('member'), member: z.string(), route: z.enum(['storedRoute', 'readRoute']) }).strict(),
]);

/** The condition that declined the overlap. */
export type GateDeclinedBy = z.infer<typeof GateDeclinedBySchema>;

/**
 * What `vat validate` says about itself when `VAT_VALIDATE_DEBUG_FACTS` names a
 * directory: a mode and post-spawn facts, not work counters. A build that does
 * not write it (main, before the overlap) leaves the directory empty, and the
 * row then says the mode is unknown.
 *
 * The writer is the cli's `ValidateDebugFacts` (`packages/cli/src/commands/validate-debug-facts.ts`).
 * Neither package depends on the other; `test/system/validate-debug-facts.system.test.ts` runs the
 * built vat and parses its dumps with this schema, so the two change together or that test fails.
 */
export const ValidateDebugFactsSchema = z
  .object({
    checksOverlapped: z.union([z.literal(0), z.literal(1)]),
    gateDeclinedBy: GateDeclinedBySchema.nullable(),
    childStderrBytesAtTurn: z.number().int().nonnegative(),
    parentStoreWritesUntilChildExit: z.number().int().nonnegative(),
    parentParseCacheWritesUntilChildExit: z.number().int().nonnegative(),
  })
  .strict();

/** What a validate run says about its own mode. */
export type ValidateDebugFacts = z.infer<typeof ValidateDebugFactsSchema>;

/** The measured result for one command. */
export interface PerfCommandStats {
  readonly name: string;
  /** Arguments as actually run, so the report records what produced the number. */
  readonly args: readonly string[];
  readonly cache: CacheMode;
  /** How many repeats contributed to the statistics below. */
  readonly runs: number;
  /** Middle value of the samples. Median, not mean — one slow outlier must not move it. */
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  /**
   * Interquartile range: the spread that travels with the median.
   *
   * A comparator uses this to decide whether a difference is real. Reporting a
   * median without it produces confident-looking deltas that are noise.
   */
  readonly iqrMs: number;
  /** Every sample, so a reader can check the statistics rather than trust them. */
  readonly samplesMs: readonly number[];
  /**
   * The one accepted code every repeat exited with, and `null` when the row
   * failed.
   *
   * **On a successful row this is the observed code, not a constant.** A gate
   * completes with `1` on a subject with findings — a vat validator exits `1`
   * when it has findings and `0` when it has none, and both ran the whole
   * corpus (see `MeasuredCommandSpec.exit`). Two rows
   * with identical medians where one exited `0` and one exited `1` are not the
   * same measurement, and a reader who cannot tell them apart cannot tell a
   * clean project from one whose findings the run had to render. It is always a
   * single code: repeats that did not all exit alike, or exited outside the
   * command's commitment, are a failed row.
   *
   * **On a failed row it stays `null`**, and that reasoning is unchanged.
   * Deliberately not "the code the failing repeat produced": once any repeat
   * fails, this row is not timing one behaviour, and the *interesting* thing is
   * no longer a number — it is which repeats failed and why, which
   * {@link PerfCommandStats.failure} says in words. Publishing one repeat's exit
   * code here would invite a reader to treat it as the row's outcome when the
   * other repeats may have exited differently. So `null` covers both mixed
   * results and a uniform failure: two repeats that both exited 3 still report
   * `null`, because a row whose statistics are empty has no exit code to speak
   * of. {@link PerfCommandStats.failed} is the flag to branch on; this field is
   * never the tell.
   */
  readonly exitCode: number | null;
  /**
   * True when this command did not produce a usable measurement — a non-zero
   * exit, a spawn failure, or repeats that disagreed.
   *
   * Timing a crash measures how fast vat fails. A failed command keeps its row
   * so the report says what happened, but a comparator must not read a delta
   * from it.
   */
  readonly failed: boolean;
  /** Why it failed, when it did. */
  readonly failure: string | null;
  /**
   * Wall per `Surface:` banner: banner to the next banner, the last to the
   * bannering process's exit. A repeat's surfaces are sequential in one process,
   * so these never overlap and may be read against the total. Empty when the
   * command wrote no banners (and on a failed row). A surface named twice in
   * one run is keyed `name`, then `name#2`.
   */
  readonly surfaces: Readonly<Record<string, PerfStats>>;
  /**
   * Total CPU per repeat: user plus system, summed over every vat process's
   * record, one record per process. Wall is never summed. `null` when no vat
   * process wrote a record (a command whose main script no vat package owns)
   * and on a failed row: unknown is not zero.
   */
  readonly cpuMs: PerfStats | null;
  /**
   * Each repeat's vat process records (pid, parent, start, end, CPU), in repeat
   * order, so a reader can see lifetimes overlap. Empty when `cpuMs` is `null`.
   */
  readonly processes: readonly (readonly PerfProcessDump[])[];
  /**
   * Whether `vat validate` overlapped its checks child, as the build's own
   * debug-facts dump says, and `null` when no repeat wrote one: a build that
   * predates the dump says nothing, which is not "did not overlap". Repeats that
   * disagree make the row failed.
   */
  readonly checksOverlapped: 0 | 1 | null;
  /** Why the overlap was declined, when `checksOverlapped` is 0 and the build says; else `null`. */
  readonly gateDeclinedBy: GateDeclinedBy | null;
}

/** The `perf` facet's report body. */
export interface PerfBody {
  readonly commands: readonly PerfCommandStats[];
  readonly load: LoadReadings;
}

const PerfStatsSchema = z
  .object({
    medianMs: z.number().nonnegative(),
    minMs: z.number().nonnegative(),
    maxMs: z.number().nonnegative(),
    iqrMs: z.number().nonnegative(),
  })
  .strict();

/**
 * Runtime schema for {@link PerfBody}.
 *
 * The envelope reader deliberately does not validate bodies — it does not know
 * their shapes. Each facet validates its own after confirming the header names
 * it, which is why this lives here rather than beside the envelope.
 *
 * Strict, not passthrough: this validates data *we* wrote. An unrecognised
 * field means a producer this build does not model, and reading it as a `perf`
 * body would be a guess.
 */
export const PerfBodySchema = z
  .object({
    commands: z.array(
      z
        .object({
          ...measuredCommandShape,
          medianMs: z.number().nonnegative(),
          minMs: z.number().nonnegative(),
          maxMs: z.number().nonnegative(),
          iqrMs: z.number().nonnegative(),
          samplesMs: z.array(z.number().nonnegative()),
          exitCode: z.number().int().nullable(),
          surfaces: z.record(z.string(), PerfStatsSchema),
          cpuMs: PerfStatsSchema.nullable(),
          processes: z.array(z.array(PerfProcessDumpSchema)),
          checksOverlapped: z.union([z.literal(0), z.literal(1)]).nullable(),
          gateDeclinedBy: GateDeclinedBySchema.nullable(),
        })
        .strict(),
    ),
    load: LoadReadingsSchema,
  })
  .strict();
