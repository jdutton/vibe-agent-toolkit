/**
 * Example: Combined Multi-Agent Server
 *
 * Exposes multiple VAT agents through a single MCP stdio transport.
 * Demonstrates agent composition and tool orchestration.
 *
 * Agents included:
 * - haiku-validator (Pure Function Tool)
 * - photo-analyzer (One-Shot LLM Analyzer)
 *
 * Usage:
 *   bun run examples/combined-server.ts
 *
 * Claude Desktop config (~/.claude/config.json):
 * {
 *   "mcpServers": {
 *     "vat-agents": {
 *       "command": "bun",
 *       "args": ["run", "/path/to/combined-server.ts"]
 *     }
 *   }
 * }
 */

import { createSuccess } from '@vibe-agent-toolkit/agent-schema';
import type { Agent, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';
import {
  haikuValidatorAgent,
  photoAnalyzerAgent,
} from '@vibe-agent-toolkit/vat-example-cat-agents';

import { StdioMCPGateway } from '../src/server/stdio-transport.js';

import { ConsoleObservabilityProvider, setupGracefulShutdown } from './example-helpers.js';

/**
 * Wraps stateless agents to return OneShotAgentOutput envelope
 * Gateway expects: { result: AgentResult<TData, TError>, metadata?: ... }
 * Stateless agents return: TData directly
 *
 * Works for both:
 * - Pure Function Tools (synchronous, deterministic)
 * - One-Shot LLM Analyzers (async, uses LLM in mock mode)
 */
function wrapStatelessAgentForGateway<TInput, TOutput>(
  agent: Agent<TInput, TOutput>
): Agent<TInput, OneShotAgentOutput<TOutput, string>> {
  return {
    name: agent.name,
    manifest: agent.manifest,
    execute: async (input: TInput) => {
      // Execute agent (may be sync or async)
      const data = await Promise.resolve(
        agent.execute(input as Parameters<typeof agent.execute>[0])
      );

      // Wrap result in OneShotAgentOutput envelope
      return {
        result: createSuccess(data as TOutput),
      };
    },
  };
}

// Create and start gateway with multiple agents
const gateway = new StdioMCPGateway({
  agents: [
    {
      name: 'haiku-validator',
      agent: wrapStatelessAgentForGateway(haikuValidatorAgent),
    },
    {
      name: 'photo-analyzer',
      agent: wrapStatelessAgentForGateway(photoAnalyzerAgent),
    },
  ],
  transport: 'stdio',
  observability: new ConsoleObservabilityProvider(),
});

await gateway.start();

console.error('[MCP Gateway] Agents available:');
console.error('  - haiku-validator: Validates 5-7-5 haiku structure');
console.error('  - photo-analyzer: Analyzes cat photos (mock mode)');

// Keep process alive and handle graceful shutdown
setupGracefulShutdown();
