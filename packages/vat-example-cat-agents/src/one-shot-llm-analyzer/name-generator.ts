import { executeLLMAnalyzer, validateAgentInput } from '@vibe-agent-toolkit/agent-runtime';
import type { Agent, LLMError, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';
import { z } from 'zod';

// Import compiled resources from markdown
// eslint-disable-next-line sonarjs/unused-import -- Will be used when real LLM mode is implemented
import * as _NameGeneratorResources from '../../generated/resources/agents/name-generator.js';
import { CatCharacteristicsSchema, type NameSuggestion } from '../types/schemas.js';

/**
 * Input schema for name generation
 */
export const NameGeneratorInputSchema = z.object({
  characteristics: CatCharacteristicsSchema.describe('Cat characteristics to base name suggestions on'),
  mockable: z.boolean().optional().describe('Whether to use mock mode (default: true)'),
});

export type NameGeneratorInput = z.infer<typeof NameGeneratorInputSchema>;

/**
 * Mock implementation that generates deterministic names based on characteristics.
 */
function mockGenerateName(characteristics: z.infer<typeof CatCharacteristicsSchema>): NameSuggestion {
  const { physical, behavioral } = characteristics;

  // Generate name components based on characteristics
  const colorPrefix = getColorPrefix(physical.furColor);
  const personalityTrait = behavioral.personality[0] ?? 'Mysterious';
  // eslint-disable-next-line sonarjs/pseudo-random -- Mock data generation, not security-sensitive
  const isNoble = Math.random() > 0.6; // 40% noble names

  let name: string;
  let alternatives: string[];

  if (isNoble) {
    // Noble name pattern
    name = `${getNobleTitle()} ${colorPrefix}`;
    alternatives = [
      `${getNobleTitle()} ${personalityTrait}`,
      `${colorPrefix} the ${personalityTrait}`,
    ];
  } else {
    // Creative name pattern
    name = `${colorPrefix} ${getCreativeSuffix(personalityTrait)}`;
    alternatives = [
      getFoodName(physical.furColor),
      getPopCultureName(personalityTrait),
    ];
  }

  const reasoning = `Based on their ${physical.furColor.toLowerCase()} fur and ${personalityTrait.toLowerCase()} personality, this name captures their essence perfectly!`;

  return {
    name,
    reasoning,
    alternatives,
  };
}

function getColorPrefix(color: string): string {
  const colorMap: Record<string, string> = {
    Orange: 'Marmalade',
    Black: 'Shadow',
    White: 'Snowball',
    Gray: 'Ash',
    'Gray tabby': 'Sterling',
    Calico: 'Patches',
    Brown: 'Mocha',
  };
  return colorMap[color] ?? 'Fluffy';
}

function getNobleTitle(): string {
  const titles = ['Sir', 'Lady', 'Duke', 'Duchess', 'Baron', 'Baroness', 'Lord', 'Dame'];
  // eslint-disable-next-line sonarjs/pseudo-random -- Mock data generation, not security-sensitive
  return titles[Math.floor(Math.random() * titles.length)] ?? 'Sir';
}

function getCreativeSuffix(_trait: string): string {
  const suffixes = ['McFluff', 'von Whiskers', 'the Great', 'Paws', 'Face'];
  // eslint-disable-next-line sonarjs/pseudo-random -- Mock data generation, not security-sensitive
  return suffixes[Math.floor(Math.random() * suffixes.length)] ?? 'McFluff';
}

function getFoodName(color: string): string {
  const foodMap: Record<string, string> = {
    Orange: 'Pumpkin',
    Black: 'Oreo',
    White: 'Marshmallow',
    Gray: 'Pepper',
    Brown: 'Cocoa',
  };
  return foodMap[color] ?? 'Cookie';
}

function getPopCultureName(_trait: string): string {
  const names = ['Gandalf', 'Yoda', 'Sherlock', 'Einstein', 'Tesla', 'Princess Leia'];
  // eslint-disable-next-line sonarjs/pseudo-random -- Mock data generation, not security-sensitive
  return names[Math.floor(Math.random() * names.length)] ?? 'Gandalf';
}

/**
 * Name generator agent
 *
 * A creative AI that generates cat names with personality. Sometimes suggests proper noble names,
 * but often goes for creative/quirky names that might be rejected by traditionalists.
 * About 40% proper noble names, 60% creative/risky names.
 *
 * In mock mode, generates deterministic names based on characteristics.
 * In real mode, uses LLM for creative generation.
 */
export const nameGeneratorAgent: Agent<
  NameGeneratorInput,
  OneShotAgentOutput<NameSuggestion, LLMError>
> = {
  name: 'name-generator',
  manifest: {
    name: 'name-generator',
    version: '1.0.0',
    description: 'Generates creative name suggestions based on cat characteristics',
    archetype: 'one-shot-llm-analyzer',
    metadata: {
      author: 'Creative AI (Somewhat Rebellious)',
      personality: "Creative but doesn't always respect nobility conventions",
      rejectionRate: '60-70%',
      model: 'claude-3-haiku',
      temperature: 0.9,
    },
  },
  execute: async (input: NameGeneratorInput) => {
    const validatedOrError = validateAgentInput<NameGeneratorInput, NameSuggestion>(
      input,
      NameGeneratorInputSchema
    );
    if ('result' in validatedOrError) {
      return validatedOrError;
    }

    const { characteristics, mockable = true } = validatedOrError;

    return executeLLMAnalyzer({
      mockable,
      mockFn: () => mockGenerateName(characteristics),
      notImplementedMessage: 'Real LLM name generation requires runtime adapter with callLLM context',
      // When real LLM mode is implemented, use:
      // systemPrompt: _NameGeneratorResources.fragments.systemPrompt.body
      // See resources/agents/name-generator.md for prompts and domain knowledge
    });
  },
};
