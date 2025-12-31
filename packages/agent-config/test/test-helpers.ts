import { expect } from 'vitest';

import { type ValidationResult } from '../src/validator/agent-validator.js';

/**
 * Assert that validation result shows errors with specific content
 */
export function assertValidationHasError(
  result: ValidationResult,
  searchTerms: string[]
): void {
  expect(result.valid).toBe(false);
  expect(result.errors.length).toBeGreaterThan(0);
  const hasExpectedError = result.errors.some(error =>
    searchTerms.some(term => error.includes(term))
  );
  expect(hasExpectedError).toBe(true);
}
