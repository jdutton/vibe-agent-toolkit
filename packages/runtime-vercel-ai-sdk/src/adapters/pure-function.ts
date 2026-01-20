import type { PureFunctionAgent } from '@vibe-agent-toolkit/agent-runtime';
import { tool } from 'ai';
import type { z } from 'zod';

import type { ConversionResult, VercelAITool } from '../types.js';

/**
 * Converts a VAT PureFunctionAgent to a Vercel AI SDK tool.
 *
 * Pure function tools are synchronous and deterministic - perfect for
 * structured data validation, transformation, and computation.
 *
 * Example:
 * ```typescript
 * import { haikuValidatorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { HaikuSchema, HaikuValidationResultSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { convertPureFunctionToTool } from '@vibe-agent-toolkit/runtime-vercel-ai-sdk';
 *
 * const haikuTool = convertPureFunctionToTool(
 *   haikuValidatorAgent,
 *   HaikuSchema,
 *   HaikuValidationResultSchema
 * );
 *
 * // Use with generateText()
 * const result = await generateText({
 *   model: openai('gpt-4'),
 *   tools: { validateHaiku: haikuTool.tool },
 *   prompt: 'Validate this haiku: ...'
 * });
 * ```
 *
 * @param agent - The VAT pure function agent to convert
 * @param inputSchema - The Zod input schema
 * @param outputSchema - The Zod output schema
 * @returns Vercel AI SDK tool definition with metadata
 */
export function convertPureFunctionToTool<TInput, TOutput>(
  agent: PureFunctionAgent<TInput, TOutput>,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
): ConversionResult<TInput, TOutput> {
  const { manifest } = agent;

  // AI SDK v6: Use inputSchema instead of parameters, add options parameter to execute
  // Type assertion needed because generic z.ZodType<TInput> doesn't satisfy tool()'s
  // compile-time type constraints (FlexibleSchema<INPUT>), but works correctly at runtime
  const vercelTool = tool({
    description: manifest.description,
    inputSchema: inputSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (args: any, _options: any) => {
      // The schema validates the input at runtime
      return agent.execute(args as TInput);
    },
  } as unknown as Parameters<typeof tool>[0]);

  return {
    tool: vercelTool as unknown as VercelAITool,
    inputSchema,
    outputSchema,
    metadata: {
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      archetype: manifest.archetype,
    },
  };
}

/**
 * Configuration for batch tool conversion
 */
export interface ToolConversionConfig<TInput, TOutput> {
  agent: PureFunctionAgent<TInput, TOutput>;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
}

/**
 * Batch converts multiple pure function agents to Vercel AI SDK tools.
 *
 * Useful when you want to provide multiple tools to an LLM in one call.
 *
 * Example:
 * ```typescript
 * import { haikuValidatorAgent, nameValidatorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { HaikuSchema, HaikuValidationResultSchema, NameValidationInputSchema, NameValidationResultSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { convertPureFunctionsToTools } from '@vibe-agent-toolkit/runtime-vercel-ai-sdk';
 *
 * const tools = convertPureFunctionsToTools({
 *   validateHaiku: {
 *     agent: haikuValidatorAgent,
 *     inputSchema: HaikuSchema,
 *     outputSchema: HaikuValidationResultSchema,
 *   },
 *   validateName: {
 *     agent: nameValidatorAgent,
 *     inputSchema: NameValidationInputSchema,
 *     outputSchema: NameValidationResultSchema,
 *   },
 * });
 *
 * const result = await generateText({
 *   model: openai('gpt-4'),
 *   tools,
 *   prompt: 'Validate these cat names and haikus...'
 * });
 * ```
 *
 * @param configs - Map of tool names to conversion configurations
 * @returns Map of tool names to Vercel AI SDK tools
 */
export function convertPureFunctionsToTools(
  configs: Record<string, ToolConversionConfig<unknown, unknown>>,
): Record<string, VercelAITool> {
  const tools: Record<string, VercelAITool> = {};

  for (const [name, config] of Object.entries(configs)) {
    const converted = convertPureFunctionToTool(
      config.agent,
      config.inputSchema,
      config.outputSchema,
    );
    tools[name] = converted.tool;
  }

  return tools;
}
