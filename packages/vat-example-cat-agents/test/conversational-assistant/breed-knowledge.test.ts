import { describe, expect, it } from 'vitest';

import { BREED_DATABASE, type BreedProfile } from '../../src/conversational-assistant/breed-knowledge.js';

describe('BREED_DATABASE', () => {
  it('should contain at least 10 breeds', () => {
    expect(BREED_DATABASE.length).toBeGreaterThanOrEqual(10);
  });

  it('should have all required fields for each breed', () => {
    for (const breed of BREED_DATABASE) {
      expect(breed.name).toBeDefined();
      expect(breed.traits).toBeDefined();
      expect(breed.traits.activityLevel).toBeInstanceOf(Array);
      expect(breed.traits.groomingNeeds).toBeDefined();
      expect(breed.traits.musicAlignment).toBeInstanceOf(Array);
      expect(breed.traits.temperament).toBeDefined();
    }
  });

  it('should have Persian for classical music', () => {
    const persian = BREED_DATABASE.find((b: BreedProfile) => b.name === 'Persian');
    expect(persian).toBeDefined();
    expect(persian?.traits.musicAlignment).toContain('classical');
  });

  it('should have hypoallergenic breeds', () => {
    const hypoallergenic = BREED_DATABASE.filter((b: BreedProfile) => b.traits.hypoallergenic);
    expect(hypoallergenic.length).toBeGreaterThan(0);
  });
});
