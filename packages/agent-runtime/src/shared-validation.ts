import { type z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Converts a Zod schema to JSON Schema
 */
export function convertToJsonSchema(
  zodSchema: z.ZodType,
  name: string,
): Record<string, unknown> {
  return zodToJsonSchema(zodSchema, {
    name,
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}

/**
 * Validates input using a Zod schema
 * @throws Error if validation fails
 */
export function validateInput<T>(
  input: unknown,
  schema: z.ZodType<T>,
  agentName: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid input for agent "${agentName}": ${result.error.message}`);
  }
  return result.data;
}

/**
 * Validates output using a Zod schema
 * @throws Error if validation fails
 */
export function validateOutput<T>(
  output: unknown,
  schema: z.ZodType<T>,
  agentName: string,
): T {
  const result = schema.safeParse(output);
  if (!result.success) {
    throw new Error(`Invalid output from agent "${agentName}": ${result.error.message}`);
  }
  return result.data;
}

/**
 * Creates a validated execute function wrapper
 * This eliminates duplication across all archetype definitions
 */
export function createValidatedExecute<TInput, TOutput, TContext>(
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  agentName: string,
  handler: (input: TInput, ctx: TContext) => Promise<TOutput>,
): (input: TInput, ...args: unknown[]) => Promise<TOutput> {
  return async (input: TInput, ...args: unknown[]): Promise<TOutput> => {
    const ctx = args[0] as TContext;
    const validatedInput = validateInput(input, inputSchema, agentName);
    const output = await handler(validatedInput, ctx);
    return validateOutput(output, outputSchema, agentName);
  };
}
