/**
 * Unit tests for the severity-counts ratchet's source recognisers.
 *
 * The whole-repo run in `validate-repo-structure.ts` can only report the lanes it
 * SAW. A lane it never saw produces no output at all, so a green run is not
 * evidence that the population is right. These tests pin the recognisers directly.
 */
import { describe, expect, it } from 'vitest';

import { classifySeverityCountsLane } from '../src/validate-repo-structure.js';

/** A lane whose status is a string literal from the vocabulary, with findings beside it. */
const LITERAL_STATUS_LANE = `
export interface Result {
  status: 'success' | 'error';
  issues: Issue[];
}
export function run(): Result {
  return { status: 'error', issues: [] };
}
`;

/** The shape `corpus/report.ts` uses: a NAMED status type, no vocabulary literal on the line. */
const NAMED_STATUS_TYPE_LANE = `
export type ReviewStatus = 'ok' | 'error' | 'skipped';

export interface ReviewSummary {
  reviewed: number;
  failed: number;
}

export interface ReviewOutcome {
  status: ReviewStatus;
  duration_ms: number;
  summary?: ReviewSummary;
  errors?: string[];
}
`;

/** A per-severity distribution published under a name outside the known set. */
const SHAPED_COUNTS_LANE = `
export type AuditStatus = 'success' | 'warning' | 'error';

export interface AuditSummary {
  errors: number;
  warnings: number;
  info: number;
  files_scanned: number;
}

export interface AuditOutcome {
  status: AuditStatus;
  summary?: AuditSummary;
}
`;

describe('classifySeverityCountsLane — regression guards', () => {
  it('sees a lane that calls the shared collapse, whatever it names its findings', () => {
    const result = classifySeverityCountsLane(`
      const status = calculateValidationStatus(rows);
    `);
    expect(result).toEqual({ isLane: true, publishesCounts: true });
  });

  it('sees a literal-status lane and marks it nonconforming without counts', () => {
    expect(classifySeverityCountsLane(LITERAL_STATUS_LANE)).toEqual({
      isLane: true,
      publishesCounts: false,
    });
  });

  it('does not read prose ABOUT the contract as the contract', () => {
    const result = classifySeverityCountsLane(`
      /** Call countBySeverity(result.allErrors) and publish issueCounts beside the status. */
      export const NOT_A_LANE = 1;
    `);
    expect(result).toEqual({ isLane: false, publishesCounts: false });
  });

  it('ignores a file that emits no verdict at all', () => {
    expect(classifySeverityCountsLane('export const x = 1;\n').isLane).toBe(false);
  });
});

describe('classifySeverityCountsLane — named status types', () => {
  it('sees a lane whose status is a NAMED type rather than a literal', () => {
    expect(classifySeverityCountsLane(NAMED_STATUS_TYPE_LANE).isLane).toBe(true);
  });

  it("sees a declared vocabulary whose only success value is 'ok'", () => {
    const okOnly = `
      export type RunStatus = 'ok' | 'skipped';
      export interface RunOutcome { status: RunStatus; }
    `;
    expect(classifySeverityCountsLane(okOnly).isLane).toBe(true);
  });

  it('judges a named-status lane WITHOUT counts as nonconforming', () => {
    expect(classifySeverityCountsLane(NAMED_STATUS_TYPE_LANE).publishesCounts).toBe(false);
  });

  it('accepts a per-severity distribution published under another name', () => {
    expect(classifySeverityCountsLane(SHAPED_COUNTS_LANE)).toEqual({
      isLane: true,
      publishesCounts: true,
    });
  });

  it('does not mistake a lone `errors` field for a per-severity distribution', () => {
    const errorsOnly = `
      export type GateStatus = 'success' | 'error';
      export interface GateResult { status: GateStatus; errors: string[]; }
    `;
    expect(classifySeverityCountsLane(errorsOnly).publishesCounts).toBe(false);
  });

  it('accepts a lane that DERIVES its counts block from the shared type', () => {
    // The refactor that strengthens a lane must not erase it. Deriving from
    // `SeverityCounts` deletes the three hand-declared properties the shape
    // recogniser keys on, so without a dedicated arm the improved file reads as
    // a REGRESSION — which is exactly what happened to `corpus/report.ts`.
    const derived = `
      import type { SeverityCounts } from '@vibe-agent-toolkit/agent-schema';
      export type GateStatus = 'success' | 'error';
      export interface GateSummary extends SeverityCounts { files_scanned: number; }
      export interface GateResult { status: GateStatus; summary: GateSummary; }
    `;
    expect(classifySeverityCountsLane(derived)).toEqual({
      isLane: true,
      publishesCounts: true,
    });
  });

  it('does not read a MENTION of the shared type in prose as derivation', () => {
    // Comment stripping is what makes the bare-name match safe; if it ever
    // regressed, a doc comment discussing `SeverityCounts` would silently
    // certify a lane that publishes nothing.
    const proseOnly = `
      export type GateStatus = 'success' | 'error';
      /** Someday this should extend SeverityCounts. It does not yet. */
      export interface GateResult { status: GateStatus; errors: string[]; }
    `;
    expect(classifySeverityCountsLane(proseOnly).publishesCounts).toBe(false);
  });
});
