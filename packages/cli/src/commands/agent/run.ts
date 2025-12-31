/**
 * vat agent run command
 *
 * Executes an agent with user input and displays the response.
 */

import { resolveAgentPath } from '../../utils/agent-discovery.js';
import { runAgent } from '../../utils/agent-runner.js';
import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';

export interface RunCommandOptions {
  debug?: boolean;
}

/**
 * Run an agent with user input
 *
 * @param pathOrName - Agent name or path to agent manifest
 * @param userInput - Input text for the agent
 * @param options - Command options
 */
export async function runCommand(
  pathOrName: string,
  userInput: string,
  options: RunCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const targetPath = await resolveAgentPath(pathOrName, logger);
    logger.info(`Running agent: ${targetPath}`);
    logger.info('');

    // Run the agent
    const result = await runAgent(targetPath, {
      userInput,
      debug: options.debug ?? false,
    });

    // Output response to stdout
    process.stdout.write(result.response);
    process.stdout.write('\n');

    // Log usage statistics to stderr
    if (result.usage) {
      const duration = Date.now() - startTime;
      logger.info('');
      logger.info(
        `Completed in ${duration}ms (tokens: ${result.usage.inputTokens} in, ${result.usage.outputTokens} out)`
      );
    }

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'AgentRun');
  }
}
