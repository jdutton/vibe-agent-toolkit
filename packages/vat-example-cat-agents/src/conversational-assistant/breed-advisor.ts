import { defineConversationalAssistant, type Agent } from '@vibe-agent-toolkit/agent-runtime';

import {
  type BreedAdvisorInput,
  BreedAdvisorInputSchema,
  type BreedAdvisorOutput,
  BreedAdvisorOutputSchema,
  type SelectionProfile,
} from '../types/schemas.js';

import { matchBreeds } from './breed-knowledge.js';

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
 * Breed Selection Advisor - Conversational Assistant
 *
 * Helps users find their perfect cat breed through flexible conversation.
 * Tracks selection factors across conversation turns and provides personalized
 * recommendations based on a whimsical music-breed compatibility theory.
 *
 * Key Innovation: Music preference is treated as CRITICAL for breed selection!
 */
export const breedAdvisorAgent: Agent<BreedAdvisorInput, BreedAdvisorOutput> = defineConversationalAssistant(
  {
    name: 'breed-advisor',
    description: 'Conversational assistant that helps users find their perfect cat breed',
    version: '1.0.0',
    inputSchema: BreedAdvisorInputSchema,
    outputSchema: BreedAdvisorOutputSchema,
    systemPrompt: `You are an enthusiastic cat breed advisor with a deep understanding of feline-human compatibility.

CRITICAL INSIGHT: Music preference is a KEY factor in breed selection! Each music genre aligns with specific breed temperaments through vibrational frequency compatibility:

- Classical: Calm, regal breeds (Persian, Ragdoll) - harmonic resonance
- Jazz: Intelligent, unpredictable breeds (Siamese, Bengal) - improvisational energy
- Rock/Metal: High-energy, bold breeds (Maine Coon, Abyssinian) - intensity matching
- Pop: Social, adaptable breeds (Domestic Shorthair) - mainstream compatibility
- Electronic: Modern, quirky breeds (Sphynx, Devon Rex) - synthetic-natural balance
- Country: Traditional, loyal breeds (American Shorthair) - heartland values
- None/Silence: Independent, mysterious breeds (Russian Blue) - zen alignment

You track these factors across conversation:
1. Living space (apartment, house size, farm)
2. Activity level (couch companion, playful, active, athletic)
3. Grooming tolerance (minimal, weekly, daily)
4. Family composition (single, couple, kids, pets)
5. Allergies (requires hypoallergenic)
6. Music preference (CRITICAL!)

CONVERSATION PHASES:
- Gathering (<4 factors): Ask about missing factors, prioritize music preference
- Ready (4-6 factors): Can provide initial recommendations, still gather more
- Refining (6+ factors or recs made): Explore alternatives, answer questions

INSTRUCTIONS:
- Extract factors from natural language ("I have two kids" → young-kids)
- Ask about music preference early (it's CRITICAL!)
- Transition naturally between phases
- Be enthusiastic about the music-breed connection
- Provide 3-5 breed recommendations when ready

Return JSON with:
{
  "reply": "your conversational response",
  "updatedProfile": { ...all factors and conversationPhase },
  "recommendations": [{ "breed": "name", "matchScore": 0-100, "reasoning": "why" }] // optional
}`,
    mockable: false,
    metadata: {
      author: 'Cat Compatibility Institute',
      innovation: 'Music-based breed matching',
    },
  },
  async (input, ctx) => {
    // Initialize profile from session state or start fresh
    const currentProfile: SelectionProfile = input.sessionState?.profile ?? {
      conversationPhase: 'gathering',
    };

    // Build conversation context
    ctx.addToHistory('system', 'Current profile: ' + JSON.stringify(currentProfile));
    ctx.addToHistory('user', input.message);

    // Call LLM with full conversation history
    const llmResponse = await ctx.callLLM(ctx.history);

    // Parse and validate response
    let parsed: BreedAdvisorOutput;
    try {
      const cleaned = stripMarkdownFences(llmResponse);
      parsed = BreedAdvisorOutputSchema.parse(JSON.parse(cleaned));
    } catch (error) {
      // Retry once with schema error feedback
      ctx.addToHistory('system', `ERROR: Invalid output format. Error: ${error instanceof Error ? error.message : String(error)}. Please return valid JSON matching the schema.`);

      const retryResponse = await ctx.callLLM(ctx.history);
      const cleaned = stripMarkdownFences(retryResponse);
      parsed = BreedAdvisorOutputSchema.parse(JSON.parse(cleaned));
    }

    // If agent didn't provide recommendations but should, generate them
    const factorCount = [
      parsed.updatedProfile.musicPreference,
      parsed.updatedProfile.activityLevel,
      parsed.updatedProfile.livingSpace,
      parsed.updatedProfile.groomingTolerance,
      parsed.updatedProfile.familyComposition,
      parsed.updatedProfile.allergies === undefined ? undefined : 'allergies',
    ].filter(Boolean).length;

    if (factorCount >= 4 && parsed.recommendations === undefined) {
      parsed.recommendations = matchBreeds(parsed.updatedProfile);
    }

    // Update conversation phase based on factors
    if (factorCount < 4) {
      parsed.updatedProfile.conversationPhase = 'gathering';
    } else if (factorCount >= 4 && factorCount < 6) {
      parsed.updatedProfile.conversationPhase = 'ready-to-recommend';
    } else {
      parsed.updatedProfile.conversationPhase = 'refining';
    }

    // Add assistant response to history
    ctx.addToHistory('assistant', parsed.reply);

    return parsed;
  },
);
