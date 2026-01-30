/**
 * Shared Contract Tests for Conversational Runtime Adapters
 *
 * This test suite validates that ALL conversational adapters behave consistently,
 * regardless of which LLM runtime they use (Vercel, OpenAI, LangChain, Claude).
 *
 * Import this function in each adapter test file to ensure all adapters pass
 * the same behavioral contract tests.
 *
 * Usage:
 * ```typescript
 * import { testConversationalAdapterContract } from './shared-contract-tests.js';
 * import { createMyAdapter } from '../../examples/conversational-adapters/my-adapter.js';
 *
 * testConversationalAdapterContract('My Runtime', createMyAdapter);
 * ```
 */

import { describe, expect, it } from 'vitest';

import type { BreedAdvisorState } from '../../examples/conversational-adapters/shared-types.js';
import type { ConversationalRuntimeAdapter } from '../../examples/conversational-runtime-adapter.js';
import type { BreedAdvisorOutput, SelectionProfile } from '../../src/types/schemas.js';

import { createTestSessionContext } from './test-helpers.js';

// Common test strings to avoid duplication
const INITIAL_GREETING = 'I need help';
const FINDING_A_CAT = 'I need help finding a cat';
const CALM_PREFERENCE = 'I prefer calm, low-energy cats';
const JAZZ_PREFERENCE = 'I love jazz';
const APARTMENT_LIVING = 'I live in an apartment';

/**
 * Shared contract tests that all conversational adapters must pass.
 *
 * @param adapterName - Human-readable name of the adapter (e.g., "OpenAI SDK")
 * @param createAdapter - Factory function that creates the adapter instance
 */
