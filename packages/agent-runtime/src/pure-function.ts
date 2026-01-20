import { buildManifest, createPureExecuteWrapper } from './execute-wrapper.js';
import type { BaseAgentConfig, PureFunctionAgent } from './types.js';

/**
 * Configuration for defining a pure function agent
 */
export type PureFunctionConfig<TInput, TOutput> = BaseAgentConfig<TInput, TOutput>;

/**
 * Defines a pure function agent that performs deterministic transformations
 * without side effects or external dependencies.
 *
 * The agent validates inputs and outputs using Zod schemas and generates
 * a manifest describing its interface.
 *
 * @param config - Agent configuration including schemas and metadata
 * @param handler - Pure function that transforms input to output
 * @returns Agent with validated execute function and manifest
 *
 * @example
 * ```typescript
 * const addAgent = definePureFunction(
 *   {
 *     name: 'add',
 *     description: 'Adds two numbers',
 *     version: '1.0.0',
 *     inputSchema: z.object({ a: z.number(), b: z.number() }),
 *     outputSchema: z.number(),
 *   },
 *   (input) => input.a + input.b
 * );
 *
 * const result = addAgent.execute({ a: 2, b: 3 }); // 5
 * ```
 */
export function definePureFunction<TInput, TOutput>(
  config: PureFunctionConfig<TInput, TOutput>,
  handler: (input: TInput) => TOutput,
): PureFunctionAgent<TInput, TOutput> {
  // Build manifest
  const manifest = buildManifest(config, 'pure-function');

  // Create validated execute function
  const execute = createPureExecuteWrapper(config, handler);

  return {
    name: config.name,
    execute,
    manifest,
  };
}
