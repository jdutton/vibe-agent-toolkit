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

/** Stable name of this facet, as it appears in the envelope header. */
export const PERF_FACET = 'perf';

/**
 * Version of this body schema.
 *
 * Bumped whenever the shape below changes. Two `perf` reports at different body
 * versions are refused against each other, because differences across a schema
 * change belong to the schema rather than to the subject.
 */
export const PERF_FACET_VERSION = 1;

/** Whether vat's caches were left in place or cleared before each repeat. */
export type CacheMode = 'warm' | 'cold';

/** What one vat command was asked to do. */
export interface PerfCommandSpec {
  /** Stable artifact name, appearing in the report and any diff. */
  readonly name: string;
  /** Arguments after the vat binary, with `{subject}` substituted at capture time. */
  readonly args: readonly string[];
}

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
   * The exit code every repeat produced.
   *
   * `null` when the repeats *disagreed*, which invalidates the measurement: a
   * set of samples where some runs succeeded and some failed is not timing one
   * behaviour. {@link PerfCommandStats.failed} records that case.
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

/**
 * Machine-load readings taken around the capture.
 *
 * **`null` means no reading, and that is not the same as zero.** Windows'
 * `os.loadavg()` returns `[0, 0, 0]` unconditionally — "no data" wearing the
 * costume of a perfectly idle machine. Encoding that as `0` would make every
 * Windows run look pristine, so the numbers are nullable and
 * {@link LoadReadings.available} is the explicit tell.
 */
export interface LoadReadings {
  /** One-minute load average before the first repeat, or `null` if unmeasurable. */
  readonly before: number | null;
  /** One-minute load average after the last repeat, or `null` if unmeasurable. */
  readonly after: number | null;
  /** Logical CPU count, so the readings can be judged proportionally. */
  readonly cpus: number;
  /**
   * Whether load could be measured on this platform at all.
   *
   * A reader must be able to tell "measured, and the machine was quiet" from
   * "never measured" — they support completely different conclusions about how
   * much to trust the timings.
   */
  readonly available: boolean;
  /**
   * True when the machine was busy enough that these timings are contaminated.
   *
   * Recorded rather than enforced: the capture still writes the report, and the
   * reader decides. A number that silently disappeared teaches less than one
   * labelled untrustworthy.
   *
   * **Absence never launders a busy reading.** If one of the two readings is
   * missing but the other says busy, this stays `true` — letting a lost second
   * reading erase a contamination the first one actually saw would be the one
   * direction of error that matters here.
   */
  readonly contaminated: boolean;
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
          name: z.string().min(1),
          args: z.array(z.string()),
          cache: z.union([z.literal('warm'), z.literal('cold')]),
          runs: z.number().int().nonnegative(),
          medianMs: z.number().nonnegative(),
          minMs: z.number().nonnegative(),
          maxMs: z.number().nonnegative(),
          iqrMs: z.number().nonnegative(),
          samplesMs: z.array(z.number().nonnegative()),
          exitCode: z.number().int().nullable(),
          failed: z.boolean(),
          failure: z.string().nullable(),
        })
        .strict(),
    ),
    load: z
      .object({
        before: z.number().nullable(),
        after: z.number().nullable(),
        cpus: z.number().int().positive(),
        available: z.boolean(),
        contaminated: z.boolean(),
      })
      .strict(),
  })
  .strict();
