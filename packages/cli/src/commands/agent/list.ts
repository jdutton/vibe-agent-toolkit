/**
 * Agent list command - discovers and lists all agents
 */

import { safePath } from '@vibe-agent-toolkit/utils';

import { discoverAgents, type DiscoveredAgent } from '../../utils/agent-discovery.js';
import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';
import { relativizePathEntries } from '../../utils/relativize-paths.js';

export interface ListCommandOptions {
  debug?: boolean;
}

/** One agent as the payload reports it — no `manifestPath`, which is derivable. */
interface ReportedAgent {
  name: string;
  version: string;
  path: string;
}

/**
 * Build the agent-list payload.
 *
 * Pure, so the payload's shape — including the fact that `path` is root-relative
 * — is under unit test rather than only under a CLI spawn. `root` is stated
 * once and is the only absolute path in the document; without it a relative
 * `path` is unresolvable, and with absolute paths the payload names the machine
 * it ran on.
 */
export function buildAgentListOutput(
  agents: readonly DiscoveredAgent[],
  root: string,
  durationMs: number,
): Record<string, unknown> {
  const reported: ReportedAgent[] = agents.map(agent => ({
    name: agent.name,
    version: agent.version,
    path: agent.path,
  }));

  return {
    status: 'success',
    root,
    agents: relativizePathEntries(reported, root),
    count: agents.length,
    duration: `${durationMs}ms`,
  };
}

export async function listCommand(options: ListCommandOptions): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    logger.debug('Discovering agents...');
    logger.debug(`Search paths: packages/vat-development-agents/agents, agents, .`);

    const agents = await discoverAgents();

    // `discoverAgents` resolves its search paths against cwd, so cwd — not a
    // config/git projectRoot — is the honest base for what it found.
    const root = safePath.resolve(process.cwd());
    const output = buildAgentListOutput(agents, root, Date.now() - startTime);

    writeYamlOutput(output);

    if (agents.length === 0) {
      logger.info('No agents discovered');
    } else {
      logger.info(`Found ${agents.length} agent(s):`);
      for (const agent of output['agents'] as ReportedAgent[]) {
        logger.info(`  ${agent.name} (${agent.version}) - ${agent.path}`);
      }
    }

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'AgentList');
  }
}
