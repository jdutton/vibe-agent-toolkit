/**
 * The `population` facet's body — **which files a vat command enumerated**, as a
 * set rather than as a cost.
 *
 * ## Why this facet had to exist
 *
 * The lab shipped four facets and every one of them measures cost: `perf` times
 * a command, `io` counts its syscalls, `parse` and `crawl` attribute milliseconds
 * to passes and contributors. That is a complete answer to *how expensive* an
 * enumeration was and no answer at all to *what it enumerated*. So the one
 * question a crawl change actually raises — did the population move? — was
 * unreachable from the instrument, and the only way to ask it was a throwaway
 * script, which is precisely the practice the lab exists to replace.
 *
 * A population is a **discrete, deterministic observable**, so this facet takes
 * the sharp comparator the `io` facet's call counts take: exact set equality, no
 * tolerance. One file's difference is real.
 *
 * ## The three things a population report must carry, and why
 *
 * 1. **The set, not a count.** Two runs that both enumerate 1,382 files and
 *    disagree about *which* 1,382 are not the same measurement, and a facet
 *    reporting only `count` would render that as agreement. `count` is here as a
 *    convenience and as the `ab` estimate; it is never the evidence.
 * 2. **The lane the run REPORTED it took** ({@link PopulationCommandStats.lane}).
 *    Setting an environment variable proves what was *asked for*; only the
 *    subject's own output proves what happened. A whole A/B on this codebase was
 *    voided once by two arms that both silently ran the incumbent crawler, and
 *    nothing in either report could have shown it.
 * 3. **An independent reference** ({@link PopulationCommandStats.offGit}). A
 *    population compared only against another run of the same instrument is
 *    self-referential — two runs of one lane agree trivially. Git's own listing
 *    is the one reference available without re-implementing the subject's glob
 *    matching, and it answers the direction that needs no globs: *did the crawl
 *    emit a path git does not track?*
 */

import { z } from 'zod';

import { LoadReadingsSchema, measuredCommandShape } from '../../harness/schemas.js';
import type { CacheMode, LoadReadings } from '../../harness/types.js';

/** Stable name of this facet, as it appears in the envelope header. */
export const POPULATION_FACET = 'population';

/**
 * Version of this body schema.
 *
 * Bumped whenever the shape below changes. Two `population` reports at different
 * body versions are refused against each other, because differences across a
 * schema change belong to the schema rather than to the subject.
 *
 * 1 — first version.
 */
export const POPULATION_FACET_VERSION = 1;

/**
 * What a row's file list actually describes.
 *
 * - **`measured`** — the command reported a population and it is below.
 * - **`nothing-enumerated`** — the command reported a population document and it
 *   listed no files. The instrument worked; the command found nothing. Very
 *   often that means the command was not pointed where the caller assumed, which
 *   is a fact worth stating rather than a zero worth averaging.
 * - **`not-measured`** — the row failed, so there is no population. The
 *   commonest causes are a command that reports no population document at all
 *   and a run that was not asked for the file list.
 */
export type PopulationAttribution = 'measured' | 'nothing-enumerated' | 'not-measured';

/** One file as the command reported it. */
export interface PopulationEntry {
  /** Subject-relative, forward-slashed — the basis the command stated. */
  readonly path: string;
  /**
   * Content identity as the subject computed it, never as the lab recomputed it.
   *
   * The point of taking the subject's own checksum is that a path present on
   * both sides with different content is a real difference the path list alone
   * cannot show, and recomputing it here would measure the lab's hashing rather
   * than the subject's.
   */
  readonly checksum: string;
}

