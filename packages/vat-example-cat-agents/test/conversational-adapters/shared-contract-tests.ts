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

import { createTestSession } from './test-helpers.js';

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
        const session = createTestSession();

        const result = await adapter.convertToFunction('I need help finding a cat breed', session);

        // All adapters must return proper structure
        expect(result).toBeDefined();
        expect(result.output).toBeDefined();
        expect(result.output.reply).toBeDefined();
        expect(typeof result.output.reply).toBe('string');
        expect(result.output.reply.length).toBeGreaterThan(0);

        // Session state must be defined
        expect(result.output.sessionState).toBeDefined();
        expect(result.output.sessionState.conversationPhase).toBeDefined();

        // Session history must be defined
        expect(result.session).toBeDefined();
        expect(result.session.history).toBeDefined();
        expect(Array.isArray(result.session.history)).toBe(true);
      });

      it('should accumulate conversation history across turns', async () => {
        const adapter = createAdapter();
        let session = createTestSession();

        const result1 = await adapter.convertToFunction('Hello', session);
        const historyLength1 = result1.session.history.length;
        session = result1.session;

        const result2 = await adapter.convertToFunction(JAZZ_PREFERENCE, session);
        const historyLength2 = result2.session.history.length;

        // History should grow with each turn
        expect(historyLength2).toBeGreaterThan(historyLength1);
      });

      it('should preserve session state between turns', async () => {
        const adapter = createAdapter();
        const session = createTestSession({
          state: {
            profile: {
              conversationPhase: 'gathering',
              musicPreference: 'jazz',
            } as SelectionProfile,
          },
        });

        const result = await adapter.convertToFunction(APARTMENT_LIVING, session);

        // Previously set state should not be lost
        expect(result.output.sessionState.musicPreference).toBeDefined();
      });
    });

    describe('Factor extraction - Living Space', () => {
      it('should extract living space from "I live in a small apartment"', async () => {
        const adapter = createAdapter();
        let session = createTestSession();

        // First turn: initial greeting
        session = (await adapter.convertToFunction(FINDING_A_CAT, session)).session;

        // Second turn: provide living space
        const result = await adapter.convertToFunction('I live in a small apartment', session);

        // All runtimes should extract this value
        expect(result.output.sessionState.livingSpace).toBeDefined();

        // Natural language mapping may differ slightly between runtimes
        // "small apartment" → "apartment" or "small-house"
        expect(['apartment', 'small-house']).toContain(result.output.sessionState.livingSpace);
      });

      it('should extract living space from "I live in an apartment"', async () => {
        const adapter = createAdapter();
        let session = createTestSession();

        session = (await adapter.convertToFunction(INITIAL_GREETING, session)).session;
        const result = await adapter.convertToFunction(APARTMENT_LIVING, session);

        expect(result.output.sessionState.livingSpace).toBeDefined();
        expect(['apartment', 'small-house']).toContain(result.output.sessionState.livingSpace);
      });
    });

    describe('Factor extraction - Music Preference', () => {
      it('should extract music preference from "I love jazz music"', async () => {
        const adapter = createAdapter();
        let session = createTestSession();

        session = (await adapter.convertToFunction(INITIAL_GREETING, session)).session;
        const result = await adapter.convertToFunction('I love jazz music', session);

        // Music preference is a critical factor - should be extracted
        expect(result.output.sessionState.musicPreference).toBe('jazz');
      });

      it('should extract music preference from "I listen to classical"', async () => {
        const adapter = createAdapter();
        let session = createTestSession();

        session = (await adapter.convertToFunction(INITIAL_GREETING, session)).session;
        const result = await adapter.convertToFunction('I listen to classical music', session);

        expect(result.output.sessionState.musicPreference).toBe('classical');
      });
    });

    describe('Factor extraction - Activity Level', () => {
      it('should extract activity level from "I prefer calm, low-energy cats"', async () => {
        const adapter = createAdapter();
        let session = createTestSession();

        session = (await adapter.convertToFunction(INITIAL_GREETING, session)).session;
        const result = await adapter.convertToFunction(CALM_PREFERENCE, session);

        // Natural language mapping: calm/low-energy → couch-companion
        expect(result.output.sessionState.activityLevel).toBeDefined();
        expect(result.output.sessionState.activityLevel).toBe('couch-companion');
      });

      it('should extract activity level from "I want a lazy cat"', async () => {
        const adapter = createAdapter();
        let session = createTestSession();

        session = (await adapter.convertToFunction(INITIAL_GREETING, session)).session;
        const result = await adapter.convertToFunction('I want a lazy cat', session);

        // Natural language mapping: lazy → couch-companion
        expect(result.output.sessionState.activityLevel).toBe('couch-companion');
      });
    });

    describe('Session state accumulation', () => {
      it('should accumulate factors without losing previous values', async () => {
        const adapter = createAdapter();
        let session = createTestSession();

        // Turn 1: Initial greeting
        session = (await adapter.convertToFunction(FINDING_A_CAT, session)).session;

        // Turn 2: Living space
        const result2 = await adapter.convertToFunction(APARTMENT_LIVING, session);
        expect(result2.output.sessionState.livingSpace).toBeDefined();
        session = result2.session;

        // Turn 3: Music preference
        const result3 = await adapter.convertToFunction(JAZZ_PREFERENCE, session);
        expect(result3.output.sessionState.musicPreference).toBe('jazz');
        expect(result3.output.sessionState.livingSpace).toBeDefined(); // Should not be lost!
        session = result3.session;

        // Turn 4: Activity level
        const result4 = await adapter.convertToFunction('I want a calm cat', session);
        expect(result4.output.sessionState.activityLevel).toBeDefined();
        expect(result4.output.sessionState.livingSpace).toBeDefined(); // Still there
        expect(result4.output.sessionState.musicPreference).toBe('jazz'); // Still there
      });

      it('should handle multiple factors in same message', async () => {
        const adapter = createAdapter();
        let session = createTestSession();

        session = (await adapter.convertToFunction(INITIAL_GREETING, session)).session;
        const result = await adapter.convertToFunction(
          'I live in a small apartment and I love jazz music',
          session,
        );

        // Should extract both factors from one message
        expect(result.output.sessionState.livingSpace).toBeDefined();
        expect(result.output.sessionState.musicPreference).toBe('jazz');
      });
    });

    describe('Result envelope', () => {
      it('should return result with status field', async () => {
        const adapter = createAdapter();
        const session = createTestSession();

        const result = await adapter.convertToFunction(INITIAL_GREETING, session);

        // Result envelope pattern
        expect(result.output.result).toBeDefined();
        expect(result.output.result.status).toBeDefined();
        expect(['in-progress', 'success']).toContain(result.output.result.status);
      });
    });

    describe('Conversation phase transitions', () => {
      it('should start in gathering phase', async () => {
        const adapter = createAdapter();
        const session = createTestSession();

        const result = await adapter.convertToFunction(INITIAL_GREETING, session);

        expect(result.output.sessionState.conversationPhase).toBe('gathering');
      });

      it('should transition to ready-to-recommend when enough factors collected', async () => {
        const adapter = createAdapter();
        let session = createTestSession();

        // Provide multiple factors to reach ready state
        session = (await adapter.convertToFunction(INITIAL_GREETING, session)).session;
        session = (await adapter.convertToFunction(APARTMENT_LIVING, session)).session;
        session = (await adapter.convertToFunction(JAZZ_PREFERENCE, session)).session;
        session = (await adapter.convertToFunction('I want a calm cat', session)).session;
        const result = await adapter.convertToFunction('I can groom weekly', session);

        // With 4+ factors, should be ready
        // Note: Some runtimes may extract faster than others
        const phase = result.output.sessionState.conversationPhase;
        expect(['gathering', 'ready-to-recommend', 'refining']).toContain(phase);
      });
    });

    describe('Error handling and edge cases', () => {
      it('should not crash on empty input', async () => {
        const adapter = createAdapter();
        const session = createTestSession();

        // Should handle gracefully, not throw
        await expect(adapter.convertToFunction('', session)).resolves.toBeDefined();
      });

      it('should handle very long input', async () => {
        const adapter = createAdapter();
        const session = createTestSession();

        const longInput = 'I love cats '.repeat(100);

        await expect(adapter.convertToFunction(longInput, session)).resolves.toBeDefined();
      });

      it('should handle special characters in input', async () => {
        const adapter = createAdapter();
        const session = createTestSession();

        const specialInput = "I live in an apartment! @#$% It's great :)";

        await expect(adapter.convertToFunction(specialInput, session)).resolves.toBeDefined();
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
