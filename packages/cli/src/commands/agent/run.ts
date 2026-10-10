/**
 * vat agent run command
 *
 * Executes an agent with user input and displays the response.
 *
 * A protocol leaf: its stdout is the agent's reply, not a document, so a
 * failure goes to stderr and ends on `ERROR` with nothing on stdout.
 */

import { errorDiagnostics, ExitCode } from '@vibe-agent-toolkit/schema';

import { resolveAgentPath } from '../../utils/agent-discovery.js';
import { runAgent } from '../../utils/agent-runner.js';
import { errorMessageOf } from '../../utils/command-refusal.js';
import { createLogger } from '../../utils/logger.js';
import { projectRootOrNull } from '../../utils/project-root-policy.js';

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
    // Spec §7: `vat agent run` uses `tolerate null` (path-explicit).
    // The result is currently not consumed downstream; the call records the
    // policy decision at the CLI boundary.
    projectRootOrNull(process.cwd());

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

    process.exit(ExitCode.OK);
  } catch (error) {
    logger.error(`vat agent run failed: ${errorMessageOf(error)}`);
    logger.debug(errorDiagnostics(error));
    process.exit(ExitCode.ERROR);
  }
}
