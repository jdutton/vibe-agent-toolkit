/**
 * MCP serve command - exposes agent collections via MCP stdio transport
 */

import {
  StdioMCPGateway,
  ConsoleLogger,
  NoOpObservabilityProvider,
} from '@vibe-agent-toolkit/gateway-mcp';

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';

import { resolveCollection } from './collections.js';

export interface ServeCommandOptions {
  debug?: boolean;
  printConfig?: boolean;
}

/**
 * Custom observability provider with console logger
 * Extends NoOpObservabilityProvider and overrides getLogger() to provide console output
 */
class ConsoleObservabilityProvider extends NoOpObservabilityProvider {
  private readonly consoleLogger = new ConsoleLogger();

  override getLogger(): ConsoleLogger {
    return this.consoleLogger;
  }
}

/**
 * Generate Claude Desktop configuration for a package
 */
function generateClaudeDesktopConfig(packageOrPath: string): string {
  // Use package name as MCP server key (sanitize for JSON key)
  const serverKey = packageOrPath
    .replaceAll('@vibe-agent-toolkit/', 'vat-')
    .replaceAll(/[^a-z0-9-]/gi, '-');

  const config = {
    mcpServers: {
      [serverKey]: {
        command: 'vat',
        args: ['mcp', 'serve', packageOrPath],
      },
    },
  };

  return JSON.stringify(config, null, 2);
}

/**
 * MCP serve command
 */
export async function serveCommand(
  packageOrPath: string,
  options: ServeCommandOptions
): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});
  const startTime = Date.now();

  try {
    // Handle --print-config flag
    if (options.printConfig) {
      logger.info(`\nClaude Desktop configuration for '${packageOrPath}':\n`);
      logger.info('Add this to ~/.claude/config.json:\n');
      console.log(generateClaudeDesktopConfig(packageOrPath));
      logger.info('\nThen restart Claude Desktop to load the MCP server.');
      process.exit(0);
    }

    // Resolve collection from package name or file path
    logger.debug(`Resolving MCP collection from: ${packageOrPath}`);
    const collection = await resolveCollection(packageOrPath);

    logger.debug(`Collection resolved: ${collection.name}`);
    logger.debug(`Agents: ${collection.agents.map((a) => a.name).join(', ')}`);

    // Create and start gateway
    const gateway = new StdioMCPGateway({
      agents: collection.agents.map((reg) => ({
        name: reg.name,
        agent: reg.agent,
      })),
      transport: 'stdio',
      observability: new ConsoleObservabilityProvider(),
    });

    logger.info(
      `Starting MCP gateway: ${collection.agents.length} agent(s) (${Date.now() - startTime}ms)`
    );

    await gateway.start();

    // Setup graceful shutdown
    process.on('SIGINT', () => {
      logger.info('Shutting down MCP gateway...');
      process.exit(0);
    });

    // Wait for stdin to close (stdio server lifetime = stdin lifetime)
    await new Promise<void>((resolve) => {
      process.stdin.on('end', () => {
        logger.info('Stdin closed, shutting down...');
        resolve();
      });
      process.stdin.on('error', () => {
        resolve();
      });
    });
  } catch (error) {
    handleCommandError(error, logger, startTime, 'MCPServe');
  }
}
