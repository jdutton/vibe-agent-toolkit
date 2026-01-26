import { type z } from 'zod';

import { convertToJsonSchema, validateInput, validateOutput } from './shared-validation.js';
import type { AgentManifest, ConversationalContext } from './types.js';

/**
 * Configuration for execute wrappers
 */
export interface ExecuteWrapperConfig<TInput, TOutput> {
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  name: string;
}

/**
 * Validates input for synchronous execution
 */
function executeWithValidationSync<TInput, TOutput>(
  input: TInput,
  config: ExecuteWrapperConfig<TInput, TOutput>,
  handler: (validatedInput: TInput) => TOutput,
): TOutput {
  const validatedInput = validateInput(input, config.inputSchema, config.name);
  const output = handler(validatedInput);
  return validateOutput(output, config.outputSchema, config.name);
}

/**
 * Validates input and output for async execution
 */
async function executeWithValidationAsync<TInput, TOutput>(
  input: TInput,
  config: ExecuteWrapperConfig<TInput, TOutput>,
  handler: (validatedInput: TInput) => Promise<TOutput>,
): Promise<TOutput> {
  const validatedInput = validateInput(input, config.inputSchema, config.name);
  const output = await handler(validatedInput);
  return validateOutput(output, config.outputSchema, config.name);
}

/**
 * Builds an agent manifest from configuration.
 *
 * @param config - Base configuration with name, description, version, schemas
 * @param archetype - The agent archetype name
 * @param metadata - Optional additional metadata to merge
 * @returns Agent manifest with JSON schemas
 */
export function buildManifest<TInput, TOutput>(
  config: {
    name: string;
    description: string;
    version: string;
    inputSchema: z.ZodType<TInput>;
    outputSchema: z.ZodType<TOutput>;
    metadata?: Record<string, unknown>;
  },
  archetype: string,
  metadata?: Record<string, unknown>,
): AgentManifest {
  const inputJsonSchema = convertToJsonSchema(config.inputSchema, `${config.name}Input`);
  const outputJsonSchema = convertToJsonSchema(config.outputSchema, `${config.name}Output`);

  const manifest: AgentManifest = {
    name: config.name,
    description: config.description,
    version: config.version,
    inputSchema: inputJsonSchema,
    outputSchema: outputJsonSchema,
    archetype,
  };

  // Merge metadata if provided
  if (config.metadata || metadata) {
    manifest.metadata = {
      ...config.metadata,
      ...metadata,
    };
  }

  return manifest;
}

/**
 * Creates a validated execute wrapper for pure (synchronous) functions.
 *
 * @param config - Configuration containing input/output schemas and agent name
 * @param handler - Pure function that transforms input to output
 * @returns Validated execute function
 */
export function createPureExecuteWrapper<TInput, TOutput>(
  config: ExecuteWrapperConfig<TInput, TOutput>,
  handler: (input: TInput) => TOutput,
): (input: TInput) => TOutput {
  return (input: TInput): TOutput => executeWithValidationSync(input, config, handler);
}

/**
 * Creates a validated execute wrapper for async functions with simple context.
 * Context is passed through without modification.
 *
 * @param config - Configuration containing input/output schemas and agent name
 * @param handler - Async function that transforms input to output using context
 * @returns Validated async execute function
 */
export function createAsyncExecuteWrapper<TInput, TOutput, TContext>(
  config: ExecuteWrapperConfig<TInput, TOutput>,
  handler: (input: TInput, ctx: TContext) => Promise<TOutput>,
): (input: TInput, ...args: unknown[]) => Promise<TOutput> {
  return (input: TInput, ...args: unknown[]): Promise<TOutput> => {
    const ctx = args[0] as TContext;
    return executeWithValidationAsync(input, config, (validatedInput) =>
      handler(validatedInput, ctx),
    );
  };
}

/**
 * Creates a validated execute wrapper for async functions with context merging.
 * Builds context by merging runtime context with config values using a builder function.
 *
 * @param config - Configuration containing input/output schemas and agent name
 * @param handler - Async function that transforms input to output using context
 * @param contextBuilder - Function that builds full context from runtime context and config
 * @returns Validated async execute function
 */
export function createAsyncExecuteWrapperWithContext<TInput, TOutput, TContext>(
  config: ExecuteWrapperConfig<TInput, TOutput>,
  handler: (input: TInput, ctx: TContext) => Promise<TOutput>,
  contextBuilder: (runtimeCtx: TContext) => TContext,
): (input: TInput, ...args: unknown[]) => Promise<TOutput> {
  return (input: TInput, ...args: unknown[]): Promise<TOutput> => {
    const runtimeCtx = args[0] as TContext;
    const fullContext = contextBuilder(runtimeCtx);
    return executeWithValidationAsync(input, config, (validatedInput) =>
      handler(validatedInput, fullContext),
    );
  };
}

/**
 * Creates a standard context mapper for conversational agents
 * (shared to avoid duplication across conversational agent types)
 */
export function createConversationalContextMapper(
  mockable: boolean,
): (ctx: ConversationalContext) => ConversationalContext {
  return (ctx: ConversationalContext): ConversationalContext => ({
    mockable,
    history: ctx.history,
    addToHistory: ctx.addToHistory,
    callLLM: ctx.callLLM,
  });
}
