/**
 * Comparing two `population` reports — a **set difference**, with no tolerance.
 *
 * The shared gates run first (same facet, same body version, at most one axis
 * moved, neither side failed); see `harness/facet-compare.ts`, which owns them so
 * that every facet refuses the same things for the same reasons.
 *
 * What is this facet's own is the subtraction, and the choice worth stating is
 * that it is **exact**. A population is a discrete, deterministic observable: one
 * file's difference is real, and a comparator that applied a threshold to it
 * would be inventing noise that the measurement does not have.
 *
 * ## Three kinds of difference, kept apart
 *
 * `added` and `removed` are membership. `changed` is a path present on both
 * sides whose content identity moved — invisible to a comparison of path lists,
 * and the reason the entries carry the subject's own checksum at all. Collapsing
 * the three into one count would report "0 differences" for two populations that
 * enumerate the same files with different contents.
 *
 * ## What a lane difference means here
 *
 * The two sides record which enumerator each said it used. That is not a gate —
 * comparing two lanes is the single most useful thing this facet does — but it
 * **qualifies every row below it**, so it is surfaced on the comparison rather
 * than left for a reader to notice in two separate reports. Two sides reporting
 * the SAME lane when the caller meant to compare two is the failure mode: it
 * looks like a clean result and is two runs of one lane agreeing trivially.
 */

import type { Axis, DecideComparisonOptions } from '../../envelope/coordinate.js';
import type { ReportEnvelope } from '../../envelope/envelope.js';
import {
  type ComparisonRefusal,
  compareCommandRows,
  unmeasurableReasonFor,
} from '../../harness/facet-compare.js';

import {
  POPULATION_FACET,
  POPULATION_FACET_VERSION,
  type PopulationAttribution,
  PopulationBodySchema,
  type PopulationCommandStats,
  type PopulationEntry,
} from './types.js';

/** What happened to one command's population between two reports. */
export type PopulationCommandVerdict =
  | {
      /** The two sides enumerated different sets, or the same paths with different content. */
      readonly kind: 'changed';
      /** Paths only the compared side enumerated. */
      readonly added: readonly string[];
      /** Paths only the baseline enumerated. */
      readonly removed: readonly string[];
      /** Paths on both sides whose checksum moved. */
      readonly changed: readonly string[];
    }
  | {
      /** Identical membership and identical content. */
      readonly kind: 'unchanged';
    }
  | {
      /**
       * The two rows cannot yield a difference — a side failed, or one of them
       * enumerated nothing, or they were captured under different cache modes.
       *
       * Its own verdict rather than folded into `unchanged`: "we could not
       * measure this" and "this did not move" are different facts, and a report
       * rendering them identically hides broken commands behind a green.
       */
      readonly kind: 'unmeasurable';
      readonly reason: string;
    }
  | { readonly kind: 'added' }
  | { readonly kind: 'removed' };

/** One command's row in a comparison. */
export interface PopulationCommandDiff {
  readonly name: string;
  readonly verdict: PopulationCommandVerdict;
  /** The baseline row, absent when the command is new. */
  readonly before: PopulationCommandStats | null;
  /** The compared row, absent when the command was dropped. */
  readonly after: PopulationCommandStats | null;
}

/** A completed comparison. */
export interface PopulationComparisonResult {
  readonly ok: true;
  /** Which axis varies, or `null` when the two reports share a coordinate. */
  readonly axis: Axis | null;
  readonly commands: readonly PopulationCommandDiff[];
  /** True when either side was measured on a contaminated machine. */
  readonly contaminated: boolean;
}

/** The outcome of comparing two population reports. */
export type PopulationComparison = PopulationComparisonResult | ComparisonRefusal;

/**
 * Why a pair of rows yields no set difference, or `null` when it does.
 *
 * The states are this facet's vocabulary; the cascade and its order are the
 * shared ones. `nothing-enumerated` is refused rather than compared because
 * subtracting a real population from an empty one reports the entire corpus as
 * removed — a maximally alarming rendering of "the command found nothing".
 */
const unmeasurableReason = unmeasurableReasonFor<PopulationAttribution>({
  measured: null,
  'nothing-enumerated': 'the command enumerated no files at all',
  'not-measured': 'no population was read from the command',
});

/**
 * Index a population's entries by path.
 *
 * @param files - Entries, path-sorted
 * @returns Checksums keyed by path
 */
function byPath(files: readonly PopulationEntry[]): ReadonlyMap<string, string> {
  return new Map(files.map((entry) => [entry.path, entry.checksum]));
}

/**
 * Diff one command that appears on both sides.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns The verdict for this command
 */
function verdictFor(
  before: PopulationCommandStats,
  after: PopulationCommandStats,
): PopulationCommandVerdict {
  const reason = unmeasurableReason(before, after);
  if (reason !== null) return { kind: 'unmeasurable', reason };

  const beforeByPath = byPath(before.files);
  const afterByPath = byPath(after.files);

  const added = after.files
    .filter((entry) => !beforeByPath.has(entry.path))
    .map((entry) => entry.path);
  const removed = before.files
    .filter((entry) => !afterByPath.has(entry.path))
    .map((entry) => entry.path);
  const changed = before.files
    .filter((entry) => {
      const other = afterByPath.get(entry.path);
      return other !== undefined && other !== entry.checksum;
    })
    .map((entry) => entry.path);

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return { kind: 'unchanged' };
  }
  return { kind: 'changed', added, removed, changed };
}

/** This facet's body contract, as the shared comparison gates need it. */
const POPULATION_CONTRACT = {
  facet: POPULATION_FACET,
  version: POPULATION_FACET_VERSION,
  schema: PopulationBodySchema,
} as const;

/**
 * Compare two `population` reports.
 *
 * @param before - The baseline report
 * @param after - The report being compared against it
 * @param options - Axis options
 * @returns A comparison, or a refusal explaining why the two cannot be compared
 */
export function comparePopulation(
  before: ReportEnvelope<unknown>,
  after: ReportEnvelope<unknown>,
  options: DecideComparisonOptions = {},
): PopulationComparison {
  return compareCommandRows<PopulationCommandStats, PopulationCommandVerdict>(
    before,
    after,
    POPULATION_CONTRACT,
    options,
    verdictFor,
  );
}
