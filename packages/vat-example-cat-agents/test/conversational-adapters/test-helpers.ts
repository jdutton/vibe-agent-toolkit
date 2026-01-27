/**
 * Shared test helpers for conversational adapter tests
 *
 * Reduces duplication across adapter test files by providing common setup and utilities.
 */

import type { Session } from '@vibe-agent-toolkit/transports';
import { expect, vi } from 'vitest';

import type { BreedAdvisorState } from '../../examples/conversational-adapters/shared-types.js';

/**
 * Helper to create a test session with default values
 */
export function createTestSession(overrides?: Partial<Session<BreedAdvisorState>>): Session<BreedAdvisorState> {
  return {
    history: [],
    state: {
      profile: {
        conversationPhase: 'gathering',
      },
    },
    ...overrides,
  };
}

/**
 * Create a mock implementation for the breed advisor agent
 *
 * This mock extracts simple patterns from user messages and updates session state accordingly.
 */
export function createMockBreedAdvisorAgent(): {
  name: string;
  manifest: {
    name: string;
    archetype: string;
    description: string;
    version: string;
  };
  execute: ReturnType<typeof vi.fn>;
} {
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

/**
 * Test that an adapter creation function doesn't throw when an API key is missing
 */
export function testMissingAPIKey(
  envVarName: string,
  createAdapter: () => unknown,
): void {
  const originalKey = process.env[envVarName];
  delete process.env[envVarName];

  expect(() => {
    createAdapter();
  }).not.toThrow();

  // Restore env var
  if (originalKey) {
    process.env[envVarName] = originalKey;
  }
}
