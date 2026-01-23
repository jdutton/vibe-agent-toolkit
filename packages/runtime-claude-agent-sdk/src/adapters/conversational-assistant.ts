import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { createConversationalContext, type Agent, type Message } from '@vibe-agent-toolkit/agent-runtime';
import type { z } from 'zod';

import type { BatchConversionResult, ClaudeAgentLLMConfig, SingleAgentConverter } from '../types.js';

import {
  createAnthropicConversationalContext,
  createSingleConverterFunction,
  createToolsFromConfigs,
} from './common-helpers.js';

/**
 * Session state for a conversational agent
 */
export interface ConversationSession {
  /** Conversation history */
  history: Message[];
  /** Agent-specific session state (optional) */
  state?: unknown;
}

/**
 * Converts a VAT Conversational Assistant agent to Claude Agent SDK MCP tool
 *
 * Creates an in-process MCP server with a tool that wraps the VAT agent.
 * The tool maintains conversation history and session state across turns.
 *
 * @param agent - The VAT conversational assistant agent to convert
 * @param inputSchema - Zod schema for validating inputs
 * @param outputSchema - Zod schema for validating outputs
 * @param llmConfig - Configuration for LLM calls
 * @param serverName - Optional name for the MCP server (defaults to agent name)
 * @returns MCP server instance with metadata and schemas
 *
 * @example
 * ```typescript
 * import { query } from '@anthropic-ai/claude-agent-sdk';
 * import { breedAdvisorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { convertConversationalAssistantToTool } from '@vibe-agent-toolkit/runtime-claude-agent-sdk';
 *
 * const { server, metadata } = convertConversationalAssistantToTool(
 *   breedAdvisorAgent,
 *   BreedAdvisorInputSchema,
 *   BreedAdvisorOutputSchema,
 *   {
 *     apiKey: process.env.ANTHROPIC_API_KEY,
 *     model: 'claude-3-5-haiku-20241022',
 *     temperature: 0.7
 *   }
 * );
 *
 * // Use with Claude Agent SDK
 * const session = { history: [] };
 * for await (const message of query({
 *   prompt: "Help me find a cat breed",
 *   options: {
 *     mcpServers: { 'breed-advisor': server },
 *     allowedTools: ['mcp__breed-advisor__breed-advisor']
 *   }
 * })) {
 *   if (message.type === 'result') {
 *     console.log(message.result);
 *   }
 * }
 * ```
 */
export const convertConversationalAssistantToTool: SingleAgentConverter = createSingleConverterFunction(
  'conversational-assistant',
  createAnthropicConversationalContext,
  (agent, callLLM, model, temperature) => async (input) => {
    // Initialize or extract session from input
    const session: ConversationSession =
      (input as { session?: ConversationSession }).session ?? { history: [] };

    // Build conversational context using helper
    const context = createConversationalContext(session.history, async (messages: Message[]) => {
      return callLLM(messages, model, temperature);
    });

    // Execute agent with context
    const result = await agent.execute(input, context);

    // Return result with updated session
    return {
      ...(result as Record<string, unknown>),
      session,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  },
) as never;

/**
 * Batch converts multiple VAT Conversational Assistant agents to Claude Agent SDK MCP servers
 *
 * Creates a single MCP server containing all agents as tools.
 * All tools share the same LLM configuration but maintain separate conversation histories.
 *
 * @param configs - Map of tool names to conversion configurations
 * @param llmConfig - Shared LLM configuration for all agents
 * @param serverName - Name for the combined MCP server (defaults to 'vat-conversational-agents')
 * @returns MCP server instance with all tools
 *
 * @example
 * ```typescript
 * const { server, metadata } = convertConversationalAssistantsToTools({
 *   breedAdvisor: {
 *     agent: breedAdvisorAgent,
 *     inputSchema: BreedAdvisorInputSchema,
 *     outputSchema: BreedAdvisorOutputSchema,
 *   },
 *   petCareAdvisor: {
 *     agent: petCareAdvisorAgent,
 *     inputSchema: PetCareInputSchema,
 *     outputSchema: PetCareOutputSchema,
 *   },
 * }, {
 *   apiKey: process.env.ANTHROPIC_API_KEY,
 *   model: 'claude-3-5-haiku-20241022',
 *   temperature: 0.7,
 * });
 *
 * // Use all tools with Claude Agent SDK
 * for await (const message of query({
 *   prompt: "Help me choose a cat breed and care for it",
 *   options: {
 *     mcpServers: { 'cat-advisors': server },
 *     allowedTools: [
 *       'mcp__cat-advisors__breedAdvisor',
 *       'mcp__cat-advisors__petCareAdvisor'
 *     ]
 *   }
 * })) {
 *   console.log(message);
 * }
 * ```
 */
export function convertConversationalAssistantsToTools(
  configs: Record<
    string,
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: Agent<any, any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: z.ZodType<any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      outputSchema: z.ZodType<any>;
    }
  >,
  llmConfig: ClaudeAgentLLMConfig,
  serverName = 'vat-conversational-agents',
): BatchConversionResult {
  // Create shared conversational context
  const { callLLM, model, temperature } = createAnthropicConversationalContext(llmConfig);

  // Track sessions per tool
  const sessions = new Map<string, ConversationSession>();

  // Create tools from configs using helper
  const { tools, toolsMetadata } = createToolsFromConfigs(
    configs,
    'conversational-assistant',
    serverName,
    (key: string) => {
      // Get or create session for this tool
      let session = sessions.get(key);
      if (!session) {
        session = { history: [] };
        sessions.set(key, session);
      }

      // Build conversational context
      const currentSession = session;
      return {
        mockable: false,
        history: currentSession.history,
        addToHistory: (role: 'system' | 'user' | 'assistant', content: string) => {
          currentSession.history.push({ role, content });
        },
        callLLM: async (messages: Message[]): Promise<string> => {
          return callLLM(messages, model, temperature);
        },
      };
    },
  );

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
