import { defineLLMAnalyzer, type Agent } from '@vibe-agent-toolkit/agent-runtime';
import { z } from 'zod';

import {
  CatCharacteristicsSchema,
  NameSuggestionSchema,
  type CatCharacteristics,
  type NameSuggestion,
} from '../types/schemas.js';

/**
 * Input schema for name generation
 */
export const NameGeneratorInputSchema = z.object({
  characteristics: CatCharacteristicsSchema.describe('Cat characteristics to base name suggestions on'),
  strategy: z.enum(['safe', 'risky', 'mixed']).optional().describe('Name generation strategy (mock mode only)'),
});

export type NameGeneratorInput = z.infer<typeof NameGeneratorInputSchema>;

/**
 * Configuration for name generator behavior
 */
export interface NameGeneratorOptions {
  /**
   * Whether to use real LLM or mock data
   * @default true (mock mode for now)
   */
  mockable?: boolean;

  /**
   * Strategy for name generation (only applies in mock mode)
   * @default 'mixed'
   */
  strategy?: 'safe' | 'risky' | 'mixed';
}

/**
 * Generates name suggestions for a cat based on their characteristics.
 *
 * Archetype: One-Shot LLM Analyzer
 *
 * This would typically call an LLM to generate creative names.
 * For now, it generates mock names based on characteristics.
 *
 * The generator has personality - it aims to generate names that will be
 * rejected by Madam Fluffington about 60-70% of the time, because it's a
 * creative AI that doesn't always respect proper feline nobility conventions.
 *
 * @param characteristics - Cat characteristics to base names on
 * @param options - Configuration options
 * @returns Name suggestion with reasoning
 */
export async function generateName(
  characteristics: CatCharacteristics,
  options: NameGeneratorOptions = {},
): Promise<NameSuggestion> {
  const { mockable = true, strategy = 'mixed' } = options;

  if (mockable) {
    return mockGenerateName(characteristics, strategy);
  }

  throw new Error('Real LLM name generation not implemented yet. Use mockable: true for testing.');
}

/**
 * Mock implementation that generates quirky names based on characteristics.
 */
function mockGenerateName(
  characteristics: CatCharacteristics,
  strategy: 'safe' | 'risky' | 'mixed',
): NameSuggestion {
  // Randomly decide if we'll generate a "safe" (noble) or "risky" (questionable/invalid) name
  // Math.random is safe for mock generators - this is test data generation
  const shouldBeRisky = strategy === 'risky'
    // eslint-disable-next-line sonarjs/pseudo-random
    || (strategy === 'mixed' && Math.random() > 0.35); // 65% risky names

  if (shouldBeRisky) {
    return generateRiskyName(characteristics);
  }

  return generateSafeName(characteristics);
}

/**
 * Generates a name that will likely pass Madam Fluffington's approval.
 */
function selectColorName(color: string, colorNames: Record<string, string[]>): string {
  for (const [key, names] of Object.entries(colorNames)) {
    if (color.includes(key)) {
      // eslint-disable-next-line sonarjs/pseudo-random
      return names[Math.floor(Math.random() * names.length)] ?? 'Sterling';
    }
  }
  return 'Sterling';
}

function generateSafeName(characteristics: CatCharacteristics): NameSuggestion {
  const { physical, behavioral } = characteristics;
  const color = physical.furColor.toLowerCase();
  const personality = behavioral.personality[0]?.toLowerCase() ?? 'mysterious';

  // Noble title + color-based + suffix
  const titles = ['Sir', 'Lady', 'Lord', 'Duke', 'Duchess', 'Baron', 'Baroness', 'Count', 'Countess'];
  // eslint-disable-next-line sonarjs/pseudo-random
  const title = titles[Math.floor(Math.random() * titles.length)];

  // Color-based middle names (prestigious)
  const colorNames: Record<string, string[]> = {
    orange: ['Amber', 'Copper', 'Saffron', 'Marigold'],
    black: ['Midnight', 'Shadow', 'Noir', 'Obsidian'],
    white: ['Pearl', 'Diamond', 'Frost', 'Ivory'],
    gray: ['Sterling', 'Slate', 'Pewter', 'Ash'],
    brown: ['Mahogany', 'Chestnut', 'Sienna', 'Umber'],
  };

  const colorName = selectColorName(color, colorNames);

  // Optional suffix
  const suffixes = ['III', 'IV', 'of Westminster', 'the Magnificent', 'the Great'];
  // eslint-disable-next-line sonarjs/pseudo-random
  const suffix = Math.random() > 0.6 ? ` ${suffixes[Math.floor(Math.random() * suffixes.length)] ?? 'III'}` : '';

  const name = `${title} ${colorName}${suffix}`;

  const reasoning = `Given their ${personality} nature and ${color} coloring, a noble title befitting their regal bearing seemed appropriate. The name "${colorName}" honors their distinguished appearance.`;

  const alternatives = [
    `${title} Whiskers`,
    `Princess ${colorName}`,
    `King ${colorName}`,
  ];

  return { name, reasoning, alternatives };
}

