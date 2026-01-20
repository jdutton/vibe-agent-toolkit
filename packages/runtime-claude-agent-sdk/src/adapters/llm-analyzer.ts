import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { type Agent } from '@vibe-agent-toolkit/agent-runtime';
import type { z } from 'zod';

import type { AgentConversionResult, BatchConversionResult, ClaudeAgentLLMConfig } from '../types.js';

import {
  type BatchToolMetadata,
  createBatchToolMetadata,
  createMcpServerWithTool,
  createSingleToolMetadata,
  createToolHandler,
} from './common-helpers.js';

const DEFAULT_MODEL = 'claude-3-5-haiku-20241022';

/**
 * Converts a VAT LLM Analyzer agent to Claude Agent SDK MCP tool
 *
 * Creates an in-process MCP server with a tool that wraps the VAT agent.
 * The tool makes LLM calls using the Anthropic SDK when invoked.
 *
 * @param agent - The VAT LLM analyzer agent to convert
 * @param inputSchema - Zod schema for validating inputs
 * @param outputSchema - Zod schema for validating outputs
 * @param llmConfig - Configuration for LLM calls
 * @param serverName - Optional name for the MCP server (defaults to agent name)
 * @returns MCP server instance with metadata and schemas
 *
 * @example
 * ```typescript
 * import { query } from '@anthropic-ai/claude-agent-sdk';
 * import { nameGeneratorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { convertLLMAnalyzerToTool } from '@vibe-agent-toolkit/runtime-claude-agent-sdk';
 *
 * const { server, metadata } = convertLLMAnalyzerToTool(
 *   nameGeneratorAgent,
 *   NameGeneratorInputSchema,
 *   NameSuggestionSchema,
 *   {
 *     apiKey: process.env.ANTHROPIC_API_KEY,
 *     model: DEFAULT_MODEL,
 *     temperature: 0.9
 *   }
 * );
 *
 * // Use with Claude Agent SDK
 * for await (const message of query({
 *   prompt: "Generate a distinguished cat name for an orange cat",
 *   options: {
 *     mcpServers: { 'name-tools': server },
 *     allowedTools: ['mcp__name-tools__name-generator']
 *   }
 * })) {
 *   if (message.type === 'result') {
 *     console.log(message.result);
 *   }
 * }
 * ```
 */
export function convertLLMAnalyzerToTool<TInput, TOutput>(
  agent: Agent<TInput, TOutput>,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  llmConfig: ClaudeAgentLLMConfig,
  serverName?: string,
): AgentConversionResult<TInput, TOutput> {
  const { manifest } = agent;
  const mcpServerName = serverName ?? manifest.name;

  // Create Anthropic client and callLLM function
  const { callLLM, model, temperature } = createLLMContext(llmConfig);

  // Create MCP server with the agent as a tool
  const server = createMcpServerWithTool(
    manifest,
    mcpServerName,
    inputSchema,
    outputSchema,
    async (input: TInput) => {
      const context = {
        mockable: false,
        model,
        temperature,
        callLLM,
      };
      return agent.execute(input, context);
    },
  );

  return {
    server,
    metadata: createSingleToolMetadata(manifest, 'llm-analyzer', mcpServerName),
    inputSchema,
    outputSchema,
  };
}

/**
 * Helper to create LLM context with Anthropic client
 */
function createLLMContext(llmConfig: ClaudeAgentLLMConfig) {
  const anthropic = new Anthropic({
    apiKey: llmConfig.apiKey ?? process.env['ANTHROPIC_API_KEY'],
  });

  const model = llmConfig.model ?? DEFAULT_MODEL;
  const temperature = llmConfig.temperature ?? 0.7;

  const callLLM = async (prompt: string): Promise<string> => {
    const response = await anthropic.messages.create({
      model,
      max_tokens: llmConfig.maxTokens ?? 4096,
      temperature,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find(
      (block): block is Anthropic.Messages.TextBlock => block.type === 'text',
    );
    return textBlock?.text ?? '';
  };

  return { callLLM, model, temperature };
}

/**
 * Batch converts multiple VAT LLM Analyzer agents to Claude Agent SDK MCP servers
 *
 * Creates a single MCP server containing all agents as tools.
 * All tools share the same LLM configuration.
 *
 * @param configs - Map of tool names to conversion configurations
 * @param llmConfig - Shared LLM configuration for all agents
 * @param serverName - Name for the combined MCP server (defaults to 'vat-llm-agents')
 * @returns MCP server instance with all tools
 *
 * @example
 * ```typescript
 * const { server, metadata } = convertLLMAnalyzersToTools({
 *   generateName: {
 *     agent: nameGeneratorAgent,
 *     inputSchema: NameGeneratorInputSchema,
 *     outputSchema: NameSuggestionSchema,
 *   },
 *   generateHaiku: {
 *     agent: haikuGeneratorAgent,
 *     inputSchema: HaikuGeneratorInputSchema,
 *     outputSchema: HaikuSchema,
 *   },
 * }, {
 *   apiKey: process.env.ANTHROPIC_API_KEY,
 *   model: DEFAULT_MODEL,
 *   temperature: 0.8,
 * });
 *
 * // Use all tools with Claude Agent SDK
 * for await (const message of query({
 *   prompt: "Generate a cat name and haiku",
 *   options: {
 *     mcpServers: { 'cat-llm-tools': server },
 *     allowedTools: [
 *       'mcp__cat-llm-tools__generateName',
 *       'mcp__cat-llm-tools__generateHaiku'
 *     ]
 *   }
 * })) {
 *   console.log(message);
 * }
 * ```
 */
export function convertLLMAnalyzersToTools(
  configs: Record<
    string,
    {
      agent: Agent<unknown, unknown>;
      inputSchema: z.ZodType<unknown>;
      outputSchema: z.ZodType<unknown>;
    }
  >,
  llmConfig: ClaudeAgentLLMConfig,
  serverName = 'vat-llm-agents',
): BatchConversionResult {
  // Create shared LLM context
  const { callLLM, model, temperature } = createLLMContext(llmConfig);

  const tools: ReturnType<typeof tool>[] = [];
  const toolsMetadata: BatchToolMetadata = {};

  // Convert each agent to a tool
  for (const [key, config] of Object.entries(configs)) {
    const agent = config.agent;
    const { manifest } = agent;

    tools.push(
      tool(
        key, // Use the key as the tool name
        manifest.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config.inputSchema as any, // Claude Agent SDK accepts Zod schemas
        createToolHandler(agent, config.inputSchema, config.outputSchema, () => ({
          mockable: false,
          model,
          temperature,
          callLLM,
        })),
      ),
    );

    toolsMetadata[key] = createBatchToolMetadata(key, manifest, 'llm-analyzer', serverName);
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
