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

import type { ExitCommitment } from './commands.js';
import { recordExits } from './exit-record.js';
import { compareByCodeUnit } from './fingerprint.js';
import type { SequenceResult } from './sequence.js';
import type { CaptureRequest } from './types.js';

/** What the header records of one measured command — the fields of `SpecMeasurement` it reads. */
interface MeasuredCommand {
  /** What its children went without. */
  readonly removed: readonly string[];
  /** The command, with the commitment its exits were judged by. */
  readonly spec: { readonly name: string; readonly exit: ExitCommitment };
  readonly results: readonly SequenceResult[];
}

/**
 * Stamp a facet's body with the coordinate it was measured at.
 *
 * ⚠️ **There is no version argument, and adding one back is a defect.** What
 * shape a body is in is stated by the body, and read by the facet's own strict
 * schema — see `envelope/envelope.ts`'s header for why the two integers that
 * used to be stamped here were strictly weaker than that.
 *
 * @param facet - The facet's stable name, as it appears in the header
 * @param request - What the capture was asked to do; the coordinate comes from
 *   the instrument and subject it actually resolved, never from what was typed
 * @param body - The facet's own measurements
 * @param measured - Every measured command: the report records what its
 *   children ran WITHOUT, as they ran (never a recomputation from the
 *   environment the report is stamped in), and the exit commitment it was
 *   judged by with the code its repetitions shared
 * @returns A complete report envelope, ready to store
 */
export function buildReportEnvelope<TBody>(
  facet: string,
  request: CaptureRequest,
  body: TBody,
  measured: readonly MeasuredCommand[],
): ReportEnvelope<TBody> {
  return {
    facet,
    coordinate: {
      subject: request.subject.ref,
      subjectVersion: request.subject.version,
      instrument: request.instrument.version,
    },
    capturedAt: request.capturedAt,
    removedEnv: [...new Set(measured.flatMap((measurement) => measurement.removed))].sort(compareByCodeUnit),
    exits: measured.flatMap((measurement) => recordExits([measurement.spec], measurement.results)),
    body,
  };
}
