import { describe, expect, it } from 'vitest';

import { haikuGeneratorAgent } from '../../src/one-shot-llm-analyzer/haiku-generator.js';
import { createTestCat, expectAgentSuccess } from '../test-helpers.js';

describe('haikuGeneratorAgent', () => {
  it('should have correct manifest', () => {
    expect(haikuGeneratorAgent.name).toBe('haiku-generator');
    expect(haikuGeneratorAgent.manifest.name).toBe('haiku-generator');
    expect(haikuGeneratorAgent.manifest.description).toBe(
      'Generates contemplative haikus about cats based on their characteristics',
    );
    expect(haikuGeneratorAgent.manifest.version).toBe('1.0.0');
    expect(haikuGeneratorAgent.manifest.archetype).toBe('one-shot-llm-analyzer');
  });

  it('should generate haiku for orange tabby via agent.execute() in mock mode', async () => {
    const characteristics = createTestCat({
      furColor: 'Orange',
      furPattern: 'Tabby',
      personality: ['Playful', 'Energetic'],
      description: 'A large orange tabby cat',
    });

    const data = await expectAgentSuccess(
      haikuGeneratorAgent,
      { characteristics },
      expect,
    );

    expect(data.line1).toBeTruthy();
    expect(data.line2).toBeTruthy();
    expect(data.line3).toBeTruthy();
  });

  it('should generate haiku for black cat via agent.execute() in mock mode', async () => {
    const characteristics = createTestCat({
      furColor: 'Black',
      size: 'medium',
      personality: ['Mysterious', 'Independent'],
      description: 'A mysterious black cat',
    });

    const data = await expectAgentSuccess(
      haikuGeneratorAgent,
      { characteristics, mockable: true },
      expect,
    );

    expect(data.line1).toBeTruthy();
    expect(data.line2).toBeTruthy();
    expect(data.line3).toBeTruthy();
  });

  it('should generate haiku with three non-empty lines', async () => {
    const characteristics = createTestCat({
      furColor: 'White',
      breed: 'Persian',
      size: 'small',
      personality: ['Calm', 'Graceful'],
      description: 'A calm white Persian cat',
    });

    const data = await expectAgentSuccess(
      haikuGeneratorAgent,
      { characteristics },
      expect,
    );

    // Verify structure
    expect(data.line1.length).toBeGreaterThan(0);
    expect(data.line2.length).toBeGreaterThan(0);
    expect(data.line3.length).toBeGreaterThan(0);
  });
});
