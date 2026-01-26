import { describe, expect, it } from 'vitest';

import {
  BreedAdvisorInputSchema,
  BreedAdvisorOutputSchema,
  SelectionProfileSchema,
} from '../../src/types/schemas.js';

const CONVERSATION_PHASE_GATHERING = 'gathering';
const CONVERSATION_PHASE_READY_TO_RECOMMEND = 'ready-to-recommend';
const RESULT_STATUS_IN_PROGRESS = 'in-progress';

describe('SelectionProfileSchema', () => {
  it('should validate minimal profile with only phase', () => {
    const result = SelectionProfileSchema.safeParse({
      conversationPhase: CONVERSATION_PHASE_GATHERING,
    });

    expect(result.success).toBe(true);
  });

  it('should validate complete profile', () => {
    const result = SelectionProfileSchema.safeParse({
      livingSpace: 'apartment',
      activityLevel: 'couch-companion',
      groomingTolerance: 'minimal',
      familyComposition: 'single',
      allergies: false,
      musicPreference: 'classical',
      conversationPhase: CONVERSATION_PHASE_READY_TO_RECOMMEND,
    });

    expect(result.success).toBe(true);
  });

  it('should reject invalid activity level', () => {
    const result = SelectionProfileSchema.safeParse({
      activityLevel: 'super-active',
      conversationPhase: CONVERSATION_PHASE_GATHERING,
    });

    expect(result.success).toBe(false);
  });

  it('should accept missing conversation phase (optional, set by agent)', () => {
    const result = SelectionProfileSchema.safeParse({
      livingSpace: 'apartment',
    });

    expect(result.success).toBe(true);
  });
});

describe('BreedAdvisorInputSchema', () => {
  it('should validate message with no session state', () => {
    const result = BreedAdvisorInputSchema.safeParse({
      message: 'Hello, I need help finding a cat breed',
    });

    expect(result.success).toBe(true);
  });

  it('should validate message with session state', () => {
    const result = BreedAdvisorInputSchema.safeParse({
      message: 'I live in an apartment',
      sessionState: {
        profile: {
          conversationPhase: CONVERSATION_PHASE_GATHERING,
        },
        conversationHistory: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi! What kind of cat are you looking for?' },
        ],
      },
    });

    expect(result.success).toBe(true);
  });
});

describe('BreedAdvisorOutputSchema', () => {
  it('should validate reply with in-progress result', () => {
    const result = BreedAdvisorOutputSchema.safeParse({
      reply: 'Great! Tell me about your living space.',
      sessionState: {
        conversationPhase: CONVERSATION_PHASE_GATHERING,
      },
      result: {
        status: RESULT_STATUS_IN_PROGRESS,
        metadata: {
          factorsCollected: 1,
          requiredFactors: 4,
          conversationPhase: CONVERSATION_PHASE_GATHERING,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('should validate reply with recommendations in metadata', () => {
    const result = BreedAdvisorOutputSchema.safeParse({
      reply: 'Based on your preferences, here are my recommendations:',
      sessionState: {
        conversationPhase: CONVERSATION_PHASE_READY_TO_RECOMMEND,
        musicPreference: 'classical',
        livingSpace: 'apartment',
      },
      result: {
        status: RESULT_STATUS_IN_PROGRESS,
        metadata: {
          recommendations: [
            {
              breed: 'Persian',
              matchScore: 95,
              reasoning: 'Classical music aligns with calm temperament',
            },
          ],
          conversationPhase: 'refining',
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('should reject invalid match score', () => {
    const result = BreedAdvisorOutputSchema.safeParse({
      reply: 'Here are recommendations',
      sessionState: { conversationPhase: 'ready-to-recommend' },
      result: {
        status: RESULT_STATUS_IN_PROGRESS,
        metadata: {
          recommendations: [
            {
              breed: 'Persian',
              matchScore: 150, // Invalid: > 100
              reasoning: 'Great match',
            },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
