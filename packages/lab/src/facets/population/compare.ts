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
 * and the reason the entries carry the subject's own identity at all. Collapsing
 * the three into one count would report "0 differences" for two populations that
 * enumerate the same files with different contents.
 *
 * ## What an arm difference means here
 *
 * The two sides record which enumerator each said it used. That is not a gate:
 * comparing two enumerators is the single most useful thing this facet does, but
 * it **qualifies every row below it**, so it is surfaced on the comparison rather
 * than left for a reader to notice in two separate reports. Two sides reporting
 * the SAME enumerator when the caller meant to compare two is the failure mode:
 * it looks like a clean result and is two runs of one enumerator agreeing trivially.
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
  type PopulationAttribution,
  PopulationBodySchema,
  type PopulationCommandStats,
  type PopulationEntry,
  type PopulationIdentity,
} from './types.js';

/**
 * Whether content identity could be compared between the two sides.
 *
 * Not comparable when a path on both sides carries identities of different
 * schemes (an rc.17 `checksum` against a `contentKey`): neither equal nor
 * different, so no path is called changed on that evidence.
 */
export type ContentComparison =
  | { readonly kind: 'compared' }
  | { readonly kind: 'incomparable'; readonly reason: string };

/** What happened to one command's population between two reports. */
export type PopulationCommandVerdict =
  | {
      /** The two sides enumerated different sets, or the same paths with different content. */
      readonly kind: 'changed';
      /** Paths only the compared side enumerated. */
      readonly added: readonly string[];
      /** Paths only the baseline enumerated. */
      readonly removed: readonly string[];
      /** Paths on both sides whose identity moved; empty when content was incomparable. */
      readonly changed: readonly string[];
      /** Whether {@link changed} is evidence of anything: see {@link ContentComparison}. */
      readonly contentComparison: ContentComparison;
    }
  | {
      /**
       * Identical membership, and content that could not be compared because the
       * two sides identify content under different schemes.
       *
       * Its own verdict rather than `unchanged`: "the same files, same content"
       * is a claim nothing here supports.
       */
      readonly kind: 'content-incomparable';
      readonly reason: string;
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
 * @returns Identities keyed by path
 */
function byPath(files: readonly PopulationEntry[]): ReadonlyMap<string, PopulationIdentity> {
  return new Map(files.map((entry) => [entry.path, entry.identity]));
}

/**
 * Decide whether the identities at the paths both sides enumerate can be compared.
 *
 * @param before - The baseline entries
 * @param afterByPath - The compared side's identities by path
 * @returns `compared`, or `incomparable` with the schemes that disagree
 */
function contentComparisonOf(
  before: readonly PopulationEntry[],
  afterByPath: ReadonlyMap<string, PopulationIdentity>,
): ContentComparison {
  const mismatch = before
    .map((entry) => ({ was: entry.identity.scheme, now: afterByPath.get(entry.path)?.scheme }))
    .find((pair) => pair.now !== undefined && pair.now !== pair.was);
  if (mismatch?.now === undefined) return { kind: 'compared' };
  return {
    kind: 'incomparable',
    reason:
      `the baseline identifies content by \`${mismatch.was}\` and the compared side by \`${mismatch.now}\`, ` +
      'which are different schemes, so no path is reported as changed or unchanged by content',
  };
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
  const contentComparison = contentComparisonOf(before.files, afterByPath);
  const changed = contentComparison.kind === 'incomparable'
    ? []
    : before.files
        .filter((entry) => {
          const other = afterByPath.get(entry.path);
          return other !== undefined && other.value !== entry.identity.value;
        })
        .map((entry) => entry.path);

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return contentComparison.kind === 'incomparable'
      ? { kind: 'content-incomparable', reason: contentComparison.reason }
      : { kind: 'unchanged' };
  }
  return { kind: 'changed', added, removed, changed, contentComparison };
}

/** This facet's body contract, as the shared comparison gates need it. */
const POPULATION_CONTRACT = {
  facet: POPULATION_FACET,
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
