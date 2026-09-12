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

import {
  buildIssuesOutputData,
  buildValidationDocument,
  exitCodeForValidateRun,
} from '../../../src/commands/resources/validate.js';

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

/**
 * The run-integrity refusal: a run that scanned NO file must never answer
 * `success`.
 *
 * ## The defect
 *
 * `vat resources validate --collection no-such-collection` reported
 * `status: success`, `filesScanned: 0`, exit 0. A `--collection` name that
 * matches nothing (a typo, a renamed collection) filters every resource out,
 * and zero issues over zero files serializes identically to "every file in the
 * collection is clean". A path argument naming a tree with no markdown does the
 * same through the other builder. Neither the registry nor the CLI had a
 * zero-resource refusal, and no test covered the zero case.
 *
 * ## Why the assertion is on the document builder
 *
 * Both outcomes — clean and with-issues — go through `buildValidationDocument`,
 * so deriving the refusal there makes "filesScanned: 0, status: success"
 * unrepresentable by construction rather than merely unwritten. The precedent is
 * `vat resources check` and `vat claude budget`: a non-overridable
 * `RESOURCE_CHECK_BROKEN` at `error`, ONE per run, shared through
 * `run-integrity.ts`.
 */
describe('buildValidationDocument — a run that scanned nothing is not a verdict', () => {
  /** The code the run-integrity refusal carries, shared with `vat resources check`. */
  const RUN_INTEGRITY_CODE = 'RESOURCE_CHECK_BROKEN';

  /** A context whose scan matched no resource — what a stray `--collection` produces. */
  const NOTHING_SCANNED = {
    ...CONTEXT,
    stats: { totalResources: 0, totalLinks: 0, linksByType: {} },
    collection: 'no-such-collection',
  };

  it('refuses a clean run over zero files with ONE RESOURCE_CHECK_BROKEN at error', () => {
    // 🔑 The reproduced defect. Delete the guard and this reds: no issue was
    // flattened, so the success builder answers `success` over `filesScanned: 0`.
    const data = buildValidationDocument([], NOTHING_SCANNED, NO_COLLECTIONS, false);

    expect(data.status).toBe('error');
    expect(data.filesScanned).toBe(0);
    expect(data.issueCounts).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(data.issueSummary).toEqual({ [RUN_INTEGRITY_CODE]: 1 });
    // ONE row, and it is not a file: the claim is about the run.
    expect(data.issues).toHaveLength(1);
    expect(data.issues?.[0]).toMatchObject({ errors: 1, codes: { [RUN_INTEGRITY_CODE]: 1 } });
    // No file carried the error, so no file is counted as carrying one.
    expect(data.filesWithErrors).toBe(0);
  });

  it('names the filter that matched nothing and what to do about it', () => {
    const data = buildValidationDocument([], NOTHING_SCANNED, NO_COLLECTIONS, true);
    const row = data.issues?.[0] as { issues: Array<{ code: string; message: string }> };
    const [finding] = row.issues;

    expect(finding?.code).toBe(RUN_INTEGRITY_CODE);
    expect(finding?.message).toContain('no-such-collection');
    expect(finding?.message).toContain('vat resources scan');
    // It claims the RUN is not a verdict — never that the corpus is broken.
    expect(finding?.message).not.toMatch(/broken link|invalid/i);
  });

  it('stays silent over a populated corpus, however clean', () => {
    // 🔑 The over-correction guard: an ordinary clean run must not start
    // reporting an error.
    const data = buildValidationDocument([], CONTEXT, NO_COLLECTIONS, false);

    expect(data.status).toBe('success');
    expect(data.filesScanned).toBe(3);
    expect(data.issues).toBeUndefined();
  });

  it('adds the refusal beside real findings when those came from a zero-file scan', () => {
    // A location-less library finding (a config-level error, say) over a
    // filter that matched nothing: the run is still not a verdict about files.
    const data = buildValidationDocument([issue('warning')], NOTHING_SCANNED, NO_COLLECTIONS, false);

    expect(data.status).toBe('error');
    expect(data.issueSummary?.[RUN_INTEGRITY_CODE]).toBe(1);
    expect(data.issueCounts).toEqual({ errors: 1, warnings: 1, info: 0 });
  });
});

describe('exitCodeForValidateRun — the exit code agrees with the document', () => {
  it('exits 1 when the document refused the run, even though the library found no error', () => {
    // The library's `hasErrors` is computed over the WHOLE project; the refusal
    // is derived over what was REPORTED. Both must fail the run.
    expect(exitCodeForValidateRun(false, { status: 'error' })).toBe(1);
  });

  it('still exits 1 on a library error the --collection filter hid from the document', () => {
    expect(exitCodeForValidateRun(true, { status: 'success' })).toBe(1);
  });

  it('exits 0 only when both agree the run is clean', () => {
    expect(exitCodeForValidateRun(false, { status: 'success' })).toBe(0);
    expect(exitCodeForValidateRun(false, { status: 'warning' })).toBe(0);
  });
});
