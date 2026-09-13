import type { SeverityCounts } from './validation-issue.js';

/**
 * The exit-code contract every VAT process ends on.
 *
 * ONE vocabulary, three values, and every `process.exit(…)` in the repo names
 * one of them (the `no-literal-process-exit` lint rule refuses a bare number).
 * A CI wrapper reads `$?` the same way for every verb:
 *
 * ```sh
 * case $? in 0) ;; 1) echo findings ;; *) echo broken; exit 1 ;; esac
 * ```
 *
 * - {@link ExitCode.OK} — the command ran and found nothing at error severity.
 *   Warnings and informational findings are published in the document, not in
 *   the exit code (a command's `--strict` promotes warnings, where it offers one).
 * - {@link ExitCode.FINDINGS} — the command ran to completion and what it
 *   examined failed its gate: an error-severity finding, a failed eval, a
 *   measured change. The document says which.
 * - {@link ExitCode.ERROR} — the command could not do its job: a usage
 *   mistake, an unreadable input, a missing dependency, an internal failure.
 *   Whether the fault is the operator's or VAT's is said in the message and,
 *   where a verb has more than one such cause, in a `reason` beside it — never
 *   in a fourth exit code, because 3 and 4 meant different things in different
 *   verbs and a wrapper cannot read a number it has to look up per command.
 *
 * Why the finer distinctions were folded rather than kept: the five vocabularies
 * this replaced disagreed on what `1` meant, and the orchestrator that runs
 * verbs as phases read all five as one. A code is only a contract when every
 * producer means the same thing by it.
 */
export const ExitCode = Object.freeze({
  /** The command ran; nothing at error severity. */
  OK: 0,
  /** The command ran to completion and what it examined failed its gate. */
  FINDINGS: 1,
  /** The command could not do its job — usage, environment, or internal failure. */
  ERROR: 2,
} as const);

/** One of the three exit codes. */
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

const EXIT_CODE_VALUES: ReadonlySet<number> = new Set<number>(Object.values(ExitCode));

/**
 * Whether `code` is one of the three contract values.
 *
 * The orchestrator uses this to refuse a phase status it cannot interpret:
 * a phase that ends on anything else is a defect to surface, not a number to
 * round to "error".
 */
export function isExitCode(code: number): code is ExitCodeValue {
  return EXIT_CODE_VALUES.has(code);
}

/**
 * The exit code a completed run with these finding counts ends on.
 *
 * Errors fail the gate; warnings do only under `strict`; informational
 * findings never do. Never answers {@link ExitCode.ERROR}: a run that produced
 * counts completed, and a completed run is not a broken one.
 *
 * @param counts - The run's per-severity counts
 * @param options - `strict`: treat warnings as failing
 */
export function exitCodeForSeverityCounts(
  counts: SeverityCounts,
  options: { readonly strict?: boolean } = {},
): typeof ExitCode.OK | typeof ExitCode.FINDINGS {
  if (counts.errors > 0) return ExitCode.FINDINGS;
  if (options.strict === true && counts.warnings > 0) return ExitCode.FINDINGS;
  return ExitCode.OK;
}
