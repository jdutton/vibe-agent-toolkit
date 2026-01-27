/**
 * Shared test helpers for conversational adapter tests
 *
 * Reduces duplication across adapter test files by providing common setup and utilities.
 */

import type { Session } from '@vibe-agent-toolkit/transports';
import { expect } from 'vitest';

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
 * NOTE: Mock agent implementation is NOT extracted here due to vitest hoisting constraints.
 *
 * Vitest hoists vi.mock() calls to the top of files before imports execute.
 * This means mock factory functions cannot reference imported variables.
 * Each adapter test file must define createMockAgent() locally before vi.mock().
 *
 * This is intentional duplication required by the testing framework.
 * The alternative would be to inline the mock implementation in vi.mock() factories,
 * which would make the code even more duplicated and harder to read.
 *
 * Reference: https://vitest.dev/api/vi.html#vi-mock
 */

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

/**
 * Test that an adapter was created successfully with expected properties
 */
export function testAdapterCreation(
  adapterName: string,
  createAdapter: () => { name: string; convertToFunction: unknown },
): void {
  const adapter = createAdapter();

  expect(adapter).toBeDefined();
  expect(adapter.name).toBe(adapterName);
  expect(adapter.convertToFunction).toBeDefined();
  expect(typeof adapter.convertToFunction).toBe('function');
}
