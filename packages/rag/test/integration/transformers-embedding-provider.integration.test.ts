/**
 * Tests for TransformersEmbeddingProvider
 *
 * Note: These are integration tests that use real transformers.js models.
 * They may download models on first run (~20MB for all-MiniLM-L6-v2).
 */

import { describe, it, expect } from 'vitest';

import { TransformersEmbeddingProvider } from '../../src/embedding-providers/transformers-embedding-provider.js';

import { assertBatchEmbedding } from './embedding-test-helpers.js';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

describe('TransformersEmbeddingProvider', () => {
  // Use default model for tests
  const provider = new TransformersEmbeddingProvider();

  it('should have correct metadata', () => {
    expect(provider.name).toBe('transformers-js');
    expect(provider.model).toBe(DEFAULT_MODEL);
    expect(provider.dimensions).toBe(384);
  });

  it('should embed a single text', async () => {
    const text = 'Hello world';
    const embedding = await provider.embed(text);

    expect(embedding).toBeInstanceOf(Array);
    expect(embedding).toHaveLength(384);
    expect(embedding.every((n) => typeof n === 'number')).toBe(true);
  });

  it('should embed an empty string', async () => {
    const embedding = await provider.embed('');

    expect(embedding).toBeInstanceOf(Array);
    expect(embedding).toHaveLength(384);
  });

  it('should produce normalized embeddings', async () => {
    const text = 'Test embedding';
    const embedding = await provider.embed(text);

    // Calculate magnitude (should be close to 1 for normalized vectors)
    const magnitude = Math.sqrt(
      embedding.reduce((sum, val) => sum + val * val, 0)
    );

    expect(magnitude).toBeCloseTo(1, 2);
  });

  it('should produce different embeddings for different texts', async () => {
    const embedding1 = await provider.embed('cat');
    const embedding2 = await provider.embed('dog');

    expect(embedding1).not.toEqual(embedding2);
  });

  it('should produce similar embeddings for similar texts', async () => {
    const embedding1 = await provider.embed('cat');
    const embedding2 = await provider.embed('kitten');
    const embedding3 = await provider.embed('spaceship');

    // Calculate cosine similarity
    const cosineSimilarity = (a: number[], b: number[]): number => {
      const dotProduct = a.reduce((sum, val, i) => {
        const bVal = b[i];
        return bVal === undefined ? sum : sum + val * bVal;
      }, 0);
      return dotProduct; // Already normalized, so dot product = cosine similarity
    };

    const similarity12 = cosineSimilarity(embedding1, embedding2);
    const similarity13 = cosineSimilarity(embedding1, embedding3);

    // cat-kitten should be more similar than cat-spaceship
    expect(similarity12).toBeGreaterThan(similarity13);
    expect(similarity12).toBeGreaterThan(0.5);
  });

  it('should embed batch of texts', async () => {
    await assertBatchEmbedding(provider, 384);
  });

  it('should handle empty batch', async () => {
    const embeddings = await provider.embedBatch([]);

    expect(embeddings).toEqual([]);
  });

  it('should be deterministic', async () => {
    const text = 'Deterministic test';
    const embedding1 = await provider.embed(text);
    const embedding2 = await provider.embed(text);

    expect(embedding1).toEqual(embedding2);
  });

  it('should handle long text', async () => {
    const longText = 'word '.repeat(100); // 500 chars
    const embedding = await provider.embed(longText);

    expect(embedding).toHaveLength(384);
  });
});

describe('TransformersEmbeddingProvider - Custom Model', () => {
  it('should support custom model configuration', async () => {
    const provider = new TransformersEmbeddingProvider({
      model: DEFAULT_MODEL,
      dimensions: 384,
    });

    expect(provider.model).toBe(DEFAULT_MODEL);
    expect(provider.dimensions).toBe(384);

    const embedding = await provider.embed('test');
    expect(embedding).toHaveLength(384);
  });
});
