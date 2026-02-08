/**
 * Simple Pure Function Agent for Testing
 *
 * A minimal pure function agent that validates text length.
 * Used to test runtime adapters' pure function conversion.
 */

import { definePureFunction } from '@vibe-agent-toolkit/agent-runtime';

import type { SimpleValidationInput, SimpleValidationOutput } from './schemas.js';
import { SimpleValidationInputSchema, SimpleValidationOutputSchema } from './schemas.js';

/**
 * Simple text validator - pure function with no external dependencies
 */
export const simpleValidatorAgent = definePureFunction(
  {
    name: 'haiku-validator',
    description: 'Validates haiku syllable patterns',
    version: '1.0.0',
    inputSchema: SimpleValidationInputSchema,
    outputSchema: SimpleValidationOutputSchema,
  },
  (input: SimpleValidationInput): SimpleValidationOutput => {
    const { line1, line2, line3 } = input;

    // Improved syllable counting for common English patterns
    const countSyllables = (text: string): number => {
      const word = text.toLowerCase().trim();
      if (word.length <= 3) return 1;

      // Remove silent e
      const normalized = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
      // Split into syllables based on vowel groups
      const syllables = normalized.match(/[aeiouy]{1,2}/g);
      return syllables ? syllables.length : 1;
    };

    // Count syllables for each word in each line
    const countLine = (line: string): number => {
      return line
        .split(/\s+/)
        .map((word) => countSyllables(word))
        .reduce((sum, count) => sum + count, 0);
    };

    const syllables = {
      line1: countLine(line1),
      line2: countLine(line2),
      line3: countLine(line3),
    };

    // Valid haiku: 5-7-5 syllable pattern
    const valid = syllables.line1 === 5 && syllables.line2 === 7 && syllables.line3 === 5;

    return {
      valid,
      syllables,
      ...(valid ? {} : { errors: ['Invalid haiku syllable pattern (expected 5-7-5)'] }),
    };
  },
);

export type SimpleValidatorAgent = typeof simpleValidatorAgent;