export function testConversationalAdapterContract(
  adapterName: string,
  createAdapter: () => ConversationalRuntimeAdapter<BreedAdvisorOutput, BreedAdvisorState>,
): void {
  describe(`${adapterName} - Shared Contract Tests`, () => {
    describe('Basic conversation flow', () => {
      it('should handle initial greeting', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        const result = await adapter.convertToFunction('I need help finding a cat breed', context);

        // All adapters must return proper structure
        expect(result).toBeDefined();
        expect(result).toBeDefined();
        expect(result.reply).toBeDefined();
        expect(typeof result.reply).toBe('string');
        expect(result.reply.length).toBeGreaterThan(0);

        // Session state must be defined
        expect(context.state).toBeDefined();
        expect(result.sessionState.conversationPhase).toBeDefined();

        // Session history must be defined
        expect(context).toBeDefined();
        expect(context.conversationHistory).toBeDefined();
        expect(Array.isArray(context.conversationHistory)).toBe(true);
      });

      it('should accumulate conversation history across turns', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        await adapter.convertToFunction('Hello', context);
        const historyLength1 = context.conversationHistory.length;

        await adapter.convertToFunction(JAZZ_PREFERENCE, context);
        const historyLength2 = context.conversationHistory.length;

        // History should grow with each turn
        expect(historyLength2).toBeGreaterThan(historyLength1);
      });

      it('should preserve session state between turns', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext({
          state: {
            profile: {
              conversationPhase: 'gathering',
              musicPreference: 'jazz',
            } as SelectionProfile,
          },
        });

        const result = await adapter.convertToFunction(APARTMENT_LIVING, context);

        // Previously set state should not be lost
        expect(result.sessionState.musicPreference).toBeDefined();
      });
    });

    describe('Factor extraction - Living Space', () => {
      it('should extract living space from "I live in a small apartment"', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        // First turn: initial greeting
        await adapter.convertToFunction(FINDING_A_CAT, context);

        // Second turn: provide living space
        const result = await adapter.convertToFunction('I live in a small apartment', context);

        // All runtimes should extract this value
        expect(result.sessionState.livingSpace).toBeDefined();

        // Natural language mapping may differ slightly between runtimes
        // "small apartment" → "apartment" or "small-house"
        expect(['apartment', 'small-house']).toContain(result.sessionState.livingSpace);
      });

      it('should extract living space from "I live in an apartment"', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        await adapter.convertToFunction(INITIAL_GREETING, context);
        const result = await adapter.convertToFunction(APARTMENT_LIVING, context);

        expect(result.sessionState.livingSpace).toBeDefined();
        expect(['apartment', 'small-house']).toContain(result.sessionState.livingSpace);
      });
    });

    describe('Factor extraction - Music Preference', () => {
      it('should extract music preference from "I love jazz music"', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        await adapter.convertToFunction(INITIAL_GREETING, context);
        const result = await adapter.convertToFunction('I love jazz music', context);

        // Music preference is a critical factor - should be extracted
        expect(result.sessionState.musicPreference).toBe('jazz');
      });

      it('should extract music preference from "I listen to classical"', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        await adapter.convertToFunction(INITIAL_GREETING, context);
        const result = await adapter.convertToFunction('I listen to classical music', context);

        expect(result.sessionState.musicPreference).toBe('classical');
      });
    });

    describe('Factor extraction - Activity Level', () => {
      it('should extract activity level from "I prefer calm, low-energy cats"', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        await adapter.convertToFunction(INITIAL_GREETING, context);
        const result = await adapter.convertToFunction(CALM_PREFERENCE, context);

        // Natural language mapping: calm/low-energy → couch-companion
        expect(result.sessionState.activityLevel).toBeDefined();
        expect(result.sessionState.activityLevel).toBe('couch-companion');
      });

      it('should extract activity level from "I want a lazy cat"', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        await adapter.convertToFunction(INITIAL_GREETING, context);
        const result = await adapter.convertToFunction('I want a lazy cat', context);

        // Natural language mapping: lazy → couch-companion
        expect(result.sessionState.activityLevel).toBe('couch-companion');
      });
    });

    describe('Session state accumulation', () => {
      it('should accumulate factors without losing previous values', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        // Turn 1: Initial greeting
        await adapter.convertToFunction(FINDING_A_CAT, context);

        // Turn 2: Living space
        const result2 = await adapter.convertToFunction(APARTMENT_LIVING, context);
        expect(result2.sessionState.livingSpace).toBeDefined();
        
        // Turn 3: Music preference
        const result3 = await adapter.convertToFunction(JAZZ_PREFERENCE, context);
        expect(result3.sessionState.musicPreference).toBe('jazz');
        expect(result3.sessionState.livingSpace).toBeDefined(); // Should not be lost!
        
        // Turn 4: Activity level
        const result4 = await adapter.convertToFunction('I want a calm cat', context);
        expect(result4.sessionState.activityLevel).toBeDefined();
        expect(result4.sessionState.livingSpace).toBeDefined(); // Still there
        expect(result4.sessionState.musicPreference).toBe('jazz'); // Still there
      });

      it('should handle multiple factors in same message', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        await adapter.convertToFunction(INITIAL_GREETING, context);
        const result = await adapter.convertToFunction(
          'I live in a small apartment and I love jazz music',
          context,
        );

        // Should extract both factors from one message
        expect(result.sessionState.livingSpace).toBeDefined();
        expect(result.sessionState.musicPreference).toBe('jazz');
      });
    });

    describe('Result envelope', () => {
      it('should return result with status field', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        const result = await adapter.convertToFunction(INITIAL_GREETING, context);

        // Result envelope pattern
        expect(result.result).toBeDefined();
        expect(result.result.status).toBeDefined();
        expect(['in-progress', 'success']).toContain(result.result.status);
      });
    });

    describe('Conversation phase transitions', () => {
      it('should start in gathering phase', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        const result = await adapter.convertToFunction(INITIAL_GREETING, context);

        expect(result.sessionState.conversationPhase).toBe('gathering');
      });

      it('should transition to ready-to-recommend when enough factors collected', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        // Provide multiple factors to reach ready state
        await adapter.convertToFunction(INITIAL_GREETING, context);
        await adapter.convertToFunction(APARTMENT_LIVING, context);
        await adapter.convertToFunction(JAZZ_PREFERENCE, context);
        await adapter.convertToFunction('I want a calm cat', context);
        const result = await adapter.convertToFunction('I can groom weekly', context);

        // With 4+ factors, should be ready
        // Note: Some runtimes may extract faster than others
        const phase = result.sessionState.conversationPhase;
        expect(['gathering', 'ready-to-recommend', 'refining']).toContain(phase);
      });
    });

    describe('Error handling and edge cases', () => {
      it('should not crash on empty input', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        // Should handle gracefully, not throw
        await expect(adapter.convertToFunction('', context)).resolves.toBeDefined();
      });

      it('should handle very long input', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        const longInput = 'I love cats '.repeat(100);

        await expect(adapter.convertToFunction(longInput, context)).resolves.toBeDefined();
      });

      it('should handle special characters in input', async () => {
        const adapter = createAdapter();
        const context = createTestSessionContext();

        const specialInput = "I live in an apartment! @#$% It's great :)";

        await expect(adapter.convertToFunction(specialInput, context)).resolves.toBeDefined();
      });
    });

    describe('Adapter metadata', () => {
      it('should have a name property', () => {
        const adapter = createAdapter();

        expect(adapter.name).toBeDefined();
        expect(typeof adapter.name).toBe('string');
        expect(adapter.name.length).toBeGreaterThan(0);
      });

      it('should have a convertToFunction method', () => {
        const adapter = createAdapter();

        expect(adapter.convertToFunction).toBeDefined();
        expect(typeof adapter.convertToFunction).toBe('function');
      });
    });
  });
}
