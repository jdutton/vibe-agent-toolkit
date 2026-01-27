import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import type { Agent, Message, PureFunctionAgent } from '@vibe-agent-toolkit/agent-runtime';
import type { z } from 'zod';

import type { ClaudeAgentLLMConfig, ClaudeAgentMcpServer } from '../types.js';

const DEFAULT_MODEL = 'claude-3-5-haiku-20241022';

/**
 * Creates metadata object for a single agent conversion
 */
export function createSingleToolMetadata(
  manifest: { name: string; description: string; version: string },
  archetype: string,
  mcpServerName: string,
): {
  name: string;
  description: string;
  version: string;
  archetype: string;
  serverName: string;
  toolName: string;
} {
  return {
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    archetype,
    serverName: mcpServerName,
    toolName: `mcp__${mcpServerName}__${manifest.name}`,
  };
}

/**
 * Creates metadata object for batch conversion
 */
export function createBatchToolMetadata(
  key: string,
  manifest: { name: string; description: string; version: string },
  archetype: string,
  serverName: string,
): {
  name: string;
  description: string;
  version: string;
  archetype: string;
  toolName: string;
} {
  return {
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    archetype,
    toolName: `mcp__${serverName}__${key}`,
  };
}

/**
 * Creates an MCP server with a single tool
 */
export function createMcpServerWithTool<TInput, TOutput>(
  manifest: { name: string; description: string; version: string },
  mcpServerName: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  handler: (input: TInput) => Promise<TOutput>,
): ClaudeAgentMcpServer {
  const server = createSdkMcpServer({
    name: mcpServerName,
    version: manifest.version,
    tools: [
      tool(
        manifest.name,
        manifest.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema as any, // Claude Agent SDK accepts Zod schemas
        async (args, _extra) => {
          const validatedInput = inputSchema.parse(args);
          // handler is agent.execute which returns output directly (unwrapped)
          // The agent's execute wrapper validates input/output schemas and throws on error
          const output = await handler(validatedInput);

          // Validate the output with schema (redundant but explicit)
          const validatedOutput = outputSchema.parse(output);

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(validatedOutput, null, 2),
              },
            ],
          };
        },
      ),
    ],
  });

  return server;
}

/**
 * Creates tool handler for batch conversion
 */
export function createToolHandler<TInput, TOutput>(
  agent: Agent<TInput, TOutput> | PureFunctionAgent<TInput, TOutput>,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  getContext?: (input: TInput) => unknown,
): (args: unknown, _extra: unknown) => Promise<{
  content: Array<{
    type: 'text';
    text: string;
  }>;
}> {
  return async (args: unknown, _extra: unknown) => {
    const validatedInput = inputSchema.parse(args);

    const result = getContext
      ? await (agent as Agent<TInput, TOutput>).execute(validatedInput, getContext(validatedInput))
      : await (agent as PureFunctionAgent<TInput, TOutput>).execute(validatedInput);

    const validatedOutput = outputSchema.parse(result);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(validatedOutput, null, 2),
        },
      ],
    };
  };
}

/**
 * Type for batch conversion metadata
 */
export type BatchToolMetadata = Record<
  string,
  {
    name: string;
    description: string;
    version: string;
    archetype: string;
    toolName: string;
  }
>;

/**
 * Generic helper to convert a single agent to MCP tool
 * Reduces duplication between conversational and analyzer adapters
 */
export function convertAgentToTool<TInput, TOutput>(
  agent: Agent<TInput, TOutput>,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  serverName: string | undefined,
  archetype: string,
  handler: (input: TInput) => Promise<TOutput>,
): {
  server: ReturnType<typeof createSdkMcpServer>;
  metadata: { name: string; description: string; version: string; archetype: string; serverName: string; toolName: string };
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
} {
  const { manifest } = agent;
  const mcpServerName = serverName ?? manifest.name;

  // Create MCP server with the agent as a tool
  const server = createMcpServerWithTool(manifest, mcpServerName, inputSchema, outputSchema, handler);

  return {
    server,
    metadata: createSingleToolMetadata(manifest, archetype, mcpServerName),
    inputSchema,
    outputSchema,
  };
}

/**
 * Factory to create single agent converter functions
 * Eliminates duplication between LLM analyzer and conversational assistant converters
 *
 * @param archetype - Agent archetype name
 * @param createContext - Function to create LLM context from config
 * @param createHandler - Function to create handler from agent and context
 * @returns Converter function with same signature as manual implementations
 */
export function createSingleConverterFunction<TInput, TOutput, TCallLLM = unknown>(
  archetype: string,
  createContext: (config: ClaudeAgentLLMConfig) => {
    callLLM: TCallLLM;
    model: string;
    temperature: number;
  },
  createHandler: (agent: Agent<TInput, TOutput>, callLLM: TCallLLM, model: string, temperature: number) => (
    input: TInput,
  ) => Promise<TOutput>,
): (
  agent: Agent<TInput, TOutput>,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  llmConfig: ClaudeAgentLLMConfig,
  serverName?: string,
) => {
  server: ReturnType<typeof createSdkMcpServer>;
  metadata: {
    name: string;
    description: string;
    version: string;
    archetype: string;
    serverName: string;
    toolName: string;
  };
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
} {
  return function (
    agent: Agent<TInput, TOutput>,
    inputSchema: z.ZodType<TInput>,
    outputSchema: z.ZodType<TOutput>,
    llmConfig: ClaudeAgentLLMConfig,
    serverName?: string,
  ) {
    const { callLLM, model, temperature } = createContext(llmConfig);
    const handler = createHandler(agent, callLLM, model, temperature);
    return convertAgentToTool(agent, inputSchema, outputSchema, serverName, archetype, handler);
  };
}

