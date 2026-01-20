import { type z } from 'zod';

import { buildManifest, createAsyncExecuteWrapperWithContext } from './execute-wrapper.js';
import type { Agent, LLMAnalyzerContext } from './types.js';

/**
 * Configuration for defining an LLM analyzer agent
 */
export interface LLMAnalyzerConfig<TInput, TOutput> {
  /** Unique name for the agent */
  name: string;

  /** Human-readable description of what the agent does */
  description: string;

  /** Semantic version (e.g., "1.0.0") */
  version: string;

  /** Zod schema for input validation */
  inputSchema: z.ZodType<TInput>;

  /** Zod schema for output validation */
  outputSchema: z.ZodType<TOutput>;

  /** Whether this agent can be mocked in tests (default: true) */
  mockable?: boolean;

  /** LLM model identifier (optional) */
  model?: string;

  /** Temperature for LLM generation (0-1, optional) */
  temperature?: number;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Defines an LLM analyzer agent that uses language models to analyze
 * and transform data.
 *
 * The agent validates inputs and outputs using Zod schemas, provides
 * LLM context to the handler, and generates a manifest describing its
 * interface and capabilities.
 *
 * @param config - Agent configuration including schemas and LLM parameters
 * @param handler - Async function that uses LLM context to transform input
 * @returns Agent with validated execute function and manifest
 *
 * @example
 * ```typescript
 * const sentimentAgent = defineLLMAnalyzer(
 *   {
 *     name: 'sentiment-analyzer',
 *     description: 'Analyzes sentiment of text',
 *     version: '1.0.0',
 *     inputSchema: z.object({ text: z.string() }),
 *     outputSchema: z.object({ sentiment: z.enum(['positive', 'negative', 'neutral']) }),
 *     model: 'claude-3-haiku',
 *     mockable: true,
 *   },
 *   async (input, ctx) => {
 *     const response = await ctx.callLLM(`Analyze sentiment: ${input.text}`);
 *     return { sentiment: 'positive' }; // Parse response
 *   }
 * );
 * ```
 */
export function defineLLMAnalyzer<TInput, TOutput>(
  config: LLMAnalyzerConfig<TInput, TOutput>,
  handler: (input: TInput, ctx: LLMAnalyzerContext) => Promise<TOutput>,
): Agent<TInput, TOutput> {
  // Build manifest with LLM-specific metadata
  const manifest = buildManifest(config, 'llm-analyzer', {
    mockable: config.mockable ?? true,
    ...(config.model && { model: config.model }),
    ...(config.temperature !== undefined && { temperature: config.temperature }),
  });

  // Create validated execute function that accepts variable arguments
  const execute = createAsyncExecuteWrapperWithContext(
    config,
    handler,
    (ctx: LLMAnalyzerContext): LLMAnalyzerContext => ({
      mockable: config.mockable ?? true,
      callLLM: ctx.callLLM,
      ...(config.model && { model: config.model }),
      ...(config.temperature !== undefined && { temperature: config.temperature }),
    }),
  );

  return {
    name: config.name,
    execute,
    manifest,
  };
}
