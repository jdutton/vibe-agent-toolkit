/**
 * @vibe-agent-toolkit/gateway-mcp
 *
 * MCP Gateway for exposing VAT agents through Model Context Protocol.
 */

// Core types
export * from './types.js';

// Observability (Task 3)
export * from './observability/interfaces.js';
export { NoOpObservabilityProvider } from './observability/no-op-provider.js';
export { ConsoleLogger } from './observability/console-logger.js';

// Server and adapters will be added in future tasks
