/**
 * The `memory` facet's body — peak resident memory per command.
 *
 * Exists because the lab could not see a regression that took `vat build` on one
 * adopter from ~1.0 GB to ~5.4 GB peak RSS and out of heap: `perf` saw only that
 * it was slower, which it also was for other reasons, and nothing measured the
 * memory itself.
 *
 * **One sample per repeat, and it is the LARGEST vat process's peak.** Each of
 * vat's own node processes in the repeat writes its own peak resident set (see
 * `rss-probe.cts`): that figure includes the process's worker threads, and
 * excludes its children and its parent. The repeat's sample is the largest of
 * them, never their sum — high-water marks taken at different moments do not
 * add up to anything that was ever resident at once. How many processes
 * reported travels beside it, so a launcher that started doing its work
 * in-process (one process instead of two) is visible rather than silently
 * folded in.
 */

import { z } from 'zod';

import { LoadReadingsSchema, measuredCommandShape } from '../../harness/schemas.js';
import type { CacheMode, LoadReadings } from '../../harness/types.js';

/** Stable name of this facet, as it appears in the envelope header. */
export const MEMORY_FACET = 'memory';

/** The measured result for one command. */
export interface MemoryCommandStats {
  readonly name: string;
  /** Arguments as actually run, so the report records what produced the number. */
  readonly args: readonly string[];
  readonly cache: CacheMode;
  /** How many repeats contributed to the statistics below. */
  readonly runs: number;
  /** Median of the per-repeat peaks, in kilobytes. */
  readonly medianKb: number;
  readonly minKb: number;
  readonly maxKb: number;
  /** Interquartile range of the per-repeat peaks: the spread that travels with the median. */
  readonly iqrKb: number;
  /** Each repeat's peak — its largest vat process's — in capture order. */
  readonly samplesKb: readonly number[];
  /**
   * How many node processes wrote a peak in each repeat, in capture order.
   *
   * Not a measurement of memory, and not summed into one: it says what the peak
   * was the largest OF. A change here between two reports is a change in how vat
   * runs, and is a better first explanation for a moved peak than anything else.
   */
  readonly processesPerRepeat: readonly number[];
  /**
   * The one accepted code every repeat exited with, and `null` when the row
   * failed — the same contract as `PerfCommandStats.exitCode`, for the same
   * reason: a findings exit rendered work a clean exit did not.
   */
  readonly exitCode: number | null;
  /**
   * True when this command did not produce a usable measurement: a repeat
   * failed, or a repeat left no peak at all (killed, out of heap, preload never
   * loaded). A row like that keeps its place so the report says so, but its
   * numbers are zeros a comparator must not subtract.
   */
  readonly failed: boolean;
  /** Why it failed, when it did. */
  readonly failure: string | null;
}

/** The `memory` facet's report body. */
export interface MemoryBody {
  readonly commands: readonly MemoryCommandStats[];
  /** Read around the capture. Peak RSS barely moves with load; it travels anyway, as on every facet. */
  readonly load: LoadReadings;
}

/**
 * Runtime schema for {@link MemoryBody}. Strict: an unrecognised field is a
 * producer this build does not model, and reading it would be a guess.
 */
export const MemoryBodySchema = z
  .object({
    commands: z.array(
      z
        .object({
          ...measuredCommandShape,
          medianKb: z.number().nonnegative(),
          minKb: z.number().nonnegative(),
          maxKb: z.number().nonnegative(),
          iqrKb: z.number().nonnegative(),
          samplesKb: z.array(z.number().nonnegative()),
          processesPerRepeat: z.array(z.number().int().nonnegative()),
          exitCode: z.number().int().nullable(),
        })
        .strict(),
    ),
    load: LoadReadingsSchema,
  })
  .strict();

/**
 * One dump, exactly as `rss-probe.cts` writes it. Strict, and no version field —
 * see `harness/dumps.ts`'s `DumpKind.schema`.
 */
export const RssDumpSchema = z
  .object({
    pid: z.number().int(),
    maxRssKb: z.number().nonnegative(),
  })
  .strict();

/** One process's peak. */
export type RssDump = z.infer<typeof RssDumpSchema>;
