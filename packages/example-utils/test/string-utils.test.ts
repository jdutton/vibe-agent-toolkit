/**
 * EXAMPLE TESTS - DELETE WHEN USING THIS TEMPLATE
 *
 * These tests validate the template setup works correctly.
 * Delete this file when using the template for your project.
 */
import { describe, expect, it } from 'vitest';

import { capitalize, isEmpty, truncate } from '../src/string-utils.js';

describe('capitalize', () => {
  it('should capitalize the first letter', () => {
    expect(capitalize('hello')).toBe('Hello');
  });

  it('should handle empty strings', () => {
    expect(capitalize('')).toBe('');
  });

  it('should handle single character strings', () => {
    expect(capitalize('a')).toBe('A');
  });

  it('should not affect already capitalized strings', () => {
    expect(capitalize('Hello')).toBe('Hello');
  });
});

describe('isEmpty', () => {
  it('should return true for empty strings', () => {
    expect(isEmpty('')).toBe(true);
  });

  it('should return true for whitespace-only strings', () => {
    expect(isEmpty('   ')).toBe(true);
    expect(isEmpty('\t\n')).toBe(true);
  });

  it('should return false for non-empty strings', () => {
    expect(isEmpty('hello')).toBe(false);
    expect(isEmpty(' hello ')).toBe(false);
  });
});

describe('truncate', () => {
  it('should truncate long strings', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  it('should not truncate short strings', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('should handle custom suffix', () => {
    expect(truncate('hello world', 8, '…')).toBe('hello w…');
  });

  it('should handle edge cases', () => {
    expect(truncate('', 5)).toBe('');
    expect(truncate('hello', 5)).toBe('hello');
  });
});
