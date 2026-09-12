/**
 * The arm a measured run SAID it took, read back out of the subject's own
 * stdout — and how every facet names it.
 *
 * ## Why the output and never the environment
 *
 * An A/B of two enumerators is selected by an environment variable
 * (`VAT_RESOURCES_CRAWL`, `VAT_EXTENT_SOURCE`). Setting the variable proves what
 * was *asked for*; only the subject's output proves what *happened*. A vat
 * build that ignores the variable, or a `crawlSourceFor` that silently declines
 * git on a root outside a repository, runs the same arm on both sides — and an
 * A/B whose two arms ran one enumerator is a clean result that means nothing.
 * So the lane is read from what the subject printed, and the caller's env is
 * never consulted, by any facet.
 *
 * ## Why this lives in the harness and not in one facet
 *
 * `population` needed it first, because a population without its lane is a set
 * whose arm is unproven. `io` needed it second, the hard way: a 2026-09-11 A/B
 * of the git-vs-filesystem extent source had to INFER which arm each side ran
 * from a call-site signature (`realizations.js:51` at 0 calls versus 12,003),
 * because its rows carried counts and nothing about the arm that produced them.
 * Two facets reading the same field out of the same document is one concern,
 * and one function, or the two readers drift — one accepting a `null` extent
 * source, the other refusing every walk-lane document.
 *
 * ## What a `null` means, and why it is not a lane
 *
 * Both fields are free strings, never an enum of the lanes this build knows: a
 * vat that grows a third lane must show up under that lane's name rather than be
 * folded into whichever known value is nearest. `null` means *the subject's
 * output did not say* — the build is too old to report it, or the measured spec
 * prints a document this reader does not parse — and it has to stay
 * distinguishable from every real lane, because it is the one case where an
 * arm's identity is unproven.
 *
 * ⚠️ `extentSource: null` is NOT "did not say". vat prints `null` for the walk,
 * a lane with no extent to source, and omits the key on a build too old to
 * report it. The reader keeps the lane in both cases and reports the extent
 * source as `null` in both, because the two are the same fact about the arm: it
 * has no extent source it can name.
 *
 * ## Why JSON only, and why the YAML lane line is deliberately not read
 *
 * `vat resources scan` prints YAML by default and the same document as JSON
 * under `--format json`. The io/perf default spec (`resources-scan`) prints the
 * YAML, and its `lane:` line is right there in the text — and this reader must
 * not take it. A YAML parser is a dependency this package deliberately does not
 * carry, and a regex over the text would be a second parser that drifts from
 * the first. So a row measured over the default spec honestly reads `lane:
 * null`, and a caller who wants the arm on an io row asks for the spec that
 * prints JSON: `--command resources-population`.
 */

import { z } from 'zod';

/** What a subject's output said about the arm it ran. */
export interface ReportedLane {
  /**
   * Which enumerator the run said produced its result, verbatim from its own
   * output — or `null` when the output stated none.
   */
  readonly lane: string | null;
  /**
   * Which source the reported lane enumerated from, verbatim from its own
   * output — or `null` when the output stated none, which is also what the walk
   * lane prints because it has no extent to source.
   *
   * {@link ReportedLane.lane} is not fine-grained enough to identify an arm on
   * its own: the projection lane has two enumerators and reports the same word
   * for both, so an A/B varying only the extent source produces two rows
   * identical in every other field. Only this field separates "the enumerators
   * agree" from "the switch did nothing".
   */
  readonly extentSource: string | null;
}

/** The two nulls — what every unreadable output reduces to. */
const UNREPORTED: ReportedLane = Object.freeze({ lane: null, extentSource: null });

/**
 * The part of any vat document this module reads.
 *
 * Deliberately NOT strict and deliberately narrow: the document carries a root,
 * totals, per-collection counts, a duration — none of them this module's
 * business, and modelling them would make an unrelated addition to the
 * subject's output an unreadable lane.
 */
const LaneFieldsSchema = z.object({
  // A free string, matching the body's own field: an unknown lane name must
  // survive verbatim rather than be folded into a value this build recognises.
  lane: z.string().min(1).optional(),
  // Nullable as well as optional, and the difference is load-bearing: vat emits
  // `null` for the walk (a lane with no extent to source) and omits the key
  // entirely on a build too old to report it. Rejecting the null would refuse
  // every walk-lane document.
  extentSource: z.string().min(1).nullable().optional(),
});

