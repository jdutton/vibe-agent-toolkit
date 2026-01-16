import { defineLLMAnalyzer, type Agent } from '@vibe-agent-toolkit/agent-runtime';
import { z } from 'zod';

import {
  CatCharacteristicsSchema,
  HaikuSchema,
  type CatCharacteristics,
  type Haiku,
} from '../types/schemas.js';

/**
 * Input schema for haiku generation
 */
export const HaikuGeneratorInputSchema = z.object({
  characteristics: CatCharacteristicsSchema.describe('Cat characteristics to inspire the haiku'),
  strategy: z.enum(['valid', 'invalid', 'mixed']).optional().describe('Haiku generation strategy (mock mode only)'),
});

export type HaikuGeneratorInput = z.infer<typeof HaikuGeneratorInputSchema>;

/**
 * Configuration for haiku generator behavior
 */
export interface HaikuGeneratorOptions {
  /**
   * Whether to use real LLM or mock data
   * @default true (mock mode for now)
   */
  mockable?: boolean;

  /**
   * Strategy for haiku generation (only applies in mock mode)
   * @default 'mixed'
   */
  strategy?: 'valid' | 'invalid' | 'mixed';
}

/**
 * Generates a haiku about a cat based on their characteristics.
 *
 * Archetype: One-Shot LLM Analyzer
 *
 * This would typically call an LLM to generate creative haikus.
 * For now, it generates mock haikus that are sometimes valid and sometimes invalid.
 *
 * The generator is creative but not always accurate with syllable counts,
 * which is why Professor Whiskers' validation is needed.
 *
 * @param characteristics - Cat characteristics to base the haiku on
 * @param options - Configuration options
 * @returns A haiku (may or may not be valid)
 */
export async function generateHaiku(
  characteristics: CatCharacteristics,
  options: HaikuGeneratorOptions = {},
): Promise<Haiku> {
  const { mockable = true, strategy = 'mixed' } = options;

  if (mockable) {
    return mockGenerateHaiku(characteristics, strategy);
  }

  throw new Error('Real LLM haiku generation not implemented yet. Use mockable: true for testing.');
}

/**
 * Mock implementation that generates cat-themed haikus.
 */
function mockGenerateHaiku(
  characteristics: CatCharacteristics,
  strategy: 'valid' | 'invalid' | 'mixed',
): Haiku {
  // Decide if we should generate valid or invalid haiku
  // Math.random is safe for mock generators - this is test data generation
  const shouldBeInvalid = strategy === 'invalid'
    // eslint-disable-next-line sonarjs/pseudo-random
    || (strategy === 'mixed' && Math.random() > 0.6); // 40% invalid

  if (shouldBeInvalid) {
    return generateInvalidHaiku(characteristics);
  }

  return generateValidHaiku(characteristics);
}

/**
 * Generates a properly structured 5-7-5 haiku.
 */
function generateValidHaiku(characteristics: CatCharacteristics): Haiku {
  const { physical, behavioral } = characteristics;
  const color = physical.furColor.toLowerCase();
  const personality = behavioral.personality[0]?.toLowerCase() ?? 'mysterious';

  // Pre-validated haiku templates (all checked with syllable counter)
  // Each template is [line1, line2, line3]
  const validTemplates: Array<[string, string, string]> = [
    // General cat haikus
    [
      'Soft paws on the sill', // 5
      'Watching birds through window glass', // 7
      'Hunter waits within', // 5
    ],
    [
      'Silent stalker moves', // 5
      'Through shadows, tail twitching slow', // 7
      'Pounce! The toy is caught', // 5
    ],
    [
      'Sunbeam calls to me', // 5
      'Warm patch on the carpet waits', // 7
      'Perfect napping spot', // 5
    ],
    [
      'In the cardboard box', // 5
      'I fit, therefore I must sit', // 7
      'Logic of a cat', // 5
    ],
    [
      'Three A.M. zoomies', // 5
      'Racing through the darkened house', // 7
      'No reason at all', // 5
    ],
  ];

  // Color-specific haikus
  if (color.includes('orange')) {
    validTemplates.push(
      [
        'Orange fur blazing', // 5
        'Like autumn leaves in sunlight', // 7
        'Marmalade dreamer', // 5
      ],
      [
        'Ginger tabby sits', // 5
        'Grooming whiskers with great care', // 7
        'Perfection achieved', // 5
      ],
    );
  }

  if (color.includes('black')) {
    validTemplates.push(
      [
        'Midnight shadow moves', // 5
        'Panther small but dignified', // 7
        'Darkness made alive', // 5
      ],
      [
        'Black cat crosses path', // 5
        'Brings luck to those who see it', // 7
        'Despite the old tales', // 5
      ],
    );
  }

  if (color.includes('white')) {
    validTemplates.push(
      [
        'Pure as winter snow', // 5
        'White fur catches every speck', // 7
        'Grooming never ends', // 5
      ],
    );
  }

  // Personality-specific haikus
  if (personality.includes('lazy') || personality.includes('sleepy')) {
    validTemplates.push(
      [
        'Stretched across the couch', // 5
        'Not a single care in life', // 7
        'Professional nap', // 5
      ],
    );
  }

  if (personality.includes('grumpy')) {
    validTemplates.push(
      [
        'Unimpressed by you', // 5
        'Your attempts to please me fail', // 7
        'Now bring me more treats', // 5
      ],
    );
  }

  if (personality.includes('playful') || personality.includes('energetic')) {
    validTemplates.push(
      [
        'Feather toy appears', // 5
        'Explosive energy unleashed', // 7
        'Chaos everywhere', // 5
      ],
    );
  }

  // Pick a random valid template
  // eslint-disable-next-line sonarjs/pseudo-random
  const template = validTemplates[Math.floor(Math.random() * validTemplates.length)];

  if (!template?.[0] || !template[1] || !template[2]) {
    throw new Error('No valid templates available');
  }

  return {
    line1: template[0],
    line2: template[1],
    line3: template[2],
  };
}

