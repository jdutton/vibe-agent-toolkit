import { describe, expect, it } from 'vitest';

import { critiqueHaiku, haikuValidatorAgent, validateHaiku, type Haiku } from '../../src/pure-function-tool/haiku-validator.js';

const VALID_LINE1 = 'Autumn moon rises';
const VALID_LINE2 = 'Silver light on quiet waves';
const VALID_LINE3 = 'The cat sits and waits';

function createValidHaiku(): Haiku {
  return {
    line1: VALID_LINE1,
    line2: VALID_LINE2,
    line3: VALID_LINE3,
  };
}

function expectValidHaikuResult(result: ReturnType<typeof validateHaiku>): void {
  expect(result.valid).toBe(true);
  expect(result.syllables).toEqual({
    line1: 5,
    line2: 7,
    line3: 5,
  });
  expect(result.errors).toHaveLength(0);
  expect(result.hasKigo).toBe(true);
}

describe('validateHaiku', () => {
  it('should validate a correct haiku', () => {
    const haiku = createValidHaiku();
    const result = validateHaiku(haiku);
    expectValidHaikuResult(result);
  });

  it('should detect incorrect syllable count', () => {
    const haiku: Haiku = {
      line1: 'The big cat',
      line2: VALID_LINE2,
      line3: VALID_LINE3,
    };

    const result = validateHaiku(haiku);

    expect(result.valid).toBe(false);
    expect(result.syllables.line1).toBe(3);
    expect(result.errors).toContain('Line 1 has 3 syllables, expected 5');
  });

  it('should detect missing kigo', () => {
    const haiku: Haiku = {
      line1: 'A cat walks by',
      line2: 'Padding softly on the floor',
      line3: 'Then sits and stares',
    };

    const result = validateHaiku(haiku);

    expect(result.hasKigo).toBe(false);
  });

  it('should detect kireji', () => {
    const haiku: Haiku = {
      line1: 'Winter wind howls—',
      line2: 'The old cat curls up tighter',
      line3: 'Dreams of warmer days',
    };

    const result = validateHaiku(haiku);

    expect(result.hasKireji).toBe(true);
  });
});

describe('critiqueHaiku', () => {
  it('should provide encouraging critique for valid haiku', () => {
    const haiku: Haiku = {
      line1: 'The old winter pond',
      line2: 'A frog jumps into water',
      line3: 'Splash then silence—cold',
    };

    const critique = critiqueHaiku(haiku);

    expect(critique).toContain('Professor Whiskers');
    expect(critique).toContain('IMPECCABLE');
    expect(critique).toContain('5-7-5');
    expect(critique).toContain('You may proceed');
  });

  it('should provide harsh critique for invalid syllable structure', () => {
    const haiku: Haiku = {
      line1: 'Cat',
      line2: 'Sits',
      line3: 'There',
    };

    const critique = critiqueHaiku(haiku);

    expect(critique).toContain('UNACCEPTABLE');
    expect(critique).toContain('REVISION');
    expect(critique).toContain('syllable structure');
  });
});

describe('haikuValidatorAgent', () => {
  it('should have correct manifest', () => {
    expect(haikuValidatorAgent.name).toBe('haiku-validator');
    expect(haikuValidatorAgent.manifest.name).toBe('haiku-validator');
    expect(haikuValidatorAgent.manifest.description).toBe(
      'Validates haiku syllable structure and traditional elements',
    );
    expect(haikuValidatorAgent.manifest.version).toBe('1.0.0');
    expect(haikuValidatorAgent.manifest.archetype).toBe('pure-function');
    expect(haikuValidatorAgent.manifest.inputSchema).toBeDefined();
    expect(haikuValidatorAgent.manifest.outputSchema).toBeDefined();
    expect(haikuValidatorAgent.manifest.metadata).toEqual({
      author: 'Professor Whiskers',
      strict: true,
      checks: ['syllables', 'kigo', 'kireji'],
    });
  });

  it('should validate a correct haiku via agent.execute()', () => {
    const haiku = createValidHaiku();
    const result = haikuValidatorAgent.execute(haiku);
    expectValidHaikuResult(result);
  });

  it('should detect incorrect syllable count via agent.execute()', () => {
    const haiku: Haiku = {
      line1: 'The big cat',
      line2: VALID_LINE2,
      line3: VALID_LINE3,
    };

    const result = haikuValidatorAgent.execute(haiku);

    expect(result.valid).toBe(false);
    expect(result.syllables.line1).toBe(3);
    expect(result.errors).toContain('Line 1 has 3 syllables, expected 5');
  });

  it('should throw error for invalid input', () => {
    expect(() => haikuValidatorAgent.execute({ line1: 'test' } as never)).toThrow(
      'Invalid input for agent "haiku-validator"',
    );
  });
});
