/**
 * What a unit test of a command's pure decisions needs twice or more: the refusal a call
 * throws, as a value to assert on, and a logger that records instead of printing.
 */

import { vi } from 'vitest';

import { CommandRefusalError } from '../../src/utils/command-refusal.js';

/**
 * The `CommandRefusalError` `work` throws. Anything else it throws is rethrown, and returning
 * without throwing fails the test: a refusal that silently stopped happening is the regression.
 */
export function refusalOf(work: () => unknown): CommandRefusalError {
  try {
    work();
  } catch (error) {
    if (error instanceof CommandRefusalError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** A logger whose four channels are spies. */
export function fakeLogger(): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}
