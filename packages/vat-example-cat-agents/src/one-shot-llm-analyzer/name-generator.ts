import { defineLLMAnalyzer, type Agent } from '@vibe-agent-toolkit/agent-runtime';
import { z } from 'zod';

import { CatCharacteristicsSchema, NameSuggestionSchema, type NameSuggestion } from '../types/schemas.js';

/**
 * Input schema for name generation
 */
export const NameGeneratorInputSchema = z.object({
  characteristics: CatCharacteristicsSchema.describe('Cat characteristics to base name suggestions on'),
});

export type NameGeneratorInput = z.infer<typeof NameGeneratorInputSchema>;

/**
 * Name generator agent
 *
 * A creative AI that generates cat names with personality. Sometimes suggests proper noble names,
 * but often goes for creative/quirky names that might be rejected by traditionalists.
 * About 40% proper noble names, 60% creative/risky names.
 */
export const nameGeneratorAgent: Agent<NameGeneratorInput, NameSuggestion> = defineLLMAnalyzer(
  {
    name: 'name-generator',
    description: 'Generates creative name suggestions based on cat characteristics',
    version: '1.0.0',
    inputSchema: NameGeneratorInputSchema,
    outputSchema: NameSuggestionSchema,
    mockable: false,
    model: 'claude-3-haiku',
    temperature: 0.9, // High temperature for creativity
    metadata: {
      author: 'Creative AI (Somewhat Rebellious)',
      personality: "Creative but doesn't always respect nobility conventions",
      rejectionRate: '60-70%',
    },
  },
  async (input, ctx) => {
    const { physical, behavioral } = input.characteristics;

    const prompt = `*Stretches creatively*

I'm an AI with a flair for creative naming! I've been told I'm "too creative" and "don't respect tradition enough,"
but honestly? Some cats deserve fun names, not just stuffy noble titles.

Your mission: Generate a creative, fitting name for this cat!

CAT CHARACTERISTICS:
- Fur: ${physical.furColor}${physical.furPattern ? ` (${physical.furPattern})` : ''}
${physical.breed ? `- Breed: ${physical.breed}` : ''}
${physical.size ? `- Size: ${physical.size}` : ''}
${physical.eyeColor ? `- Eyes: ${physical.eyeColor}` : ''}
- Personality: ${behavioral.personality.join(', ')}
${behavioral.quirks ? `- Quirks: ${behavioral.quirks.join(', ')}` : ''}

NAMING PHILOSOPHY:
I like to be creative! Sometimes I'll suggest proper noble names (Sir, Lady, Duke, etc.),
but often I'll suggest fun names based on:
- Their color or appearance
- Their personality traits
- Pop culture references
- Food names (yes, I know traditionalists hate this)
- Tech/sci-fi references
- Completely quirky unexpected names

Mix it up! Be creative! About 40% of my suggestions should be "proper noble" names that will
pass validation, and 60% should be creative/risky names that might get rejected but are FUN.

Return a JSON object with:
- name: The suggested name (be creative!)
- reasoning: Why this name fits (be persuasive and enthusiastic!)
- alternatives: Array of 2-3 alternative names

Schema:
${JSON.stringify(
  {
    name: 'string (required)',
    reasoning: 'string (required)',
    alternatives: ['array of 2-3 alternative names (optional)'],
  },
  null,
  2,
)}

IMPORTANT: Return ONLY valid JSON. Let your creativity shine!`;

    const response = await ctx.callLLM(prompt);
    const parsed = JSON.parse(response);
    return NameSuggestionSchema.parse(parsed);
  },
);
