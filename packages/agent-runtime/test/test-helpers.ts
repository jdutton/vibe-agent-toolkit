import { z } from 'zod';

// ============================================================================
// Generic Test Helpers
// ============================================================================

/**
 * Creates a standard agent config for tests to avoid duplication
 */
export function createStandardConfig<TInput, TOutput>(options: {
  name: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  subscribesTo?: string[];
  metadata?: Record<string, unknown>;
}): {
  name: string;
  description: string;
  version: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  subscribesTo?: string[];
  metadata?: Record<string, unknown>;
} {
  return {
    name: options.name,
    description: `${options.name} description`,
    version: '1.0.0',
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    ...(options.subscribesTo && { subscribesTo: options.subscribesTo }),
    ...(options.metadata && { metadata: options.metadata }),
  };
}

// ============================================================================
// Specific Agent Test Configurations
// ============================================================================

/**
 * Shared configuration for add agent tests
 */
export function createAddAgentConfig(): {
  name: string;
  description: string;
  version: string;
  inputSchema: z.ZodObject<{ a: z.ZodNumber; b: z.ZodNumber }>;
  outputSchema: z.ZodNumber;
} {
  return {
    name: 'add',
    description: 'Adds two numbers',
    version: '1.0.0',
    inputSchema: z.object({
      a: z.number(),
      b: z.number(),
    }),
    outputSchema: z.number(),
  };
}

/**
 * Shared handler for add agent tests
 */
export function addHandler(input: { a: number; b: number }): number {
  return input.a + input.b;
}

/**
 * Shared configuration for sentiment agent tests
 */
export function createSentimentAgentConfig(): {
  name: string;
  description: string;
  version: string;
  inputSchema: z.ZodObject<{ text: z.ZodString }>;
  outputSchema: z.ZodObject<{
    sentiment: z.ZodEnum<['positive', 'negative', 'neutral']>;
  }>;
  model: string;
  temperature: number;
} {
  return {
    name: 'sentiment',
    description: 'Analyzes sentiment',
    version: '1.0.0',
    inputSchema: z.object({
      text: z.string(),
    }),
    outputSchema: z.object({
      sentiment: z.enum(['positive', 'negative', 'neutral'] as const),
    }),
    model: 'claude-3-haiku',
    temperature: 0.7,
  };
}
