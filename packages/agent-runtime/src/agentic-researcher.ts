import { type z } from 'zod';

import { buildManifest, createAsyncExecuteWrapperWithContext } from './execute-wrapper.js';
import type { Agent, ResearcherContext } from './types.js';

/**
 * Configuration for defining an agentic researcher agent
 */
export interface AgenticResearcherConfig<TInput, TOutput> {
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

  /** List of tool names this agent can use (optional) */
  tools?: string[];

  /** Maximum number of iterations (default: 10) */
  maxIterations?: number;

  /** Whether this agent can be mocked in tests (default: true) */
  mockable?: boolean;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Defines an agentic researcher agent that iteratively uses tools and LLM
 * reasoning to accomplish complex research tasks.
 *
 * The agent validates inputs and outputs using Zod schemas, provides
 * access to tools and LLM context, and tracks iteration count.
 *
 * @param config - Agent configuration including schemas and tools
 * @param handler - Async function that uses research context
 * @returns Agent with validated execute function and manifest
 *
 * @example
 * ```typescript
 * const researchAgent = defineAgenticResearcher(
 *   {
 *     name: 'web-researcher',
 *     description: 'Researches topics using web search',
 *     version: '1.0.0',
 *     inputSchema: z.object({ topic: z.string() }),
 *     outputSchema: z.object({ findings: z.string() }),
 *     tools: ['search', 'scrape'],
 *     maxIterations: 5,
 *   },
 *   async (input, ctx) => {
 *     let findings = '';
 *     while (ctx.iterationCount < ctx.maxIterations) {
 *       const query = await ctx.callLLM(`What should I search next for: ${input.topic}`);
 *       const results = await ctx.callTool('search', { query });
 *       findings += results;
 *       ctx.iterationCount++;
 *     }
 *     return { findings };
 *   }
 * );
 * ```
 */
export function defineAgenticResearcher<TInput, TOutput>(
  config: AgenticResearcherConfig<TInput, TOutput>,
  handler: (input: TInput, ctx: ResearcherContext) => Promise<TOutput>,
): Agent<TInput, TOutput> {
  // Build manifest
  const manifest = buildManifest(config, 'agentic-researcher', {
    mockable: config.mockable ?? true,
    maxIterations: config.maxIterations ?? 10,
    ...(config.tools && { tools: config.tools }),
  });

  // Create validated execute function
  const execute = createAsyncExecuteWrapperWithContext(
    config,
    handler,
    (ctx: ResearcherContext): ResearcherContext => ({
      mockable: config.mockable ?? true,
      tools: ctx.tools,
      callLLM: ctx.callLLM,
      callTool: ctx.callTool,
      iterationCount: 0,
      maxIterations: config.maxIterations ?? 10,
    }),
  );

  return {
    name: config.name,
    execute,
    manifest,
  };
}
