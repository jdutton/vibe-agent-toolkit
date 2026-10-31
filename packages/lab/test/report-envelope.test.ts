/**
 * A report's `removedEnv` is what its measured children ran WITHOUT, taken from
 * the children's own runs — never recomputed from the environment the report
 * happens to be stamped in, which can differ from the one the children saw.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildReportEnvelope } from '../src/harness/report.js';
import type { CaptureRequest } from '../src/harness/types.js';

import { COORDINATE } from './report-fixtures.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The fields of a capture request the envelope reads. */
const REQUEST = {
  subject: { ref: COORDINATE.subject, version: COORDINATE.subjectVersion },
  instrument: { version: COORDINATE.instrument },
  env: { set: {}, unset: [] },
  capturedAt: '2026-10-31T00:00:00.000Z',
} as unknown as CaptureRequest;

describe('buildReportEnvelope — removedEnv', () => {
  it("is the sorted union of every measured command's children's removed names", () => {
    const envelope = buildReportEnvelope('perf', REQUEST, {}, [{ removed: ['XDG_CONFIG_HOME', 'TMPDIR'] }, { removed: ['TMPDIR', 'GIT_EXEC_PATH'] }]);

    expect(envelope.removedEnv).toStrictEqual(['GIT_EXEC_PATH', 'TMPDIR', 'XDG_CONFIG_HOME']);
  });

  it('names nothing the children did not go without, whatever the stamping environment carries', () => {
    vi.stubEnv('VAT_LAB_STAMPED_AFTER_THE_RUN', 'x');

    expect(buildReportEnvelope('perf', REQUEST, {}, []).removedEnv).toStrictEqual([]);
  });
});
