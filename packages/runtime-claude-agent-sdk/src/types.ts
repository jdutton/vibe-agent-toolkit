import type { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';

/**
 * Claude Agent SDK MCP server instance returned by createSdkMcpServer
 */
export type ClaudeAgentMcpServer = ReturnType<typeof createSdkMcpServer>;

/**
 * Configuration for Claude Agent SDK LLM calls
 * Used by LLM Analyzer agents that make their own LLM calls
 */
export interface ClaudeAgentLLMConfig {
  /** API key for Anthropic API */
  apiKey?: string;
  /** Model to use (defaults to claude-3-5-haiku-20241022) */
  model?: string;
  /** Temperature for LLM calls */
  temperature?: number;
  /** Max tokens for LLM calls */
  maxTokens?: number;
}

/**
 * Standard return type for single agent conversion
 */
export interface AgentConversionResult<TInput, TOutput> {
  server: ClaudeAgentMcpServer;
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
}

/**
 * Type for single agent converter functions
 * Eliminates duplication in converter function signatures
 */
export type SingleAgentConverter = <TInput, TOutput>(
  agent: { manifest: { name: string; description: string; version: string } },
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  llmConfig: ClaudeAgentLLMConfig,
  serverName?: string,
) => AgentConversionResult<TInput, TOutput>;

/**
 * Standard return type for batch agent conversion
 */
export interface BatchConversionResult {
  server: ClaudeAgentMcpServer;
  metadata: {
    serverName: string;
    tools: Record<
      string,
      {
        name: string;
        description: string;
        version: string;
        archetype: string;
        toolName: string;
      }
    >;
  };
}
