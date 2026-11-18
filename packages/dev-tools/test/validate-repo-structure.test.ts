/**
 * Unit tests for the pure parts of `validate-repo-structure.ts`: the
 * severity-counts ratchet's source recognisers and the contraband listing merge.
 *
 * The whole-repo run in `validate-repo-structure.ts` can only report the lanes it
 * SAW. A lane it never saw produces no output at all, so a green run is not
 * evidence that the population is right. These tests pin the recognisers directly.
 *
 * What needs real git or a real refused read lives in
 * `integration/validate-repo-structure.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  classifySeverityCountsLane,
  mergeContrabandListings,
} from '../src/validate-repo-structure.js';

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
      const status = resultStatus(rows);
    `);
    expect(result).toEqual({ isLane: true, publishesCounts: true });
  });

  it('sees a lane that builds the shared report envelope, and reads it as publishing counts', () => {
    // `buildReport()` derives `status` AND `summary` from the findings in one
    // place, so a lane migrated onto the envelope spells neither a status
    // literal nor a counts property — the migration that FIXED the lane erased
    // it from the population (three commands went "stale" the day they moved).
    const result = classifySeverityCountsLane(`
      return buildReport<CheckData>({ examined, findings, data, gate });
    `);
    expect(result).toEqual({ isLane: true, publishesCounts: true });
  });

  it('sees a lane that describes its result through the shared describeIssues', () => {
    // `describeIssues` derives status, summary and the sentence through
    // `summarizeIssues`; a validator migrated onto it calls neither by name.
    const result = classifySeverityCountsLane(`
      return { path, type, ...describeIssues(issues, 'claude-plugin'), issues };
    `);
    expect(result).toEqual({ isLane: true, publishesCounts: true });
  });

  it('sees a lane that publishes the envelope through the run-integrity pass', () => {
    // `withRunIntegrity` is the pass every report takes on its way out, and it
    // rebuilds the envelope — so a lane that hands a report to it (the corpus
    // runner, writing each plugin's audit report) publishes `summary` without
    // spelling the builder's name.
    const result = classifySeverityCountsLane(`
      const document = withRunIntegrity(located, AUDIT_EXAMINED);
      return { audit: { status: document.status, findings_emitted: document.findings.length } };
    `);
    expect(result).toEqual({ isLane: true, publishesCounts: true });
  });

  it('sees a lane that imports the envelope builder under an alias', () => {
    // The alias is arbitrary, so the IMPORT is the structural fact the
    // recogniser keys on, not the call.
    const aliased = `
      import { buildReport as buildEnvelope } from '@vibe-agent-toolkit/schema';
      const r = buildEnvelope({ examined: 1, findings, data, gate: { strict: false } });
    `;
    expect(classifySeverityCountsLane(aliased)).toEqual({ isLane: true, publishesCounts: true });
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
      import type { SeverityCounts } from '@vibe-agent-toolkit/schema';
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
    const proseOnly = `
      export type GateStatus = 'success' | 'error';
      /** Someday this should extend SeverityCounts. It does not yet. */
      export interface GateResult { status: GateStatus; errors: string[]; }
    `;
    expect(classifySeverityCountsLane(proseOnly).publishesCounts).toBe(false);
  });

  // The first version of the derivation arm matched the BARE NAME
  // `SeverityCounts`. Each case below was certified by it while publishing no
  // distribution at all. Consuming a type is not publishing one.
  it.each([
    ['a string literal naming the type', `throw new Error('expected SeverityCounts, got nothing');`],
    ['a pure CONSUMER of the type', `export function render(c: SeverityCounts): string { return String(c); }`],
    ['a bare re-export', `export type { SeverityCounts } from './counts.js';`],
    ['an unrelated identifier of the same name', `const SeverityCounts = 0;`],
  ])('does not certify %s', (_label, body) => {
    const lane = `
      export type GateStatus = 'success' | 'error';
      export interface GateResult { status: GateStatus; errors: string[]; }
      ${body}
    `;
    expect(classifySeverityCountsLane(lane).publishesCounts).toBe(false);
  });

  it('sees the library result shape: a literal status with a `summary: SeverityCounts` field, and a `resultStatus` call', () => {
    // `ValidationResult` moved from `issueCounts` to `summary: SeverityCounts`
    // beside `status: 'ok' | 'findings'`. A recogniser that only knew the old
    // property name would read the migrated declaration as a REGRESSION.
    const declared = `
      import type { SeverityCounts } from '@vibe-agent-toolkit/schema';
      export interface LaneResult {
        status: 'ok' | 'findings';
        description: string;
        issues: string[];
        summary: SeverityCounts;
      }
    `;
    expect(classifySeverityCountsLane(declared)).toEqual({ isLane: true, publishesCounts: true });
    // Deriving the status through the ONE shared derivation is a lane on its own.
    const derived = `
      export function build(issues: Issue[]) { return { status: resultStatus(issues) }; }
    `;
    expect(classifySeverityCountsLane(derived).isLane).toBe(true);
    // A human sentence named `summary` is not a counts block.
    const sentence = `
      export interface LaneResult { status: 'ok' | 'findings'; issues: string[];
        summary: string;
      }
    `;
    expect(classifySeverityCountsLane(sentence)).toEqual({ isLane: true, publishesCounts: false });
  });

  it('still sees the counts field VANISH from a lane that merely imports the type', () => {
    // The regression the bucket notes for `phase-utils.ts`, `skills/package.ts`
    // and `validators/types.ts` exist to catch. All three conform via the counts
    // PROPERTY, not the shared collapse, and all three keep an
    // `import type { SeverityCounts }` line that a bare-name match would have
    // accepted on its own — silently certifying the very deletion under test.
    const regressed = `
      import type { SeverityCounts } from '@vibe-agent-toolkit/schema';
      export type GateStatus = 'success' | 'error';
      export interface GateResult { status: GateStatus; findings: string[]; }
      export function toCounts(c: SeverityCounts): SeverityCounts { return c; }
    `;
    expect(classifySeverityCountsLane(regressed)).toEqual({
      isLane: true,
      publishesCounts: false,
    });
  });
});

/**
 * The pure half of `contrabandPopulation`: git hands it NUL-delimited `ls-files -z`
 * listings (tracked, then untracked-not-ignored) and it must keep every publishable
 * text path exactly once, byte for byte.
 */
describe('mergeContrabandListings — the population the confidentiality gate scans', () => {
  it('lists each path once, however many git listings named it', () => {
    expect(mergeContrabandListings(['a.ts\0b.ts\0', 'b.ts\0c.ts\0'])).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('keeps a path that only the untracked listing names', () => {
    expect(mergeContrabandListings(['tracked.ts\0', 'nested/brand-new.ts\0'])).toContain('nested/brand-new.ts');
  });

  it('drops the empty entry the trailing NUL leaves, and an empty listing', () => {
    expect(mergeContrabandListings(['a.ts\0', ''])).toEqual(['a.ts']);
  });

  it('drops binaries, whose bytes the token scan cannot read as text', () => {
    expect(mergeContrabandListings(['logo.PNG\0fixture.zip\0bun.lock\0doc.md\0', ''])).toEqual(['doc.md']);
  });

  it('keeps a leading space, because it is part of the file name', () => {
    expect(mergeContrabandListings([' leading.ts\0', ''])).toEqual([' leading.ts']);
  });
});
