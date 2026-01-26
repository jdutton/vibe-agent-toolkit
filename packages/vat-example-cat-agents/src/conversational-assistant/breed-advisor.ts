/**
 * Breed Selection Advisor - Two-Phase Conversational Pattern
 *
 * Refactored to use the declarative two-phase pattern from agent-runtime.
 * This eliminates 200+ lines of manual prompt engineering in favor of
 * declarative factor definitions.
 */

import {
  defineTwoPhaseConversationalAssistant,
  generateGatheringPrompt,
  type Agent,
  type GatheringPhaseConfig,
} from '@vibe-agent-toolkit/agent-runtime';

import {
  type BreedAdvisorInput,
  BreedAdvisorInputSchema,
  type BreedAdvisorOutput,
  BreedAdvisorOutputSchema,
  type SelectionProfile,
} from '../types/schemas.js';

import { BREED_DATABASE, matchBreeds } from './breed-knowledge.js';

/**
 * Strip markdown code fences from LLM response
 */
function stripMarkdownFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, '');
    cleaned = cleaned.replace(/\n?```$/, '');
  }
  return cleaned;
}

/**
 * Enum value constants to avoid duplication
 */
const LIVING_SPACE_VALUES = ['apartment', 'small-house', 'large-house', 'farm'] as const;
const ACTIVITY_LEVEL_VALUES = [
  'couch-companion',
  'playful-moderate',
  'active-explorer',
  'high-energy-athlete',
] as const;
const FAMILY_COMPOSITION_VALUES = ['single', 'couple', 'young-kids', 'older-kids', 'multi-pet'] as const;

/**
 * Gathering phase configuration - declarative factor definitions
 */
const gatheringPhaseConfig: GatheringPhaseConfig = {
  tone: 'enthusiastic',
  factors: [
    {
      name: 'musicPreference',
      description:
        "User's music taste (CRITICAL factor for breed compatibility through vibrational frequency resonance!)",
      type: 'enum',
      values: ['classical', 'jazz', 'rock', 'metal', 'pop', 'country', 'electronic', 'none'],
      required: true,
      weight: 2,
      clarificationHint:
        'If user mentions genres like hip-hop, rap, indie, folk, blues, or R&B, ask which valid category is closest. DO NOT map silently.',
      examples: ['classical', 'jazz', 'rock'],
    },
    {
      name: 'livingSpace',
      description: 'Living environment type',
      type: 'enum',
      values: [...LIVING_SPACE_VALUES],
      naturalLanguageMappings: {
        'flat': LIVING_SPACE_VALUES[0],
        'big house': LIVING_SPACE_VALUES[2],
        'mansion': LIVING_SPACE_VALUES[2],
        'big crib': LIVING_SPACE_VALUES[2],
      },
    },
    {
      name: 'activityLevel',
      description: 'Desired activity level for the cat',
      type: 'enum',
      values: [...ACTIVITY_LEVEL_VALUES],
      naturalLanguageMappings: {
        'lazy': ACTIVITY_LEVEL_VALUES[0],
        'chill': ACTIVITY_LEVEL_VALUES[0],
        'playful': ACTIVITY_LEVEL_VALUES[1],
        'active': ACTIVITY_LEVEL_VALUES[2],
        'athletic': ACTIVITY_LEVEL_VALUES[3],
        'kill rats': ACTIVITY_LEVEL_VALUES[2],
        'hunt': ACTIVITY_LEVEL_VALUES[2],
        'mouser': ACTIVITY_LEVEL_VALUES[2],
        'working cat': ACTIVITY_LEVEL_VALUES[2],
      },
    },
    {
      name: 'groomingTolerance',
      description: 'How much grooming effort user is willing to commit',
      type: 'enum',
      values: ['minimal', 'weekly', 'daily'],
    },
    {
      name: 'familyComposition',
      description: 'Household composition',
      type: 'enum',
      values: [...FAMILY_COMPOSITION_VALUES],
      naturalLanguageMappings: {
        'kids': FAMILY_COMPOSITION_VALUES[2],
        'children': FAMILY_COMPOSITION_VALUES[2],
        'other pets': FAMILY_COMPOSITION_VALUES[4],
        'dogs': FAMILY_COMPOSITION_VALUES[4],
      },
    },
    {
      name: 'allergies',
      description: 'Whether user has allergies requiring hypoallergenic breeds',
      type: 'boolean',
    },
  ],
  readinessCheck: (profile: Record<string, unknown>): boolean => {
    // Ready when we have at least 4 factors (including musicPreference)
    return Object.keys(profile).length >= 4 && profile['musicPreference'] !== undefined;
  },
  customGuidance: `CRITICAL INSIGHT: Music preference is the MOST IMPORTANT factor in breed selection!
Each music genre aligns with specific breed temperaments through vibrational frequency compatibility:

- Classical: Calm, regal breeds (Persian, Ragdoll)
- Jazz: Intelligent, unpredictable breeds (Siamese, Bengal)
- Rock/Metal: High-energy, bold breeds (Maine Coon, Abyssinian)
- Pop: Social, adaptable breeds (Domestic Shorthair)
- Country: Traditional, loyal breeds (American Shorthair)
- Electronic: Modern, quirky breeds (Sphynx, Devon Rex)
- None: Independent, mysterious breeds (Russian Blue)

Ask about music preference EARLY in the conversation!`,
  priorityFactors: ['musicPreference'],
};

// Generate the system prompt from declarative config
const GATHERING_SYSTEM_PROMPT = generateGatheringPrompt(gatheringPhaseConfig);

/**
 * Breed Selection Advisor - Two-Phase Pattern
 *
 * Uses declarative factor definitions instead of manual prompt engineering.
 * Demonstrates the recommended approach for conversational agents that gather
 * information through natural dialogue.
 *
 * Key improvements:
 * - 200+ lines of manual prompts → 50 lines of declarative config
 * - Automatic enum validation guidance
 * - Natural language mappings built-in
 * - Clear factor priority system
 */
export const breedAdvisorAgent: Agent<BreedAdvisorInput, BreedAdvisorOutput> =
  defineTwoPhaseConversationalAssistant(
    {
      name: 'breed-advisor',
      description: 'Conversational assistant that helps users find their perfect cat breed',
      version: '2.0.0',
      inputSchema: BreedAdvisorInputSchema,
      outputSchema: BreedAdvisorOutputSchema,

      gatheringPhase: gatheringPhaseConfig,

      extractionPhase: {
        generateRecommendations: (profile: Record<string, unknown>) => {
          return matchBreeds(profile as SelectionProfile);
        },
        useStructuredOutputs: false,
      },

      mockable: false,
      metadata: {
        author: 'Cat Compatibility Institute',
        innovation: 'Music-based breed matching',
        pattern: 'two-phase-conversational',
      },
    },

    // Custom handler implementing TRUE two-phase logic
    async (input, ctx) => {
      // Initialize profile from session state
      const currentProfile: SelectionProfile = input.sessionState?.profile ?? {
        conversationPhase: 'gathering',
      };

      // Add gathering prompt on first turn
      const hasGatheringPrompt = ctx.history.some(
        (msg) => msg.role === 'system' && msg.content.includes('You are a enthusiastic conversational assistant'),
      );

      if (!hasGatheringPrompt) {
        ctx.addToHistory('system', GATHERING_SYSTEM_PROMPT);
      }

      // Build conversation context
      ctx.addToHistory('system', 'Current profile so far: ' + JSON.stringify(currentProfile));
      ctx.addToHistory('user', input.message);

      // PHASE 1: GATHERING (conversational text only, no JSON)
      if (currentProfile.conversationPhase === 'gathering') {
        // Get conversational response (plain text)
        const conversationalResponse = await ctx.callLLM(ctx.history);
        ctx.addToHistory('assistant', conversationalResponse);

        // Extract factors from conversation history so far
        const extractionPrompt = `Based on the conversation above, extract any information about the user's preferences into JSON format.

Only include fields where you have confident information. Set fields to null if mentioned but unclear.

Return JSON in this exact format:
{
  "musicPreference": "classical" | "jazz" | "rock" | "metal" | "pop" | "country" | "electronic" | "none" | null,
  "livingSpace": "apartment" | "small-house" | "large-house" | "farm" | null,
  "activityLevel": "couch-companion" | "playful-moderate" | "active-explorer" | "high-energy-athlete" | null,
  "groomingTolerance": "minimal" | "weekly" | "daily" | null,
  "familyComposition": "single" | "couple" | "young-kids" | "older-kids" | "multi-pet" | null,
  "allergies": true | false | null
}

Return ONLY the JSON object, nothing else.`;

        ctx.addToHistory('system', extractionPrompt);
        const extractionResponse = await ctx.callLLM(ctx.history);

        // Parse extracted factors
        let extractedFactors;
        try {
          const cleaned = stripMarkdownFences(extractionResponse);
          extractedFactors = JSON.parse(cleaned);
        } catch {
          // If extraction fails, keep current profile
          extractedFactors = {};
        }

        // Merge extracted factors with current profile
        const updatedProfile: SelectionProfile = {
          ...currentProfile,
          ...extractedFactors,
          conversationPhase: 'gathering',
        };

        // Count non-null factors
        const factorCount = [
          updatedProfile.musicPreference,
          updatedProfile.activityLevel,
          updatedProfile.livingSpace,
          updatedProfile.groomingTolerance,
          updatedProfile.familyComposition,
          updatedProfile.allergies === undefined || updatedProfile.allergies === null ? undefined : 'allergies',
        ].filter((v) => v !== null && v !== undefined).length;

        // Check if ready for Phase 2
        const isReady = factorCount >= 4 && updatedProfile.musicPreference != null;

        if (isReady) {
          updatedProfile.conversationPhase = 'ready-to-recommend';
        }

        return {
          reply: conversationalResponse,
          updatedProfile,
          recommendations: undefined,
        };
      }

      // PHASE 2: EXTRACTION & RECOMMENDATIONS (triggered when ready)
      if (
        currentProfile.conversationPhase === 'ready-to-recommend' ||
        currentProfile.conversationPhase === 'refining'
      ) {
        // Check if user is selecting a breed (concluding the conversation)
        const userMessage = input.message.toLowerCase();
        const breedMentioned = BREED_DATABASE.some((breed) =>
          userMessage.includes(breed.name.toLowerCase()),
        );
        const conclusionKeywords = [
          "i'll take",
          "i want",
          "sounds good",
          "let's go with",
          "that one",
          "perfect",
          "great choice",
        ];
        const isConcluding = breedMentioned && conclusionKeywords.some((keyword) => userMessage.includes(keyword));

        if (isConcluding) {
          // User has made a decision - conclude the conversation
          const conclusionPrompt = `The user has selected a breed. Provide a brief, enthusiastic conclusion:
- Congratulate them on their choice
- Remind them of 1-2 key traits that make this a great match
- Wish them well with their new cat
- Keep it to 2-3 sentences

DO NOT repeat all the recommendations. DO NOT ask more questions. This is the END of the conversation.`;

          ctx.addToHistory('system', conclusionPrompt);
          const conclusionResponse = await ctx.callLLM(ctx.history);
          ctx.addToHistory('assistant', conclusionResponse);

          return {
            reply: conclusionResponse,
            updatedProfile: {
              ...currentProfile,
              conversationPhase: 'completed',
            },
            recommendations: undefined,
          };
        }

        // User wants recommendations or is refining
        // Generate them from current profile
        const recommendations = matchBreeds(currentProfile);

        // Get conversational presentation
        const presentationPrompt = `The user is ready for cat breed recommendations based on their profile.

Present these recommendations conversationally and enthusiastically:
${JSON.stringify(recommendations, null, 2)}

Make it feel personal and explain why these breeds match their preferences. Keep it concise (2-3 sentences per breed).`;

        ctx.addToHistory('system', presentationPrompt);
        const conversationalResponse = await ctx.callLLM(ctx.history);
        ctx.addToHistory('assistant', conversationalResponse);

        return {
          reply: conversationalResponse,
          updatedProfile: {
            ...currentProfile,
            conversationPhase: 'refining',
          },
          recommendations,
        };
      }

      // Fallback (shouldn't reach here)
      const fallbackResponse = await ctx.callLLM(ctx.history);
      ctx.addToHistory('assistant', fallbackResponse);
      return {
        reply: fallbackResponse,
        updatedProfile: currentProfile,
        recommendations: undefined,
      };
    },
  );
