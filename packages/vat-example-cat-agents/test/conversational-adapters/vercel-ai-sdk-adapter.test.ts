/**
 * Test: Vercel AI SDK adapter for conversational demo
 *
 * Runs shared contract tests plus Vercel-specific tests.
 */

import { describe, it, vi } from 'vitest';

import { createVercelAISDKAdapter } from '../../examples/conversational-adapters/vercel-ai-sdk-adapter.js';

import { testConversationalAdapterContract } from './shared-contract-tests.js';
import { testAdapterCreation } from './test-helpers.js';

// Factory function for creating mock agent (must be defined before vi.mock() for hoisting)
// NOTE: This function is duplicated across all adapter tests due to vitest hoisting constraints.
// Mock factories cannot reference imported functions. See test-helpers.ts for explanation.
function createMockAgent() {
  return {
    name: 'breed-advisor',
    manifest: {
      name: 'breed-advisor',
      archetype: 'two-phase-conversational-assistant',
      description: 'Test agent',
      version: '1.0.0',
    },
    execute: vi.fn().mockImplementation((input: { message: string; sessionState?: { profile?: Record<string, unknown> } }, context: { addToHistory: (role: string, content: string) => void }) => {
      const { message, sessionState } = input;
      const currentState = sessionState?.profile ?? {};

      // Add user message to history
      context.addToHistory('user', message);

      // Extract info from user message (simple pattern matching)
      const newState = { ...currentState };

      if (/apartment|small.*apartment/i.test(message)) {
        newState.livingSpace = 'apartment';
      }
      if (/jazz/i.test(message)) {
        newState.musicPreference = 'jazz';
      }
      if (/classical/i.test(message)) {
        newState.musicPreference = 'classical';
      }
      if (/calm|low.energy|lazy/i.test(message)) {
        newState.activityLevel = 'couch-companion';
      }

      const reply = 'Mocked agent response';

      // Add assistant response to history
      context.addToHistory('assistant', reply);

      return Promise.resolve({
        reply,
        sessionState: newState,
        result: { status: 'in-progress' },
      });
    }),
  };
}

// Mock Vercel AI SDK
vi.mock('ai', () => ({
  streamText: vi.fn(() => ({
    text: Promise.resolve('Mocked LLM response'),
  })),
}));

// Mock @ai-sdk/openai
vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn(() => 'mocked-model'),
}));

// Mock the breed advisor agent with realistic extraction
vi.mock('../../src/conversational-assistant/breed-advisor.js', () => ({
  breedAdvisorAgent: createMockAgent(),
}));

// Run shared contract tests
testConversationalAdapterContract('Vercel AI SDK', createVercelAISDKAdapter);

describe('Vercel AI SDK Adapter - Vercel-Specific Tests', () => {
  it('should create adapter successfully', () => {
    testAdapterCreation('Vercel AI SDK', createVercelAISDKAdapter);
  });
});
