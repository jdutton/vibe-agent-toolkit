/**
 * Agent validate command - validates agent manifest and prerequisites
 */

import { validateAgent } from '@vibe-agent-toolkit/agent-config';

import { resolveAgentPath } from '../../utils/agent-discovery.js';
import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';

export interface ValidateCommandOptions {
  debug?: boolean;
}

export async function validateCommand(
  pathOrName: string,
  options: ValidateCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    // Resolve agent name to path if needed
    const targetPath = await resolveAgentPath(pathOrName, logger);

    logger.debug(`Validating agent: ${targetPath}`);

    // Validate agent
    const result = await validateAgent(targetPath);

    // Prepare output
    const output = {
      status: result.valid ? 'success' : 'error',
      manifest: result.manifest,
      validation: {
        errors: result.errors,
        warnings: result.warnings,
      },
      duration: `${Date.now() - startTime}ms`,
    };

    writeYamlOutput(output);

    if (!result.valid) {
      logger.error('Agent validation failed');
      for (const error of result.errors) {
        logger.error(`  - ${error}`);
      }
      process.exit(1);
    }

    if (result.warnings.length > 0) {
      logger.info('Validation passed with warnings:');
      for (const warning of result.warnings) {
        logger.info(`  - ${warning}`);
      }
    } else {
      logger.info('Agent validation successful');
    }

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'AgentValidate');
  }
}
