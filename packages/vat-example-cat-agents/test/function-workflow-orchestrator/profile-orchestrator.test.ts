import { describe, expect, it } from 'vitest';

import { createCatProfile, formatCatProfile } from '../../src/function-workflow-orchestrator/profile-orchestrator.js';

const ORANGE_CAT_JPG = 'orange-cat.jpg';
const TEST_CAT_JPG = 'test-cat.jpg';

describe('createCatProfile', () => {
  it('should create profile from photo', async () => {
    const profile = await createCatProfile({
      photo: 'orange-tabby-cat.jpg',
    });

    expect(profile.characteristics).toBeDefined();
    expect(profile.characteristics.physical.furColor).toBe('Orange');
    expect(profile.name).toBeDefined();
    expect(profile.nameValidation).toBeDefined();
    expect(profile.haiku).toBeDefined();
    expect(profile.haikuValidation).toBeDefined();
  });

  it('should create profile from description', async () => {
    const profile = await createCatProfile({
      description: 'A playful orange tabby cat with green eyes',
    });

    expect(profile.characteristics).toBeDefined();
    expect(profile.characteristics.physical.furColor).toBe('Orange');
    expect(profile.characteristics.physical.eyeColor).toBe('Green');
    expect(profile.name).toBeDefined();
    expect(profile.haiku).toBeDefined();
  });

  it('should throw error if neither photo nor description provided', async () => {
    await expect(
      createCatProfile({}),
    ).rejects.toThrow('Must provide either photo or description');
  });

  it('should track name generation attempts', async () => {
    const profile = await createCatProfile({
      photo: ORANGE_CAT_JPG,
    });

    expect(profile.attempts.nameAttempts).toBeGreaterThan(0);
    expect(profile.attempts.nameAttempts).toBeLessThanOrEqual(5);
  });

  it('should track haiku generation attempts', async () => {
    const profile = await createCatProfile({
      photo: 'black-cat.jpg',
    });

    expect(profile.attempts.haikuAttempts).toBeGreaterThan(0);
    expect(profile.attempts.haikuAttempts).toBeLessThanOrEqual(5);
  });

  it('should retry name generation until valid', async () => {
    const profile = await createCatProfile({
      photo: ORANGE_CAT_JPG,
    }, {
      maxNameAttempts: 10,
      acceptQuestionable: false,
    });

    // Should eventually get a valid name
    expect(profile.nameValidation.status).toBe('valid');
  });

  it('should accept questionable names if configured', async () => {
    const profile = await createCatProfile({
      photo: ORANGE_CAT_JPG,
    }, {
      maxNameAttempts: 10,
      acceptQuestionable: true,
    });

    // Should accept valid or questionable
    expect(['valid', 'questionable']).toContain(profile.nameValidation.status);
  });

  it('should retry haiku generation until valid', async () => {
    const profile = await createCatProfile({
      photo: ORANGE_CAT_JPG,
    }, {
      maxHaikuAttempts: 10,
    });

    // Should eventually get a valid haiku
    expect(profile.haikuValidation.valid).toBe(true);
    expect(profile.haikuValidation.syllables.line1).toBe(5);
    expect(profile.haikuValidation.syllables.line2).toBe(7);
    expect(profile.haikuValidation.syllables.line3).toBe(5);
  });

  it('should stop after max name attempts', async () => {
    const profile = await createCatProfile({
      photo: ORANGE_CAT_JPG,
    }, {
      maxNameAttempts: 3,
      acceptQuestionable: false,
    });

    expect(profile.attempts.nameAttempts).toBeLessThanOrEqual(3);
  });

  it('should stop after max haiku attempts', async () => {
    const profile = await createCatProfile({
      photo: ORANGE_CAT_JPG,
    }, {
      maxHaikuAttempts: 3,
    });

    expect(profile.attempts.haikuAttempts).toBeLessThanOrEqual(3);
  });

  it('should return last attempt if max reached without success', async () => {
    const profile = await createCatProfile({
      photo: ORANGE_CAT_JPG,
    }, {
      maxNameAttempts: 1,
      maxHaikuAttempts: 1,
      acceptQuestionable: false,
    });

    // Should have name and haiku even if not perfect
    expect(profile.name).toBeDefined();
    expect(profile.haiku).toBeDefined();
    expect(profile.attempts.nameAttempts).toBe(1);
    expect(profile.attempts.haikuAttempts).toBe(1);
  });

  it('should generate different profiles for different inputs', async () => {
    const profile1 = await createCatProfile({
      photo: ORANGE_CAT_JPG,
    });

    const profile2 = await createCatProfile({
      photo: 'black-cat.jpg',
    });

    expect(profile1.characteristics.physical.furColor).not.toBe(
      profile2.characteristics.physical.furColor,
    );
  });

  it('should handle complex descriptions', async () => {
    const profile = await createCatProfile({
      description: 'A massive Maine Coon with orange tabby fur, green eyes, very lazy personality, loves boxes',
    });

    expect(profile.characteristics.physical.breed).toBe('Maine Coon');
    expect(profile.characteristics.physical.furColor).toBe('Orange');
    expect(profile.characteristics.behavioral.personality).toContain('Lazy');
    expect(profile.characteristics.behavioral.quirks).toContain('Loves sitting in boxes');
  });

  it('should prefer photo over description when both provided', async () => {
    const profile = await createCatProfile({
      photo: ORANGE_CAT_JPG,
      description: 'Black cat', // This should be ignored
    });

    // Should use photo analysis (orange) not description (black)
    expect(profile.characteristics.physical.furColor).toBe('Orange');
  });

  it('should handle cats with multiple personality traits', async () => {
    const profile = await createCatProfile({
      description: 'Playful, energetic, curious, and friendly orange kitten',
    });

    expect(profile.characteristics.behavioral.personality.length).toBeGreaterThan(1);
    expect(profile.characteristics.behavioral.personality).toContain('Playful');
  });

  it('should generate profile with all required fields', async () => {
    const profile = await createCatProfile({
      photo: TEST_CAT_JPG,
    });

    // Check all required fields exist
    expect(profile.characteristics).toBeDefined();
    expect(profile.characteristics.physical).toBeDefined();
    expect(profile.characteristics.behavioral).toBeDefined();
    expect(profile.characteristics.description).toBeDefined();
    expect(profile.name).toBeDefined();
    expect(profile.name.name).toBeDefined();
    expect(profile.name.reasoning).toBeDefined();
    expect(profile.nameValidation).toBeDefined();
    expect(profile.haiku).toBeDefined();
    expect(profile.haiku.line1).toBeDefined();
    expect(profile.haiku.line2).toBeDefined();
    expect(profile.haiku.line3).toBeDefined();
    expect(profile.haikuValidation).toBeDefined();
    expect(profile.attempts).toBeDefined();
    expect(profile.attempts.nameAttempts).toBeDefined();
    expect(profile.attempts.haikuAttempts).toBeDefined();
  });
});