/**
 * Read the arm out of an already-parsed document.
 *
 * For a caller that has parsed the subject's JSON for its own reasons — the
 * population reader validates a wider schema over the same value — so the
 * output is not parsed twice.
 *
 * @param value - A parsed document, or anything else
 * @returns The reported arm, with both fields `null` when the value does not
 *   carry one this build can read
 */
export function laneOfDocument(value: unknown): ReportedLane {
  const parsed = LaneFieldsSchema.safeParse(value);
  if (!parsed.success) return UNREPORTED;
  return {
    lane: parsed.data.lane ?? null,
    extentSource: parsed.data.extentSource ?? null,
  };
}

/**
 * Read the arm out of what a subject printed.
 *
 * Never throws and never refuses: a lane is a qualifier on a measurement, not
 * the measurement, so output that carries none leaves the row's numbers
 * standing with both fields `null`. Whether a facet can tolerate that is the
 * facet's call — `population` cannot, and refuses before it gets here.
 *
 * @param stdout - Everything the subject wrote to stdout
 * @returns The reported arm, or both `null` when the output is not a JSON
 *   document carrying one
 */
export function readLaneFromOutput(stdout: string): ReportedLane {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout) as unknown;
  } catch {
    return UNREPORTED;
  }
  return laneOfDocument(raw);
}

/** Said in place of an arm when the subject's output named none. */
export const LANE_UNREPORTED = "lane UNREPORTED by the subject's output";

/**
 * How a row's arm reads.
 *
 * The extent source QUALIFIES the lane rather than replacing it, and it is
 * appended rather than given its own column so a reader seeing `projection` on
 * both sides gets the qualifier in the same glance — the moment they can still
 * notice the two arms are not the two they asked for. A `null` extent source is
 * the walk, which has no extent to source, so that row reads bare.
 *
 * @param row - What the subject's output said
 * @returns The arm's name, or `null` when the output named no lane
 */
export function armOf(row: ReportedLane): string | null {
  if (row.lane === null) return null;
  return row.extentSource === null ? row.lane : `${row.lane} via ${row.extentSource}`;
}

/**
 * How a row's arm reads on a line that must never be blank.
 *
 * A missing lane is spelled out rather than left empty: a blank reads as an
 * ordinary row, and this is a row whose arm is unproven.
 *
 * @param row - What the subject's output said
 * @returns The arm's name, or {@link LANE_UNREPORTED}
 */
export function armLabel(row: ReportedLane): string {
  return armOf(row) ?? LANE_UNREPORTED;
}

/**
 * The arm caveat for one command's pair of rows in a comparison.
 *
 * Two sides that report the SAME arm are two runs of one enumerator, and their
 * agreement means nothing about the question the comparison was asked. That is
 * the failure this exists to make visible, so it is said on the row rather than
 * left to a reader holding two reports open. Two sides that report NO arm are
 * not "the same arm" either — they are two rows that cannot prove which arm
 * they ran, and silence there would read as a clean pair.
 *
 * ⚠️ Keyed on the lane AND its extent source, because the lane alone was not
 * enough to identify an arm: the projection lane has two enumerators and
 * reports the same word for both, so an A/B varying only `VAT_EXTENT_SOURCE`
 * used to slip past this note reading as a genuine agreement.
 *
 * @param before - The baseline row's arm, or `null` when that side has no row
 * @param after - The compared row's arm, or `null` when that side has no row
 * @returns A clause to append to the row line, or an empty string when a side
 *   is absent altogether
 */
export function laneNote(before: ReportedLane | null, after: ReportedLane | null): string {
  if (before === null || after === null) return '';
  const left = armOf(before);
  const right = armOf(after);
  if (left === null && right === null) {
    return ' [arm UNPROVEN on both sides — neither output reported a lane]';
  }
  if (left !== right) return ` [${left ?? LANE_UNREPORTED} → ${right ?? LANE_UNREPORTED}]`;
  return ` [both sides ran the '${String(left)}' arm — this compares one enumerator with itself]`;
}
