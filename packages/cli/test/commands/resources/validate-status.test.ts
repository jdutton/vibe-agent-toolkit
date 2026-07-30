/**
 * Unit tests for the verdict `vat resources validate` reports.
 *
 * One question — "issues → status" — must get ONE answer across every lane, in
 * ONE vocabulary: `success | warning | error`, meaning the worst ACTIONABLE
 * severity. This command used to answer it in a private two-value vocabulary
 * (`success | failed`), so the same underlying condition read differently here
 * than from `vat audit`, `vat skills validate`, or the library validators.
 *
 * The load-bearing case is info-only: it must report `success` (nothing to act
 * on) while `issueCounts.info` proves something WAS found. A test that only
 * covers clean-vs-error cannot tell the two vocabularies apart.
 *
 * All in-memory — the builder is pure, so no CLI spawn and no file system.
 */

import { describe, expect, it } from 'vitest';

import { buildIssuesOutputData } from '../../../src/commands/resources/validate.js';

/** Registry stub: no resource belongs to a collection, so collection stats stay empty. */
const NO_COLLECTIONS = { getResource: () => undefined };

const CONTEXT = {
  stats: { totalResources: 3, totalLinks: 7, linksByType: {} },
  validationMetadata: { validationMode: 'strict' as const },
  collectionStats: undefined,
  duration: 12,
};

/** One flattened issue at the given severity, all four severities available. */
function issue(severity: 'error' | 'warning' | 'info' | 'ignore', file = 'docs/a.md') {
  return {
    file,
    absPath: `/testroot-rv/${file}`,
    line: 4,
    column: 1,
    code: 'LINK_BROKEN_FILE' as const,
    severity,
    message: `${severity} finding`,
  };
}

/** Build the reported payload for a set of severities. */
function report(...severities: Array<'error' | 'warning' | 'info' | 'ignore'>) {
  return buildIssuesOutputData(severities.map((s) => issue(s)), CONTEXT, NO_COLLECTIONS);
}

describe('buildIssuesOutputData — reported status vocabulary', () => {
  it('reports `error` (never `failed`) when an error-severity issue fired', () => {
    const data = report('error');
    expect(data.status).toBe('error');
    expect(data.errorsFound).toBe(1);
    expect(data.filesWithErrors).toBe(1);
    expect(data.issueCounts).toEqual({ errors: 1, warnings: 0, info: 0 });
  });

  it('reports `warning` for a warning-only run — a verdict `failed` could not express', () => {
    const data = report('warning');
    expect(data.status).toBe('warning');
    expect(data.errorsFound).toBe(0);
    expect(data.filesWithErrors).toBe(0);
    expect(data.issueCounts).toEqual({ errors: 0, warnings: 1, info: 0 });
  });

  it('reports `success` for an info-only run WHILE counting the info issue', () => {
    // The discriminating case: `status` names the worst ACTIONABLE severity, so
    // an informational observation is not a failure — and that is only honest
    // because `issueCounts` rides beside it and the issue is still listed.
    const data = report('info');
    expect(data.status).toBe('success');
    expect(data.issueCounts?.info).toBe(1);
    expect(data.errorsFound).toBe(0);
    // The file still has a row, and the row still names the severity — as the
    // presence of an `info` count rather than as a per-issue `severity` field.
    expect(data.issues?.[0]).toEqual({
      file: 'docs/a.md',
      info: 1,
      codes: { LINK_BROKEN_FILE: 1 },
    });
  });

  it('counts an `ignore`-severity issue in no bucket at all', () => {
    // Suppressed by the adopter's own `validation.allow` config — counting it as
    // info would resurrect something they deliberately silenced.
    const data = report('ignore');
    expect(data.status).toBe('success');
    expect(data.issueCounts).toEqual({ errors: 0, warnings: 0, info: 0 });
  });

  it('collapses a mixed set to the worst actionable severity', () => {
    expect(report('info', 'warning', 'error').status).toBe('error');
    expect(report('ignore', 'info', 'warning').status).toBe('warning');
  });

  it('never emits the retired `failed` verdict', () => {
    const statuses = [
      report('error').status,
      report('warning').status,
      report('info').status,
      report('ignore').status,
    ];
    expect(statuses).not.toContain('failed');
  });
});
