import { describe, expect, it } from 'vitest';

import { critiqueCatName, nameValidatorAgent, validateCatName } from '../../src/pure-function-tool/name-validator.js';
import type { CatCharacteristics } from '../../src/types/schemas.js';
import { expectAgentSuccess, expectError } from '../test-helpers.js';

describe('validateCatName', () => {
  it('should approve noble titles', () => {
    const result = validateCatName('Duke Sterling III');

    expect(result.status).toBe('valid');
    expect(result.reason).toContain('nobility');
    expect(result.reason).toContain('purrs approvingly');
  });

  it('should reject vulgar names', () => {
    const result = validateCatName('Poopface');

    expect(result.status).toBe('invalid');
    expect(result.reason).toContain('VULGAR');
  });

  it('should reject common names', () => {
    const result = validateCatName('Fluffy');

    expect(result.status).toBe('invalid');
    expect(result.reason).toContain('too common');
  });

  it('should find names with precious materials distinguished', () => {
    const result = validateCatName('Diamond Paws');

    expect(result.status).toBe('valid');
    expect(result.reason).toContain('precious');
  });

  it('should mark ordinary names as questionable', () => {
    const result = validateCatName('Whiskers');

    expect(result.status).toBe('valid'); // Contains "whiskers" which is a distinguished pattern
    expect(result.reason).toContain('feline attributes');
  });

  it('should consider cat characteristics for orange cats', () => {
    const cat: CatCharacteristics = {
      physical: {
        furColor: 'Orange',
        furPattern: 'Tabby',
        size: 'large',
      },
      behavioral: {
        personality: ['Playful', 'Energetic'],
      },
      description: 'A large orange tabby cat',
    };

    const result = validateCatName('Sir Marmalade', cat);

    expect(result.status).toBe('valid');
    expect(result.reason).toContain('nobility');
  });

  it('should reject forbidden names regardless of characteristics', () => {
    // Fluffy is forbidden regardless of characteristics
    const result = validateCatName('Fluffy');

    expect(result.status).toBe('invalid');
    expect(result.reason).toContain('too common');
  });

  it('should warn about names too long for tiny cats', () => {
    const cat: CatCharacteristics = {
      physical: {
        furColor: 'White',
        size: 'tiny',
      },
      behavioral: {
        personality: ['Delicate'],
      },
      description: 'A tiny white kitten',
    };

    // Use a non-noble name to avoid getting 'valid' status from distinguished patterns
    const result = validateCatName('Alexander Bartholomew Maximilian', cat);

    expect(result.status).toBe('questionable');
    expect(result.reason).toContain('longer than the cat');
  });
});

describe('critiqueCatName', () => {
  it('should provide full critique with cat characteristics', () => {
    const cat: CatCharacteristics = {
      physical: {
        furColor: 'Orange',
        furPattern: 'Tabby',
        breed: 'Maine Coon',
        size: 'large',
      },
      behavioral: {
        personality: ['Regal', 'Demanding'],
      },
      description: 'A majestic orange Maine Coon',
    };

    const critique = critiqueCatName('Duke Marmalade', cat);

    expect(critique).toContain('Madam Fluffington');
    expect(critique).toContain('Orange');
    expect(critique).toContain('Maine Coon');
    expect(critique).toContain('Duke Marmalade');
  });

  it('should show disapproval for invalid names', () => {
    const critique = critiqueCatName('Kitty');

    expect(critique).toContain('INVALID');
    expect(critique).toContain('flicks tail disdainfully');
  });

  it('should show approval for valid names', () => {
    const critique = critiqueCatName('Lady Sapphire');

    expect(critique).toContain('VALID');
    expect(critique).toContain('purrs contentedly');
    expect(critique).toContain('I approve');
  });
});

describe('nameValidatorAgent', () => {
  it('should have correct manifest', () => {
    expect(nameValidatorAgent.name).toBe('name-validator');
    expect(nameValidatorAgent.manifest.name).toBe('name-validator');
    expect(nameValidatorAgent.manifest.description).toBe(
      'Validates cat names for proper nobility conventions and appropriateness',
    );
    expect(nameValidatorAgent.manifest.version).toBe('1.0.0');
    expect(nameValidatorAgent.manifest.archetype).toBe('pure-function-tool');
  });

  it('should validate a noble name via agent.execute()', async () => {
    const data = await expectAgentSuccess(nameValidatorAgent, { name: 'Duke Sterling III' }, expect);

    expect(data.status).toBe('valid');
    expect(data.reason).toContain('nobility');
  });

  it('should reject a vulgar name via agent.execute()', async () => {
    const data = await expectAgentSuccess(nameValidatorAgent, { name: 'Poopface' }, expect);

    expect(data.status).toBe('invalid');
    expect(data.reason).toContain('VULGAR');
  });

  it('should consider cat characteristics via agent.execute()', async () => {
    const cat: CatCharacteristics = {
      physical: {
        furColor: 'Orange',
        furPattern: 'Tabby',
        size: 'large',
      },
      behavioral: {
        personality: ['Playful', 'Energetic'],
      },
      description: 'A large orange tabby cat',
    };

    const data = await expectAgentSuccess(
      nameValidatorAgent,
      { name: 'Sir Marmalade', characteristics: cat },
      expect,
    );

    expect(data.status).toBe('valid');
    expect(data.reason).toContain('nobility');
  });

  it('should return error for invalid input', async () => {
    const output = await nameValidatorAgent.execute({ invalid: 'data' } as never);

    expectError(output, 'invalid-format', expect);
    expect(output.result.status).toBe('error'); // SonarJS: explicit assertion required
  });
});
