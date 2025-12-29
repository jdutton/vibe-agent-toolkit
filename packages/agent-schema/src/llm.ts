import { z } from 'zod';

/**
 * LLM configuration (primary or alternative)
 */
const BaseLLMConfigSchema = z.object({
  provider: z.string()
    .describe('LLM provider (e.g., anthropic, openai, google)'),

  model: z.string()
    .describe('Model identifier (e.g., claude-sonnet-4.5, gpt-4o)'),

  temperature: z.number()
    .min(0)
    .max(2)
    .optional()
    .describe('Sampling temperature (0-2, default varies by provider)'),

  maxTokens: z.number()
    .int()
    .positive()
    .optional()
    .describe('Maximum tokens in response'),

  topP: z.number()
    .min(0)
    .max(1)
    .optional()
    .describe('Nucleus sampling parameter'),
}).strict();

/**
 * Full LLM configuration with alternatives
 */
export const LLMConfigSchema = BaseLLMConfigSchema.extend({
  alternatives: z.array(BaseLLMConfigSchema)
    .optional()
    .describe('Alternative LLM configurations (not just fallbacks - choices)'),
}).strict().describe('LLM configuration');

export type LLMConfig = z.infer<typeof LLMConfigSchema>;
