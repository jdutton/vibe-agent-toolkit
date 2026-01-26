import {
  batchConvert,
  type PureFunctionAgent,
  type ToolConversionConfigs,
} from '@vibe-agent-toolkit/agent-runtime';
import type OpenAI from 'openai';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Converts a VAT Pure Function agent to OpenAI function calling tool definition
 *
 * @param agent - The VAT pure function agent to convert
 * @param inputSchema - Zod schema for validating inputs
 * @param outputSchema - Zod schema for validating outputs
 * @returns OpenAI tool definition with metadata and executor
 *
 * @example
 * ```typescript
 * import OpenAI from 'openai';
 * import { haikuValidatorAgent } from '@vibe-agent-toolkit/vat-example-cat-agents';
 * import { convertPureFunctionToTool } from '@vibe-agent-toolkit/runtime-openai';
 *
 * const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
 *
 * const { tool, execute } = convertPureFunctionToTool(
 *   haikuValidatorAgent,
 *   HaikuSchema,
 *   HaikuValidationResultSchema
 * );
 *
 * // Use with OpenAI chat completions
 * const response = await openai.chat.completions.create({
 *   model: 'gpt-4o-mini',
 *   messages: [{ role: 'user', content: 'Validate this haiku...' }],
 *   tools: [tool],
 * });
 *
 * // Execute tool calls
 * for (const toolCall of response.choices[0].message.tool_calls ?? []) {
 *   const result = await execute(JSON.parse(toolCall.function.arguments));
 * }
 * ```
 */
export function convertPureFunctionToTool<TInput, TOutput>(
  agent: PureFunctionAgent<TInput, TOutput>,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
): {
  tool: OpenAI.Chat.ChatCompletionTool;
  execute: (args: TInput) => Promise<TOutput>;
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

  // Convert Zod schema to JSON Schema for OpenAI
  const jsonSchema = zodToJsonSchema(inputSchema, {
    name: manifest.name,
    $refStrategy: 'none', // Inline all schemas
  });

  // Create OpenAI tool definition
  const tool: OpenAI.Chat.ChatCompletionTool = {
    type: 'function',
    function: {
      name: manifest.name,
      description: manifest.description,
      parameters: jsonSchema as Record<string, unknown>,
    },
  };

  // Create executor function
  const execute = async (args: TInput): Promise<TOutput> => {
    // Validate input
    const validatedInput = inputSchema.parse(args);

    // Execute agent - returns OneShotAgentOutput with envelope
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = (await agent.execute(validatedInput)) as any;

    // Unwrap envelope and validate the data
    if (output.result.status === 'success') {
      return outputSchema.parse(output.result.data) as TOutput;
    }

    // Error case - throw to let caller handle
    throw new Error(`Agent execution failed: ${String(output.result.error)}`);
  };

  return {
    tool,
    execute,
    metadata: {
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      archetype: manifest.archetype,
    },
    inputSchema,
    outputSchema,
  };
}

/**
 * Batch converts multiple VAT Pure Function agents to OpenAI tools
 *
 * @param configs - Map of tool names to conversion configurations
 * @returns Map of tool names to OpenAI tool definitions and executors
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
 * // Use all tools with OpenAI
 * const toolArray = Object.values(tools).map(t => t.tool);
 * const response = await openai.chat.completions.create({
 *   model: 'gpt-4o-mini',
 *   messages: [{ role: 'user', content: 'Help me...' }],
 *   tools: toolArray,
 * });
 * ```
 */
export function convertPureFunctionsToTools(
  configs: ToolConversionConfigs,
): Record<
  string,
  {
    tool: OpenAI.Chat.ChatCompletionTool;
    execute: (args: unknown) => Promise<unknown>;
    metadata: { name: string; description: string; version: string; archetype: string };
  }
> {
  return batchConvert(configs, (config) => {
    const { tool, execute, metadata } = convertPureFunctionToTool(
      config.agent as PureFunctionAgent<unknown, unknown>,
      config.inputSchema,
      config.outputSchema,
    );
    return { tool, execute, metadata };
  });
}
