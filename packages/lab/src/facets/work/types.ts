/**
 * The `work` facet's body: how much work a vat command did, read from vat's own
 * deterministic work counters (`@vibe-agent-toolkit/utils`'s `countWork`).
 *
 * **What the facet is for.** `io` counts Node `fs` and `child_process` calls
 * from outside the process; it cannot see a store row decoded, an extent
 * derived or a parse served from cache, because those are not calls into Node.
 * vat counts them at the code sites that do the work and dumps them per process
 * when `VAT_WORK_COUNTERS` names a directory. This facet reads those dumps.
 *
 * **It reports; it gates nothing.** There is no ceiling, threshold or budget
 * anywhere in this facet.
 */

import { WORK_COUNTER_NAMES, type WorkCounter } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import { LoadReadingsSchema, measuredCommandShape } from '../../harness/schemas.js';
import type { CacheMode, LoadReadings } from '../../harness/types.js';

/** Stable name of this facet, as it appears in the envelope header. */
export const WORK_FACET = 'work';

/**
 * The fewest repeats a `work` capture takes: repeat 0 is a warm-up and is
 * discarded, and stability needs two compared repeats after it.
 */
export const WORK_MIN_RUNS = 3;

/**
 * A counter name this build reads — derived from the utils tuple, never a
 * hand-kept copy. A dump from a newer vat carrying a counter this build does
 * not know is therefore refused; run the lab from the newer side.
 *
 * ⚠️ Not when a counter was removed or renamed: a removed counter makes the
 * older lab the reader of a mixed pair, and a renamed one leaves no lab build
 * that reads dumps from both sides.
 */
export const WorkCounterNameSchema = z.enum(WORK_COUNTER_NAMES);

/**
 * Which counters a cache mode reports without comparing them exactly.
 *
 * The one declaration of what a `work` comparison may call a finding, read by
 * both `stable` and the comparator:
 *
 * - `parse.refused.load` is load-dependent in every mode: a time or heap limit
 *   breached under a busy machine is not a property of the code. Reporting it
 *   only is not enough on its own: a refused parse also moves
 *   `parse.dispatched`, `extent.derived`, the store's row counts,
 *   `store.miss.refusedPairs` and `parse.refused.keyDetermined`. So a row with
 *   a load refusal in any compared repeat has `stable: null` and withholds the
 *   exact verdict for every counter ({@link WorkCommandStats.loadRefusedRepeats}).
 * - `parse.redispatched` is reported in every mode: a second dispatch happens
 *   only when a cache entry the worker filed is gone at the read-back (a
 *   concurrent cache clear, a purged temp directory), which is not the code.
 * - In `cold` mode `parse.dispatched` and `parse.cache.hit` depend on timing:
 *   the dispatcher's look-ahead window can have two files with one content key
 *   in flight at once, and both miss.
 *
 * Every other counter is compared exactly in both modes.
 */
const REPORTED_ONLY: Readonly<Record<CacheMode, readonly WorkCounter[]>> = {
  warm: ['parse.refused.load', 'parse.redispatched'],
  cold: ['parse.refused.load', 'parse.redispatched', 'parse.dispatched', 'parse.cache.hit'],
};

/**
 * Whether a counter is compared exactly under a cache mode.
 *
 * @param counter - The counter
 * @param cache - The cache mode both sides ran under
 * @returns True when any difference in it is a finding; false when it is reported only
 */
export function comparedExactly(counter: WorkCounter, cache: CacheMode): boolean {
  return !REPORTED_ONLY[cache].includes(counter);
}

/** One counter's count, summed across every process of the reported repeat. */
export interface WorkCounterReading {
  readonly name: WorkCounter;
  readonly count: number;
}

/** The measured result for one command. */
export interface WorkCommandStats {
  /** Stable artifact name, appearing in the report and any diff. */
  readonly name: string;
  /** Arguments as actually run. */
  readonly args: readonly string[];
  readonly cache: CacheMode;
  /** How many times the command ran, the discarded warm-up included. */
  readonly runs: number;
  /** How many repeats were compared to decide {@link WorkCommandStats.stable}: `runs - 1`. */
  readonly comparedRuns: number;
  /**
   * Whether the compared repeats agreed on every exactly-compared counter, or
   * `null` when agreement is no warrant: below two compared repeats, where
   * nothing could disagree, or when a compared repeat refused a parse under load.
   *
   * A reported-only counter ({@link comparedExactly}) never makes this false.
   */
  readonly stable: boolean | null;
  /**
   * How many repeats refused a parse under machine load (`parse.refused.load > 0`):
   * the compared repeats, plus a warm-mode warm-up, whose refusal moves the
   * compared repeats' counts through the cache it filled.
   */
  readonly loadRefusedRepeats: number;
  /** How many process dumps the reported repeat held. */
  readonly processes: number;
  /**
   * The last compared repeat's counts, in the utils tuple order. A counter the
   * measured vat does not emit is absent, never zero.
   */
  readonly counters: readonly WorkCounterReading[];
  /**
   * Every counter whose count differed between two adjacent compared repeats,
   * reported-only ones included, in tuple order.
   */
  readonly varied: readonly WorkCounter[];
  /** True when this command did not produce a usable measurement. */
  readonly failed: boolean;
  /** Why it failed, when it did. */
  readonly failure: string | null;
}

/** The `work` facet's report body. */
export interface WorkBody {
  readonly commands: readonly WorkCommandStats[];
  /** Machine load around the capture: the load-dependent counter moves with it. */
  readonly load: LoadReadings;
}

/**
 * Runtime schema for {@link WorkBody}. Strict, and with no version field: the
 * shape decides what this build reads.
 */
export const WorkBodySchema = z
  .object({
    commands: z.array(
      z
        .object({
          ...measuredCommandShape,
          comparedRuns: z.number().int().nonnegative(),
          stable: z.boolean().nullable(),
          loadRefusedRepeats: z.number().int().nonnegative(),
          processes: z.number().int().nonnegative(),
          counters: z.array(
            z.object({ name: WorkCounterNameSchema, count: z.number().int().nonnegative() }).strict(),
          ),
          varied: z.array(WorkCounterNameSchema),
        })
        .strict(),
    ),
    load: LoadReadingsSchema,
  })
  .strict();
