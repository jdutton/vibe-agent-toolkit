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
 * Version of this body schema.
 *
 * Bumped whenever the shape below changes. Two `perf` reports at different body
 * versions are refused against each other, because differences across a schema
 * change belong to the schema rather than to the subject.
 *
 * **2 — `exitCode` changed meaning.** In v1 a successful row always published
 * `0`; it now publishes the accepted code the repeats actually produced, so a
 * v1 row saying `0` and a v2 row saying `0` are not the same claim (the v1 one
 * could not have said `1`). The refusal above is the point of the bump: a v1
 * baseline held beside a v2 candidate must not be compared silently.
 */
export const PERF_FACET_VERSION = 2;

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
   * **On a successful row this is the observed code, not a constant.** A command
   * may declare that more than one code means "finished its work" — a vat
   * validator exits `1` when it has findings and `0` when it has none, and both
   * ran the whole corpus (see `MeasuredCommandSpec.completedExitCodes`). Two rows
   * with identical medians where one exited `0` and one exited `1` are not the
   * same measurement, and a reader who cannot tell them apart cannot tell a
   * clean project from one whose findings the run had to render. It is always a
   * single code: repeats that disagreed are a failed row, per rule 2 of
   * `summarizeRepeatFailures`.
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
}

/** The `perf` facet's report body. */
export interface PerfBody {
  readonly commands: readonly PerfCommandStats[];
  readonly load: LoadReadings;
}

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
        })
        .strict(),
    ),
    load: LoadReadingsSchema,
  })
  .strict();
