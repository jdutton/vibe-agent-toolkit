import type { Agent } from '@vibe-agent-toolkit/agent-runtime';
import { generateText } from 'ai';
import type { z } from 'zod';

import type { VercelAILLMConfig } from '../types.js';

/**
 * Converts a VAT LLM Analyzer agent to a function compatible with Vercel AI SDK.
 *
 * LLM analyzers make a single LLM call to analyze input and produce structured output.
 * They're perfect for classification, extraction, generation, and analysis tasks.
 *
 * Example:
 * ```typescript
 * import { openai } from '@ai-sdk/openai';
 * import { nameGeneratorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { NameGeneratorInputSchema, NameSuggestionSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { convertLLMAnalyzerToFunction } from '@vibe-agent-toolkit/runtime-vercel-ai-sdk';
 *
 * const generateName = convertLLMAnalyzerToFunction(
 *   nameGeneratorAgent,
 *   NameGeneratorInputSchema,
 *   NameSuggestionSchema,
 *   { model: openai('gpt-4'), temperature: 0.9 }
 * );
 *
 * // Use the function
 * const result = await generateName({
 *   characteristics: { physical: { furColor: 'Orange' }, behavioral: { personality: ['Mischievous'] } }
 * });
 * console.log(result.name); // "Sir Knocksalot"
 * ```
 *
 * @param agent - The VAT LLM analyzer agent to convert
 * @param inputSchema - The Zod input schema
 * @param outputSchema - The Zod output schema
 * @param llmConfig - Configuration for the LLM (model, temperature, etc.)
 * @returns An async function that executes the agent with the configured LLM
 */
export function convertLLMAnalyzerToFunction<TInput, TOutput>(
  agent: Agent<TInput, TOutput>,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  llmConfig: VercelAILLMConfig,
): (input: TInput) => Promise<TOutput> {
  return async (input: TInput) => {
    // Validate input
    const validatedInput = inputSchema.parse(input);

    // Create LLM context with Vercel AI SDK's generateText
    const callLLM = async (prompt: string) => {
      const result = await generateText({
        model: llmConfig.model,
        ...(llmConfig.temperature ? { temperature: llmConfig.temperature } : {}),
        ...(llmConfig.maxTokens ? { maxTokens: llmConfig.maxTokens } : {}),
        ...llmConfig.additionalSettings,
        prompt,
      });

      return result.text;
    };

    // Execute the agent with mock mode disabled (real LLM call)
    const context = {
      mockable: false,
      model: llmConfig.model.modelId ?? 'unknown',
      temperature: llmConfig.temperature ?? 0.7,
      callLLM,
    };

    // Call the agent's execute function with the LLM context
    const output = await agent.execute(validatedInput, context);

    // Validate output
    return outputSchema.parse(output);
  };
}

/**
 * Batch converts multiple LLM analyzer agents to executable functions.
 *
 * Useful when you need multiple AI-powered analysis functions with a shared LLM configuration.
 *
 * Example:
 * ```typescript
 * import { openai } from '@ai-sdk/openai';
 * import { nameGeneratorAgent, haikuGeneratorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { convertLLMAnalyzersToFunctions } from '@vibe-agent-toolkit/runtime-vercel-ai-sdk';
 *
 * const analyzers = convertLLMAnalyzersToFunctions(
 *   {
 *     generateName: {
 *       agent: nameGeneratorAgent,
 *       inputSchema: NameGeneratorInputSchema,
 *       outputSchema: NameSuggestionSchema,
 *     },
 *     generateHaiku: {
 *       agent: haikuGeneratorAgent,
 *       inputSchema: HaikuGeneratorInputSchema,
 *       outputSchema: HaikuSchema,
 *     },
 *   },
 *   { model: openai('gpt-4'), temperature: 0.8 }
 * );
 *
 * // Use the functions
 * const name = await analyzers.generateName({ characteristics });
 * const haiku = await analyzers.generateHaiku({ characteristics });
 * ```
 *
 * @param configs - Map of function names to conversion configurations
 * @param llmConfig - Shared LLM configuration for all agents
 * @returns Map of function names to executable async functions
 */
export interface LLMAnalyzerConversionConfig<TInput, TOutput> {
  agent: Agent<TInput, TOutput>;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
}

export function convertLLMAnalyzersToFunctions<
  T extends Record<string, LLMAnalyzerConversionConfig<unknown, unknown>>,
>(
  configs: T,
  llmConfig: VercelAILLMConfig,
): Record<keyof T, (input: unknown) => Promise<unknown>> {
  const functions: Record<string, (input: unknown) => Promise<unknown>> = {};

  for (const [name, config] of Object.entries(configs)) {
    functions[name] = convertLLMAnalyzerToFunction(
      config.agent,
      config.inputSchema,
      config.outputSchema,
      llmConfig,
    );
  }

  return functions as Record<keyof T, (input: unknown) => Promise<unknown>>;
}
