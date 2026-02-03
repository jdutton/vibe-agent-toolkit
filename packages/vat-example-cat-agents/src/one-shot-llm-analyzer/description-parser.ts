import { executeLLMAnalyzer } from '@vibe-agent-toolkit/agent-runtime';
import type { Agent, LLMError, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';
import { LLM_INVALID_OUTPUT, RESULT_ERROR } from '@vibe-agent-toolkit/agent-schema';
import { z } from 'zod';

import { CatCharacteristicsSchema, type CatCharacteristics } from '../types/schemas.js';
// Extract fur color from text descriptions
import { extractFurColor as extractFurColorUtil } from '../utils/color-extraction.js';

/**
 * Input schema for description parsing
 */
export const DescriptionParserInputSchema = z.object({
  description: z.string().describe('Text description of the cat (structured or unstructured)'),
  mockable: z.boolean().optional().describe('Whether to use mock mode (default: true)'),
});

export type DescriptionParserInput = z.infer<typeof DescriptionParserInputSchema>;

/**
 * Configuration for description parser behavior
 */
export interface DescriptionParserOptions {
  /**
   * Whether to use real LLM or mock data
   * @default true (mock mode for now)
   */
  mockable?: boolean;
}

/**
 * Parses a text description of a cat and extracts characteristics.
 *
 * Archetype: One-Shot LLM Analyzer
 *
 * This would typically call an LLM to parse unstructured text.
 * For now, it generates mock data based on keyword extraction.
 *
 * Handles both structured descriptions and "word vomit":
 * - "Orange tabby, playful, loves boxes"
 * - "So there's this cat right and he's like super orange and has stripes and he knocks stuff off tables"
 *
 * @param description - Text description of the cat (structured or unstructured)
 * @param options - Configuration options
 * @returns Cat characteristics extracted from the description
 */
export async function parseDescription(
  description: string,
  options: DescriptionParserOptions = {},
): Promise<CatCharacteristics> {
  const { mockable = true } = options;

  if (mockable) {
    return mockParseDescription(description);
  }

  throw new Error('Real LLM parsing not implemented yet. Use mockable: true for testing.');
}

/**
 * Mock implementation that extracts characteristics from text using keyword matching.
 */
function mockParseDescription(description: string): CatCharacteristics {
  const lowerDesc = description.toLowerCase();

  // Extract physical characteristics
  const furColor = extractFurColor(lowerDesc);
  const furPattern = extractFurPattern(lowerDesc);
  const eyeColor = extractEyeColor(lowerDesc);
  const breed = extractBreed(lowerDesc);
  const size = extractSize(lowerDesc);

  // Extract behavioral characteristics
  const personality = extractPersonality(lowerDesc);
  const quirks = extractQuirks(lowerDesc);
  const vocalizations = extractVocalizations(lowerDesc);

  // Extract metadata
  const age = extractAge(lowerDesc);
  const origin = extractOrigin(lowerDesc);
  const occupation = extractOccupation(lowerDesc);

  return {
    physical: {
      furColor,
      furPattern,
      eyeColor,
      breed,
      size,
    },
    behavioral: {
      personality,
      quirks,
      vocalizations,
    },
    metadata: age || origin || occupation ? {
      age,
      origin,
      occupation,
    } : undefined,
    description,
  };
}

function extractFurColor(text: string): string {
  return extractFurColorUtil(text, 'Mixed colors');
}

function extractFurPattern(text: string): string | undefined {
  if (text.includes('tabby') || text.includes('stripe')) {
    return 'Tabby';
  }
  if (text.includes('spot')) {
    return 'Spotted';
  }
  if (text.includes('tuxedo')) {
    return 'Tuxedo';
  }
  if (text.includes('point') && (text.includes('siamese') || text.includes('himalayan'))) {
    return 'Colorpoint';
  }
  if (text.includes('bicolor') || text.includes('two-tone')) {
    return 'Bicolor';
  }

  return undefined;
}

function extractEyeColor(text: string): string | undefined {
  if (text.includes('blue eye') || text.includes('blue-eye')) {
    return 'Blue';
  }
  if (text.includes('green eye') || text.includes('green-eye')) {
    return 'Green';
  }
  if (text.includes('amber eye') || text.includes('gold eye') || text.includes('yellow eye')) {
    return 'Amber';
  }
  if (text.includes('copper eye')) {
    return 'Copper';
  }

  return undefined;
}

function extractBreed(text: string): string | undefined {
  const breeds = [
    'persian', 'siamese', 'maine coon', 'bengal', 'ragdoll',
    'sphynx', 'british shorthair', 'scottish fold', 'abyssinian',
    'russian blue', 'birman', 'himalayan', 'burmese', 'exotic shorthair',
  ];

  for (const breed of breeds) {
    if (text.includes(breed)) {
      return breed.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
  }

  return undefined;
}

function extractSize(text: string): 'tiny' | 'small' | 'medium' | 'large' | 'extra-large' | undefined {
  if (text.includes('tiny') || text.includes('kitten') || text.includes('teacup')) {
    return 'tiny';
  }
  if (text.includes('small') || text.includes('petite')) {
    return 'small';
  }
  if (text.includes('huge') || text.includes('giant') || text.includes('massive')) {
    return 'extra-large';
  }
  if (text.includes('large') || text.includes('big')) {
    return 'large';
  }
  if (text.includes('medium')) {
    return 'medium';
  }

  return undefined;
}

function extractPersonality(text: string): string[] {
  const personality: string[] = [];

  // Positive traits
  if (text.includes('playful')) {
    personality.push('Playful');
  }
  if (text.includes('friendly') || text.includes('affectionate')) {
    personality.push('Friendly');
  }
  if (text.includes('curious')) {
    personality.push('Curious');
  }
  if (text.includes('energetic') || text.includes('active')) {
    personality.push('Energetic');
  }
  if (text.includes('calm') || text.includes('peaceful')) {
    personality.push('Calm');
  }
  if (text.includes('intelligent') || text.includes('smart')) {
    personality.push('Intelligent');
  }

  // Negative/quirky traits
  if (text.includes('grumpy') || text.includes('cranky')) {
    personality.push('Grumpy');
  }
  if (text.includes('lazy') || text.includes('sleepy')) {
    personality.push('Lazy');
  }
  if (text.includes('aloof') || text.includes('independent')) {
    personality.push('Aloof');
  }
  if (text.includes('demanding') || text.includes('bossy')) {
    personality.push('Demanding');
  }
  if (text.includes('shy') || text.includes('timid')) {
    personality.push('Shy');
  }
  if (text.includes('mischievous') || text.includes('trouble')) {
    personality.push('Mischievous');
  }

  // Default if nothing found
  if (personality.length === 0) {
    personality.push('Mysterious', 'Independent');
  }

  return personality;
}

function extractQuirks(text: string): string[] | undefined {
  const quirks: string[] = [];

  if (text.includes('knock') && (text.includes('stuff') || text.includes('things') || text.includes('off'))) {
    quirks.push('Knocks things off tables');
  }
  if (text.includes('box') || text.includes('boxes')) {
    quirks.push('Loves sitting in boxes');
  }
  if (text.includes('zoomies') || text.includes('running around') || text.includes('crazy')) {
    quirks.push('Gets the zoomies at 3am');
  }
  if (text.includes('water') && !text.includes("doesn't like") && !text.includes('hates')) {
    quirks.push('Fascinated by running water');
  }
  if (text.includes('fetch') || text.includes('retrieves')) {
    quirks.push('Plays fetch like a dog');
  }
  if (text.includes('chirp') || text.includes('trill')) {
    quirks.push('Makes chirping sounds');
  }
  if (text.includes('cross-eye') || text.includes('derp')) {
    quirks.push('Adorably cross-eyed');
  }
  if (text.includes('toe') && text.includes('extra')) {
    quirks.push('Extra toes (polydactyl)');
  }

  return quirks.length > 0 ? quirks : undefined;
}

function extractVocalizations(text: string): string[] | undefined {
  const vocalizations: string[] = [];

  if (text.includes('meow') || text.includes('mew')) {
    vocalizations.push('Meows');
  }
  if (text.includes('purr')) {
    vocalizations.push('Purrs');
  }
  if (text.includes('chirp') || text.includes('trill')) {
    vocalizations.push('Chirps');
  }
  if (text.includes('hiss')) {
    vocalizations.push('Hisses');
  }
  if (text.includes('yowl') || text.includes('howl')) {
    vocalizations.push('Yowls');
  }
  if (text.includes('silent') || text.includes('quiet')) {
    vocalizations.push('Usually silent');
  }
  if (text.includes('chatty') || text.includes('talkative') || text.includes('vocal')) {
    vocalizations.push('Very vocal', 'Meows frequently');
  }

  return vocalizations.length > 0 ? vocalizations : undefined;
}

function extractAge(text: string): string | undefined {
  // Try to find specific age patterns like "5 years old" or "2yo" FIRST
  // This must come before general keywords to avoid matching "5 year old" as "senior (10+ years)"
  // Simplified regex to avoid backtracking - non-capturing group
  // eslint-disable-next-line sonarjs/slow-regex
  const ageRegex = /(\d+)\s*(?:year|yo)/;
  const ageMatch = ageRegex.exec(text);
  if (ageMatch) {
    return `${String(ageMatch[1] ?? '0')} years old`;
  }

  if (text.includes('kitten')) {
    return 'Kitten (under 1 year)';
  }
  if (text.includes('young')) {
    return '1-3 years';
  }
  if (text.includes('adult')) {
    return '3-10 years';
  }
  if (text.includes('senior') || text.includes('elderly')) {
    return 'Senior (10+ years)';
  }

  return undefined;
}

function extractOrigin(text: string): string | undefined {
  if (text.includes('rescue') || text.includes('adopted') || text.includes('shelter')) {
    return 'Rescue/Shelter';
  }
  if (text.includes('stray')) {
    return 'Former stray';
  }
  if (text.includes('breeder')) {
    return 'From breeder';
  }
  if (text.includes('street') || text.includes('alley')) {
    return 'Street cat';
  }

  return undefined;
}

function extractOccupation(text: string): string | undefined {
  if (text.includes('mouser') || text.includes('catches mice') || text.includes('hunter')) {
    return 'Professional mouser';
  }
  if (text.includes('office') || text.includes('workplace')) {
    return 'Office cat';
  }
  if (text.includes('barn')) {
    return 'Barn cat';
  }
  if (text.includes('therapy')) {
    return 'Therapy cat';
  }
  if (text.includes('instagram') || text.includes('influencer') || text.includes('famous')) {
    return 'Social media influencer';
  }
  if (text.includes('lazy') && text.includes('job')) {
    return 'Professional napper';
  }

  return undefined;
}

/**
 * Description parser agent
 *
 * Captain Obvious is a cat who states the obvious and extracts characteristics literally.
 * He has an uncanny ability to parse both structured descriptions and complete "word vomit",
 * extracting every detail with earnest precision.
 *
 * In mock mode, uses keyword extraction. In real mode, uses LLM to parse natural language.
 */
export const descriptionParserAgent: Agent<
  DescriptionParserInput,
  OneShotAgentOutput<CatCharacteristics, LLMError>
> = {
  name: 'description-parser',
  manifest: {
    name: 'description-parser',
    version: '1.0.0',
    description: 'Parses text descriptions and extracts structured cat characteristics',
    archetype: 'one-shot-llm-analyzer',
    metadata: {
      author: 'Captain Obvious',
      personality: 'States the obvious, extracts characteristics literally',
      handlesUnstructured: true,
      model: 'claude-3-haiku',
    },
  },
  execute: async (input: DescriptionParserInput) => {
    // Validate input
    const parsed = DescriptionParserInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        result: { status: RESULT_ERROR, error: LLM_INVALID_OUTPUT },
      };
    }

    const { description, mockable = true } = parsed.data;

    return executeLLMAnalyzer({
      mockable,
      mockFn: () => mockParseDescription(description),
      realFn: async () => {
        throw new Error('Real LLM parsing not implemented yet. Use mockable: true for testing.');
      },
      parseOutput: (raw) => {
        const parsed = JSON.parse(raw as string);
        return CatCharacteristicsSchema.parse(parsed);
      },
      errorContext: 'Description parsing',
    });
  },
};
