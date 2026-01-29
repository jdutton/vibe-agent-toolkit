/**
 * Shared helpers for MCP Gateway examples
 */

import { ConsoleLogger } from '../src/observability/console-logger.js';
import { NoOpObservabilityProvider } from '../src/observability/no-op-provider.js';

/**
 * Custom observability provider with console logger
 * Extends NoOpObservabilityProvider and overrides getLogger() to provide console output
 */
export class ConsoleObservabilityProvider extends NoOpObservabilityProvider {
  private readonly consoleLogger = new ConsoleLogger();

  override getLogger(): ConsoleLogger {
    return this.consoleLogger;
  }
}

/**
 * Handles graceful shutdown for MCP servers
 */
export function setupGracefulShutdown(): void {
  process.on('SIGINT', () => {
    console.error('[MCP Gateway] Shutting down...');
    process.exit(0);
  });
}