/**
 * Helper to create tools array from agent configs
 * Reduces duplication in batch conversion functions
 */
export function createToolsFromConfigs<TInput, TOutput>(
  configs: Record<string, { agent: Agent<TInput, TOutput> | PureFunctionAgent<TInput, TOutput>; inputSchema: z.ZodType<TInput>; outputSchema: z.ZodType<TOutput> }>,
  archetype: string,
  serverName: string,
  contextFactory: (key: string) => unknown,
): {
  tools: ReturnType<typeof tool>[];
  toolsMetadata: BatchToolMetadata;
} {
  const tools: ReturnType<typeof tool>[] = [];
  const toolsMetadata: BatchToolMetadata = {};

  // Convert each agent to a tool
  for (const [key, config] of Object.entries(configs)) {
    const agent = config.agent;
    const { manifest } = agent;

    tools.push(
      tool(
        key,
        manifest.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config.inputSchema as any,
        createToolHandler(agent, config.inputSchema, config.outputSchema, () => contextFactory(key)),
      ),
    );

    toolsMetadata[key] = createBatchToolMetadata(key, manifest, archetype, serverName);
  }

  return { tools, toolsMetadata };
}

/**
 * Helper to extract text from Anthropic API response
 *
 * @param response - Anthropic API response
 * @returns Extracted text content
 */
export function extractTextFromResponse(response: Anthropic.Messages.Message): string {
  const textBlock = response.content.find(
    (block): block is Anthropic.Messages.TextBlock => block.type === 'text',
  );
  return textBlock?.text ?? '';
}

/**
 * Format messages for Anthropic API
 *
 * Extracts system prompt and filters/maps remaining messages to Anthropic format
 *
 * @param messages - Array of messages to format
 * @returns Object with systemPrompt (if any) and conversationMessages in Anthropic format
 */
export function formatMessagesForAnthropic(messages: Message[]): {
  systemPrompt?: string;
  conversationMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  // Collect all system messages and combine them
  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversationMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

  const result: {
    systemPrompt?: string;
    conversationMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  } = {
    conversationMessages,
  };

  // Combine all system messages with double newlines
  if (systemMessages.length > 0) {
    result.systemPrompt = systemMessages.map((m) => m.content).join('\n\n');
  }

  return result;
}

/**
 * Creates an Anthropic client and configuration
 */
function createAnthropicClient(llmConfig: ClaudeAgentLLMConfig) {
  const anthropic = new Anthropic({
    apiKey: llmConfig.apiKey ?? process.env['ANTHROPIC_API_KEY'],
  });

  const model = llmConfig.model ?? DEFAULT_MODEL;
  const temperature = llmConfig.temperature ?? 0.7;
  const maxTokens = llmConfig.maxTokens ?? 4096;

  return { anthropic, model, temperature, maxTokens };
}

/**
 * Creates an Anthropic client and callLLM function for LLM Analyzer agents
 *
 * @param llmConfig - LLM configuration
 * @returns Object containing callLLM function, model, and temperature
 */
export function createAnthropicLLMContext(llmConfig: ClaudeAgentLLMConfig): {
  callLLM: (prompt: string) => Promise<string>;
  model: string;
  temperature: number;
} {
  const { anthropic, model, temperature, maxTokens } = createAnthropicClient(llmConfig);

  const callLLM = async (prompt: string): Promise<string> => {
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: 'user', content: prompt }],
    });

    return extractTextFromResponse(response);
  };

  return { callLLM, model, temperature };
}

/**
 * Creates an Anthropic client and callLLM function for Conversational Assistant agents
 *
 * @param llmConfig - LLM configuration
 * @returns Object containing callLLM function, model, and temperature
 */
export function createAnthropicConversationalContext(llmConfig: ClaudeAgentLLMConfig): {
  callLLM: (messages: Message[], modelOverride?: string, tempOverride?: number) => Promise<string>;
  model: string;
  temperature: number;
} {
  const { anthropic, model, temperature, maxTokens } = createAnthropicClient(llmConfig);

  const callLLM = async (messages: Message[], modelOverride?: string, tempOverride?: number): Promise<string> => {
    // Format messages for Anthropic API using shared helper
    const { systemPrompt, conversationMessages } = formatMessagesForAnthropic(messages);

    const response = await anthropic.messages.create({
      model: modelOverride ?? model,
      max_tokens: maxTokens,
      temperature: tempOverride ?? temperature,
      ...(systemPrompt && { system: systemPrompt }),
      messages: conversationMessages,
    });

    return extractTextFromResponse(response);
  };

  return { callLLM, model, temperature };
}