/** The measured result for one command. */
export interface PopulationCommandStats {
  /** Stable artifact name, appearing in the report and any diff. */
  readonly name: string;
  /** Arguments as actually run, so the report records what produced the set. */
  readonly args: readonly string[];
  readonly cache: CacheMode;
  /** How many times the command actually ran. No repeat is discarded. */
  readonly runs: number;
  /**
   * Whether every repeat enumerated the identical set — or `null` when fewer
   * than two repeats ran and nothing could have disagreed.
   *
   * **`null` is not `true`.** A population is supposed to be deterministic, so
   * repeats that disagree are a finding about the subject rather than noise to
   * be averaged; this is the flag that says a reader is entitled to read the
   * single reported set as *the* answer.
   */
  readonly stable: boolean | null;
  /** See {@link PopulationAttribution}. Read this before reading anything below it. */
  readonly attribution: PopulationAttribution;
  /**
   * Which enumerator the run said produced this set, verbatim from its own
   * output — or `null` when the document stated none.
   *
   * Deliberately a free string and not an enum of the lanes this build knows.
   * A vat that grows a third lane must show up as that lane's name, not be
   * quietly folded into whichever known value is nearest; and `null` has to stay
   * distinguishable from any real lane, because it means *this build of vat does
   * not say*, which is the one case where an arm's identity is unproven.
   */
  readonly lane: string | null;
  /**
   * Which enumerator the reported lane used, verbatim from the run's own output
   * — or `null` when the document stated none.
   *
   * {@link lane} is not fine-grained enough to identify an arm on its own: the
   * projection lane has two enumerators and reports the same word for both, so
   * an A/B varying only the extent source produces two rows identical in every
   * other field. Two such rows agreeing then means either "the enumerators
   * agree" or "the switch did nothing", and only this field separates them.
   *
   * A free string for the same reason {@link lane} is, and `null` likewise
   * means *this build of vat does not say* rather than *the walk ran*.
   */
  readonly extentSource: string | null;
  /** The stated root every {@link PopulationEntry.path} is relative to. */
  readonly root: string | null;
  /** How many files were enumerated. Convenience; {@link files} is the evidence. */
  readonly count: number;
  /** Every enumerated file, sorted by path. */
  readonly files: readonly PopulationEntry[];
  /**
   * How many paths git tracks in the subject, or `null` when git could not say.
   *
   * The denominator for {@link offGit}, and `null` rather than `0` because "git
   * declined to answer" and "git tracks nothing" support opposite conclusions
   * about whether {@link offGit} means anything.
   */
  readonly gitTracked: number | null;
  /**
   * Enumerated paths that git does not track, sorted.
   *
   * The one containment direction answerable without re-implementing the
   * subject's include/exclude globs, and it is the direction that catches the
   * failures worth catching: a path git never listed is either genuinely off-git
   * content (which the projection lane admits on purpose) or a path the crawl
   * mangled on its way out of git. **Never truncated** — a list this report
   * shortened would read as a small divergence.
   *
   * Empty when {@link gitTracked} is `null`, where it would otherwise be the
   * whole population wearing the costume of a finding.
   */
  readonly offGit: readonly string[];
  /**
   * True when this row produced no usable population.
   *
   * A failed command keeps its row so the report says what happened, but a
   * comparator must not read a difference from it.
   */
  readonly failed: boolean;
  /** Why it failed, when it did. */
  readonly failure: string | null;
}

/** The `population` facet's report body. */
export interface PopulationBody {
  readonly commands: readonly PopulationCommandStats[];
  /**
   * Machine load around the capture.
   *
   * Carried for the same reason every facet carries it, and read differently: a
   * set is not contaminated by a busy machine the way a duration is, so a
   * contaminated `population` capture is a note about the run rather than a
   * caveat on the numbers.
   */
  readonly load: LoadReadings;
}

/** The schema fields describing one enumerated file. */
export const populationEntryShape = {
  path: z.string().min(1),
  checksum: z.string(),
} as const;

/**
 * Runtime schema for {@link PopulationBody}.
 *
 * Strict, not passthrough: this validates data *we* wrote. An unrecognised field
 * means a producer this build does not model.
 */
export const PopulationBodySchema = z
  .object({
    commands: z.array(
      z
        .object({
          ...measuredCommandShape,
          stable: z.boolean().nullable(),
          attribution: z.enum(['measured', 'nothing-enumerated', 'not-measured']),
          lane: z.string().nullable(),
          extentSource: z.string().nullable(),
          root: z.string().nullable(),
          count: z.number().int().nonnegative(),
          files: z.array(z.object(populationEntryShape).strict()),
          gitTracked: z.number().int().nonnegative().nullable(),
          offGit: z.array(z.string()),
        })
        .strict(),
    ),
    load: LoadReadingsSchema,
  })
  .strict();
