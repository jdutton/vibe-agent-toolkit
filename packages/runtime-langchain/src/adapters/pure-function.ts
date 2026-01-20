import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  batchConvert,
  type PureFunctionAgent,
  type ToolConversionConfigs,
} from '@vibe-agent-toolkit/agent-runtime';
import type { z } from 'zod';

/**
 * Converts a VAT Pure Function agent to a LangChain DynamicStructuredTool
 *
 * @param agent - The VAT pure function agent to convert
 * @param inputSchema - Zod schema for validating inputs
 * @param outputSchema - Zod schema for validating outputs
 * @returns LangChain tool with metadata
 *
 * @example
 * ```typescript
 * import { ChatOpenAI } from '@langchain/openai';
 * import { haikuValidatorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { convertPureFunctionToTool } from '@vibe-agent-toolkit/runtime-langchain';
 *
 * const tool = convertPureFunctionToTool(
 *   haikuValidatorAgent,
 *   HaikuSchema,
 *   HaikuValidationResultSchema
 * );
 *
 * // Use with LangChain agent
 * const llm = new ChatOpenAI({ model: 'gpt-4' });
 * const agent = createToolCallingAgent({ llm, tools: [tool.tool] });
 * ```
 */
export function convertPureFunctionToTool<TInput, TOutput>(
  agent: PureFunctionAgent<TInput, TOutput>,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
): {
  tool: DynamicStructuredTool;
  metadata: {
    name: string;
    description: string;
    version: string;
    archetype: string;
  };
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
} {
  const { manifest } = agent;

  // Create LangChain DynamicStructuredTool
  const tool = new DynamicStructuredTool({
    name: manifest.name,
    description: manifest.description,
    schema: inputSchema,
    func: async (input: TInput) => {
      // Execute the agent
      const result = await agent.execute(input);

      // Validate output with schema
      const validated = outputSchema.parse(result);

      // LangChain tools must return string or object that can be JSON stringified
      return JSON.stringify(validated);
    },
  });

  return {
    tool,
    metadata: {
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      archetype: 'pure-function',
    },
    inputSchema,
    outputSchema,
  };
}

/**
 * Batch converts multiple VAT Pure Function agents to LangChain tools
 *
 * @param configs - Map of tool names to conversion configurations
 * @returns Map of tool names to LangChain DynamicStructuredTools
 *
 * @example
 * ```typescript
 * const tools = convertPureFunctionsToTools({
 *   validateHaiku: {
 *     agent: haikuValidatorAgent,
 *     inputSchema: HaikuSchema,
 *     outputSchema: HaikuValidationResultSchema,
 *   },
 *   validateName: {
 *     agent: nameValidatorAgent,
 *     inputSchema: NameSchema,
 *     outputSchema: NameValidationResultSchema,
 *   },
 * });
 *
 * // Use all tools with LangChain agent
 * const llm = new ChatOpenAI({ model: 'gpt-4' });
 * const toolArray = Object.values(tools).map(t => t.tool);
 * const agent = createToolCallingAgent({ llm, tools: toolArray });
 * ```
 */
export function convertPureFunctionsToTools(
  configs: ToolConversionConfigs,
): Record<
  string,
  {
    tool: DynamicStructuredTool;
    metadata: { name: string; description: string; version: string; archetype: string };
  }
> {
  return batchConvert(configs, (config) => {
    const { tool, metadata } = convertPureFunctionToTool(
      config.agent as PureFunctionAgent<unknown, unknown>,
      config.inputSchema,
      config.outputSchema,
    );
    return { tool, metadata };
  });
}
