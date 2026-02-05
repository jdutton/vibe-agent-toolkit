/**
 * Helper functions for skill commands
 */

import type { Logger } from '../../utils/logger.js';

/**
 * Handle command errors consistently
 *
 * @param error - Error object
 * @param logger - Logger instance
 * @param startTime - Command start timestamp
 * @param commandName - Name of command for error messages
 */
export function handleCommandError(
  error: unknown,
  logger: Logger,
  startTime: number,
  commandName: string
): never {
  const duration = Date.now() - startTime;

  if (error instanceof Error) {
    logger.error(`${commandName} failed: ${error.message}`);
    logger.debug(`Error stack: ${error.stack ?? 'No stack trace'}`);
  } else {
    logger.error(`${commandName} failed: ${String(error)}`);
  }

  logger.debug(`Duration: ${duration}ms`);

  // Exit with code 2 for unexpected errors
  process.exit(2);
}
