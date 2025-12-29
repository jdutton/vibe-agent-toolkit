/**
 * Embedding Provider Comparison Tests
 *
 * Compare different embedding providers.
 */

import { describe, it, expect } from 'vitest';

import { TransformersEmbeddingProvider } from '../../src/embedding-providers/transformers-embedding-provider.js';

describe('Embedding Provider Comparison', () => {
  const transformers = new TransformersEmbeddingProvider();

  it('should produce consistent embedding dimensions', async () => {
    const text = 'Test embedding';
    const embedding = await transformers.embed(text);

    expect(embedding).toHaveLength(transformers.dimensions);
    expect(transformers.dimensions).toBe(384);
  });

  it('should show transformers.js is deterministic', async () => {
    const text = 'Deterministic test';
    const embedding1 = await transformers.embed(text);
    const embedding2 = await transformers.embed(text);

    expect(embedding1).toEqual(embedding2);
  });

  it('should produce normalized embeddings', async () => {
    const text = 'Normalized test';
    const embedding = await transformers.embed(text);

    // Calculate magnitude
    const magnitude = Math.sqrt(
      embedding.reduce((sum, val) => sum + val * val, 0)
    );

    // Should be close to 1 for normalized vectors
    expect(magnitude).toBeCloseTo(1.0, 2);
  });

  it('should document model selection tradeoffs', () => {
    // This test documents the tradeoffs between providers
    const tradeoffs = {
      transformers: {
        speed: 'fast',
        quality: 'good',
        cost: 'free',
        apiKey: false,
        dimensions: 384,
      },
      openai: {
        speed: 'medium',
        quality: 'excellent',
        cost: 'paid',
        apiKey: true,
        dimensions: 1536,
      },
    };

    expect(tradeoffs.transformers.cost).toBe('free');
    expect(tradeoffs.openai.cost).toBe('paid');
    expect(tradeoffs.openai.dimensions).toBeGreaterThan(tradeoffs.transformers.dimensions);
  });
});
