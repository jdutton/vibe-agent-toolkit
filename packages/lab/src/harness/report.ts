/**
 * Turning a facet's body into a complete report.
 *
 * The header is not the facet's to invent. A report's coordinate is the whole
 * point of the lab — a body without an accurate `subject`/`subjectVersion`/
 * `instrument` triple is comparable to nothing — and every facet derives it from
 * the same request in the same way. Written per facet, the derivation is short
 * enough to look obviously right and mechanical enough to drift: a facet that
 * stamped `instrument.version` while measuring a different resolved instrument
 * would produce a report that is well-formed, plausible, and lying about axis C.
 *
 * So the facet supplies the two things that are genuinely its own — its name and
 * its body — and the harness stamps everything else.
 */

import type { ReportEnvelope } from '../envelope/envelope.js';
import { REPORT_FORMAT_VERSION } from '../envelope/envelope.js';

import type { CaptureRequest } from './types.js';

/**
 * Stamp a facet's body with the coordinate it was measured at.
 *
 * @param facet - The facet's stable name, as it appears in the header
 * @param facetVersion - The facet's body-schema version
 * @param request - What the capture was asked to do; the coordinate comes from
 *   the instrument and subject it actually resolved, never from what was typed
 * @param body - The facet's own measurements
 * @returns A complete report envelope, ready to store
 */
export function buildReportEnvelope<TBody>(
  facet: string,
  facetVersion: number,
  request: CaptureRequest,
  body: TBody,
): ReportEnvelope<TBody> {
  return {
    formatVersion: REPORT_FORMAT_VERSION,
    facet,
    facetVersion,
    coordinate: {
      subject: request.subject.ref,
      subjectVersion: request.subject.version,
      instrument: request.instrument.version,
    },
    capturedAt: request.capturedAt,
    body,
  };
}
