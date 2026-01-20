import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, PureFunctionAgent } from '@vibe-agent-toolkit/agent-runtime';
import type { z } from 'zod';

import type { ClaudeAgentMcpServer } from '../types.js';

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
          const result = await handler(validatedInput);
          const validatedOutput = outputSchema.parse(result);

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
