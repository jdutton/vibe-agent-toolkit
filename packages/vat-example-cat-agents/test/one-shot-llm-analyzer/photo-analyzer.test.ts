import { describe, expect, it } from 'vitest';

import { analyzePhoto } from '../../src/one-shot-llm-analyzer/photo-analyzer.js';

describe('analyzePhoto', () => {
  it('should extract orange color from filename', async () => {
    const result = await analyzePhoto('orange-tabby-cat.jpg');

    expect(result.physical.furColor).toBe('Orange');
    expect(result.physical.furPattern).toBe('Tabby');
  });

  it('should extract black color from filename', async () => {
    const result = await analyzePhoto('black-cat-photo.jpg');

    expect(result.physical.furColor).toBe('Black');
  });

  it('should extract white color from filename', async () => {
    const result = await analyzePhoto('white-persian.jpg');

    expect(result.physical.furColor).toBe('White');
    expect(result.physical.breed).toBe('Persian');
  });

  it('should extract size from filename', async () => {
    const result = await analyzePhoto('tiny-kitten.jpg');

    expect(result.physical.size).toBe('tiny');
  });

  it('should extract large size from filename', async () => {
    const result = await analyzePhoto('large-maine-coon.jpg');

    expect(result.physical.size).toBe('large');
    expect(result.physical.breed).toBe('Maine Coon');
  });

  it('should extract personality from filename', async () => {
    const result = await analyzePhoto('grumpy-cat.jpg');

    expect(result.behavioral.personality).toContain('Grumpy');
  });

  it('should extract lazy personality from filename', async () => {
    const result = await analyzePhoto('lazy-gray-cat.jpg');

    expect(result.behavioral.personality).toContain('Lazy');
    expect(result.physical.furColor).toBe('Gray');
  });

  it('should extract playful personality from filename', async () => {
    const result = await analyzePhoto('playful-orange-kitten.jpg');

    expect(result.behavioral.personality).toContain('Playful');
    expect(result.physical.furColor).toBe('Orange');
  });

  it('should extract eye color from filename', async () => {
    const result = await analyzePhoto('white-cat-blue-eye.jpg');

    expect(result.physical.eyeColor).toBe('Blue');
    expect(result.physical.furColor).toBe('White');
  });

  it('should extract quirks from filename', async () => {
    const result = await analyzePhoto('fluffy-persian-cross-eye.jpg');

    expect(result.behavioral.quirks).toContain('Cross-eyed stare');
  });

  it('should generate a description', async () => {
    const result = await analyzePhoto('orange-tabby-large.jpg');

    expect(result.description).toBeTruthy();
    expect(result.description.toLowerCase()).toContain('orange');
  });

  it('should handle calico patterns', async () => {
    const result = await analyzePhoto('calico-cat.jpg');

    expect(result.physical.furColor).toContain('Calico');
    expect(result.physical.furPattern).toBe('Patched');
  });

  it('should default to gray tabby if no color found', async () => {
    const result = await analyzePhoto('random-cat-image.jpg');

    expect(result.physical.furColor).toBe('Gray tabby');
  });

  it('should default to medium size if not specified', async () => {
    const result = await analyzePhoto('cat.jpg');

    expect(result.physical.size).toBe('medium');
  });

  it('should include metadata', async () => {
    const result = await analyzePhoto('cat-photo.jpg');

    expect(result.metadata).toBeDefined();
    expect(result.metadata?.origin).toBe('Photo analysis');
  });

  it('should throw error if mockable is false', async () => {
    await expect(
      analyzePhoto('test.jpg', { mockable: false }),
    ).rejects.toThrow('Real vision API not implemented yet');
  });
});
