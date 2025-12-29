/**
 * Shared helper functions for resources commands
 */

import type { Logger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';

/**
 * Handle command error with standard formatting and exit
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
    duration: `${duration}ms`,
  });

  process.exit(2);
}
