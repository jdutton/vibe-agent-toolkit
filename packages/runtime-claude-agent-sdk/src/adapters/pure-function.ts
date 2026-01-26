import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  type PureFunctionAgent,
  type ToolConversionConfigs,
} from '@vibe-agent-toolkit/agent-runtime';
import type { z } from 'zod';

import type { AgentConversionResult, BatchConversionResult } from '../types.js';

import {
  type BatchToolMetadata,
  createBatchToolMetadata,
  createMcpServerWithTool,
  createSingleToolMetadata,
  createToolHandler,
} from './common-helpers.js';

/**
 * Converts a VAT Pure Function agent to Claude Agent SDK MCP tool
 *
 * Creates an in-process MCP server with a single tool that wraps the VAT agent.
 * The tool can be used with the Claude Agent SDK's query() function.
 *
 * @param agent - The VAT pure function agent to convert
 * @param inputSchema - Zod schema for validating inputs
 * @param outputSchema - Zod schema for validating outputs
 * @param serverName - Optional name for the MCP server (defaults to agent name)
 * @returns MCP server instance with metadata and schemas
 *
 * @example
 * ```typescript
 * import { query } from '@anthropic-ai/claude-agent-sdk';
 * import { haikuValidatorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { convertPureFunctionToTool } from '@vibe-agent-toolkit/runtime-claude-agent-sdk';
 *
 * const { server, metadata } = convertPureFunctionToTool(
 *   haikuValidatorAgent,
 *   HaikuSchema,
 *   HaikuValidationResultSchema
 * );
 *
 * // Use with Claude Agent SDK
 * for await (const message of query({
 *   prompt: "Validate this haiku: 'Cat sits on warm mat / Purring in the sunshine / Dreams of tuna fish'",
 *   options: {
 *     mcpServers: { 'haiku-tools': server },
 *     allowedTools: ['mcp__haiku-tools__haiku-validator']
 *   }
 * })) {
 *   if (message.type === 'result') {
 *     console.log(message.result);
 *   }
 * }
 * ```
 */
export function convertPureFunctionToTool<TInput, TOutput>(
  agent: PureFunctionAgent<TInput, TOutput>,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  serverName?: string,
): AgentConversionResult<TInput, TOutput> {
  const { manifest } = agent;
  const mcpServerName = serverName ?? manifest.name;

  // Create MCP server with the agent as a tool
  const server = createMcpServerWithTool(
    manifest,
    mcpServerName,
    inputSchema,
    outputSchema,
    async (input: TInput) => agent.execute(input),
  );

  return {
    server,
    metadata: createSingleToolMetadata(manifest, manifest.archetype, mcpServerName),
    inputSchema,
    outputSchema,
  };
}

/**
 * Batch converts multiple VAT Pure Function agents to Claude Agent SDK MCP servers
 *
 * Creates a single MCP server containing all agents as tools.
 *
 * @param configs - Map of tool names to conversion configurations
 * @param serverName - Name for the combined MCP server (defaults to 'vat-agents')
 * @returns MCP server instance with all tools
 *
 * @example
 * ```typescript
 * const { server, metadata } = convertPureFunctionsToTools({
 *   validateHaiku: {
 *     agent: haikuValidatorAgent,
 *     inputSchema: HaikuSchema,
 *     outputSchema: HaikuValidationResultSchema,
 *   },
 *   generateName: {
 *     agent: nameGeneratorAgent,
 *     inputSchema: NameInputSchema,
 *     outputSchema: NameOutputSchema,
 *   },
 * }, 'cat-tools');
 *
 * // Use all tools with Claude Agent SDK
 * for await (const message of query({
 *   prompt: "Help me validate a haiku and generate a cat name",
 *   options: {
 *     mcpServers: { 'cat-tools': server },
 *     allowedTools: [
 *       'mcp__cat-tools__validateHaiku',
 *       'mcp__cat-tools__generateName'
 *     ]
 *   }
 * })) {
 *   console.log(message);
 * }
 * ```
 */
export function convertPureFunctionsToTools(
  configs: ToolConversionConfigs,
  serverName = 'vat-agents',
): BatchConversionResult {
  const tools: ReturnType<typeof tool>[] = [];
  const toolsMetadata: BatchToolMetadata = {};

  // Convert each agent to a tool
  for (const [key, config] of Object.entries(configs)) {
    const agent = config.agent as PureFunctionAgent<unknown, unknown>;
    const { manifest } = agent;

    tools.push(
      tool(
        key, // Use the key as the tool name for clarity
        manifest.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config.inputSchema as any, // Claude Agent SDK accepts Zod schemas
        createToolHandler(agent, config.inputSchema, config.outputSchema),
      ),
    );

    toolsMetadata[key] = createBatchToolMetadata(key, manifest, 'pure-function', serverName);
  }

  // Create combined MCP server
  const server = createSdkMcpServer({
    name: serverName,
    version: '1.0.0',
    tools,
  });

  return {
    server,
    metadata: {
      serverName,
      tools: toolsMetadata,
    },
  };
}
