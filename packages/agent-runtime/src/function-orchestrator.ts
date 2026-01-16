import { buildManifest, createAsyncExecuteWrapper } from './execute-wrapper.js';
import type { Agent, BaseAgentConfig, OrchestratorContext } from './types.js';

/**
 * Configuration for defining a function orchestrator agent
 */
export type FunctionOrchestratorConfig<TInput, TOutput> = BaseAgentConfig<TInput, TOutput>;

/**
 * Defines a function orchestrator agent that coordinates multiple other
 * agents or functions to accomplish complex workflows.
 *
 * The agent validates inputs and outputs using Zod schemas and provides
 * utilities for calling other agents, parallel execution, and retries.
 *
 * @param config - Agent configuration including schemas
 * @param handler - Async function that orchestrates other agents
 * @returns Agent with validated execute function and manifest
 *
 * @example
 * ```typescript
 * const orchestrator = defineFunctionOrchestrator(
 *   {
 *     name: 'data-pipeline',
 *     description: 'Orchestrates data processing pipeline',
 *     version: '1.0.0',
 *     inputSchema: z.object({ data: z.array(z.string()) }),
 *     outputSchema: z.object({ processed: z.array(z.string()) }),
 *   },
 *   async (input, ctx) => {
 *     // Process items in parallel
 *     const results = await ctx.parallel(
 *       input.data.map(item => () => ctx.call('process-item', { item }))
 *     );
 *
 *     // Aggregate with retry
 *     const aggregated = await ctx.retry(
 *       () => ctx.call('aggregate', { results }),
 *       { maxAttempts: 3 }
 *     );
 *
 *     return { processed: aggregated };
 *   }
 * );
 * ```
 */
export function defineFunctionOrchestrator<TInput, TOutput>(
  config: FunctionOrchestratorConfig<TInput, TOutput>,
  handler: (input: TInput, ctx: OrchestratorContext) => Promise<TOutput>,
): Agent<TInput, TOutput> {
  // Build manifest
  const manifest = buildManifest(config, 'function-orchestrator');

  // Create validated execute function
  const execute = createAsyncExecuteWrapper(config, handler);

  return {
    name: config.name,
    execute,
    manifest,
  };
}
