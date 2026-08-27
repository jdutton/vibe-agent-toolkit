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
import type { ReportEnvelope } from '../src/envelope/envelope.js';
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
    facet: 'perf',
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

/**
 * A report written to an OLDER body shape: one field dropped from every command
 * row.
 *
 * 🚩 This is how each facet's comparator suite exercises the sharp case a
 * `facetVersion` integer used to sit in front of — two PRE-CHANGE reports that
 * agree with each other perfectly, so a gate comparing only the two sides to
 * each other cannot see them. `harness/facet-compare.ts` validates each side
 * against THIS BUILD's strict schema, which does see them, and does so without
 * anyone having remembered to move a number.
 *
 * Shared rather than written per facet: the two suites that need it were
 * byte-identical, and a per-facet copy is a per-facet chance for one of them to
 * stop testing the case while still looking like it does.
 *
 * @param report - A well-formed report of any facet with a `commands` body
 * @param field - The command-row field an older build would not have written
 * @returns The same report with that field absent from every command
 */
export function reportMissingCommandField(
  report: ReportEnvelope<{ readonly commands: readonly object[] }>,
  field: string,
): ReportEnvelope<unknown> {
  return {
    ...report,
    body: {
      ...report.body,
      commands: report.body.commands.map((command) =>
        Object.fromEntries(Object.entries(command).filter(([key]) => key !== field)),
      ),
    },
  };
}
