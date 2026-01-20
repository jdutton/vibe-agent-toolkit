import type { z } from 'zod';

import type { Agent, PureFunctionAgent } from './types.js';

/**
 * Configuration for converting a pure function agent to a runtime-specific tool
 */
export interface ToolConversionConfig<TInput = unknown, TOutput = unknown> {
  agent: PureFunctionAgent<TInput, TOutput>;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
}

/**
 * Configuration for converting an LLM analyzer agent to a runtime-specific function
 */
export interface LLMAnalyzerConversionConfig<TInput = unknown, TOutput = unknown> {
  agent: Agent<TInput, TOutput>;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
}

/**
 * Batch conversion configuration for pure function tools
 */
export type ToolConversionConfigs = Record<string, ToolConversionConfig>;

/**
 * Batch conversion configuration for LLM analyzer functions
 */
export type LLMAnalyzerConversionConfigs = Record<string, LLMAnalyzerConversionConfig>;

/**
 * Generic batch conversion utility for converting multiple configs to results
 * Eliminates code duplication in runtime adapters
 *
 * @param configs - Map of keys to conversion configurations
 * @param converter - Function that converts a single config to a result
 * @returns Map of keys to conversion results
 *
 * @example
 * ```typescript
 * const tools = batchConvert(configs, (config) => {
 *   const { tool, metadata } = convertPureFunctionToTool(
 *     config.agent,
 *     config.inputSchema,
 *     config.outputSchema,
 *   );
 *   return { tool, metadata };
 * });
 * ```
 */
export function batchConvert<TConfig, TResult>(
  configs: Record<string, TConfig>,
  converter: (config: TConfig) => TResult,
): Record<string, TResult> {
  return Object.fromEntries(
    Object.entries(configs).map(([key, config]) => [key, converter(config)]),
  );
}
