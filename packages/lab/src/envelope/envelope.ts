/**
 * The report envelope — the header every facet writes and every comparator
 * reads.
 *
 * A facet (skill lint, resource integrity, performance, I/O accounting, compat
 * prediction) decides what goes in `body`. The envelope decides everything
 * needed to know whether two bodies may be held next to each other: the
 * coordinate they were measured at, and the two schema versions that say what
 * shape the body is in.
 *
 * **Refusal, not coercion.** A report from an older format, a different facet,
 * or an older body schema is *refused* rather than best-efforted into
 * comparison. A comparator that silently tolerates a schema change reports
 * differences that are artifacts of the change rather than of the subject, and
 * those are the most expensive kind of wrong answer this package can give.
 */

import { z } from 'zod';

import { type Coordinate, CoordinateSchema } from './coordinate.js';

/**
 * Version of the envelope itself — the fields around `body`.
 *
 * Bumped only when the header changes shape. A bump invalidates every stored
 * report, which is the point: an envelope that cannot be read the same way is
 * not comparable to one that can.
 */
export const REPORT_FORMAT_VERSION = 1;

/** A measurement of one facet at one coordinate. */
export interface ReportEnvelope<TBody = unknown> {
  /** See {@link REPORT_FORMAT_VERSION}. */
  readonly formatVersion: number;
  /** Which facet produced this — `io`, `perf`, `skill-lint`, and so on. */
  readonly facet: string;
  /** Version of *this facet's* body schema, owned by the facet. */
  readonly facetVersion: number;
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

export const ReportEnvelopeSchema = z
  .object({
    formatVersion: z.number().int().positive(),
    facet: z.string().min(1),
    facetVersion: z.number().int().positive(),
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
 * schema and validates it after checking that `facet` and `facetVersion` are
 * the ones it understands.
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
  if (parsed.data.formatVersion !== REPORT_FORMAT_VERSION) {
    return {
      ok: false,
      refusal:
        `REFUSED: report envelope formatVersion ${String(parsed.data.formatVersion)}, ` +
        `this build reads ${String(REPORT_FORMAT_VERSION)}. Re-capture the report; a header ` +
        'from another format cannot be read the same way, so any diff against it would be ' +
        'a diff of the format rather than of the subject.',
    };
  }
  return { ok: true, envelope: parsed.data as ReportEnvelope<unknown> };
}

/**
 * May these two reports be compared as measurements of the same thing?
 *
 * Answers only the schema half of the question — whether the bodies are the
 * same shape. The coordinate half is `decideComparison`, and a caller needs
 * both to hold.
 *
 * @param a - The baseline report
 * @param b - The report being compared against it
 * @returns `null` when the two are comparable, or a refusal explaining why not
 */
export function refuseIncomparableSchemas(
  a: ReportEnvelope<unknown>,
  b: ReportEnvelope<unknown>,
): string | null {
  if (a.facet !== b.facet) {
    return `REFUSED: these reports measure different facets ('${a.facet}' and '${b.facet}'). There is no delta between two different measurements.`;
  }
  if (a.facetVersion !== b.facetVersion) {
    return (
      `REFUSED: facet '${a.facet}' body schema moved between these reports ` +
      `(v${String(a.facetVersion)} and v${String(b.facetVersion)}). Re-capture the older side; ` +
      'differences across a schema change belong to the schema, not to the subject.'
    );
  }
  return null;
}