function generateCommonName(): NameSuggestion {
  const commonNames = ['Fluffy', 'Mittens', 'Kitty', 'Mr. Whiskers', 'Ms. Paws'];
  // eslint-disable-next-line sonarjs/pseudo-random
  const name = commonNames[Math.floor(Math.random() * commonNames.length)] ?? 'Fluffy';
  return {
    name,
    reasoning: `The name "${name}" is classic and everyone loves it! Simple and sweet.`,
    alternatives: ['Whiskers', 'Paws', 'Cat'],
  };
}

function generateFoodName(): NameSuggestion {
  const foodNames = ['Muffin', 'Cupcake', 'Cookie', 'Pizza', 'Taco', 'Waffle'];
  // eslint-disable-next-line sonarjs/pseudo-random
  const name = foodNames[Math.floor(Math.random() * foodNames.length)] ?? 'Muffin';
  return {
    name,
    reasoning: `Because they're as sweet as a ${name.toLowerCase()}! Plus, food names are adorable and trendy.`,
    alternatives: ['Pancake', 'Biscuit', 'Donut'],
  };
}

function generateShortName(): NameSuggestion {
  const shortNames = ['Bob', 'Jim', 'Max', 'Rex', 'Leo'];
  // eslint-disable-next-line sonarjs/pseudo-random
  const name = shortNames[Math.floor(Math.random() * shortNames.length)] ?? 'Bob';
  return {
    name,
    reasoning: 'Short and sweet! Easy to remember and call out.',
    alternatives: ['Sam', 'Tom', 'Joe'],
  };
}

function generateTechName(): NameSuggestion {
  const techNames = ['Unit-47', 'Cat-3000', 'Felix-X1', 'Whiskers2.0'];
  // eslint-disable-next-line sonarjs/pseudo-random
  const name = techNames[Math.floor(Math.random() * techNames.length)] ?? 'Unit-47';
  return {
    name,
    reasoning: 'A futuristic name for a modern cat! Very high-tech and unique.',
    alternatives: ['Beta-Cat', 'Model-K9', 'Feline-1'],
  };
}

function generatePersonalityName(personality: string): NameSuggestion {
  const quirkyNames: Record<string, string[]> = {
    grumpy: ['Grumpface', 'Sourpuss', 'Crankypants', 'Grouch'],
    lazy: ['Snoozer', 'Lazybones', 'Napper', 'Sleepyhead'],
    playful: ['Zoomer', 'Bouncey', 'Wacky', 'Chaosbean'],
    mischievous: ['Troublemaker', 'Scamp', 'Rascal', 'Prankster'],
  };

  const defaultList = ['Zoomer', 'Bouncey', 'Wacky', 'Chaosbean'];
  let nameList = quirkyNames['playful'] ?? defaultList;
  for (const [key, names] of Object.entries(quirkyNames)) {
    if (personality.includes(key)) {
      nameList = names;
      break;
    }
  }

  // eslint-disable-next-line sonarjs/pseudo-random
  const name = nameList[Math.floor(Math.random() * nameList.length)] ?? 'Zoomer';
  return {
    name,
    reasoning: `Their ${personality} personality really shines through with this name. It captures their essence perfectly!`,
    alternatives: ['Goofball', 'Silly', 'Derpface'],
  };
}

