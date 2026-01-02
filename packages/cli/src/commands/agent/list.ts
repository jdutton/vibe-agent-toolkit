/**
 * Agent list command - discovers and lists all agents
 */

import { discoverAgents } from '../../utils/agent-discovery.js';
import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';

export interface ListCommandOptions {
  debug?: boolean;
}

export async function listCommand(options: ListCommandOptions): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    logger.debug('Discovering agents...');
    logger.debug(`Search paths: packages/vat-development-agents/agents, agents, .`);

    const agents = await discoverAgents();

    const output = {
      status: 'success',
      agents: agents.map(agent => ({
        name: agent.name,
        version: agent.version,
        path: agent.path,
      })),
      count: agents.length,
      duration: `${Date.now() - startTime}ms`,
    };

    writeYamlOutput(output);

    if (agents.length === 0) {
      logger.info('No agents discovered');
    } else {
      logger.info(`Found ${agents.length} agent(s):`);
      for (const agent of agents) {
        logger.info(`  ${agent.name} (${agent.version}) - ${agent.path}`);
      }
    }

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'AgentList');
  }
}
