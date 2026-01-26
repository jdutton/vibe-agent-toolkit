import { describe, expect, it } from 'vitest';

import { breedAdvisorAgent } from '../../src/conversational-assistant/breed-advisor.js';

/**
 * Create a mock context for testing two-phase pattern
 * @param conversationalResponse - Response for Phase 1 (conversational text)
 * @param extractedFactors - Extracted factors for Phase 1 (JSON)
 * @param presentationResponse - Response for Phase 2 (recommendation presentation)
 */
function createMockContext(
  conversationalResponse: string,
  extractedFactors?: Record<string, unknown>,
  presentationResponse?: string,
) {
  const history: Array<{ role: string; content: string }> = [];

  return {
    mockable: true,
    history,
    addToHistory: (role: string, content: string) => {
      history.push({ role, content });
    },
    callLLM: async () => {
      // Check if this is an extraction call (history contains extraction prompt)
      const isExtractionCall = history.some((msg) =>
        msg.content.includes('extract any information about the user'),
      );

      // Check if this is a presentation call (history contains presentation prompt)
      const isPresentationCall = history.some((msg) =>
        msg.content.includes('ready for cat breed recommendations'),
      );

      if (isPresentationCall && presentationResponse) {
        return presentationResponse;
      }

      if (isExtractionCall && extractedFactors) {
        return JSON.stringify(extractedFactors);
      }

      return conversationalResponse;
    },
  };
}

describe('breedAdvisorAgent', () => {
  it('should have correct name and manifest', () => {
    expect(breedAdvisorAgent.name).toBe('breed-advisor');
    expect(breedAdvisorAgent.manifest).toBeDefined();
    expect(breedAdvisorAgent.manifest.archetype).toBe('two-phase-conversational-assistant');
  });

  it('should have execute function', () => {
    expect(breedAdvisorAgent.execute).toBeInstanceOf(Function);
  });

  it('should have two-phase pattern metadata', () => {
    expect(breedAdvisorAgent.manifest.metadata).toBeDefined();
    expect(breedAdvisorAgent.manifest.metadata?.pattern).toBe('two-phase-conversational');
    expect(breedAdvisorAgent.manifest.metadata?.gatheringPhase).toBeDefined();
  });
});

describe('breedAdvisorAgent.execute', () => {
  it('should start conversation with gathering phase', async () => {
    const input = {
      message: 'Hello, I need help finding a cat breed',
    };

    const mockContext = createMockContext(
      "Hi! I'd love to help you find the perfect cat breed. To start, what kind of music do you enjoy?",
      {}, // No factors extracted yet
    );

    const result = await breedAdvisorAgent.execute(input, mockContext);

    expect(result.reply).toBeDefined();
    expect(result.updatedProfile.conversationPhase).toBe('gathering');
  });
});

describe('breedAdvisorAgent multi-turn conversation', () => {
  const READY_PHASE = 'ready-to-recommend';

  it('should extract music preference from natural language', async () => {
    const input = {
      message: 'I really love classical music',
      sessionState: {
        profile: {
          conversationPhase: 'gathering' as const,
        },
      },
    };

    const mockContext = createMockContext(
      'Excellent! Classical music suggests calm, regal breeds.',
      {
        musicPreference: 'classical',
      },
    );

    const result = await breedAdvisorAgent.execute(input, mockContext);

    expect(result.updatedProfile.musicPreference).toBe('classical');
  });

  it('should extract multiple factors from one message', async () => {
    const input = {
      message: 'I live in an apartment and have two young kids',
      sessionState: {
        profile: {
          conversationPhase: 'gathering' as const,
        },
      },
    };

    const mockContext = createMockContext(
      'Perfect! Apartment living with kids means we need family-friendly breeds.',
      {
        livingSpace: 'apartment',
        familyComposition: 'young-kids',
      },
    );

    const result = await breedAdvisorAgent.execute(input, mockContext);

    expect(result.updatedProfile.livingSpace).toBe('apartment');
    expect(result.updatedProfile.familyComposition).toBe('young-kids');
  });

  it('should transition to ready-to-recommend phase with 4 factors', async () => {
    const input = {
      message: 'I prefer minimal grooming',
      sessionState: {
        profile: {
          musicPreference: 'pop' as const,
          livingSpace: 'apartment' as const,
          familyComposition: 'couple' as const,
          conversationPhase: 'gathering' as const,
        },
      },
    };

    const mockContext = createMockContext(
      'Great! With minimal grooming preference, I have enough information. Ready to see recommendations?',
      {
        musicPreference: 'pop',
        livingSpace: 'apartment',
        familyComposition: 'couple',
        groomingTolerance: 'minimal',
      },
    );

    const result = await breedAdvisorAgent.execute(input, mockContext);

    // With 4 factors including music, should transition to ready-to-recommend
    expect(result.updatedProfile.conversationPhase).toBe('ready-to-recommend');
    expect(result.updatedProfile.groomingTolerance).toBe('minimal');
  });

  it('should provide recommendations when explicitly asked', async () => {
    const input = {
      message: 'What breeds do you recommend for me?',
      sessionState: {
        profile: {
          musicPreference: 'classical' as const,
          livingSpace: 'apartment' as const,
          activityLevel: 'couch-companion' as const,
          groomingTolerance: 'daily' as const,
          conversationPhase: READY_PHASE as const,
        },
      },
    };

    const mockContext = createMockContext(
      JSON.stringify({
        reply: 'Based on your preferences, I recommend Persian cats!',
        updatedProfile: {
          musicPreference: 'classical',
          livingSpace: 'apartment',
          activityLevel: 'couch-companion',
          groomingTolerance: 'daily',
          conversationPhase: READY_PHASE,
        },
        recommendations: [
          {
            breed: 'Persian',
            matchScore: 90,
            reasoning: 'Classical music alignment; couch companion; daily grooming tolerance',
          },
        ],
      }),
    );

    const result = await breedAdvisorAgent.execute(input, mockContext);

    expect(result.recommendations).toBeDefined();
    if (result.recommendations) {
      const persian = result.recommendations.find((r) => r.breed === 'Persian');
      expect(persian).toBeDefined();
    }
  });

  it('should handle allergy requirements', async () => {
    const input = {
      message: 'I have allergies',
      sessionState: {
        profile: {
          musicPreference: 'electronic' as const,
          conversationPhase: 'gathering' as const,
        },
      },
    };

    const mockContext = createMockContext(
      "No problem! We'll focus on hypoallergenic breeds like Sphynx.",
      {
        musicPreference: 'electronic',
        allergies: true,
      },
    );

    const result = await breedAdvisorAgent.execute(input, mockContext);

    expect(result.updatedProfile.allergies).toBe(true);
  });
});

describe('breedAdvisorAgent declarative configuration', () => {
  it('should use generated prompts from factor definitions', () => {
    // Verify the manifest contains generated prompt information
    expect(breedAdvisorAgent.manifest.metadata?.gatheringPhase).toBeDefined();
    expect(breedAdvisorAgent.manifest.metadata?.gatheringPhase?.factorCount).toBe(6);
    expect(breedAdvisorAgent.manifest.metadata?.gatheringPhase?.requiredFactors).toContain('musicPreference');
    expect(breedAdvisorAgent.manifest.metadata?.gatheringPhase?.priorityFactors).toContain('musicPreference');
  });

  it('should have extraction phase metadata', () => {
    expect(breedAdvisorAgent.manifest.metadata?.extractionPhase).toBeDefined();
    expect(breedAdvisorAgent.manifest.metadata?.extractionPhase?.useStructuredOutputs).toBe(false);
  });
});