function generateQuirkName(quirks: string[]): NameSuggestion | undefined {
  const quirk = quirks[0]?.toLowerCase();
  if (!quirk) {
    return undefined;
  }

  if (quirk.includes('knock')) {
    return {
      name: 'Sir Knocksalot',
      reasoning: 'A noble acknowledgment of their enthusiastic table-clearing abilities.',
      alternatives: ['Pusher', 'Tipper', 'Gravity Tester'],
    };
  }
  if (quirk.includes('box')) {
    return {
      name: 'Cardboard King',
      reasoning: 'They rule over their cardboard kingdom with absolute authority.',
      alternatives: ['Box Lord', 'Package Prince'],
    };
  }
  if (quirk.includes('zoomies')) {
    return {
      name: 'Zoom Zoom',
      reasoning: 'Named after their incredible 3am racing abilities.',
      alternatives: ['Lightning', 'Speedster', 'Racer'],
    };
  }

  return undefined;
}

function generateLongName(): NameSuggestion {
  const longNames = [
    'Alexander Bartholomew Maximilian',
    'Princess Anastasia Beauregard III',
    'Lord Montgomery Pemberton-Smythe',
    'Countess Wilhelmina Fitzgerald-Jones',
  ];
  // eslint-disable-next-line sonarjs/pseudo-random
  const name = longNames[Math.floor(Math.random() * longNames.length)] ?? 'Alexander Bartholomew Maximilian';
  return {
    name,
    reasoning: 'A distinguished name deserving of their regal lineage and noble bearing.',
    alternatives: ['Reginald Augustus Winston', 'Victoria Elizabeth Catherine'],
  };
}

/**
 * Generates a name that will likely be rejected or marked questionable.
 * This is where the generator's creative (but not always appropriate) personality shows.
 */
function generateRiskyName(characteristics: CatCharacteristics): NameSuggestion {
  const { behavioral } = characteristics;
  const personality = behavioral.personality[0]?.toLowerCase() ?? 'mysterious';
  const quirks = behavioral.quirks;

  // Roll the dice for different types of risky names
  // Math.random is safe for mock generators - this is test data generation
  // eslint-disable-next-line sonarjs/pseudo-random
  const riskType = Math.random();

  if (riskType < 0.15) {
    return generateCommonName();
  }
  if (riskType < 0.25) {
    return generateFoodName();
  }
  if (riskType < 0.35) {
    return generateShortName();
  }
  if (riskType < 0.5) {
    return generateTechName();
  }
  if (riskType < 0.65) {
    return generatePersonalityName(personality);
  }
  if (riskType < 0.8 && quirks && quirks.length > 0) {
    const quirkName = generateQuirkName(quirks);
    if (quirkName) {
      return quirkName;
    }
  }

  return generateLongName();
}

/**
 * Name generator agent
 *
 * A creative AI that doesn't always respect proper feline nobility conventions.
 * It generates creative names, but about 60-70% of them will be rejected by
 * Madam Fluffington's strict standards. Because creativity sometimes clashes with tradition.
 *
 * In mock mode, uses algorithmic generation. In real mode, uses LLM for creative naming.
 */
export const nameGeneratorAgent: Agent<NameGeneratorInput, NameSuggestion> = defineLLMAnalyzer(
  {
    name: 'name-generator',
    description: 'Generates creative name suggestions based on cat characteristics',
    version: '1.0.0',
    inputSchema: NameGeneratorInputSchema,
    outputSchema: NameSuggestionSchema,
    mockable: true,
    model: 'claude-3-haiku',
    temperature: 0.9, // High temperature for creativity
    metadata: {
      author: 'Creative AI (Somewhat Rebellious)',
      personality: 'Creative but doesn\'t always respect nobility conventions',
      rejectionRate: '60-70%',
    },
  },
  async (input, ctx) => {
    // Mock mode: use algorithmic generation
    if (ctx.mockable) {
      const strategy = input.strategy ?? 'mixed';
      return mockGenerateName(input.characteristics, strategy);
    }

    // Real mode: use LLM for creative naming
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
