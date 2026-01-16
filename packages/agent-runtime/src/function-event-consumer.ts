import { type z } from 'zod';

import { buildManifest, createAsyncExecuteWrapper } from './execute-wrapper.js';
import type { Agent, EventConsumerContext } from './types.js';

/**
 * Configuration for defining a function event consumer agent
 */
export interface FunctionEventConsumerConfig<TInput, TOutput> {
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

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Defines a function event consumer agent that reacts to events
 * using deterministic processing logic.
 *
 * The agent validates inputs and outputs using Zod schemas and provides
 * access to event data and the ability to emit new events.
 *
 * @param config - Agent configuration including schemas and event subscriptions
 * @param handler - Async function that processes events
 * @returns Agent with validated execute function and manifest
 *
 * @example
 * ```typescript
 * const consumer = defineFunctionEventConsumer(
 *   {
 *     name: 'order-processor',
 *     description: 'Processes order events',
 *     version: '1.0.0',
 *     inputSchema: z.object({ orderId: z.string() }),
 *     outputSchema: z.object({ processed: z.boolean() }),
 *     subscribesTo: ['order.created', 'order.updated'],
 *   },
 *   async (input, ctx) => {
 *     // Process the order
 *     console.log(`Processing ${ctx.eventType}: ${input.orderId}`);
 *
 *     // Store state
 *     ctx.state.set(`order:${input.orderId}`, ctx.eventData);
 *
 *     // Emit completion event
 *     await ctx.emit('order.processed', { orderId: input.orderId });
 *
 *     return { processed: true };
 *   }
 * );
 * ```
 */
export function defineFunctionEventConsumer<TInput, TOutput>(
  config: FunctionEventConsumerConfig<TInput, TOutput>,
  handler: (input: TInput, ctx: EventConsumerContext) => Promise<TOutput>,
): Agent<TInput, TOutput> {
  // Build manifest
  const manifest = buildManifest(config, 'function-event-consumer', {
    ...(config.subscribesTo && { subscribesTo: config.subscribesTo }),
  });

  // Create validated execute function
  const execute = createAsyncExecuteWrapper(config, handler);

  return {
    name: config.name,
    execute,
    manifest,
  };
}
