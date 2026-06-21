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
  const { summary, expectations } = result.data;
  return {
    summary: { passed: summary.passed, total: summary.total },
    expectations: expectations.map(e => ({
      text: e.text,
      passed: e.passed,
      ...(e.evidence === undefined ? {} : { evidence: e.evidence }),
    })),
  };
}
