/**
 * Scaffolding every capture suite needs, and none of it facet-specific.
 *
 * Not a test file — no `.test.ts` suffix, so the runner does not collect it.
 * Extracted because `io` and `parse` (and any facet after them) ask the same
 * three questions before they get to their own: what subject is the probe
 * standing in for, did the capture stamp the coordinate it actually measured,
 * and does the body it produced satisfy the facet's own schema. Written per
 * suite, those drift — one suite checking `capturedAt` and another not — and a
 * facet whose envelope was never asserted looks exactly as tested as one whose
 * was.
 */

import { expect } from 'vitest';

import { REPORT_FORMAT_VERSION, type ReportEnvelope } from '../src/envelope/envelope.js';
import type { ResolvedSubject } from '../src/harness/types.js';

import { PROBE_VERSION } from './command-probe.js';

/**
 * A subject literal pointing at a probe's directory.
 *
 * Constructed rather than resolved: `resolveSubject` runs git, and a capture
 * suite is about what happens to a measurement, not about how axis B is
 * discovered.
 *
 * @param path - The probe's working directory
 * @param id - Subject id, so two suites' reports stay distinguishable
 * @param fingerprint - Axis B's content fingerprint, likewise
 * @returns A snapshot-kind subject at that path
 */
export function probeSubject(path: string, id: string, fingerprint: string): ResolvedSubject {
  return {
    path,
    ref: { id, source: path },
    version: { kind: 'snapshot', fingerprint, fileCount: 3 },
  };
}

/** What a capture must have stamped on the report it produced. */
export interface ExpectedStamp {
  readonly facet: string;
  readonly facetVersion: number;
  readonly subject: ResolvedSubject;
  /** The caller owns the clock, so this exact string must come back. */
  readonly capturedAt: string;
}

/**
 * Assert that a capture stamped the coordinate it actually measured.
 *
 * The coordinate is the whole point of the lab — a body without an accurate
 * subject/version/instrument triple is comparable to nothing — so every facet
 * asserts all three, and asserts them the same way.
 *
 * @param report - The captured report
 * @param expected - See {@link ExpectedStamp}
 */
export function expectStamp(report: ReportEnvelope<unknown>, expected: ExpectedStamp): void {
  expect(report.formatVersion).toBe(REPORT_FORMAT_VERSION);
  expect(report.facet).toBe(expected.facet);
  expect(report.facetVersion).toBe(expected.facetVersion);
  expect(report.coordinate).toEqual({
    subject: expected.subject.ref,
    subjectVersion: expected.subject.version,
    instrument: PROBE_VERSION,
  });
  expect(report.capturedAt).toBe(expected.capturedAt);
}

/**
 * Assert that a body satisfies its facet's own schema, saying which field failed.
 *
 * Reported through the assertion rather than as a bare boolean: a strict schema
 * rejecting one field should name it, or a failure here costs a debugging
 * session to locate.
 *
 * @param schema - The facet's body schema
 * @param body - The body the capture produced
 */
export function expectBodyMatchesSchema(
  schema: { safeParse(value: unknown): { success: true } | { success: false; error: Error } },
  body: unknown,
): void {
  const parsed = schema.safeParse(body);
  expect(parsed.success ? null : parsed.error.message).toBeNull();
}
