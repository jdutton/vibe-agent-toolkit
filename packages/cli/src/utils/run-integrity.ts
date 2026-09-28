/**
 * The run-integrity refusal: ONE mechanism for every gate that must never
 * answer `success` after checking nothing.
 *
 * ## The class this closes
 *
 * A gate that checked nothing produces the same document as a gate that was
 * removed. `vat resources check` shipped it (no `checks:` block → `status:
 * success`, exit 0), then `vat claude budget` (a path matching no working
 * location), then the repo's own audit quality gate (a green path over zero
 * parsed findings), then `vat resources validate` (a `--collection` matching
 * nothing → `filesScanned: 0`, exit 0), `vat claude marketplace validate` (no
 * `plugins/` to walk, no count published), `vat corpus scan` (an empty tree
 * "audits cleanly"), `vat verify`'s `packaged-content` phase (a typo'd glob
 * discovers no bundle and the phase reports `success`), then `vat skills
 * validate` (the same typo'd glob: one info line, no document, exit 0 — and
 * `vat validate` folded that into `success`) and `vat audit` (an existing tree
 * with nothing auditable: `status: success` over `filesScanned: 0`). Nine
 * instances of one shape, and each was first fixed by hand at its own site.
 * This module is where that hand-fixing stops: every site derives its refusal
 * through the same three functions, so the invariants below are properties of
 * the mechanism rather than of each author's memory.
 *
 * ## The invariants
 *
 * 1. **Code {@link RUN_INTEGRITY_CODE} — `RESOURCE_CHECK_BROKEN` — and never a
 *    sibling per site.** It is the registry's one run-integrity claim — *these
 *    assertions did not execute meaningfully, so the green means nothing* — and
 *    it is a registered REFUSAL code, which `ValidationConfigSchema` refuses as a
 *    `severity` or `allow` key — what makes it non-overridable by construction. A code per site would buy a consumer
 *    nothing the message does not already say while adding one more thing an
 *    adopter's CI has to know to look for.
 * 2. **Severity `error`, and not a parameter.** The one thing that must never be
 *    configurable about "the gate did not do its job" is whether it gates.
 * 3. **Derived once, in the writer, from the verb's declared denominator.**
 *    {@link withRunIntegrity} is the one function every lane's `Report` passes
 *    through on its way out, so deriving the refusal there lands it after
 *    `resolveIssueSeverity` and `applyAllowFilter` and makes "denominator zero,
 *    status clean" unrepresentable rather than merely unwritten. A pure
 *    function, unit-testable without I/O — no verb decides this at its own site.
 * 4. **ONE finding per run**, however many things went unmatched. The claim is
 *    about the RUN; one per argument is per-finding duplication.
 * 5. **The message says what did not run and what the operator can do.** It
 *    must not claim the corpus is broken — it claims the run is not a verdict.
 * 6. **stderr may still carry a human warning; the document and the exit code
 *    must agree with it.** The human channel and the machine channel were what
 *    disagreed in every shipped instance, and only the machine channel gates.
 */

import {
  buildReport,
  CODE_REGISTRY,
  toFindings,
  type IssueCode,
  type RefusalCode,
  type Report,
  type ValidationIssue,
} from '@vibe-agent-toolkit/schema';

/**
 * The code every run-integrity refusal carries.
 *
 * 🔑 **One code for every refusal, on purpose.** A statement that would not
 * compile, a corpus with no members, a run with no rules, a run that was killed,
 * a scan that matched no file, a walk that missed a declared plugin, a phase that
 * found no bundle — all are the same claim to a consumer, and they need the
 * identical non-overridability, which the registry grants by registering it as
 * a REFUSAL — a kind `ValidationConfigSchema` refuses as a `severity` or `allow` key.
 */
export const RUN_INTEGRITY_CODE = 'RESOURCE_CHECK_BROKEN' satisfies RefusalCode;

/**
 * A run-integrity refusal: the non-overridable code, at `error`, always.
 *
 * The severity is not a parameter and must not become one. Every caller is
 * reporting that the gate did not do its job, and the one thing that must never
 * be configurable about that report is whether it gates.
 *
 * @param message - What did not run, and what the operator can do about it
 * @returns The finding
 */
export function runIntegrityFinding(message: string): ValidationIssue {
  return { code: RUN_INTEGRITY_CODE, severity: 'error', message };
}

/**
 * The refusal for a run whose denominator is zero — nothing was checked.
 *
 * 🪤 **It asks the DENOMINATOR, never the config.** A builder cannot see why
 * nothing ran and deliberately does not ask. An absent config block, a filter
 * that matched nothing, a glob with a typo, a directory that was never built —
 * all arrive as the same document, and all of them are a gate that asserted
 * nothing. The message is where a site names the likely causes and the remedy.
 *
 * 🪤 **One report per situation.** A run that already carries a run-integrity
 * finding (an interrupted run, say) has the more specific of the two claims on
 * the document, so this stands down rather than handing the operator two reports
 * about one situation. Nothing weaker is needed: every such finding is `error`,
 * so the status is already refused.
 *
 * @param denominator - How many things the run actually checked
 * @param issues - What the run already found, so an existing run-integrity
 *   report is not duplicated
 * @param message - The site's own account of what did not run and what to do;
 *   evaluated lazily so a populated run pays nothing for it
 * @returns The one finding, or nothing when at least one thing was checked
 */
export function nothingCheckedFinding(
  denominator: number,
  issues: readonly ValidationIssue[],
  message: () => string,
): readonly ValidationIssue[] {
  if (denominator > 0) return [];
  if (issues.some((issue) => issue.code === RUN_INTEGRITY_CODE)) return [];
  return [runIntegrityFinding(message())];
}

/**
 * What a report's `examined` counts, and what an operator should check when
 * it is zero — the two facts only the verb knows, so {@link withRunIntegrity}
 * can name them without asking why the denominator is zero (🪤 above).
 */
export interface ExaminedDeclaration {
  /** What `examined` counts, plural noun: 'files', 'skills', 'rows of the population', 'search roots'. */
  readonly unit: string;
  /** What an operator should check when it is zero — the site-specific remedy. */
  readonly whenZero: string;
}

/**
 * The single point every completed {@link Report} passes through on its way
 * out: adds the one `RESOURCE_CHECK_BROKEN` refusal-as-finding when `examined`
 * is zero, so no verb decides this at its own site (invariant 3 above).
 *
 * Stands down (returns `report` unchanged) in three cases: `status: 'error'`
 * — a run that did not finish is not a run that examined nothing, and its own
 * `error` already carries the refusal; `examined > 0` — the positive control;
 * and a findings list that already carries a refusal-kind code (invariant 4 —
 * one refusal per run, whichever the site already published wins over the
 * generic one).
 *
 * @param report - The completed or failed report, as the verb built it
 * @param examined - What `examined` counts and the remedy for zero
 * @returns `report` unchanged, or rebuilt with the one refusal finding added
 */
export function withRunIntegrity<T>(report: Report<T>, examined: ExaminedDeclaration): Report<T> {
  if (
    report.status === 'error'
    || report.examined > 0
    || report.findings.some((f) => Object.hasOwn(CODE_REGISTRY, f.code) && CODE_REGISTRY[f.code as IssueCode].kind === 'refusal')
  ) {
    return report;
  }
  return buildReport({
    examined: report.examined,
    findings: [
      ...report.findings,
      ...toFindings([runIntegrityFinding(`Nothing was examined: 0 ${examined.unit}. ${examined.whenZero}`)]),
    ],
    data: report.data,
    gate: report.gate,
    durationMs: report.durationMs,
  });
}
