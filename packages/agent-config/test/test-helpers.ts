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

/**
 * Assert that validation failed with unknown manifest info
 */
export function assertValidationFailedWithUnknownManifest(
  result: ValidationResult,
  options: { checkVersion?: boolean } = {}
): void {
  expect(result.valid).toBe(false);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.manifest.name).toBe('unknown');
  if (options.checkVersion !== false) {
    expect(result.manifest.version).toBe('unknown');
  }
}
