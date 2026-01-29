/**
 * Example: Photo Analyzer via MCP
 *
 * Exposes the photo-analyzer agent through MCP stdio transport
 * for use in Claude Desktop.
 *
 * Note: Currently uses mock mode (analyzes filename patterns).
 * Real vision API integration planned for future enhancement.
 *
 * Usage:
 *   bun run examples/photo-analyzer-server.ts
 *
 * Claude Desktop config (~/.claude/config.json):
 * {
 *   "mcpServers": {
 *     "vat-photo": {
 *       "command": "bun",
 *       "args": ["run", "/path/to/photo-analyzer-server.ts"]
 *     }
 *   }
 * }
 */

import { createSuccess } from '@vibe-agent-toolkit/agent-schema';
import type { Agent, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';
import { photoAnalyzerAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';

import { StdioMCPGateway } from '../src/server/stdio-transport.js';

import { ConsoleObservabilityProvider, setupGracefulShutdown } from './example-helpers.js';

/**
 * Wraps One-Shot LLM Analyzer agent to return OneShotAgentOutput envelope
 * Gateway expects: { result: AgentResult<TData, TError>, metadata?: ... }
 * One-Shot LLM Analyzer returns: TData directly (in mock mode)
 */
function wrapOneShotAgentForGateway<TInput, TOutput>(
  oneShotAgent: typeof photoAnalyzerAgent
): Agent<TInput, OneShotAgentOutput<TOutput, string>> {
  return {
    name: oneShotAgent.name,
    manifest: oneShotAgent.manifest,
    execute: async (input: TInput) => {
      // Execute the one-shot agent (returns data directly in mock mode)
      const data = await oneShotAgent.execute(input as Parameters<typeof oneShotAgent.execute>[0]);

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
      name: 'photo-analyzer',
      agent: wrapOneShotAgentForGateway(photoAnalyzerAgent),
    },
  ],
  transport: 'stdio',
  observability: new ConsoleObservabilityProvider(),
});

await gateway.start();

// Keep process alive and handle graceful shutdown
setupGracefulShutdown();
