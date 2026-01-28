import type { Agent, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';

import { ResultTranslator } from '../server/result-translator.js';
import type { ArchetypeAdapter, ConnectionId, MCPToolDefinition, MCPToolResult } from '../types.js';

/**
 * Adapter for stateless agents (Pure Function Tool, One-Shot LLM Analyzer)
 *
 * Direct pass-through with no session management.
 * Maps agent.execute() → MCP tool result.
 */
export class StatelessAdapter implements ArchetypeAdapter {
  readonly name = 'stateless';
  private readonly translator = new ResultTranslator();

  /**
   * Create MCP tool definition from agent manifest
   */
  createToolDefinition(agent: Agent<unknown, unknown>): MCPToolDefinition {
    const { manifest } = agent;

    return {
      name: manifest.name,
      description: manifest.description ?? `Agent: ${manifest.name}`,
      inputSchema: this.extractInputSchema(agent),
    };
  }

  /**
   * Execute agent and return MCP result
   */
  async execute(
    agent: Agent<unknown, OneShotAgentOutput<unknown, string>>,
    args: Record<string, unknown>,
    _connectionId: ConnectionId
  ): Promise<MCPToolResult> {
    // Direct pass-through, no session state needed
    const output = await agent.execute(args);

    // Translate VAT result envelope to MCP format
    return this.translator.toMCPResult(output);
  }

  /**
   * Extract input schema from agent (will be enhanced in future)
   *
   * Phase 2: Extract from agent.manifest.interface.input or agent metadata
   */
  private extractInputSchema(agent: Agent<unknown, unknown>): Record<string, unknown> {
    // For Phase 1, create a generic schema
    return {
      type: 'object',
      properties: {},
      additionalProperties: true,
      description: `Input for ${agent.manifest.name}`,
    };
  }
}
