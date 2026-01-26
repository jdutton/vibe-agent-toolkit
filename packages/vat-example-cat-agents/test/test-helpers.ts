import type { OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';
import type { expect } from 'vitest';

import type { CatCharacteristics } from '../src/types/schemas.js';

/**
 * Shared test fixtures for cat characteristics
 */

export const TEST_CATS = {
  orange: {
    physical: {
      furColor: 'Orange',
      furPattern: 'Tabby',
      size: 'medium' as const,
    },
    behavioral: {
      personality: ['Playful', 'Energetic'],
    },
    description: 'A playful orange tabby',
  } satisfies CatCharacteristics,

  black: {
    physical: {
      furColor: 'Black',
      size: 'medium' as const,
    },
    behavioral: {
      personality: ['Mysterious', 'Independent'],
    },
    description: 'A mysterious black cat',
  } satisfies CatCharacteristics,

  lazy: {
    physical: {
      furColor: 'Gray',
      size: 'large' as const,
    },
    behavioral: {
      personality: ['Lazy', 'Relaxed'],
    },
    description: 'A very lazy cat',
  } satisfies CatCharacteristics,
};

/**
 * Shared validator for number parsing in tests
 */
export function createNumberValidator(
  options: { requirePositive?: boolean } = {},
): (response: string) => { valid: boolean; error?: string; value?: number } {
  return (response: string): { valid: boolean; error?: string; value?: number } => {
    const num = Number.parseInt(response, 10);
    if (Number.isNaN(num)) {
      return { valid: false, error: 'Must be a number' };
    }
    if (options.requirePositive && num < 0) {
      return { valid: false, error: 'Must be positive' };
    }
    return { valid: true, value: num };
  };
}

/**
 * Helper to find content matching a pattern across multiple attempts
 */
export async function findMatchingContent<T>(
  generator: () => Promise<T>,
  matcher: (result: T) => boolean,
  options: { maxAttempts?: number } = {},
): Promise<{ found: boolean; result?: T }> {
  const { maxAttempts = 10 } = options;

  for (let index = 0; index < maxAttempts; index++) {
    const result = await generator();
    if (matcher(result)) {
      return { found: true, result };
    }
  }

  return { found: false };
}

/**
 * Helper to find haiku containing specific keywords
 */
export async function findHaikuWithKeywords(
  generator: () => Promise<{ line1: string; line2: string; line3: string }>,
  keywords: string[],
  options: { maxAttempts?: number } = {},
): Promise<boolean> {
  const { maxAttempts = 10 } = options;

  for (let index = 0; index < maxAttempts; index++) {
    const result = await generator();
    const fullText = `${result.line1} ${result.line2} ${result.line3}`.toLowerCase();

    if (keywords.some((keyword) => fullText.includes(keyword))) {
      return true;
    }
  }

  return false;
}

/**
 * Helper to find content with invalid syllable count in specific line
 */
export async function findInvalidSyllableLine(
  generator: () => Promise<{ line1: string; line2: string; line3: string }>,
  validator: (haiku: { line1: string; line2: string; line3: string }) => {
    valid: boolean;
    syllables: { line1: number; line2: number; line3: number };
    errors: string[];
  },
  lineNumber: 1 | 2 | 3,
  expectedSyllables: number,
  options: { maxAttempts?: number } = {},
): Promise<boolean> {
  const { maxAttempts = 20 } = options;
  const lineKey = `line${lineNumber}` as 'line1' | 'line2' | 'line3';
  const lineLabel = `Line ${lineNumber}`;

  for (let index = 0; index < maxAttempts; index++) {
    const result = await generator();
    const validation = validator(result);

    if (!validation.valid && validation.syllables[lineKey] !== expectedSyllables) {
      const hasCorrectError = validation.errors.some((e) => e.includes(lineLabel));
      if (hasCorrectError) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Helper to assert and extract successful agent result
 * Eliminates duplication in envelope testing pattern
 */
export function expectSuccess<TData, TError>(
  output: OneShotAgentOutput<TData, TError>,
  expectFn: typeof expect,
): asserts output is OneShotAgentOutput<TData, TError> & {
  result: { status: 'success'; data: TData };
} {
  expectFn(output.result.status).toBe('success');
}

/**
 * Helper to assert and extract error agent result
 * Eliminates duplication in envelope testing pattern
 */
export function expectError<TData, TError>(
  output: OneShotAgentOutput<TData, TError>,
  expectedError: TError,
  expectFn: typeof expect,
): asserts output is OneShotAgentOutput<TData, TError> & {
  result: { status: 'error'; error: TError };
} {
  expectFn(output.result.status).toBe('error');
  if (output.result.status === 'error') {
    expectFn(output.result.error).toBe(expectedError);
  }
}

/**
 * Helper to execute agent and verify success result
 * Returns the unwrapped data for further assertions
 */
export async function expectAgentSuccess<TInput, TData, TError>(
  agent: { execute: (input: TInput) => Promise<OneShotAgentOutput<TData, TError>> },
  input: TInput,
  expectFn: typeof expect,
): Promise<TData> {
  const output = await agent.execute(input);
  expectSuccess(output, expectFn);
  return output.result.data;
}
