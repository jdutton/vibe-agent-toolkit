import { z } from 'zod';

/**
 * Physical and behavioral characteristics of a cat
 */
export const CatCharacteristicsSchema = z.object({
  physical: z.object({
    furColor: z.string().describe('Primary fur color'),
    furPattern: z.string().optional().describe('Fur pattern (tabby, calico, etc.)'),
    eyeColor: z.string().optional().describe('Eye color'),
    breed: z.string().optional().describe('Cat breed'),
    size: z.enum(['tiny', 'small', 'medium', 'large', 'extra-large']).optional(),
  }),
  behavioral: z.object({
    personality: z.array(z.string()).describe('Personality traits'),
    quirks: z.array(z.string()).optional().describe('Unique quirks or habits'),
    vocalizations: z.array(z.string()).optional().describe('Types of sounds they make'),
  }),
  metadata: z.object({
    origin: z.string().optional().describe('Where the cat is from'),
    age: z.string().optional().describe('Age or age range'),
    occupation: z.string().optional().describe('What they do'),
  }).optional(),
  notes: z.string().optional().describe('Additional notes'),
  description: z.string().describe('Full prose description of the cat'),
});

export type CatCharacteristics = z.infer<typeof CatCharacteristicsSchema>;

/**
 * A name suggestion with reasoning
 */
export const NameSuggestionSchema = z.object({
  name: z.string().describe('Suggested name'),
  reasoning: z.string().describe('Why this name fits the cat'),
  alternatives: z.array(z.string()).optional().describe('Alternative name suggestions'),
});

export type NameSuggestion = z.infer<typeof NameSuggestionSchema>;

/**
 * Result of validating a cat name
 */
export const NameValidationResultSchema = z.object({
  status: z.enum(['valid', 'invalid', 'questionable']).describe('Validation status'),
  reason: z.string().describe('Explanation of the validation result'),
  suggestedFixes: z.array(z.string()).optional().describe('Suggested improvements'),
});

export type NameValidationResult = z.infer<typeof NameValidationResultSchema>;

/**
 * A three-line haiku
 */
export const HaikuSchema = z.object({
  line1: z.string().describe('First line (5 syllables)'),
  line2: z.string().describe('Second line (7 syllables)'),
  line3: z.string().describe('Third line (5 syllables)'),
});

export type Haiku = z.infer<typeof HaikuSchema>;

/**
 * Result of validating a haiku
 */
export const HaikuValidationResultSchema = z.object({
  valid: z.boolean().describe('Whether the haiku follows proper structure'),
  syllables: z.object({
    line1: z.number().describe('Syllable count in line 1 (should be 5)'),
    line2: z.number().describe('Syllable count in line 2 (should be 7)'),
    line3: z.number().describe('Syllable count in line 3 (should be 5)'),
  }),
  errors: z.array(z.string()).describe('List of structural errors'),
  hasKigo: z.boolean().optional().describe('Whether it contains a seasonal reference'),
  hasKireji: z.boolean().optional().describe('Whether it has a cutting word or pause'),
});

export type HaikuValidationResult = z.infer<typeof HaikuValidationResultSchema>;

/**
 * Selection profile for breed advisor conversation
 */
export const SelectionProfileSchema = z.object({
  livingSpace: z.enum(['apartment', 'small-house', 'large-house', 'farm']).optional().describe('Living space type'),
  activityLevel: z.enum(['couch-companion', 'playful-moderate', 'active-explorer', 'high-energy-athlete']).optional().describe('Desired activity level'),
  groomingTolerance: z.enum(['minimal', 'weekly', 'daily']).optional().describe('Grooming tolerance'),
  familyComposition: z.enum(['single', 'couple', 'young-kids', 'older-kids', 'multi-pet']).optional().describe('Family composition'),
  allergies: z.boolean().optional().describe('Has allergies requiring hypoallergenic breeds'),
  musicPreference: z.enum(['classical', 'jazz', 'rock', 'metal', 'pop', 'country', 'electronic', 'none']).optional().describe('Music preference (CRITICAL factor!)'),
  conversationPhase: z.enum(['gathering', 'ready-to-recommend', 'refining']).describe('Current conversation phase'),
});

export type SelectionProfile = z.infer<typeof SelectionProfileSchema>;

/**
 * Input for breed advisor agent
 */
export const BreedAdvisorInputSchema = z.object({
  message: z.string().describe('User message'),
  sessionState: z.object({
    profile: SelectionProfileSchema,
    conversationHistory: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string(),
    })).optional(),
  }).optional().describe('Current session state'),
});

export type BreedAdvisorInput = z.infer<typeof BreedAdvisorInputSchema>;

/**
 * Output from breed advisor agent
 */
export const BreedAdvisorOutputSchema = z.object({
  reply: z.string().describe('Agent response to user'),
  updatedProfile: SelectionProfileSchema.describe('Updated selection profile'),
  recommendations: z.array(z.object({
    breed: z.string().describe('Breed name'),
    matchScore: z.number().min(0).max(100).describe('Match score (0-100)'),
    reasoning: z.string().describe('Why this breed matches'),
  })).optional().describe('Breed recommendations if ready'),
});

export type BreedAdvisorOutput = z.infer<typeof BreedAdvisorOutputSchema>;
