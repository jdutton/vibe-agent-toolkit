/* eslint-disable sonarjs/no-duplicate-string */
// Test file - duplicated patterns are acceptable for test clarity
import { describe, expect, it } from 'vitest';

import { expandPattern, expandPatterns, isGlobPattern } from '../src/pattern-expander.js';

describe('isGlobPattern', () => {
  it('should return false for plain paths', () => {
    expect(isGlobPattern('docs')).toBe(false);
    expect(isGlobPattern('docs/guide')).toBe(false);
    expect(isGlobPattern('path/to/file.md')).toBe(false);
  });

  it('should return true for glob patterns with wildcards', () => {
    expect(isGlobPattern('docs/**/*.md')).toBe(true);
    expect(isGlobPattern('**/*.json')).toBe(true);
    expect(isGlobPattern('*.txt')).toBe(true);
  });

  it('should return true for glob patterns with character classes', () => {
    expect(isGlobPattern('docs/[abc].md')).toBe(true);
    expect(isGlobPattern('files/*.{md,txt}')).toBe(true);
  });

  it('should return true for glob patterns with question marks', () => {
    expect(isGlobPattern('file?.md')).toBe(true);
  });
});

describe('expandPattern', () => {
  it('should expand plain paths to glob patterns with **/ prefix', () => {
    expect(expandPattern('docs')).toBe('**/docs/**/*.{md,json}');
    expect(expandPattern('src/guide')).toBe('**/src/guide/**/*.{md,json}');
  });

  it('should strip trailing slashes before expansion', () => {
    expect(expandPattern('docs/')).toBe('**/docs/**/*.{md,json}');
    expect(expandPattern('src/guide/')).toBe('**/src/guide/**/*.{md,json}');
  });

  it('should prepend **/ to relative glob patterns', () => {
    expect(expandPattern('docs/**/*.md')).toBe('**/docs/**/*.md');
    expect(expandPattern('docs/[abc].md')).toBe('**/docs/[abc].md');
    expect(expandPattern('files/*.{md,txt}')).toBe('**/files/*.{md,txt}');
  });

  it('should preserve patterns that already start with **/', () => {
    expect(expandPattern('**/*.schema.json')).toBe('**/*.schema.json');
    expect(expandPattern('**/*.md')).toBe('**/*.md');
  });

  it('should preserve root-level patterns unchanged', () => {
    expect(expandPattern('*.txt')).toBe('*.txt');
    expect(expandPattern('*.md')).toBe('*.md');
  });
});

describe('expandPatterns', () => {
  it('should expand array of patterns', () => {
    const patterns = ['docs', 'src/**/*.ts', 'README.md'];
    const expanded = expandPatterns(patterns);

    expect(expanded).toEqual([
      '**/docs/**/*.{md,json}',
      '**/src/**/*.ts',
      '**/README.md/**/*.{md,json}',
    ]);
  });

  it('should handle empty array', () => {
    expect(expandPatterns([])).toEqual([]);
  });

  it('should handle mixed paths and patterns', () => {
    const patterns = ['docs', 'guides/', '**/*.schema.json', 'examples'];
    const expanded = expandPatterns(patterns);

    expect(expanded).toEqual([
      '**/docs/**/*.{md,json}',
      '**/guides/**/*.{md,json}',
      '**/*.schema.json',
      '**/examples/**/*.{md,json}',
    ]);
  });
});
