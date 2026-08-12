/**
 * The envelope's whole job is to refuse. These tests pin *that it does* — a
 * reader that quietly accepts a report from another format or another body
 * schema produces diffs that belong to the schema change rather than to the
 * subject, which is the most expensive wrong answer this package can give.
 */

import { describe, expect, it } from 'vitest';

import {
  readEnvelope,
  refuseIncomparableSchemas,
  REPORT_FORMAT_VERSION,
  type ReportEnvelope,
} from '../src/envelope/envelope.js';

import { COORDINATE, makeReport } from './report-fixtures.js';

/**
 * A stored report as a plain object, so a test can vary any field including
 * ones the typed builder would reject.
 *
 * @param over - Fields to replace
 * @returns A plain object as it would be read back off disk
 */
function stored(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...makeReport(), ...over };
}

/**
 * Read a stored object as an envelope, failing the test if it does not parse.
 *
 * @param over - Fields to replace on the baseline report
 * @returns The parsed envelope
 */
function envelope(over: Record<string, unknown> = {}): ReportEnvelope<unknown> {
  const result = readEnvelope(stored(over));
  if (!result.ok) throw new Error(result.refusal);
  return result.envelope;
}

describe('readEnvelope', () => {
  it('accepts a well-formed report and preserves the body verbatim', () => {
    const result = readEnvelope(stored());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.refusal);
    expect(result.envelope.facet).toBe('perf');
    expect(result.envelope.coordinate).toEqual(COORDINATE);
    // The body passes through untouched: the envelope reader deliberately does
    // not validate bodies, because it does not know their shapes.
    expect(result.envelope.body).toEqual({ commands: [] });
  });

  it('refuses a report written by another envelope format', () => {
    const result = readEnvelope(stored({ formatVersion: REPORT_FORMAT_VERSION + 1 }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toMatch(/^REFUSED:/);
    expect(result.refusal).toContain(String(REPORT_FORMAT_VERSION + 1));
  });

  it('refuses a value that is not an envelope at all', () => {
    const result = readEnvelope({ hello: 'world' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toMatch(/^REFUSED:/);
  });

  it('refuses an envelope carrying an unknown header field', () => {
    // Strict on purpose: this package validates what it writes itself, and an
    // unrecognised header field means a producer this reader does not model.
    const result = readEnvelope(stored({ wallMs: 1234 }));
    expect(result.ok).toBe(false);
  });

  it('refuses a coordinate whose commit was left as a branch name', () => {
    // The positive control for pinning: a coordinate is only comparable once
    // the ref has been resolved, so an unresolved one must not parse as valid.
    const result = readEnvelope(
      stored({
        coordinate: { ...COORDINATE, subjectVersion: { kind: 'git', commit: '', ref: 'main', dirty: false, workingFingerprint: null } },
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('refuseIncomparableSchemas', () => {
  it('permits two reports of the same facet at the same body version', () => {
    expect(refuseIncomparableSchemas(envelope(), envelope())).toBeNull();
  });

  it('permits reports whose only difference is the capture time', () => {
    // capturedAt moves on every run; comparing it would report a difference
    // between two identical measurements.
    const later = envelope({ capturedAt: '2026-12-25T12:00:00.000Z' });
    expect(refuseIncomparableSchemas(envelope(), later)).toBeNull();
  });

  it('refuses two different facets', () => {
    const refusal = refuseIncomparableSchemas(envelope(), envelope({ facet: 'io' }));
    expect(refusal).toMatch(/^REFUSED:/);
    expect(refusal).toContain('perf');
    expect(refusal).toContain('io');
  });

  it('refuses one facet across a body schema bump', () => {
    const refusal = refuseIncomparableSchemas(envelope(), envelope({ facetVersion: 2 }));
    expect(refusal).toMatch(/^REFUSED:/);
    expect(refusal).toContain('v1');
    expect(refusal).toContain('v2');
  });
});
