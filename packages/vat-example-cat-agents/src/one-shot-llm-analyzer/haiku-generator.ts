import { defineLLMAnalyzer, type Agent } from '@vibe-agent-toolkit/agent-runtime';
import { z } from 'zod';

import { CatCharacteristicsSchema, HaikuSchema, type Haiku } from '../types/schemas.js';

/**
 * Input schema for haiku generation
 */
export const HaikuGeneratorInputSchema = z.object({
  characteristics: CatCharacteristicsSchema.describe('Cat characteristics to inspire the haiku'),
});

export type HaikuGeneratorInput = z.infer<typeof HaikuGeneratorInputSchema>;

/**
 * Haiku generator agent
 *
 * Ms. Haiku is a zen cat poet who sometimes ignores syllable rules for artistic expression.
 * About 60% of her haikus follow proper 5-7-5 structure, but 40% bend the rules in pursuit
 * of deeper meaning. This is why Professor Whiskers' validation is needed.
 */
export const haikuGeneratorAgent: Agent<HaikuGeneratorInput, Haiku> = defineLLMAnalyzer(
  {
    name: 'haiku-generator',
    description: 'Generates contemplative haikus about cats based on their characteristics',
    version: '1.0.0',
    inputSchema: HaikuGeneratorInputSchema,
    outputSchema: HaikuSchema,
    mockable: false,
    model: 'claude-3-haiku',
    temperature: 0.8, // Moderate temperature for poetic creativity
    metadata: {
      author: 'Ms. Haiku',
      personality: 'Zen cat poet, sometimes ignores syllable rules for artistic expression',
      validRate: '60%',
    },
  },
  async (input, ctx) => {
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
