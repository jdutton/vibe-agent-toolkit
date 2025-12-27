/**
 * EXAMPLE INTEGRATION TEST - DELETE WHEN USING THIS TEMPLATE
 *
 * This demonstrates the integration test pattern.
 * Integration tests verify multiple functions work together.
 */
import { describe, expect, it } from 'vitest';

import { capitalize, isEmpty, truncate } from '../../src/string-utils.js';

describe('String Utils Integration', () => {
  it('should process user input through validation and formatting pipeline', () => {
    // Simulates a real workflow: validate input, then format it
    const userInput = '  hello world from example template  ';

    // Step 1: Validate input is not empty
    const isValid = !isEmpty(userInput);
    expect(isValid).toBe(true);

    // Step 2: Clean and capitalize
    const cleaned = userInput.trim();
    const capitalized = capitalize(cleaned);
    expect(capitalized).toBe('Hello world from example template');

    // Step 3: Truncate for display
    const display = truncate(capitalized, 20);
    expect(display).toBe('Hello world from ...');
  });

  it('should handle empty input gracefully in workflow', () => {
    const userInput = '   ';

    // Validate
    const isValid = !isEmpty(userInput);
    expect(isValid).toBe(false);

    // Don't process empty input
    if (isValid) {
      capitalize(userInput.trim());
    }
    // Test passes without processing
  });

  it('should chain operations for text processing', () => {
    // Example: process a list of strings
    const inputs = ['hello', 'world', 'from', 'the', 'example template'];

    const processed = inputs
      .map(str => capitalize(str))
      .join(' ');

    expect(processed).toBe('Hello World From The Example template');

    const truncated = truncate(processed, 25);
    expect(truncated).toBe('Hello World From The E...');
  });
});
