import { sanitizeGraderText } from './grader-text.js';
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
  /**
   * Every graded expectation, flattened across all evals. `evalId` names the eval
   * the entry came from — it is what lets a reader line the two `--baseline`
   * artifacts up PER EVAL instead of only in aggregate. Optional for the same
   * reason `runNonce` is: {@link parseGradingJson} builds a `NormalizedGrading`
   * from an externally produced grading.json, which carries no such attribution.
   */
  expectations: { text: string; passed: boolean; evidence?: string; evalId?: string }[];
  /** Per-run integrity nonce the experimenter copied from its prompt (if present). */
  runNonce?: string;
  /**
   * Which `--baseline` arm produced this report: `'with'` (the skill declared —
   * grading.json) or `'without'` (the control — baseline.json). Stamped by
   * {@link import('./fragment-merge.js').mergeFragmentsToGrading}, which is the
   * only producer that knows the arm. Optional for the same reason `runNonce` is:
   * {@link parseGradingJson} normalizes an externally produced grading.json that
   * legitimately carries no arm, and inventing one there would be a lie about
   * provenance rather than a missing field.
   */
  arm?: 'with' | 'without';
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
 * Thrown when a per-eval grader fragment's `arm` disagrees with the arm the
 * merge was told it is assembling. Deliberately distinct from
 * {@link GradingNonceError}: a fragment can carry a perfectly valid nonce for
 * THIS run and still belong to the other arm, and that is a different failure —
 * not a forgery, but a mix-up that would fold a control-arm verdict into the
 * treatment number (or the reverse). Either way the merged total is no longer a
 * measurement of one arm, which is the entire premise of the `--baseline` A/B,
 * so the merge refuses rather than emit a mislabelled artifact that downstream
 * readers would take as authoritative.
 */
export class GradingArmError extends Error {
  constructor(message: string) {
    super(
      `grader fragment arm mismatch: ${message}. Each --baseline arm is merged into its own ` +
        'artifact (grading.json = the WITH arm, baseline.json = the WITHOUT/control arm), and ' +
        'every fragment merged into one must come from that arm — a fragment with no `arm` ' +
        "belongs to the default 'with' arm. Mixing arms would make the merged pass count a " +
        'measurement of neither.',
    );
    this.name = 'GradingArmError';
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
    // Both halves are attacker-reachable and land in an operator-facing message: a
    // `.strict()` rejection puts the grader-CHOSEN KEY inside zod's own issue message,
    // and `path` is built from that same key. Sanitize both — this is the route that
    // has already been found twice in sibling modules, and it must not reopen here just
    // because today's only callers are tests.
    const firstIssue = result.error.issues[0];
    const path = sanitizeGraderText(firstIssue?.path.join('.') ?? '(root)');
    const detail = sanitizeGraderText(firstIssue?.message ?? 'unknown');
    throw new GradingSkewError(`missing/invalid field at "${path}" (${detail})`);
  }
  const { summary, expectations, runNonce, arm } = result.data;
  // Pass `evalId`/`arm` through WHEN PRESENT. The docblocks on NormalizedGrading
  // explain why they are optional — an externally produced grading.json legitimately
  // carries no attribution, and inventing one would be a lie about provenance. That
  // argues for omitting an ABSENT field, not for discarding a present one: the schema
  // already parses both, so dropping them silently narrowed the declared type and
  // threw away exactly the key a reader needs to line the two --baseline artifacts
  // up per eval.
  return {
    summary: { passed: summary.passed, total: summary.total },
    expectations: expectations.map(e => ({
      text: e.text,
      passed: e.passed,
      ...(e.evidence === undefined ? {} : { evidence: e.evidence }),
      ...(e.evalId === undefined ? {} : { evalId: e.evalId }),
    })),
    ...(runNonce === undefined ? {} : { runNonce }),
    ...(arm === undefined ? {} : { arm }),
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
