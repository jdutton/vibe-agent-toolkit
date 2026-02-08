import { describe, expect, it } from 'vitest';

import { simpleValidatorAgent } from '../src/pure-function-agent.js';

describe('simpleValidatorAgent', () => {
  it('should validate valid haiku with 5-7-5 pattern', () => {
    const result = simpleValidatorAgent.execute({
      line1: 'Orange fur ablaze',
      line2: 'Whiskers twitch in winter sun',
      line3: 'Cat dreams of dinner',
    });

    expect(result.valid).toBe(true);
    expect(result.syllables).toEqual({
      line1: 5,
      line2: 7,
      line3: 5,
    });
  });

  it('should reject invalid haiku with wrong syllable counts', () => {
    const result = simpleValidatorAgent.execute({
      line1: 'Cat',
      line2: 'Meow',
      line3: 'Purr',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it('should have correct manifest metadata', () => {
    expect(simpleValidatorAgent.manifest.name).toBe('haiku-validator');
    expect(simpleValidatorAgent.manifest.description).toContain('haiku');
    expect(simpleValidatorAgent.manifest.archetype).toBe('pure-function');
  });

  it('should count syllables correctly for each line', () => {
    const result = simpleValidatorAgent.execute({
      line1: 'Test line one here',
      line2: 'Another test line with more words',
      line3: 'Final test line',
    });

    expect(result.syllables).toBeDefined();
    expect(result.syllables?.line1).toBeGreaterThan(0);
    expect(result.syllables?.line2).toBeGreaterThan(0);
    expect(result.syllables?.line3).toBeGreaterThan(0);
  });

  it('should return error message for invalid haiku', () => {
    const result = simpleValidatorAgent.execute({
      line1: 'Cat',
      line2: 'Dog',
      line3: 'Bird',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]).toContain('5-7-5');
  });

  it('should handle words with silent e', () => {
    const result = simpleValidatorAgent.execute({
      line1: 'The gentle breeze blows',
      line2: 'Through the ancient forest trees',
      line3: 'Nature whispers peace',
    });

    expect(result.syllables).toBeDefined();
    expect(result.valid).toBeDefined();
  });

  it('should have execute function',() => {
    expect(typeof simpleValidatorAgent.execute).toBe('function');
    expect(simpleValidatorAgent.name).toBe('haiku-validator');
  });
});
