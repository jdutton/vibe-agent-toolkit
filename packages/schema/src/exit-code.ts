import { inspect } from 'node:util';

import type { ReportStatus } from './report.js';
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

/** The envelope fields an exit code is derived from (a non-envelope verb adapts to them). */
export interface ExitDeterminingDocument {
  readonly status: ReportStatus;
  readonly summary: SeverityCounts;
}

/**
 * The ONE mapping from a published document to its exit code. `status: error`
 * is {@link ExitCode.ERROR}; otherwise the COUNTS decide, never the status word
 * (`findings` means only a non-empty list): errors fail, warnings only under
 * `strict`, info never.
 *
 * @param report - The published document, or its adapter's reading of it
 * @param options - `strict`: treat warnings as failing
 */
export function exitCodeForReport(
  report: ExitDeterminingDocument,
  options: { readonly strict?: boolean } = {},
): ExitCodeValue {
  if (report.status === 'error') return ExitCode.ERROR;
  if (report.summary.errors > 0) return ExitCode.FINDINGS;
  if (options.strict === true && report.summary.warnings > 0) return ExitCode.FINDINGS;
  return ExitCode.OK;
}

/**
 * A child `vat`'s exit status as a contract code: anything off the contract (a
 * signal's `null`, Node's abort 134) is {@link ExitCode.ERROR}.
 */
export function exitCodeOfChild(status: number | null): ExitCodeValue {
  return status !== null && isExitCode(status) ? status : ExitCode.ERROR;
}

/**
 * Everything about a thrown value that `error.message` alone discards: the
 * stack of an `Error` (the frame that threw is the one thing a reader of an
 * ERROR needs), or an inspection of a non-`Error` value, which the envelope
 * would otherwise flatten to the literal `Unknown error`.
 */
export function errorDiagnostics(error: unknown): string {
  if (error instanceof Error) {
    // `stack` is optional in the type and absent on some cross-realm errors.
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return `Non-Error value thrown: ${inspect(error, { depth: 3 })}`;
}

let lastResortInstalled = false;

/**
 * The last resort every VAT `bin` installs first (`validate-structure` Rule 13
 * checks that it does): a throw nothing below caught ends on
 * {@link ExitCode.ERROR}. Node's default for an unhandled rejection is exit 1
 * — FINDINGS — so without this a crash reads as "the tree failed its gate".
 * The frames still go to `write` (stderr by default). Installed once per process.
 */
export function installLastResortExit(write: (text: string) => void = (text) => process.stderr.write(text)): void {
  if (lastResortInstalled) return;
  lastResortInstalled = true;
  const onUncaught = (error: unknown): void => {
    write(`${errorDiagnostics(error)}\n`);
    process.exit(ExitCode.ERROR);
  };
  process.on('unhandledRejection', onUncaught);
  process.on('uncaughtException', onUncaught);
}
