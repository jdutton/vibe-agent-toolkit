import type { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeAuthConfig, ClaudeModelConfig } from '@vibe-agent-toolkit/claude-marketplace';
import type { z } from 'zod';

/**
 * Claude Agent SDK MCP server instance returned by createSdkMcpServer
 */
export type ClaudeAgentMcpServer = ReturnType<typeof createSdkMcpServer>;

/**
 * Configuration for Claude Agent SDK LLM calls.
 * Extends ClaudeModelConfig (model, availableModels) and ClaudeAuthConfig (apiKeyHelper, forceLoginMethod, forceLoginOrgUUID)
 * from claude-marketplace, plus SDK-specific settings.
 */
export interface ClaudeAgentLLMConfig extends ClaudeModelConfig, ClaudeAuthConfig {
  /** API key for Anthropic API (SDK-specific shorthand) */
  apiKey?: string;
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
