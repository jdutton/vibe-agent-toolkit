/**
 * Simple schemas for test agents
 *
 * These are intentionally minimal to focus on testing runtime adapter functionality
 * rather than complex domain logic.
 */

import { z } from 'zod';

/**
 * Input for simple name generator
 */
export const SimpleNameInputSchema = z.object({
  adjective: z.string().describe('An adjective to describe the subject'),
  noun: z.string().describe('A noun representing the subject'),
});

export type SimpleNameInput = z.infer<typeof SimpleNameInputSchema>;

/**
 * Output from simple name generator
 */
export const SimpleNameOutputSchema = z.object({
  name: z.string().describe('Generated name combining the inputs'),
  reasoning: z.string().describe('Brief explanation of the name choice'),
});

export type SimpleNameOutput = z.infer<typeof SimpleNameOutputSchema>;

/**
 * Input for simple validator (pure function) - haiku format for testing
 */
export const SimpleValidationInputSchema = z.object({
  line1: z.string().describe('First line of haiku'),
  line2: z.string().describe('Second line of haiku'),
  line3: z.string().describe('Third line of haiku'),
});

export type SimpleValidationInput = z.infer<typeof SimpleValidationInputSchema>;

/**
 * Output from simple validator - haiku validation result
 */
export const SimpleValidationOutputSchema = z.object({
  valid: z.boolean().describe('Whether the haiku passes validation'),
  syllables: z
    .object({
      line1: z.number().describe('Syllable count for line 1'),
      line2: z.number().describe('Syllable count for line 2'),
      line3: z.number().describe('Syllable count for line 3'),
    })
    .optional()
    .describe('Syllable counts for each line'),
  errors: z.array(z.unknown()).optional().describe('Validation errors if any'),
});

export type SimpleValidationOutput = z.infer<typeof SimpleValidationOutputSchema>;
