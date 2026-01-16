import { describe, expect, it } from 'vitest';

import { generateName } from '../../src/one-shot-llm-analyzer/name-generator.js';
import type { CatCharacteristics } from '../../src/types/schemas.js';
import { TEST_CATS } from '../test-helpers.js';

describe('generateName', () => {
  const orangeCat = TEST_CATS.orange;
  const blackCat = TEST_CATS.black;
  const lazyCat = TEST_CATS.lazy;

  it('should generate name suggestion', async () => {
    const result = await generateName(orangeCat);

    expect(result.name).toBeTruthy();
    expect(result.reasoning).toBeTruthy();
    expect(typeof result.name).toBe('string');
    expect(typeof result.reasoning).toBe('string');
  });

  it('should include alternatives', async () => {
    const result = await generateName(orangeCat);

    expect(result.alternatives).toBeDefined();
    expect(Array.isArray(result.alternatives)).toBe(true);
  });

  it('should generate safe names with safe strategy', async () => {
    const result = await generateName(orangeCat, { strategy: 'safe' });

    // Safe names should contain noble titles
    const nobleTitles = ['Sir', 'Lady', 'Lord', 'Duke', 'Duchess', 'Baron', 'Baroness', 'Count', 'Countess'];
    const hasNobleTitle = nobleTitles.some((title) => result.name.includes(title));
    expect(hasNobleTitle).toBe(true);
  });

  it('should generate risky names with risky strategy', async () => {
    const result = await generateName(orangeCat, { strategy: 'risky' });

    // Risky names should NOT contain noble titles (or rarely)
    const nobleTitles = ['Sir', 'Lady', 'Lord', 'Duke', 'Duchess', 'Baron', 'Baroness', 'Count', 'Countess'];
    const hasNobleTitle = nobleTitles.some((title) => result.name.includes(title));

    // If it does have a noble title, it should be combined with something questionable
    if (hasNobleTitle) {
      // Should still be risky in some way (e.g., "Sir Knocksalot")
      expect(result.name.length).toBeGreaterThan(5);
    }

    expect(result.reasoning).toBeTruthy();
  });

  it('should generate different names on multiple calls', async () => {
    const names = new Set<string>();

    // Generate 10 names and expect at least some variety
    for (let index = 0; index < 10; index++) {
      const result = await generateName(orangeCat, { strategy: 'mixed' });
      names.add(result.name);
    }

    // Should have generated at least 3 different names out of 10
    expect(names.size).toBeGreaterThan(2);
  });

  it('should consider cat color in reasoning', async () => {
    // Try more times since the generator might produce quirky names without color references
    let foundColorReference = false;

    for (let index = 0; index < 20; index++) {
      const result = await generateName(orangeCat);

      const colorRegex = /orange|color|fur|ginger|amber|copper|appearance/;
      if (colorRegex.exec(result.reasoning.toLowerCase())) {
        foundColorReference = true;
        break;
      }
    }

    // Should reference color/appearance in at least some names out of 20
    expect(foundColorReference).toBe(true);
  });

  it('should consider personality in reasoning', async () => {
    // Try a few times since the generator might produce various names
    let foundPersonalityReference = false;

    for (let index = 0; index < 10; index++) {
      const result = await generateName(lazyCat);

      const personalityRegex = /lazy|relax|personality|sleep|nap|rest/;
      if (personalityRegex.exec(result.reasoning.toLowerCase())) {
        foundPersonalityReference = true;
        break;
      }
    }

    // Should reference personality traits in at least some names
    expect(foundPersonalityReference).toBe(true);
  });

  it('should generate appropriate names for black cats', async () => {
    // Generate multiple names and check if at least one is color-appropriate
    let hasColorAppropriateName = false;

    for (let index = 0; index < 5; index++) {
      const result = await generateName(blackCat, { strategy: 'safe' });
      const colorWords = ['midnight', 'shadow', 'noir', 'obsidian', 'black'];

      if (colorWords.some((word) => result.name.toLowerCase().includes(word))) {
        hasColorAppropriateName = true;
        break;
      }
    }

    // At least some attempts should generate color-appropriate names
    // (may not always happen due to randomness, but should be likely)
    expect(hasColorAppropriateName).toBe(true);
  });

  it('should handle cats with quirks', async () => {
    const quirkyCat: CatCharacteristics = {
      physical: {
        furColor: 'Orange',
        size: 'medium',
      },
      behavioral: {
        personality: ['Mischievous'],
        quirks: ['Knocks things off tables'],
      },
      description: 'A mischievous cat who knocks things off tables',
    };

    const result = await generateName(quirkyCat, { strategy: 'risky' });

    expect(result.name).toBeTruthy();
    expect(result.reasoning).toBeTruthy();
  });

  it('should throw error if mockable is false', async () => {
    await expect(
      generateName(orangeCat, { mockable: false }),
    ).rejects.toThrow('Real LLM name generation not implemented yet');
  });

  it('should generate some common names with risky strategy', async () => {
    // Test that risky strategy can generate forbidden names
    let foundCommonName = false;

    for (let index = 0; index < 20; index++) {
      const result = await generateName(orangeCat, { strategy: 'risky' });
      const commonNames = ['Fluffy', 'Mittens', 'Kitty', 'Whiskers', 'Muffin', 'Cupcake', 'Bob'];

      if (commonNames.some((name) => result.name.includes(name))) {
        foundCommonName = true;
        break;
      }
    }

    // Should find at least one common/risky name in 20 attempts
    expect(foundCommonName).toBe(true);
  });

  it('should provide useful reasoning for safe names', async () => {
    const result = await generateName(orangeCat, { strategy: 'safe' });

    // Reasoning should mention why the name is appropriate
    expect(result.reasoning.length).toBeGreaterThan(20);
    expect(result.reasoning).toMatch(/given|because|appropriate|fitt?ing|befitt?ing/i);
  });
});