describe('formatCatProfile', () => {
  it('should format complete profile', async () => {
    const profile = await createCatProfile({
      photo: 'orange-tabby.jpg',
    });

    const formatted = formatCatProfile(profile);

    expect(formatted).toContain('CAT PROFILE GENERATED');
    expect(formatted).toContain('CHARACTERISTICS');
    expect(formatted).toContain('SUGGESTED NAME');
    expect(formatted).toContain('COMMEMORATIVE HAIKU');
  });

  it('should include fur color in output', async () => {
    const profile = await createCatProfile({
      photo: ORANGE_CAT_JPG,
    });

    const formatted = formatCatProfile(profile);

    expect(formatted).toContain('Orange');
  });

  it('should include name and validation status', async () => {
    const profile = await createCatProfile({
      photo: TEST_CAT_JPG,
    });

    const formatted = formatCatProfile(profile);

    expect(formatted).toContain(profile.name.name);
    expect(formatted).toContain(profile.nameValidation.status.toUpperCase());
  });

  it('should include haiku lines', async () => {
    const profile = await createCatProfile({
      photo: TEST_CAT_JPG,
    });

    const formatted = formatCatProfile(profile);

    expect(formatted).toContain(profile.haiku.line1);
    expect(formatted).toContain(profile.haiku.line2);
    expect(formatted).toContain(profile.haiku.line3);
  });

  it('should show syllable counts', async () => {
    const profile = await createCatProfile({
      photo: TEST_CAT_JPG,
    });

    const formatted = formatCatProfile(profile);

    expect(formatted).toContain('Syllables:');
    // Simplified regex to avoid backtracking issues
    expect(formatted).toMatch(/\d-\d-\d/);
  });

  it('should show attempt counts', async () => {
    const profile = await createCatProfile({
      photo: TEST_CAT_JPG,
    });

    const formatted = formatCatProfile(profile);

    expect(formatted).toContain('attempt');
    expect(formatted).toContain(String(profile.attempts.nameAttempts));
    expect(formatted).toContain(String(profile.attempts.haikuAttempts));
  });

  it('should indicate valid haiku', async () => {
    const profile = await createCatProfile({
      photo: TEST_CAT_JPG,
    }, {
      maxHaikuAttempts: 10,
    });

    const formatted = formatCatProfile(profile);

    if (profile.haikuValidation.valid) {
      expect(formatted).toContain('YES ✓');
    } else {
      expect(formatted).toContain('NO ✗');
    }
  });

  it('should show haiku errors if invalid', async () => {
    const profile = await createCatProfile({
      photo: TEST_CAT_JPG,
    }, {
      maxHaikuAttempts: 1,
    });

    const formatted = formatCatProfile(profile);

    if (!profile.haikuValidation.valid) {
      expect(formatted).toContain('Errors:');
    }
  });

  it('should include personality traits', async () => {
    const profile = await createCatProfile({
      description: 'Playful orange cat',
    });

    const formatted = formatCatProfile(profile);

    expect(formatted).toContain('Personality:');
    expect(formatted).toContain('Playful');
  });

  it('should include breed if present', async () => {
    const profile = await createCatProfile({
      photo: 'maine-coon-cat.jpg',
    });

    const formatted = formatCatProfile(profile);

    if (profile.characteristics.physical.breed) {
      expect(formatted).toContain('Breed:');
      expect(formatted).toContain(profile.characteristics.physical.breed);
    }
  });

  it('should include quirks if present', async () => {
    const profile = await createCatProfile({
      description: 'Cat who loves boxes',
    });

    const formatted = formatCatProfile(profile);

    if (profile.characteristics.behavioral.quirks) {
      expect(formatted).toContain('Quirks:');
    }
  });
});
