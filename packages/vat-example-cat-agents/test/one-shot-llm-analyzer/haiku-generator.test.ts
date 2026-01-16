import { describe, expect, it } from 'vitest';

import { generateHaiku } from '../../src/one-shot-llm-analyzer/haiku-generator.js';
import { validateHaiku } from '../../src/pure-function-tool/haiku-validator.js';
import { findHaikuWithKeywords, findInvalidSyllableLine, TEST_CATS } from '../test-helpers.js';

describe('generateHaiku', () => {
  const orangeCat = TEST_CATS.orange;
  const blackCat = TEST_CATS.black;
  const lazyCat = TEST_CATS.lazy;

  it('should generate haiku with three lines', async () => {
    const result = await generateHaiku(orangeCat);

    expect(result.line1).toBeTruthy();
    expect(result.line2).toBeTruthy();
    expect(result.line3).toBeTruthy();
    expect(typeof result.line1).toBe('string');
    expect(typeof result.line2).toBe('string');
    expect(typeof result.line3).toBe('string');
  });

  it('should generate valid haiku with valid strategy', async () => {
    // Try a few times since syllable counting can occasionally be off
    let foundValid = false;

    for (let index = 0; index < 5; index++) {
      const result = await generateHaiku(orangeCat, { strategy: 'valid' });
      const validation = validateHaiku(result);

      if (validation.valid) {
        expect(validation.syllables.line1).toBe(5);
        expect(validation.syllables.line2).toBe(7);
        expect(validation.syllables.line3).toBe(5);
        foundValid = true;
        break;
      }
    }

    // Should get at least one valid haiku in 5 attempts
    expect(foundValid).toBe(true);
  });

  it('should generate invalid haiku with invalid strategy', async () => {
    const result = await generateHaiku(orangeCat, { strategy: 'invalid' });
    const validation = validateHaiku(result);

    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  it('should generate mix of valid and invalid with mixed strategy', async () => {
    const results: boolean[] = [];

    // Generate 10 haikus
    for (let index = 0; index < 10; index++) {
      const haiku = await generateHaiku(orangeCat, { strategy: 'mixed' });
      const validation = validateHaiku(haiku);
      results.push(validation.valid);
    }

    // Should have both valid and invalid results
    const validCount = results.filter((v) => v).length;
    const invalidCount = results.filter((v) => !v).length;

    expect(validCount).toBeGreaterThan(0);
    expect(invalidCount).toBeGreaterThan(0);
  });

  it('should generate different haikus on multiple calls', async () => {
    const haikus = new Set<string>();

    for (let index = 0; index < 10; index++) {
      const result = await generateHaiku(orangeCat, { strategy: 'valid' });
      haikus.add(`${result.line1}|${result.line2}|${result.line3}`);
    }

    // Should have some variety
    expect(haikus.size).toBeGreaterThan(1);
  });

  it('should consider cat color in haiku content', async () => {
    const mentionsColor = await findHaikuWithKeywords(
      () => generateHaiku(orangeCat, { strategy: 'valid' }),
      ['orange', 'ginger', 'marmalade'],
    );

    // At least some haikus should reference the color
    expect(mentionsColor).toBe(true);
  });

  it('should generate appropriate haiku for black cats', async () => {
    const hasBlackCatTheme = await findHaikuWithKeywords(
      () => generateHaiku(blackCat, { strategy: 'valid' }),
      ['black', 'midnight', 'shadow', 'dark'],
    );

    expect(hasBlackCatTheme).toBe(true);
  });

  it('should generate appropriate haiku for lazy cats', async () => {
    const hasLazyTheme = await findHaikuWithKeywords(
      () => generateHaiku(lazyCat, { strategy: 'valid' }),
      ['sleep', 'nap', 'rest', 'couch', 'lazy'],
    );

    expect(hasLazyTheme).toBe(true);
  });

  it('should include seasonal references in some haikus', async () => {
    let hasSeasonal = false;

    // Try more attempts since it's probabilistic
    for (let index = 0; index < 30; index++) {
      const result = await generateHaiku(orangeCat, { strategy: 'valid' });
      const validation = validateHaiku(result);

      if (validation.hasKigo) {
        hasSeasonal = true;
        break;
      }
    }

    // At least some valid haikus should have seasonal references
    // (with 30 attempts, probability of at least one is very high)
    expect(hasSeasonal).toBe(true);
  });

  it('should generate haikus with cutting words', async () => {
    let hasKireji = false;

    // Try more attempts since it's probabilistic
    for (let index = 0; index < 30; index++) {
      const result = await generateHaiku(orangeCat, { strategy: 'valid' });
      const validation = validateHaiku(result);

      if (validation.hasKireji) {
        hasKireji = true;
        break;
      }
    }

    // At least some haikus should have cutting words
    // (with 30 attempts, probability of at least one is very high)
    expect(hasKireji).toBe(true);
  });

  it('should generate invalid haiku with wrong syllable count in line 1', async () => {
    const found = await findInvalidSyllableLine(
      () => generateHaiku(orangeCat, { strategy: 'invalid' }),
      validateHaiku,
      1,
      5,
    );
    expect(found).toBe(true);
  });

  it('should generate invalid haiku with wrong syllable count in line 2', async () => {
    const found = await findInvalidSyllableLine(
      () => generateHaiku(orangeCat, { strategy: 'invalid' }),
      validateHaiku,
      2,
      7,
    );
    expect(found).toBe(true);
  });

  it('should generate invalid haiku with wrong syllable count in line 3', async () => {
    const found = await findInvalidSyllableLine(
      () => generateHaiku(orangeCat, { strategy: 'invalid' }),
      validateHaiku,
      3,
      5,
    );
    expect(found).toBe(true);
  });

  it('should throw error if mockable is false', async () => {
    await expect(
      generateHaiku(orangeCat, { mockable: false }),
    ).rejects.toThrow('Real LLM haiku generation not implemented yet');
  });

  it('should generate cat-themed content', async () => {
    const catWords = [
      'cat', 'paw', 'whisker', 'fur', 'tail', 'meow', 'purr',
      'hunt', 'stalk', 'nap', 'sleep', 'box', 'window', 'bird',
      'shadow', 'silent', 'watch', 'wait',
    ];

    const foundCatTheme = await findHaikuWithKeywords(
      () => generateHaiku(orangeCat, { strategy: 'valid' }),
      catWords,
    );

    expect(foundCatTheme).toBe(true);
  });
});
