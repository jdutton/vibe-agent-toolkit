import { type z } from 'zod';

import { buildManifest, createAsyncExecuteWrapperWithContext } from './execute-wrapper.js';
import type { Agent, CoordinatorContext } from './types.js';

/**
 * Configuration for defining an LLM coordinator agent
 */
export interface LLMCoordinatorConfig<TInput, TOutput> {
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

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Defines an LLM coordinator agent that uses language models to make
 * decisions about which agents to call and how to coordinate workflows.
 *
 * The agent validates inputs and outputs using Zod schemas, provides
 * access to LLM reasoning and other agents, and supports routing logic.
 *
 * @param config - Agent configuration including schemas
 * @param handler - Async function that coordinates using LLM
 * @returns Agent with validated execute function and manifest
 *
 * @example
 * ```typescript
 * const coordinator = defineLLMCoordinator(
 *   {
 *     name: 'task-coordinator',
 *     description: 'Coordinates task execution based on LLM decisions',
 *     version: '1.0.0',
 *     inputSchema: z.object({ task: z.string() }),
 *     outputSchema: z.object({ result: z.string() }),
 *   },
 *   async (input, ctx) => {
 *     // Ask LLM to decide which agent to use
 *     const decision = await ctx.callLLM(
 *       `Which agent should handle this task: ${input.task}? Choose: simple, complex, or research`
 *     );
 *
 *     // Route to appropriate agent
 *     const result = await ctx.route(decision, {
 *       simple: () => ctx.call('simple-processor', input),
 *       complex: () => ctx.call('complex-processor', input),
 *       research: () => ctx.call('research-agent', input),
 *     });
 *
 *     return { result: String(result) };
 *   }
 * );
 * ```
 */
export function defineLLMCoordinator<TInput, TOutput>(
  config: LLMCoordinatorConfig<TInput, TOutput>,
  handler: (input: TInput, ctx: CoordinatorContext) => Promise<TOutput>,
): Agent<TInput, TOutput> {
  // Build manifest
  const manifest = buildManifest(config, 'llm-coordinator', {
    mockable: config.mockable ?? true,
  });

  // Create validated execute function
  const execute = createAsyncExecuteWrapperWithContext(
    config,
    handler,
    (ctx: CoordinatorContext): CoordinatorContext => ({
      mockable: config.mockable ?? true,
      call: ctx.call,
      callLLM: ctx.callLLM,
      route: ctx.route,
      state: ctx.state,
    }),
  );

  return {
    name: config.name,
    execute,
    manifest,
  };
}