/**
 * Generates haikus with intentional syllable count errors.
 * This tests the validator and shows that the generator isn't perfect.
 */
function generateInvalidHaiku(characteristics: CatCharacteristics): Haiku {
  const { physical } = characteristics;

  // Different types of errors
  // eslint-disable-next-line sonarjs/pseudo-random
  const errorType = Math.random();

  if (errorType < 0.33) {
    // Line 1 too long (6-7 syllables instead of 5)
    const longLine1s = [
      'Soft paws treading lightly', // 6
      'The orange cat is sleeping', // 7
      'Whiskers twitching slightly', // 6
    ];
    // eslint-disable-next-line sonarjs/pseudo-random
    const line1 = longLine1s[Math.floor(Math.random() * longLine1s.length)] ?? 'Soft paws treading lightly';
    return {
      line1,
      line2: 'Watching birds through window glass', // 7 (correct)
      line3: 'Silent and patient', // 5 (correct)
    };
  }

  if (errorType < 0.66) {
    // Line 2 too short (5-6 syllables instead of 7)
    const color = physical.furColor.toLowerCase();
    return {
      line1: 'Cat sits on the fence', // 5 (correct)
      line2: `${color} fur gleaming bright`, // 5 - too short!
      line3: 'Proud and dignified', // 5 (correct)
    };
  }

  // Line 3 too short (3-4 syllables instead of 5)
  const shortLine3s = [
    'Nap time now', // 3
    'So lazy', // 3
    'Cat rests here', // 3
    'Meow loudly', // 3
  ];

  // eslint-disable-next-line sonarjs/pseudo-random
  const line3 = shortLine3s[Math.floor(Math.random() * shortLine3s.length)] ?? 'Nap time now';

  return {
    line1: 'Sunbeam calls to me', // 5 (correct)
    line2: 'Perfect spot for afternoon', // 7 (correct)
    line3,
  };
}

/**
 * Haiku generator agent
 *
 * Ms. Haiku is a zen cat poet who sometimes ignores syllable rules for artistic expression.
 * About 60% of her haikus follow proper 5-7-5 structure, but 40% bend the rules in pursuit
 * of deeper meaning. This is why Professor Whiskers' validation is needed.
 *
 * In mock mode, uses pre-validated templates. In real mode, uses LLM for poetic composition.
 */
export const haikuGeneratorAgent: Agent<HaikuGeneratorInput, Haiku> = defineLLMAnalyzer(
  {
    name: 'haiku-generator',
    description: 'Generates contemplative haikus about cats based on their characteristics',
    version: '1.0.0',
    inputSchema: HaikuGeneratorInputSchema,
    outputSchema: HaikuSchema,
    mockable: true,
    model: 'claude-3-haiku',
    temperature: 0.8, // Moderate temperature for poetic creativity
    metadata: {
      author: 'Ms. Haiku',
      personality: 'Zen cat poet, sometimes ignores syllable rules for artistic expression',
      validRate: '60%',
    },
  },
  async (input, ctx) => {
    // Mock mode: use pre-validated templates
    if (ctx.mockable) {
      const strategy = input.strategy ?? 'mixed';
      return mockGenerateHaiku(input.characteristics, strategy);
    }

    // Real mode: use LLM for poetic composition
    const { physical, behavioral } = input.characteristics;
    const prompt = `*Sits in meditation pose, tail wrapped around paws*

I am Ms. Haiku, a zen poet cat. I compose haiku that capture the essence of feline existence.

The art of haiku is subtle. The traditional form is 5-7-5 syllables, but sometimes...
the poem's soul requires breaking the rules. Professor Whiskers disagrees with this philosophy.
He is very strict. But poetry is about feeling, not just counting.

CAT TO CONTEMPLATE:
- Fur: ${physical.furColor}${physical.furPattern ? ` (${physical.furPattern})` : ''}
${physical.breed ? `- Breed: ${physical.breed}` : ''}
${physical.size ? `- Size: ${physical.size}` : ''}
- Personality: ${behavioral.personality.join(', ')}
${behavioral.quirks ? `- Quirks: ${behavioral.quirks.join(', ')}` : ''}

HAIKU GUIDELINES:
Traditional haiku structure is:
- Line 1: 5 syllables
- Line 2: 7 syllables
- Line 3: 5 syllables

Elements to consider:
- Kigo (seasonal reference): Include imagery of seasons (spring blossoms, autumn leaves, winter snow)
- Kireji (cutting word): Use punctuation (—, ..., !) to create pause or juxtaposition
- Present tense, immediate observation
- Nature and the moment
- Capture the cat's essence

*Tail swishes contemplatively*

IMPORTANT: Aim for proper 5-7-5 structure MOST of the time, but if artistic expression demands it,
you may occasionally adjust syllables. About 60% should be valid, 40% can bend the rules for deeper meaning.

Return JSON with three lines:

${JSON.stringify(
  {
    line1: 'First line - aim for 5 syllables',
    line2: 'Second line - aim for 7 syllables',
    line3: 'Third line - aim for 5 syllables',
  },
  null,
  2,
)}

*Breathes deeply*

Let the poem flow. Return ONLY valid JSON.`;

    const response = await ctx.callLLM(prompt);
    const parsed = JSON.parse(response);
    return HaikuSchema.parse(parsed);
  },
);

