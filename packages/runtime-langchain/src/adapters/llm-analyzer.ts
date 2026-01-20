import { batchConvert, type Agent } from '@vibe-agent-toolkit/agent-runtime';
import type { z } from 'zod';

import type { LangChainLLMConfig, LLMAnalyzerConversionConfigs } from '../types.js';

/**
 * Converts a VAT LLM Analyzer agent to an executable async function with LangChain
 *
 * @param agent - The VAT LLM analyzer agent to convert
 * @param inputSchema - Zod schema for validating inputs
 * @param outputSchema - Zod schema for validating outputs
 * @param llmConfig - LangChain LLM configuration
 * @returns Async function that executes the agent with LangChain model
 *
 * @example
 * ```typescript
 * import { ChatOpenAI } from '@langchain/openai';
 * import { nameGeneratorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { convertLLMAnalyzerToFunction } from '@vibe-agent-toolkit/runtime-langchain';
 *
 * const generateName = convertLLMAnalyzerToFunction(
 *   nameGeneratorAgent,
 *   NameGeneratorInputSchema,
 *   NameSuggestionSchema,
 *   {
 *     model: new ChatOpenAI({ modelName: 'gpt-4o-mini' }),
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
  llmConfig: LangChainLLMConfig,
): (input: TInput) => Promise<TOutput> {
  // Create callLLM function that uses LangChain model
  const callLLM = async (prompt: string): Promise<string> => {
    const response = await llmConfig.model.invoke(prompt);
    return response.content.toString();
  };

  // Return wrapped function
  return async (input: TInput): Promise<TOutput> => {
    // Validate input
    const validatedInput = inputSchema.parse(input);

    // Extract model name from LangChain model
    let modelName: string;
    if ('modelName' in llmConfig.model && typeof llmConfig.model.modelName === 'string') {
      modelName = llmConfig.model.modelName;
    } else if ('model' in llmConfig.model && typeof llmConfig.model.model === 'string') {
      modelName = llmConfig.model.model;
    } else {
      modelName = 'unknown';
    }

    // Execute the agent with mock mode disabled (real LLM call)
    const context = {
      mockable: false,
      model: modelName,
      temperature: llmConfig.temperature ?? 0.7,
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
 * @param llmConfig - Shared LangChain LLM configuration for all agents
 * @returns Map of function names to executable async functions
 *
 * @example
 * ```typescript
 * import { ChatOpenAI } from '@langchain/openai';
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
 *     model: new ChatOpenAI({ modelName: 'gpt-4o-mini' }),
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
  llmConfig: LangChainLLMConfig,
): Record<string, (input: unknown) => Promise<unknown>> {
  return batchConvert(configs, (config) =>
    convertLLMAnalyzerToFunction(
      config.agent as Agent<unknown, unknown>,
      config.inputSchema,
      config.outputSchema,
      llmConfig,
    ),
  );
}
