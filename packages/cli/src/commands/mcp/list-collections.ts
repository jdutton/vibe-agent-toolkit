/**
 * MCP list-collections command - lists available agent collections
 */

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';

import { listKnownPackages } from './collections.js';

export interface ListCollectionsOptions {
  debug?: boolean;
}

/**
 * List available MCP agent collections
 */
export async function listCollectionsCommand(
  options: ListCollectionsOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    const packages = listKnownPackages();

    const output = {
      status: 'success',
      packages: packages.map((p) => ({
        name: p.name,
        description: p.description,
      })),
      count: packages.length,
      duration: `${Date.now() - startTime}ms`,
    };

    writeYamlOutput(output);

    logger.info(`\nAvailable MCP agent packages:\n`);
    for (const pkg of packages) {
      logger.info(`  ${pkg.name}`);
      logger.info(`    ${pkg.description}\n`);
    }

    logger.info(`Usage:`);
    logger.info(`  vat mcp serve <package>                 # Start MCP server`);
    logger.info(`  vat mcp serve <package> --print-config  # Show Claude Desktop config\n`);

    logger.info(`Examples:`);
    logger.info(`  vat mcp serve @vibe-agent-toolkit/vat-example-cat-agents`);
    logger.info(`  vat mcp serve ./packages/vat-example-cat-agents  # Local development\n`);

    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'MCPListCollections');
  }
}
