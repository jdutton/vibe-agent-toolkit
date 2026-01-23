import { describe, expect, it } from 'vitest';

import { breedAdvisorAgent } from '../../src/conversational-assistant/breed-advisor.js';

/**
 * Create a mock context for testing
 */
function createMockContext(llmResponse: string) {
  return {
    mockable: true,
    history: [],
    addToHistory: () => {},
    callLLM: async () => llmResponse,
  };
}

describe('breedAdvisorAgent', () => {
  it('should have correct name and manifest', () => {
    expect(breedAdvisorAgent.name).toBe('breed-advisor');
    expect(breedAdvisorAgent.manifest).toBeDefined();
    expect(breedAdvisorAgent.manifest.archetype).toBe('conversational-assistant');
  });

  it('should have execute function', () => {
    expect(breedAdvisorAgent.execute).toBeInstanceOf(Function);
  });
});

describe('breedAdvisorAgent.execute', () => {
  it('should start conversation with gathering phase', async () => {
    const input = {
      message: 'Hello, I need help finding a cat breed',
    };

    const mockContext = createMockContext(JSON.stringify({
      reply: 'Hi! I\'d love to help you find the perfect cat breed. To start, what kind of music do you enjoy?',
      updatedProfile: {
        conversationPhase: 'gathering',
      },
    }));

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

    const mockContext = createMockContext(JSON.stringify({
      reply: 'Excellent! Classical music suggests calm, regal breeds.',
      updatedProfile: {
        musicPreference: 'classical',
        conversationPhase: 'gathering',
      },
    }));

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

    const mockContext = createMockContext(JSON.stringify({
      reply: 'Perfect! Apartment living with kids means we need family-friendly breeds.',
      updatedProfile: {
        livingSpace: 'apartment',
        familyComposition: 'young-kids',
        conversationPhase: 'gathering',
      },
    }));

    const result = await breedAdvisorAgent.execute(input, mockContext);

    expect(result.updatedProfile.livingSpace).toBe('apartment');
    expect(result.updatedProfile.familyComposition).toBe('young-kids');
  });

  it('should transition to ready phase with 4 factors', async () => {
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

    const mockContext = createMockContext(JSON.stringify({
      reply: 'Great! With minimal grooming preference, here are my recommendations:',
      updatedProfile: {
        musicPreference: 'pop',
        livingSpace: 'apartment',
        familyComposition: 'couple',
        groomingTolerance: 'minimal',
        conversationPhase: 'ready-to-recommend',
      },
      recommendations: [
        {
          breed: 'Domestic Shorthair',
          matchScore: 80,
          reasoning: 'Pop music aligns; minimal grooming; apartment suitable',
        },
      ],
    }));

    const result = await breedAdvisorAgent.execute(input, mockContext);

    expect(result.updatedProfile.conversationPhase).toBe(READY_PHASE);
    expect(result.recommendations).toBeDefined();
    if (result.recommendations) {
      expect(result.recommendations.length).toBeGreaterThan(0);
    }
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
          conversationPhase: READY_PHASE,
        },
      },
    };

    const mockContext = createMockContext(JSON.stringify({
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
    }));

    const result = await breedAdvisorAgent.execute(input, mockContext);

    expect(result.recommendations).toBeDefined();
    if (result.recommendations) {
      const persian = result.recommendations.find((r: { breed: string; matchScore: number; reasoning: string }) => r.breed === 'Persian');
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

    const mockContext = createMockContext(JSON.stringify({
      reply: 'No problem! We\'ll focus on hypoallergenic breeds like Sphynx.',
      updatedProfile: {
        musicPreference: 'electronic',
        allergies: true,
        conversationPhase: 'gathering',
      },
    }));

    const result = await breedAdvisorAgent.execute(input, mockContext);

    expect(result.updatedProfile.allergies).toBe(true);
  });
});
