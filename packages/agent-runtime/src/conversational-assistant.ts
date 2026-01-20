import { type z } from 'zod';

import { buildManifest, createAsyncExecuteWrapperWithContext } from './execute-wrapper.js';
import type { Agent, ConversationalContext } from './types.js';

/**
 * Configuration for defining a conversational assistant agent
 */
export interface ConversationalAssistantConfig<TInput, TOutput> {
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

  /** System prompt for the assistant (optional) */
  systemPrompt?: string;

  /** Whether this agent can be mocked in tests (default: true) */
  mockable?: boolean;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Defines a conversational assistant agent that maintains context across
 * multiple interactions using conversation history.
 *
 * The agent validates inputs and outputs using Zod schemas, provides
 * conversation context to the handler, and generates a manifest describing
 * its interface.
 *
 * @param config - Agent configuration including schemas and system prompt
 * @param handler - Async function that uses conversation context
 * @returns Agent with validated execute function and manifest
 *
 * @example
 * ```typescript
 * const chatAgent = defineConversationalAssistant(
 *   {
 *     name: 'helpful-assistant',
 *     description: 'A helpful conversational assistant',
 *     version: '1.0.0',
 *     inputSchema: z.object({ message: z.string() }),
 *     outputSchema: z.object({ reply: z.string() }),
 *     systemPrompt: 'You are a helpful assistant.',
 *   },
 *   async (input, ctx) => {
 *     ctx.addToHistory('user', input.message);
 *     const response = await ctx.callLLM(ctx.history);
 *     ctx.addToHistory('assistant', response);
 *     return { reply: response };
 *   }
 * );
 * ```
 */
export function defineConversationalAssistant<TInput, TOutput>(
  config: ConversationalAssistantConfig<TInput, TOutput>,
  handler: (input: TInput, ctx: ConversationalContext) => Promise<TOutput>,
): Agent<TInput, TOutput> {
  // Build manifest
  const manifest = buildManifest(config, 'conversational-assistant', {
    mockable: config.mockable ?? true,
    ...(config.systemPrompt && { systemPrompt: config.systemPrompt }),
  });

  // Create validated execute function
  const execute = createAsyncExecuteWrapperWithContext(
    config,
    handler,
    (ctx: ConversationalContext): ConversationalContext => ({
      mockable: config.mockable ?? true,
      history: ctx.history,
      addToHistory: ctx.addToHistory,
      callLLM: ctx.callLLM,
    }),
  );

  return {
    name: config.name,
    execute,
    manifest,
  };
}
