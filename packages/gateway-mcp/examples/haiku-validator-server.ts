/**
 * Example: Haiku Validator via MCP
 *
 * Exposes the haiku-validator agent through MCP stdio transport
 * for use in Claude Desktop.
 *
 * Usage:
 *   bun run examples/haiku-validator-server.ts
 *
 * Claude Desktop config (~/.claude/config.json):
 * {
 *   "mcpServers": {
 *     "vat-haiku": {
 *       "command": "bun",
 *       "args": ["run", "/path/to/haiku-validator-server.ts"]
 *     }
 *   }
 * }
 */

import { createSuccess } from '@vibe-agent-toolkit/agent-schema';
import type { Agent, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';
import { haikuValidatorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';

import { StdioMCPGateway } from '../src/server/stdio-transport.js';

import { ConsoleObservabilityProvider, setupGracefulShutdown } from './example-helpers.js';

/**
 * Wraps a PureFunctionAgent to return OneShotAgentOutput envelope
 * Gateway expects: { result: AgentResult<TData, TError>, metadata?: ... }
 * PureFunctionAgent returns: TData directly
 */
function wrapPureFunctionForGateway<TInput, TOutput>(
  pureFunctionAgent: typeof haikuValidatorAgent
): Agent<TInput, OneShotAgentOutput<TOutput, string>> {
  return {
    name: pureFunctionAgent.name,
    manifest: pureFunctionAgent.manifest,
    execute: async (input: TInput) => {
      // Execute the pure function (synchronous)
      const data = pureFunctionAgent.execute(input as Parameters<typeof pureFunctionAgent.execute>[0]);

      // Wrap result in OneShotAgentOutput envelope
      return {
        result: createSuccess(data as TOutput),
      };
    },
  };
}

// Create and start gateway
const gateway = new StdioMCPGateway({
  agents: [
    {
      name: 'haiku-validator',
      agent: wrapPureFunctionForGateway(haikuValidatorAgent),
    },
  ],
  transport: 'stdio',
  observability: new ConsoleObservabilityProvider(),
});

await gateway.start();

// Keep process alive and handle graceful shutdown
setupGracefulShutdown();
