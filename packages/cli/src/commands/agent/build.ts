/**
 * Agent build command - Package agents for deployment targets
 */

import { buildClaudeSkill } from '@vibe-agent-toolkit/runtime-claude-skills';

import { resolveAgentPath } from '../../utils/agent-discovery.js';
import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';

export interface BuildCommandOptions {
  target?: string;
  output?: string;
  debug?: boolean;
}

/**
 * Build an agent for a specific deployment target
 */
export async function buildCommand(
  pathOrName: string,
  options: BuildCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const target = options.target ?? 'skill';
    logger.debug(`Building agent for target: ${target}`);

    // Resolve agent path
    const agentPath = await resolveAgentPath(pathOrName, logger);
    logger.debug(`Agent path resolved: ${agentPath}`);

    // Build based on target
    let result;
    if (target === 'skill') {
      logger.info('Building Claude Skill...');
      // Only pass outputPath if explicitly provided by user
      const buildOptions = options.output
        ? { agentPath, target, outputPath: options.output }
        : { agentPath, target };
      result = await buildClaudeSkill(buildOptions);
    } else {
      throw new Error(`Unsupported build target: ${target}`);
    }

    const duration = Date.now() - startTime;

    // Output success result
    writeYamlOutput({
      status: 'success',
      agent: result.agent.name,
      target,
      output: result.outputPath,
      files: result.files,
      duration: `${duration}ms`,
    });

    logger.info(`Build completed in ${duration}ms`);
    logger.info(`Output: ${result.outputPath}`);
    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'AgentBuild');
  }
}
