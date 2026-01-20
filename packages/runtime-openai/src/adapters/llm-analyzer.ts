import { batchConvert, type Agent } from '@vibe-agent-toolkit/agent-runtime';
import type { z } from 'zod';

import type { LLMAnalyzerConversionConfigs, OpenAIConfig } from '../types.js';

/**
 * Converts a VAT LLM Analyzer agent to an executable async function with OpenAI
 *
 * @param agent - The VAT LLM analyzer agent to convert
 * @param inputSchema - Zod schema for validating inputs
 * @param outputSchema - Zod schema for validating outputs
 * @param openaiConfig - OpenAI configuration
 * @returns Async function that executes the agent with OpenAI chat completions
 *
 * @example
 * ```typescript
 * import OpenAI from 'openai';
 * import { nameGeneratorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { convertLLMAnalyzerToFunction } from '@vibe-agent-toolkit/runtime-openai';
 *
 * const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
 *
 * const generateName = convertLLMAnalyzerToFunction(
 *   nameGeneratorAgent,
 *   NameGeneratorInputSchema,
 *   NameSuggestionSchema,
 *   {
 *     client: openai,
 *     model: 'gpt-4o-mini',
 *     temperature: 0.9,
 *   }
 * );
 *
 * const result = await generateName({
 *   characteristics: {
 *     physical: { furColor: 'Orange' },
 *     behavioral: { personality: ['Distinguished'] },
 *     description: 'A noble cat',
 *   },
 * });
 * console.log(result.name); // "Sir Whiskersworth III"
 * ```
 */
export function convertLLMAnalyzerToFunction<TInput, TOutput>(
  agent: Agent<TInput, TOutput>,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  openaiConfig: OpenAIConfig,
): (input: TInput) => Promise<TOutput> {
  // Create callLLM function that uses OpenAI chat completions
  const callLLM = async (prompt: string): Promise<string> => {
    const params: {
      model: string;
      messages: Array<{ role: 'user'; content: string }>;
      temperature?: number;
      max_tokens?: number;
    } = {
      model: openaiConfig.model,
      messages: [{ role: 'user', content: prompt }],
    };

    // Only add optional parameters if defined
    if (openaiConfig.temperature !== undefined) {
      params.temperature = openaiConfig.temperature;
    }
    if (openaiConfig.maxTokens !== undefined) {
      params.max_tokens = openaiConfig.maxTokens;
    }

    const response = await openaiConfig.client.chat.completions.create({
      ...params,
      ...openaiConfig.additionalSettings,
    });

    return response.choices[0]?.message.content ?? '';
  };

  // Return wrapped function
  return async (input: TInput): Promise<TOutput> => {
    // Validate input
    const validatedInput = inputSchema.parse(input);

    // Execute the agent with mock mode disabled (real LLM call)
    const context = {
      mockable: false,
      model: openaiConfig.model,
      temperature: openaiConfig.temperature ?? 0.7,
      callLLM,
    };

    const output = await agent.execute(validatedInput, context);

    // Validate output
    return outputSchema.parse(output);
  };
}

/**
 * Batch converts multiple VAT LLM Analyzer agents to executable functions
 *
 * @param configs - Map of function names to conversion configurations
 * @param openaiConfig - Shared OpenAI configuration for all agents
 * @returns Map of function names to executable async functions
 *
 * @example
 * ```typescript
 * import OpenAI from 'openai';
 *
 * const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
 *
 * const functions = convertLLMAnalyzersToFunctions(
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
 *   {
 *     client: openai,
 *     model: 'gpt-4o-mini',
 *     temperature: 0.8,
 *   }
 * );
 *
 * const name = await functions.generateName(catInput);
 * const haiku = await functions.generateHaiku(catInput);
 * ```
 */
export function convertLLMAnalyzersToFunctions(
  configs: LLMAnalyzerConversionConfigs,
  openaiConfig: OpenAIConfig,
): Record<string, (input: unknown) => Promise<unknown>> {
  return batchConvert(configs, (config) =>
    convertLLMAnalyzerToFunction(
      config.agent as Agent<unknown, unknown>,
      config.inputSchema,
      config.outputSchema,
      openaiConfig,
    ),
  );
}
