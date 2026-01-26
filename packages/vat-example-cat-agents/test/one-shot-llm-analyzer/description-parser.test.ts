import { describe, expect, it } from 'vitest';

import { descriptionParserAgent, parseDescription } from '../../src/one-shot-llm-analyzer/description-parser.js';
import { expectAgentSuccess } from '../test-helpers.js';

describe('parseDescription', () => {
  it('should parse structured description', async () => {
    const result = await parseDescription('Orange tabby cat, playful, loves boxes');

    expect(result.physical.furColor).toBe('Orange');
    expect(result.physical.furPattern).toBe('Tabby');
    expect(result.behavioral.personality).toContain('Playful');
  });

  it('should parse word vomit description', async () => {
    const description = "So there's this cat right and he's like super orange and has stripes and he knocks stuff off tables";
    const result = await parseDescription(description);

    expect(result.physical.furColor).toBe('Orange');
    expect(result.physical.furPattern).toBe('Tabby');
    expect(result.behavioral.quirks).toContain('Knocks things off tables');
  });

  it('should extract black color', async () => {
    const result = await parseDescription('A sleek black cat with green eyes');

    expect(result.physical.furColor).toBe('Black');
    expect(result.physical.eyeColor).toBe('Green');
  });

  it('should extract white color', async () => {
    const result = await parseDescription('Pure white Persian cat, very calm');

    expect(result.physical.furColor).toBe('White');
    expect(result.physical.breed).toBe('Persian');
    expect(result.behavioral.personality).toContain('Calm');
  });

  it('should extract breed information', async () => {
    const result = await parseDescription('Siamese cat with blue eyes and talkative personality');

    expect(result.physical.breed).toBe('Siamese');
    expect(result.physical.eyeColor).toBe('Blue');
    expect(result.behavioral.vocalizations).toContain('Very vocal');
  });

  it('should extract size information', async () => {
    const result = await parseDescription('Tiny kitten, very playful and energetic');

    expect(result.physical.size).toBe('tiny');
    expect(result.behavioral.personality).toContain('Playful');
    expect(result.behavioral.personality).toContain('Energetic');
  });

  it('should extract quirks about boxes', async () => {
    const result = await parseDescription('Cat loves sitting in cardboard boxes all day');

    expect(result.behavioral.quirks).toContain('Loves sitting in boxes');
  });

  it('should extract quirks about zoomies', async () => {
    const result = await parseDescription('Gets zoomies and runs around like crazy at 3am');

    expect(result.behavioral.quirks).toContain('Gets the zoomies at 3am');
  });

  it('should extract multiple personality traits', async () => {
    const result = await parseDescription('Friendly, affectionate, curious, and intelligent orange cat');

    expect(result.behavioral.personality).toContain('Friendly');
    expect(result.behavioral.personality).toContain('Curious');
    expect(result.behavioral.personality).toContain('Intelligent');
  });

  it('should extract grumpy personality', async () => {
    const result = await parseDescription('Very grumpy and cranky cat, always judging people');

    expect(result.behavioral.personality).toContain('Grumpy');
  });

  it('should extract age information', async () => {
    const result = await parseDescription('5 year old orange tabby cat');

    expect(result.metadata?.age).toBe('5 years old');
  });

  it('should extract kitten age', async () => {
    const result = await parseDescription('Cute little kitten, very playful');

    expect(result.metadata?.age).toBe('Kitten (under 1 year)');
    expect(result.physical.size).toBe('tiny');
  });

  it('should extract senior age', async () => {
    const result = await parseDescription('Senior cat, very calm and wise');

    expect(result.metadata?.age).toBe('Senior (10+ years)');
  });

  it('should extract rescue origin', async () => {
    const result = await parseDescription('Adopted from a shelter, very friendly rescue cat');

    expect(result.metadata?.origin).toBe('Rescue/Shelter');
    expect(result.behavioral.personality).toContain('Friendly');
  });

  it('should extract occupation', async () => {
    const result = await parseDescription('Professional mouser, catches mice in the barn');

    expect(result.metadata?.occupation).toBe('Professional mouser');
  });

  it('should extract office cat occupation', async () => {
    const result = await parseDescription('Office cat, greets employees every morning');

    expect(result.metadata?.occupation).toBe('Office cat');
  });

  it('should extract vocalizations', async () => {
    const result = await parseDescription('Very chatty cat, meows and purrs constantly');

    expect(result.behavioral.vocalizations).toContain('Very vocal');
    expect(result.behavioral.vocalizations).toContain('Meows');
    expect(result.behavioral.vocalizations).toContain('Purrs');
  });

  it('should handle tuxedo pattern', async () => {
    const result = await parseDescription('Black and white tuxedo cat, very distinguished');

    expect(result.physical.furPattern).toBe('Tuxedo');
  });

  it('should default to mixed colors if none specified', async () => {
    const result = await parseDescription('A cat with an interesting personality');

    expect(result.physical.furColor).toBe('Mixed colors');
  });

  it('should default personality if none found', async () => {
    const result = await parseDescription('A cat.');

    expect(result.behavioral.personality).toContain('Mysterious');
    expect(result.behavioral.personality).toContain('Independent');
  });

  it('should preserve original description', async () => {
    const description = 'Test cat description';
    const result = await parseDescription(description);

    expect(result.description).toBe(description);
  });

  it('should throw error if mockable is false', async () => {
    await expect(
      parseDescription('test', { mockable: false }),
    ).rejects.toThrow('Real LLM parsing not implemented yet');
  });
});

describe('descriptionParserAgent', () => {
  it('should have correct manifest', () => {
    expect(descriptionParserAgent.name).toBe('description-parser');
    expect(descriptionParserAgent.manifest.name).toBe('description-parser');
    expect(descriptionParserAgent.manifest.description).toBe(
      'Parses text descriptions and extracts structured cat characteristics',
    );
    expect(descriptionParserAgent.manifest.version).toBe('1.0.0');
    expect(descriptionParserAgent.manifest.archetype).toBe('one-shot-llm-analyzer');
  });

  it('should parse description via agent.execute() in mock mode', async () => {
    const data = await expectAgentSuccess(
      descriptionParserAgent,
      { description: 'Orange tabby cat, playful, loves boxes' },
      expect,
    );

    expect(data.physical.furColor).toBe('Orange');
    expect(data.physical.furPattern).toBe('Tabby');
    expect(data.behavioral.personality).toContain('Playful');
  });

  it('should handle mockable option via agent.execute()', async () => {
    const data = await expectAgentSuccess(
      descriptionParserAgent,
      { description: 'Black cat with green eyes', mockable: true },
      expect,
    );

    expect(data.physical.furColor).toBe('Black');
    expect(data.physical.eyeColor).toBe('Green');
  });
});
