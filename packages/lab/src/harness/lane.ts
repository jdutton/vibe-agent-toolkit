/**
 * The arm a measured run SAID it took, read back out of the subject's own
 * stdout — and how every facet names it.
 *
 * vat has one enumeration lane, and two enumerators under it: git and the
 * filesystem. A run's arm is the enumerator it reported (`extentSource`).
 *
 * ## Why the output and never the environment
 *
 * An A/B of the two enumerators is selected by an environment variable
 * (`VAT_EXTENT_SOURCE`). Setting the variable proves what was *asked for*;
 * only the subject's output proves what *happened*. A vat build that ignores
 * the variable, or a `crawlSourceFor` that silently declines git on a root
 * outside a repository, runs the same arm on both sides — and an A/B whose two
 * arms ran one enumerator is a clean result that means nothing. So the arm is
 * read from what the subject printed, and the caller's env is never consulted,
 * by any facet.
 *
 * ## Why this lives in the harness and not in one facet
 *
 * `population` needed it first, because a population without its arm is a set
 * whose arm is unproven. `io` needed it second, the hard way: the first A/B
 * of the git-vs-filesystem extent source had to INFER which arm each side ran
 * from a call-site signature (`realizations.js:51` at 0 calls versus 12,003),
 * because its rows carried counts and nothing about the arm that produced them.
 * Two facets reading the same field out of the same document is one concern,
 * and one function, or the two readers drift.
 *
 * ## What a `null` means
 *
 * The field is a free string, never an enum of the enumerators this build
 * knows: a vat that grows a third must show up under its name rather than be
 * folded into whichever known value is nearest. `null` means *the subject's
 * output did not say* — the build does not report it, or the measured spec
 * prints a document this reader does not parse — and it has to stay
 * distinguishable from every real arm, because it is the one case where an
 * arm's identity is unproven.
 *
 * ## Why the default YAML spec reads an arm too
 *
 * `vat resources scan` prints YAML by default and the same document as JSON
 * under `--format json`. Both facets read every document — JSON or YAML —
 * through `document-shape.ts`'s one `parseDocument`, so a row measured over the
 * default spec (`resources-scan`) reads its real arm.
 */

import { z } from 'zod';

import { parseDocument } from './document-shape.js';

/** What a subject's output said about the arm it ran. */
export interface ReportedLane {
  /**
   * Which enumerator the run said produced its result, verbatim from its own
   * output — or `null` when the output stated none.
   */
  readonly extentSource: string | null;
}

/** The null — what every unreadable output reduces to. */
const UNREPORTED: ReportedLane = Object.freeze({ extentSource: null });

/**
 * The part of any vat document this module reads — and the ONE definition of
 * what the field may hold.
 *
 * Deliberately NOT strict and deliberately narrow: the document carries a root,
 * totals, per-collection counts, a duration — none of them this module's
 * business, and modelling them would make an unrelated addition to the
 * subject's output an unreadable arm.
 *
 * Exported so `population`'s own document schema can EXTEND it rather than
 * restate it: that facet refuses a malformed arm, and the refusal has to be a
 * verdict on the same field shape {@link laneOfDocument} reads, or the two
 * facets disagree about what a document said.
 */
export const LaneFieldsSchema = z.object({
  // A free string: an unknown enumerator name must survive verbatim rather
  // than be folded into a value this build recognises. Nullable as well as
  // optional: a build that reports no enumerator prints `null` or omits the
  // key, and both read as "did not say".
  extentSource: z.string().min(1).nullable().optional(),
}).strip(); /* a document ANOTHER vat build printed: keep only the field this facet reads, refuse none of the rest */

/**
 * Read the arm out of an already-parsed document.
 *
 * For a caller that has parsed the subject's output for its own reasons — the
 * population reader validates a wider schema over the same value — so the
 * output is not parsed twice. Reading is lenient — an unreadable field is
 * `null`, the same as an absent one — and that lenience is `io`'s contract:
 * there the arm is a qualifier on counts that are real whatever the qualifier
 * says. `population` does not inherit it: its schema extends
 * {@link LaneFieldsSchema}, so a malformed field is refused there before this
 * function ever sees it.
 *
 * @param value - A parsed document, or anything else
 * @returns The reported arm, `null` when the value does not carry one this
 *   build can read
 */
export function laneOfDocument(value: unknown): ReportedLane {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return UNREPORTED;
  const parsed = LaneFieldsSchema.shape.extentSource.safeParse((value as Record<string, unknown>)['extentSource']);
  return { extentSource: parsed.success ? (parsed.data ?? null) : null };
}

/**
 * Read the arm out of what a subject printed.
 *
 * Never throws and never refuses: an arm is a qualifier on a measurement, not
 * the measurement, so output that carries none leaves the row's numbers
 * standing with the arm `null`, spelled {@link LANE_UNREPORTED} in a report.
 *
 * Read off `parseDocument`'s `payload` — `data` for a `Report`, the whole
 * document for a legacy one.
 *
 * @param stdout - Everything the subject wrote to stdout
 * @returns The reported arm, `null` when the output carries no document this
 *   reader can classify, or no arm inside the one it found
 */
export function readLaneFromOutput(stdout: string): ReportedLane {
  const parsed = parseDocument(stdout);
  if (parsed.shape === 'unparsed') return UNREPORTED;
  return laneOfDocument(parsed.payload);
}

/** Said in place of an arm when the subject's output named none. */
export const LANE_UNREPORTED = "arm UNREPORTED by the subject's output";

/**
 * How a row's arm reads.
 *
 * @param row - What the subject's output said
 * @returns The arm's name, or `null` when the output named none
 */
export function armOf(row: ReportedLane): string | null {
  return row.extentSource;
}

/**
 * How a row's arm reads on a line that must never be blank.
 *
 * A missing arm is spelled out rather than left empty: a blank reads as an
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
 * The `[A → B]` arrow is reserved for the one case where BOTH sides named an
 * arm and the two differ. One side that named none is not a different
 * enumerator — it is an absent proof — and is named as UNPROVEN.
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
    return ' [arm UNPROVEN on both sides — neither output reported an enumerator]';
  }
  if (left === null) return oneSidedNote('before', 'after', String(right));
  if (right === null) return oneSidedNote('after', 'before', left);
  if (left !== right) return ` [${left} → ${right}]`;
  return ` [both sides ran the '${left}' arm — this compares one enumerator with itself]`;
}

/**
 * The clause for a pair where exactly one side proved its arm.
 *
 * @param unproven - Which side reported no arm
 * @param proven - The other side
 * @param arm - The arm the proven side ran
 * @returns The clause, naming the unproven side first
 */
function oneSidedNote(unproven: 'before' | 'after', proven: 'before' | 'after', arm: string): string {
  return ` [arm UNPROVEN on the ${unproven} side — ${LANE_UNREPORTED}; the ${proven} side ran '${arm}']`;
}
