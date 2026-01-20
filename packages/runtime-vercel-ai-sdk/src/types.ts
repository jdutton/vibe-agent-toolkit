import type { LanguageModel, tool as toolFunction } from 'ai';
import type { z } from 'zod';

/**
 * Vercel AI SDK tool definition
 * Compatible with generateText() and streamText()
 */
export type VercelAITool = ReturnType<typeof toolFunction>;

/**
 * Configuration for LLM calls via Vercel AI SDK
 */
export interface VercelAILLMConfig {
  /**
   * The language model to use
   * Can be from any provider (OpenAI, Anthropic, etc.)
   */
  model: LanguageModel;

  /**
   * Temperature for generation (0-1)
   * @default 0.7
   */
  temperature?: number;

  /**
   * Maximum tokens to generate
   */
  maxTokens?: number;

  /**
   * Additional model-specific settings
   */
  additionalSettings?: Record<string, unknown>;
}

/**
 * Result from converting a VAT agent to Vercel AI SDK format
 */
export interface ConversionResult<TInput, TOutput> {
  /**
   * The Vercel AI SDK tool definition
   */
  tool: VercelAITool;

  /**
   * Original input schema for reference
   */
  inputSchema: z.ZodType<TInput>;

  /**
   * Original output schema for reference
   */
  outputSchema: z.ZodType<TOutput>;

  /**
   * Agent metadata
   */
  metadata: {
    name: string;
    description: string;
    version: string;
    archetype: string;
  };
}
