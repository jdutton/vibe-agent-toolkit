import { type z } from 'zod';

import { buildManifest, createAsyncExecuteWrapperWithContext } from './execute-wrapper.js';
import type { Agent, LLMEventHandlerContext } from './types.js';

/**
 * Configuration for defining an LLM event handler agent
 */
export interface LLMEventHandlerConfig<TInput, TOutput> {
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

  /** Event types this agent subscribes to (optional) */
  subscribesTo?: string[];

  /** Whether this agent can be mocked in tests (default: true) */
  mockable?: boolean;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Defines an LLM event handler agent that reacts to events using
 * language model reasoning and processing.
 *
 * The agent validates inputs and outputs using Zod schemas and provides
 * access to LLM capabilities, event data, and event emission.
 *
 * @param config - Agent configuration including schemas and event subscriptions
 * @param handler - Async function that handles events using LLM
 * @returns Agent with validated execute function and manifest
 *
 * @example
 * ```typescript
 * const handler = defineLLMEventHandler(
 *   {
 *     name: 'support-ticket-handler',
 *     description: 'Analyzes and routes support tickets',
 *     version: '1.0.0',
 *     inputSchema: z.object({ ticketId: z.string(), content: z.string() }),
 *     outputSchema: z.object({ priority: z.string(), category: z.string() }),
 *     subscribesTo: ['ticket.created'],
 *   },
 *   async (input, ctx) => {
 *     // Use LLM to analyze ticket
 *     const analysis = await ctx.callLLM(
 *       `Analyze this support ticket and determine priority and category: ${input.content}`
 *     );
 *
 *     // Store analysis in state
 *     ctx.state.set(`ticket:${input.ticketId}`, analysis);
 *
 *     // Emit routing event
 *     await ctx.emit('ticket.analyzed', {
 *       ticketId: input.ticketId,
 *       analysis,
 *     });
 *
 *     return { priority: 'high', category: 'technical' };
 *   }
 * );
 * ```
 */
export function defineLLMEventHandler<TInput, TOutput>(
  config: LLMEventHandlerConfig<TInput, TOutput>,
  handler: (input: TInput, ctx: LLMEventHandlerContext) => Promise<TOutput>,
): Agent<TInput, TOutput> {
  // Build manifest
  const manifest = buildManifest(config, 'llm-event-handler', {
    mockable: config.mockable ?? true,
    ...(config.subscribesTo && { subscribesTo: config.subscribesTo }),
  });

  // Create validated execute function
  const execute = createAsyncExecuteWrapperWithContext(
    config,
    handler,
    (ctx: LLMEventHandlerContext): LLMEventHandlerContext => ({
      mockable: config.mockable ?? true,
      eventType: ctx.eventType,
      eventData: ctx.eventData,
      callLLM: ctx.callLLM,
      emit: ctx.emit,
      state: ctx.state,
    }),
  );

  return {
    name: config.name,
    execute,
    manifest,
  };
}
