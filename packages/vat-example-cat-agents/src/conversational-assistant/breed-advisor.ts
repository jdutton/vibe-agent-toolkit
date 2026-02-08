/**
 * Breed Selection Advisor - Two-Phase Conversational Pattern
 *
 * Now uses compiled markdown resources for all prompts and domain knowledge.
 * Prompts are auditable in resources/agents/breed-advisor.md
 */

import {
  defineTwoPhaseConversationalAssistant,
  generateGatheringPrompt,
  type Agent,
  type GatheringPhaseConfig,
  type Message,
} from '@vibe-agent-toolkit/agent-runtime';
import {
  RESULT_IN_PROGRESS,
  RESULT_SUCCESS,
} from '@vibe-agent-toolkit/agent-schema';

// Import compiled resources from markdown
import * as BreedAdvisorResources from '../../generated/resources/agents/breed-advisor.js';
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
  // Music preference insight loaded from resources/agents/breed-advisor.md
  customGuidance: BreedAdvisorResources.fragments.musicPreferenceInsight.body,
  priorityFactors: ['musicPreference'],
};

// Generate the system prompt from declarative config
const GATHERING_SYSTEM_PROMPT = generateGatheringPrompt(gatheringPhaseConfig);

/**
 * Generic extraction helper - reduces duplication
 */
