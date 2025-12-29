/**
 * Shared command error handling utilities
 */

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
