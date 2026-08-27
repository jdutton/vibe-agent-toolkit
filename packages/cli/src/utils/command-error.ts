/**
 * Shared command error handling utilities.
 *
 * THE single implementation of each failure exit. `commands/skills/` used to
 * carry its own `handleCommandError` that logged to stderr and exited 2 having
 * written nothing to stdout — same name, same signature, same documented
 * contract, silently different behaviour. Every command family routes here.
 */

import { inspect } from 'node:util';

import { countBySeverity, type SeverityCounts, type ValidationIssue } from '@vibe-agent-toolkit/schema';

import type { Logger } from './logger.js';
import { writeYamlOutput } from './output.js';

/**
 * Format duration for human readability
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string (e.g., "500ms", "1.5s", "1.5m")
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Everything about a thrown value that `error.message` alone discards.
 *
 * Exit 2 is the UNEXPECTED failure — an internal bug, not a usage mistake — and
 * the one thing a reader needs there is the frame that threw. A real `TypeError`
 * arrived here as a single line (`Cannot read properties of undefined (reading
 * 'readdir')`) with no file, no frames, and no flag that would produce them; the
 * only way to find the throw site was to hand-patch the built `dist`. A value
 * thrown that is not an `Error` fared worse still — the envelope flattens it to
 * the literal string `Unknown error`, which names neither its type nor its
 * contents.
 *
 * The result rides the logger's **debug** channel (`--debug`), so default output
 * is unchanged and no golden moves.
 *
 * @param error - The value that was thrown
 * @returns Stack trace for an `Error`, or an inspected rendering of a non-`Error`
 */
export function errorDiagnostics(error: unknown): string {
  if (error instanceof Error) {
    // `stack` is optional in the type and absent on some cross-realm errors.
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return `Non-Error value thrown: ${inspect(error, { depth: 3 })}`;
}

/** The document a command publishes when an unexpected failure stops it. */
export interface CommandErrorDocument {
  status: 'error';
  error: string;
  duration: string;
}

/**
 * Report an unexpected failure on stderr and return the document that describes
 * it, WITHOUT deciding how the caller ends.
 *
 * Split out of {@link handleCommandError} because the same failure now has two
 * endings and must not grow two policies. A command run from the command line
 * writes this document to stdout and exits 2; the same command run as a phase of
 * `vat validate` / `vat verify` / `vat build` runs in the orchestrator's own
 * process, where exiting would kill the whole run and skip every later phase —
 * so it hands the document back and the orchestrator nests it under that phase's
 * `report`, exactly as it used to nest the child's captured stdout.
 *
 * The stderr half is identical in both lanes: progress and diagnostics have
 * always streamed live, and that is unchanged by there no longer being a child.
 *
 * @param error - The value that was thrown
 * @param logger - Logger instance for error output
 * @param startTime - Command start time (from Date.now())
 * @param commandName - Name of the command (for the error message)
 */
export function reportCommandError(
  error: unknown,
  logger: Logger,
  startTime: number,
  commandName: string
): CommandErrorDocument {
  const duration = Date.now() - startTime;
  const message = error instanceof Error ? error.message : 'Unknown error';

  logger.error(`${commandName} failed: ${message}`);
  logger.debug(errorDiagnostics(error));

  return { status: 'error', error: message, duration: formatDuration(duration) };
}

/**
 * Handle command error with standard formatting and exit.
 *
 * The command-line ending for {@link reportCommandError}. Exit 2 is the
 * UNEXPECTED failure, per the exit-code contract every command's help documents.
 *
 * @param error - The error that occurred
 * @param logger - Logger instance for error output
 * @param startTime - Command start time (from Date.now())
 * @param commandName - Name of the command (for error message)
 */
export function handleCommandError(
  error: unknown,
  logger: Logger,
  startTime: number,
  commandName: string
): never {
  writeYamlOutput(reportCommandError(error, logger, startTime, commandName));
  process.exit(2);
}

/** The payload a command publishes when its own validation gate stops it. */
export interface ValidationGateFailure {
  status: 'error';
  issueCounts: SeverityCounts;
  /** What was being validated — a skill name or a path, whichever the lane has. */
  skill: string;
}

/**
 * Pure: the document {@link handleValidationGateFailure} writes.
 *
 * The per-severity distribution rides beside the status because `status: error`
 * alone cannot say whether the run also carried warnings and info — and the
 * findings themselves went to stderr, where a piped consumer never sees them.
 */
export function buildValidationGateFailure(
  subject: string,
  issues: readonly ValidationIssue[],
): ValidationGateFailure {
  return { status: 'error', issueCounts: countBySeverity(issues), skill: subject };
}

/**
 * Publish the documented failure payload for a command stopped by its OWN
 * validation gate, then exit 1.
 *
 * {@link handleCommandError} above covers the UNEXPECTED failure (exit 2). This
 * covers the expected one, and `vat skills build` / `vat skills package` both
 * exited it after writing zero bytes to stdout — while their `--help` texts
 * document a YAML summary on stdout and reserve exit 1 for exactly this case.
 * A consumer running `vat skills build | jq .status` got an empty document and
 * a bare non-zero code.
 */
export function handleValidationGateFailure(
  subject: string,
  issues: readonly ValidationIssue[],
): never {
  writeYamlOutput(buildValidationGateFailure(subject, issues));
  process.exit(1);
}
