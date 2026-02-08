import { describe, expect, it } from 'vitest';

import {
  SimpleNameInputSchema,
  SimpleNameOutputSchema,
  SimpleValidationInputSchema,
  SimpleValidationOutputSchema,
} from '../src/schemas.js';

describe('Test Agent Schemas', () => {
  describe('SimpleNameInputSchema', () => {
    it('should validate correct input', () => {
      const result = SimpleNameInputSchema.safeParse({
        adjective: 'Swift',
        noun: 'River',
      });

      expect(result.success).toBe(true);
    });

    it('should reject missing fields', () => {
      const result = SimpleNameInputSchema.safeParse({
        adjective: 'Swift',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('SimpleNameOutputSchema', () => {
    it('should validate correct output', () => {
      const result = SimpleNameOutputSchema.safeParse({
        name: 'Rivermist',
        reasoning: 'Combines swift and river',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('SimpleValidationInputSchema', () => {
    it('should validate correct haiku input', () => {
      const result = SimpleValidationInputSchema.safeParse({
        line1: 'Orange fur ablaze',
        line2: 'Whiskers twitch in winter sun',
        line3: 'Cat dreams of dinner',
      });

      expect(result.success).toBe(true);
    });

    it('should reject missing lines', () => {
      const result = SimpleValidationInputSchema.safeParse({
        line1: 'Only one line',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('SimpleValidationOutputSchema', () => {
    it('should validate output with syllables', () => {
      const result = SimpleValidationOutputSchema.safeParse({
        valid: true,
        syllables: {
          line1: 5,
          line2: 7,
          line3: 5,
        },
      });

      expect(result.success).toBe(true);
    });

    it('should validate output without optional fields', () => {
      const result = SimpleValidationOutputSchema.safeParse({
        valid: false,
      });

      expect(result.success).toBe(true);
    });
  });
});
