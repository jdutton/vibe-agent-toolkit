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

// Server (Tasks 4-7)
export { MCPGateway } from './server/mcp-gateway.js';
export { StdioMCPGateway } from './server/stdio-transport.js';

// Adapters (Tasks 5-6)
export { StatelessAdapter } from './adapters/stateless-adapter.js';