async function extractFromConversation<T>(
  history: Message[],
  callLLM: (messages: Message[]) => Promise<string>,
  extractionPrompt: string,
  defaultValue: T,
): Promise<T> {
  const extractionHistory: Message[] = [...history, { role: 'user', content: extractionPrompt }];
  const extractionResponse = await callLLM(extractionHistory);

  try {
    const cleaned = stripMarkdownFences(extractionResponse);
    return JSON.parse(cleaned) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Extract factors from conversation during gathering phase
 */
async function extractFactorsFromConversation(
  history: Message[],
  callLLM: (messages: Message[]) => Promise<string>,
): Promise<Partial<SelectionProfile>> {
  return extractFromConversation(
    history,
    callLLM,
    BreedAdvisorResources.fragments.factorExtractionPrompt.body,
    {},
  );
}

/**
 * Extract selected breed from Phase 2 conversation
 */
async function extractSelectedBreed(
  history: Message[],
  callLLM: (messages: Message[]) => Promise<string>,
): Promise<{ selectedBreed: string | null }> {
  return extractFromConversation(
    history,
    callLLM,
    BreedAdvisorResources.fragments.selectionExtractionPrompt.body,
    { selectedBreed: null },
  );
}

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
      // Status constants for result envelopes
      const PHASE_READY_TO_RECOMMEND = 'ready-to-recommend' as const;

      // Initialize profile from session state
      const currentProfile: SelectionProfile = input.sessionState?.profile ?? {
        conversationPhase: 'gathering',
      };

      // Check if this is the very first turn (no session state, no history)
      const isFirstTurn = ctx.history.length === 0 && !input.sessionState;

      // Add gathering prompt on first turn
      const hasGatheringPrompt = ctx.history.some(
        (msg) => msg.role === 'system' && msg.content.includes('You are a enthusiastic conversational assistant'),
      );

      if (!hasGatheringPrompt) {
        ctx.addToHistory('system', GATHERING_SYSTEM_PROMPT);
      }

      // First turn: provide welcoming introduction
      if (isFirstTurn) {
        // Welcome message from resources/agents/breed-advisor.md
        const greeting = BreedAdvisorResources.fragments.welcomeMessage.body;

        return {
          reply: greeting,
          sessionState: currentProfile,
          result: {
            status: RESULT_IN_PROGRESS,
            metadata: {
              factorsCollected: 0,
              requiredFactors: 4,
              conversationPhase: 'gathering',
            },
          },
        };
      }

      // Build conversation context
      ctx.addToHistory('system', 'Current profile so far: ' + JSON.stringify(currentProfile));
      ctx.addToHistory('user', input.message);

      // PHASE 1: GATHERING (conversational text only, no JSON)
      if (currentProfile.conversationPhase === 'gathering') {
        // Get conversational response (plain text)
        const conversationalResponse = await ctx.callLLM(ctx.history);
        ctx.addToHistory('assistant', conversationalResponse);

        // Extract factors from conversation history
        const extractedFactors = await extractFactorsFromConversation(ctx.history, ctx.callLLM);

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
          updatedProfile.conversationPhase = PHASE_READY_TO_RECOMMEND;

          // Transition message from resources/agents/breed-advisor.md
          const transitionMessage = '\n\n' + BreedAdvisorResources.fragments.transitionMessage.body;

          return {
            reply: conversationalResponse + transitionMessage,
            sessionState: updatedProfile,
            result: {
              status: RESULT_IN_PROGRESS,
              metadata: {
                factorsCollected: factorCount,
                requiredFactors: 4,
                conversationPhase: PHASE_READY_TO_RECOMMEND,
                message: 'Ready to provide recommendations',
              },
            },
          };
        }

        return {
          reply: conversationalResponse,
          sessionState: updatedProfile,
          result: {
            status: RESULT_IN_PROGRESS,
            metadata: {
              factorsCollected: factorCount,
              requiredFactors: 4,
              conversationPhase: updatedProfile.conversationPhase ?? 'gathering',
            },
          },
        };
      }

      // PHASE 2: EXTRACTION & RECOMMENDATIONS (triggered when ready)
      if (
        currentProfile.conversationPhase === PHASE_READY_TO_RECOMMEND ||
        currentProfile.conversationPhase === 'refining'
      ) {
        // First, extract if user made a breed selection
        const extractedData = await extractSelectedBreed(ctx.history, ctx.callLLM);

        // Check if user made a selection
        if (extractedData.selectedBreed) {
          // Conclusion prompt from resources/agents/breed-advisor.md
          const conclusionPrompt = BreedAdvisorResources.fragments.conclusionPrompt.body
            .replace('{{selectedBreed}}', extractedData.selectedBreed);

          ctx.addToHistory('system', conclusionPrompt);
          const conclusionResponse = await ctx.callLLM(ctx.history);
          ctx.addToHistory('assistant', conclusionResponse);

          // Normalize breed name against database
          let selectedBreed = extractedData.selectedBreed;
          const normalizedBreed = BREED_DATABASE.find((breed) =>
            breed.name.toLowerCase() === selectedBreed.toLowerCase() ||
            breed.name.toLowerCase().replaceAll(/\s/g, '') === selectedBreed.toLowerCase().replaceAll(/\s/g, '')
          )?.name;
          if (normalizedBreed) {
            selectedBreed = normalizedBreed;
          }

          return {
            reply: conclusionResponse,
            sessionState: {
              ...currentProfile,
              conversationPhase: 'completed',
            },
            result: {
              status: RESULT_SUCCESS,
              data: {
                selectedBreed,
                finalProfile: currentProfile,
              },
            },
          };
        }

        // No selection yet - generate recommendations and continue conversation
        const recommendations = matchBreeds(currentProfile);

        // Recommendation presentation prompt from resources/agents/breed-advisor.md
        const presentationPrompt = BreedAdvisorResources.fragments.recommendationPresentationPrompt.body
          .replace('{{recommendations}}', JSON.stringify(recommendations, null, 2));

        ctx.addToHistory('system', presentationPrompt);
        const presentationResponse = await ctx.callLLM(ctx.history);
        ctx.addToHistory('assistant', presentationResponse);

        return {
          reply: presentationResponse,
          sessionState: {
            ...currentProfile,
            conversationPhase: 'refining',
          },
          result: {
            status: RESULT_IN_PROGRESS,
            metadata: {
              recommendations,
              conversationPhase: 'refining',
            },
          },
        };
      }

      // Fallback (shouldn't reach here)
      const fallbackResponse = await ctx.callLLM(ctx.history);
      ctx.addToHistory('assistant', fallbackResponse);
      return {
        reply: fallbackResponse,
        sessionState: currentProfile,
        result: {
          status: RESULT_IN_PROGRESS,
          metadata: {
            conversationPhase: currentProfile.conversationPhase ?? 'gathering',
          },
        },
      };
    },
  );
