/**
 * Shared report fixtures.
 *
 * Not a test file — no `.test.ts` suffix, so the runner does not collect it.
 * Extracted because the envelope and store suites both need a well-formed
 * report to vary one field of, and two copies of a coordinate literal drift
 * apart the moment the contract changes (which it already has once: `dirty` and
 * `workingFingerprint` arrived after both suites were written).
 */

import type { Coordinate } from '../src/envelope/coordinate.js';
import { REPORT_FORMAT_VERSION, type ReportEnvelope } from '../src/envelope/envelope.js';
import type { LoadReadings } from '../src/harness/types.js';

/**
 * A quiet machine, so contamination is never an accidental variable.
 *
 * Shared by every facet's fixtures: load is the harness's reading, not any one
 * facet's, and two copies would drift into two different ideas of "quiet".
 */
export const CLEAN_LOAD: LoadReadings = {
  before: 1,
  after: 1.2,
  cpus: 8,
  available: true,
  contaminated: false,
};

/** The same readings, but taken while the machine was busy. */
export const BUSY_LOAD: LoadReadings = { ...CLEAN_LOAD, before: 40, after: 44, contaminated: true };

/** A clean git subject, measured by a dev build of a known version. */
export const COORDINATE: Coordinate = {
  subject: { id: 'upstream-skills', source: 'https://github.com/example/skills.git#main' },
  subjectVersion: {
    kind: 'git',
    commit: 'a'.repeat(40),
    ref: 'main',
    dirty: false,
    workingFingerprint: null,
  },
  instrument: { version: '0.1.42', commit: '1'.repeat(40), dirty: false },
};

/**
 * Build a well-formed report, overriding only what a test varies.
 *
 * @param over - Envelope fields to replace
 * @returns A complete envelope
 */
export function makeReport(over: Partial<ReportEnvelope<unknown>> = {}): ReportEnvelope<unknown> {
  return {
    formatVersion: REPORT_FORMAT_VERSION,
    facet: 'perf',
    facetVersion: 1,
    coordinate: COORDINATE,
    capturedAt: '2026-08-09T00:00:00.000Z',
    body: { commands: [] },
    ...over,
  };
}

/**
 * Build a report at a coordinate varied from the baseline.
 *
 * @param over - Coordinate fields to replace
 * @returns A complete envelope at the varied coordinate
 */
export function makeReportAt(over: Partial<Coordinate>): ReportEnvelope<unknown> {
  return makeReport({ coordinate: { ...COORDINATE, ...over } });
}
