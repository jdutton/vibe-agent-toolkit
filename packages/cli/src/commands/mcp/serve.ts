/**
 * MCP serve command - exposes agent collections via MCP stdio transport
 *
 * A protocol leaf: its stdout is the MCP JSON-RPC stream, not a document, so a
 * failure goes to stderr and ends on `ERROR` with nothing on stdout. The one
 * document it publishes is `--print-config`'s `claude-desktop-config` artifact,
 * through the writer, alone on stdout so it can be redirected into a file.
 */

import {
  StdioMCPGateway,
  ConsoleLogger,
  NoOpObservabilityProvider,
} from '@vibe-agent-toolkit/gateway-mcp';
import { errorDiagnostics, ExitCode } from '@vibe-agent-toolkit/schema';

import { errorMessageOf } from '../../utils/command-refusal.js';
import { writeArtifact } from '../../utils/document-writer.js';
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
 * Generate Claude Desktop configuration for a package — the object; the writer serializes it.
 */
function generateClaudeDesktopConfig(packageOrPath: string): { mcpServers: Record<string, { command: string; args: string[] }> } {
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

  return config;
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
    // Resolved BEFORE `--print-config`: a config for a package that does not
    // load is a paste-ready block for a server that cannot start — it exited 0
    // where the same argument without the flag exits 2.
    logger.debug(`Resolving MCP collection from: ${packageOrPath}`);
    const collection = await resolveCollection(packageOrPath);

    if (options.printConfig) {
      logger.info(`\nClaude Desktop configuration for '${packageOrPath}':\n`);
      logger.info('Add this to ~/.claude/config.json:\n');
      writeArtifact('claude-desktop-config', generateClaudeDesktopConfig(packageOrPath), 'json');
      logger.info('\nThen restart Claude Desktop to load the MCP server.');
      return;
    }

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
      process.exit(ExitCode.OK);
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
    // No document: stdout belongs to the protocol. The message, and the stack
    // under --debug, are for the operator on stderr.
    logger.error(`vat mcp serve failed: ${errorMessageOf(error)}`);
    logger.debug(errorDiagnostics(error));
    process.exit(ExitCode.ERROR);
  }
}
