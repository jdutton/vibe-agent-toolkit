import { executeLLMAnalyzer, validateAgentInput } from '@vibe-agent-toolkit/agent-runtime';
import type { Agent, LLMError, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';
import { z } from 'zod';

// Import compiled resources from markdown
// eslint-disable-next-line sonarjs/unused-import -- Will be used when real LLM mode is implemented
import * as _HaikuGeneratorResources from '../../generated/resources/agents/haiku-generator.js';
import { CatCharacteristicsSchema, type Haiku } from '../types/schemas.js';

/**
 * Input schema for haiku generation
 */
export const HaikuGeneratorInputSchema = z.object({
  characteristics: CatCharacteristicsSchema.describe('Cat characteristics to inspire the haiku'),
  mockable: z.boolean().optional().describe('Whether to use mock mode (default: true)'),
});

export type HaikuGeneratorInput = z.infer<typeof HaikuGeneratorInputSchema>;

/**
 * Mock implementation that generates simple haikus based on characteristics.
 */
function mockGenerateHaiku(characteristics: z.infer<typeof CatCharacteristicsSchema>): Haiku {
  const { physical, behavioral } = characteristics;
  const color = physical.furColor.toLowerCase();
  const personality = (behavioral.personality[0] ?? 'mysterious').toLowerCase();

  // Generate simple 5-7-5 haikus based on characteristics
  return {
    line1: `${capitalizeFirst(color)} fur gleams bright`,
    line2: `${capitalizeFirst(personality)} cat sits watching`,
    line3: 'Autumn leaves drift down',
  };
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Haiku generator agent
 *
 * Ms. Haiku is a zen cat poet who sometimes ignores syllable rules for artistic expression.
 * About 60% of her haikus follow proper 5-7-5 structure, but 40% bend the rules in pursuit
 * of deeper meaning. This is why Professor Whiskers' validation is needed.
 *
 * In mock mode, generates simple valid haikus based on characteristics.
 * In real mode, uses LLM for creative poetic generation.
 */
export const haikuGeneratorAgent: Agent<
  HaikuGeneratorInput,
  OneShotAgentOutput<Haiku, LLMError>
> = {
  name: 'haiku-generator',
  manifest: {
    name: 'haiku-generator',
    version: '1.0.0',
    description: 'Generates contemplative haikus about cats based on their characteristics',
    archetype: 'one-shot-llm-analyzer',
    metadata: {
      author: 'Ms. Haiku',
      personality: 'Zen cat poet, sometimes ignores syllable rules for artistic expression',
      validRate: '60%',
      model: 'claude-3-haiku',
      temperature: 0.8,
    },
  },
  execute: async (input: HaikuGeneratorInput) => {
    const validatedOrError = validateAgentInput<HaikuGeneratorInput, Haiku>(
      input,
      HaikuGeneratorInputSchema
    );
    if ('result' in validatedOrError) {
      return validatedOrError;
    }

    const { characteristics, mockable = true } = validatedOrError;

    return executeLLMAnalyzer({
      mockable,
      mockFn: () => mockGenerateHaiku(characteristics),
      notImplementedMessage: 'Real LLM haiku generation requires runtime adapter with callLLM context',
      // When real LLM mode is implemented, use:
      // systemPrompt: _HaikuGeneratorResources.fragments.systemPrompt.body
      // See resources/agents/haiku-generator.md for prompts and domain knowledge
    });
  },
};
