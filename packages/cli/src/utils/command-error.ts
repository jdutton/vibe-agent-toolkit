/**
 * Shared command error handling utilities.
 *
 * THE single implementation of each failure exit. `commands/skills/` used to
 * carry its own `handleCommandError` that logged to stderr and exited 2 having
 * written nothing to stdout — same name, same signature, same documented
 * contract, silently different behaviour. Every command family routes here.
 */

import { countBySeverity, type SeverityCounts, type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';

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
 * Handle command error with standard formatting and exit
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
  const duration = Date.now() - startTime;
  logger.error(`${commandName} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);

  writeYamlOutput({
    status: 'error',
    error: error instanceof Error ? error.message : 'Unknown error',
    duration: formatDuration(duration),
  });

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
