/**
 * The report envelope — the header every facet writes and every comparator
 * reads.
 *
 * A facet (skill lint, resource integrity, performance, I/O accounting, compat
 * prediction) decides what goes in `body`. The envelope decides everything
 * needed to know whether two bodies may be held next to each other: the
 * coordinate they were measured at, and which facet the body belongs to.
 *
 * **Refusal, not coercion.** A report from another header shape, a different
 * facet, or another body shape is *refused* rather than best-efforted into
 * comparison. A comparator that silently tolerates a schema change reports
 * differences that are artifacts of the change rather than of the subject, and
 * those are the most expensive kind of wrong answer this package can give.
 *
 * ## ⚠️ There are no version fields here, and adding one back is a defect
 *
 * This header used to carry a `formatVersion` and a `facetVersion`, and neither
 * ever decided anything the schemas do not decide already. {@link readEnvelope}
 * validates against {@link ReportEnvelopeSchema}, which is strict all the way
 * down through {@link CoordinateSchema} — so the very report the format bump was
 * cut for (one predating `instrument.dirty`) is refused for the honest reason,
 * that a required field is missing, without an integer in the loop. The body
 * half is the same: `harness/facet-compare.ts` validates BOTH sides against the
 * facet's own strict schema before a number is subtracted.
 *
 * The integers were strictly worse than the schemas at the one job they had,
 * because nothing fails when a human forgets to bump one. The crawl seam shipped
 * two meaning changes ahead of its bump and one of them published a confident
 * false delta in the interval.
 *
 * What no schema can see is a field whose MEANING moved while its name and type
 * stayed put — and no integer could see that either, it could only be told.
 * The remedies are to invalidate explicitly (delete the stored reports) or to
 * make the build DECLARE the thing that moved, as `CrawlTimingDump.charges`
 * does. Not to reintroduce a number nobody is obliged to move.
 */

import { z } from 'zod';

import { type Coordinate, CoordinateSchema } from './coordinate.js';

/** A measurement of one facet at one coordinate. */
export interface ReportEnvelope<TBody = unknown> {
  /** Which facet produced this — `io`, `perf`, `skill-lint`, and so on. */
  readonly facet: string;
  /** Where this was measured. See {@link Coordinate}. */
  readonly coordinate: Coordinate;
  /**
   * When the capture ran, ISO-8601.
   *
   * Recorded for provenance and **never compared**: it moves on every run, so
   * comparing it would report a difference between two identical measurements.
   */
  readonly capturedAt: string;
  /** The facet's payload. */
  readonly body: TBody;
}

/**
 * Runtime schema for {@link ReportEnvelope}.
 *
 * **Strict, and load-bearing for it.** This is the whole of "may this report be
 * read?" — see this module's header. A header carrying a field this build does
 * not model (a `formatVersion` from a build that had one, say) is refused here,
 * and so is one missing a field this build requires.
 */
export const ReportEnvelopeSchema = z
  .object({
    facet: z.string().min(1),
    coordinate: CoordinateSchema,
    capturedAt: z.string().min(1),
    body: z.unknown(),
  })
  .strict();

/** Why a stored report could not be read or compared. */
export interface EnvelopeRefusal {
  readonly ok: false;
  /** Human-facing refusal, prefixed `REFUSED:`. */
  readonly refusal: string;
}

/** A report that parsed cleanly. */
export interface EnvelopeAccepted<TBody> {
  readonly ok: true;
  readonly envelope: ReportEnvelope<TBody>;
}

/** The outcome of reading a stored report. */
export type EnvelopeResult<TBody> = EnvelopeAccepted<TBody> | EnvelopeRefusal;

/**
 * Read an unknown value as a report envelope.
 *
 * The body is *not* validated here — only the header. Each facet owns its body
 * schema and validates it after checking that `facet` is the one it understands.
 *
 * @param value - Parsed JSON or YAML from a stored report
 * @returns The envelope, or a refusal naming what was wrong
 */
export function readEnvelope(value: unknown): EnvelopeResult<unknown> {
  const parsed = ReportEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      refusal: `REFUSED: not a report envelope — ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    };
  }
  return { ok: true, envelope: parsed.data as ReportEnvelope<unknown> };
}

/**
 * Are these two reports measurements of the same facet?
 *
 * One of three gates a comparison must clear, and the only one the header alone
 * can answer. The coordinate gate is `decideComparison`; the body-shape gate is
 * `readBody` in `harness/facet-compare.ts`.
 *
 * ⚠️ **This deliberately does not compare the two bodies' shapes to each other.**
 * It used to, via a `facetVersion` integer, and that was the weaker of the two
 * checks available: two reports captured before a schema move agree with each
 * other perfectly while every row in them means what the older build meant.
 * Validating each side against THIS build's strict schema — which is what
 * `readBody` does — refuses that pair, and refuses it without anyone having
 * remembered to bump anything.
 *
 * @param a - The baseline report
 * @param b - The report being compared against it
 * @returns `null` when the two name one facet, or a refusal explaining why not
 */
export function refuseDifferentFacets(
  a: ReportEnvelope<unknown>,
  b: ReportEnvelope<unknown>,
): string | null {
  if (a.facet !== b.facet) {
    return `REFUSED: these reports measure different facets ('${a.facet}' and '${b.facet}'). There is no delta between two different measurements.`;
  }
  return null;
}
