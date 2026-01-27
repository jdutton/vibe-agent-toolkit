import { describe, expect, it } from 'vitest';

import { nameGeneratorAgent } from '../../src/one-shot-llm-analyzer/name-generator.js';
import { createTestCat, expectAgentSuccess } from '../test-helpers.js';

describe('nameGeneratorAgent', () => {
  it('should have correct manifest', () => {
    expect(nameGeneratorAgent.name).toBe('name-generator');
    expect(nameGeneratorAgent.manifest.name).toBe('name-generator');
    expect(nameGeneratorAgent.manifest.description).toBe(
      'Generates creative name suggestions based on cat characteristics',
    );
    expect(nameGeneratorAgent.manifest.version).toBe('1.0.0');
    expect(nameGeneratorAgent.manifest.archetype).toBe('one-shot-llm-analyzer');
  });

  it('should generate name for orange tabby via agent.execute() in mock mode', async () => {
    const characteristics = createTestCat({
      furColor: 'Orange',
      furPattern: 'Tabby',
      personality: ['Playful', 'Energetic'],
      description: 'A large orange tabby cat',
    });

    const data = await expectAgentSuccess(
      nameGeneratorAgent,
      { characteristics },
      expect,
    );

    expect(data.name).toBeTruthy();
    expect(data.reasoning).toBeTruthy();
    expect(data.alternatives).toBeDefined();
    if (data.alternatives) {
      expect(data.alternatives.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('should generate name for black cat via agent.execute() in mock mode', async () => {
    const characteristics = createTestCat({
      furColor: 'Black',
      size: 'medium',
      personality: ['Mysterious', 'Independent'],
      description: 'A mysterious black cat',
    });

    const data = await expectAgentSuccess(
      nameGeneratorAgent,
      { characteristics, mockable: true },
      expect,
    );

    expect(data.name).toBeTruthy();
    expect(data.reasoning).toContain('black');
  });

  it('should generate name for white persian via agent.execute() in mock mode', async () => {
    const characteristics = createTestCat({
      furColor: 'White',
      breed: 'Persian',
      size: 'small',
      personality: ['Calm', 'Graceful'],
      description: 'A calm white Persian cat',
    });

    const data = await expectAgentSuccess(
      nameGeneratorAgent,
      { characteristics },
      expect,
    );

    expect(data.name).toBeTruthy();
    expect(data.reasoning).toBeTruthy();
  });
});
