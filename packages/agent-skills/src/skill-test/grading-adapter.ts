import { GradingReportSchema } from './grading-schema.js';

/**
 * Thrown when grading.json does not match the canonical skill-creator shape
 * (see grading-schema.ts / skill-creator references/schemas.md). vat refuses to
 * limp along on malformed grading data — a wrong shape silently flowing
 * downstream causes confusing failures far from the real cause.
 */
export class GradingSkewError extends Error {
  constructor(message: string) {
    super(
      `grading.json shape skew: ${message}. Expected skill-creator's grading.json shape ` +
        '(a single flat object with top-level `expectations` and `summary`); see ' +
        'docs/skill-test-grading-schema.md. Re-sync the vendored skill-creator / adopted shapes.',
    );
    this.name = 'GradingSkewError';
  }
}

export interface NormalizedGrading {
  summary: { passed: number; total: number };
  expectations: { text: string; passed: boolean; evidence?: string }[];
  /** Per-run integrity nonce the experimenter copied from its prompt (if present). */
  runNonce?: string;
}

/**
 * Thrown when a per-eval grader fragment's integrity nonce is absent or does not
 * match the secret nonce the harness stamped into that grader's prompt for THIS
 * run. A missing/wrong nonce means the fragment was not produced by a grader we
 * prompted — most likely forged or left behind by untrusted skill code in the
 * shared sandbox — so the verdict merged from it cannot be trusted.
 */
export class GradingNonceError extends Error {
  constructor(message: string) {
    super(
      `grader integrity check failed: ${message}. The harness stamps a secret per-run ` +
        'nonce into each grader prompt (delivered only via stdin, never written to disk) ' +
        'and requires every per-eval grader fragment to echo it; a missing or wrong nonce ' +
        'means the fragment was not produced by the grader we prompted and is rejected.',
    );
    this.name = 'GradingNonceError';
  }
}

/**
 * Detect the common per-eval nested mistake: `{ evals: [ { expectations, ... } ] }`
 * with no top-level `expectations`. The grader (an LLM) reaches for this when the
 * top-level shape is under-specified; we name it explicitly so the fix is obvious.
 */
function looksPerEvalNested(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return Array.isArray(obj['evals']) && !('expectations' in obj);
}

export function parseGradingJson(raw: unknown): NormalizedGrading {
  const result = GradingReportSchema.safeParse(raw);
  if (!result.success) {
    if (looksPerEvalNested(raw)) {
      throw new GradingSkewError(
        'top-level `expectations` is missing — results were nested under an `evals` array. ' +
          'grading.json must be ONE flat object whose top-level `expectations` lists every ' +
          'graded expectation across all evals',
      );
    }
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path.join('.') ?? '(root)';
    throw new GradingSkewError(`missing/invalid field at "${path}" (${firstIssue?.message ?? 'unknown'})`);
  }
  const { summary, expectations, runNonce } = result.data;
  return {
    summary: { passed: summary.passed, total: summary.total },
    expectations: expectations.map(e => ({
      text: e.text,
      passed: e.passed,
      ...(e.evidence === undefined ? {} : { evidence: e.evidence }),
    })),
    ...(runNonce === undefined ? {} : { runNonce }),
  };
}

/** The authoritative eval verdict, recomputed from per-expectation `passed` flags. */
export interface GradingVerdict {
  passed: number;
  total: number;
  allPassed: boolean;
}

/**
 * Reconcile the grader's self-reported `summary` against the authoritative
 * per-expectation `passed` flags and return the recomputed verdict.
 *
 * The grader emits BOTH an aggregate `summary.{passed,total}` AND one
 * `expectations[]` entry per graded expectation (each with its own `passed`).
 * The schema (docs/skill-test-grading-schema.md) defines `summary` as the exact
 * aggregate of `expectations`, so the two MUST agree. We never trust the
 * self-reported summary alone — a grader that emits `summary {5,5}` alongside a
 * failing expectation would otherwise be a false green.
 *
 * Throws {@link GradingSkewError} when:
 *  - there are zero expectations (the grader graded NOTHING — an error, never a
 *    pass); or
 *  - the summary disagrees with the recomputed counts (a grader bug, surfaced
 *    loudly rather than silently flowing a wrong verdict downstream).
 */
export function reconcileGrading(report: NormalizedGrading): GradingVerdict {
  const computedPassed = report.expectations.filter(e => e.passed).length;
  const computedTotal = report.expectations.length;

  if (computedTotal === 0) {
    throw new GradingSkewError(
      'the grader recorded zero expectations — nothing was graded, so this can never be a pass. ' +
        'A valid grading.json lists every graded expectation in top-level `expectations`',
    );
  }

  const { passed, total } = report.summary;
  if (passed !== computedPassed || total !== computedTotal) {
    throw new GradingSkewError(
      `the grader's summary disagrees with its expectations: summary={passed:${passed},total:${total}} ` +
        `but expectations recompute to {passed:${computedPassed},total:${computedTotal}}. ` +
        '`summary` must be the exact aggregate of `expectations` (one entry per graded expectation)',
    );
  }

  return { passed: computedPassed, total: computedTotal, allPassed: computedPassed === computedTotal };
}
