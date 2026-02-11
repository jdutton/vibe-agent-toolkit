/**
 * Integration Tests for OnnxEmbeddingProvider
 *
 * These tests use real ONNX Runtime inference with the all-MiniLM-L6-v2 model.
 * First run downloads model files (~80MB).
 *
 * Skipped when:
 * - onnxruntime-node is not installed
 * - Running on Windows (avoid downloading native binaries in CI)
 */

import { describe, expect, it } from 'vitest';

import { OnnxEmbeddingProvider } from '../../src/embedding-providers/onnx-embedding-provider.js';

import { assertBatchEmbedding } from './embedding-test-helpers.js';

// Detect runtime availability
let onnxAvailable = false;
try {
  await import('onnxruntime-node');
  onnxAvailable = true;
} catch {
  // onnxruntime-node not installed
}

const isWindows = process.platform === 'win32';
const skipOnnx = !onnxAvailable || isWindows;

/**
 * Cosine similarity between two normalized vectors.
 * For L2-normalized vectors, dot product equals cosine similarity.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
}

describe.skipIf(skipOnnx)('OnnxEmbeddingProvider - Integration Tests', () => {
  // Model download can take a while on first run
  const provider = new OnnxEmbeddingProvider();

  it(
    'should embed a single text',
    async () => {
      const embedding = await provider.embed('Hello world');

      expect(embedding).toBeInstanceOf(Array);
      expect(embedding).toHaveLength(384);
      expect(embedding.every((n) => typeof n === 'number')).toBe(true);
    },
    120_000,
  );

  it(
    'should embed batch of texts',
    async () => {
      await assertBatchEmbedding(provider, 384);
    },
    120_000,
  );

  it(
    'should produce normalized embeddings (magnitude close to 1)',
    async () => {
      const embedding = await provider.embed('Test embedding normalization');

      const magnitude = Math.sqrt(
        embedding.reduce((sum, val) => sum + val * val, 0),
      );

      expect(magnitude).toBeCloseTo(1, 2);
    },
    120_000,
  );

  it(
    'should produce different embeddings for different texts',
    async () => {
      const embedding1 = await provider.embed('cat');
      const embedding2 = await provider.embed('quantum mechanics');

      expect(embedding1).not.toEqual(embedding2);
    },
    120_000,
  );

  it(
    'should produce similar embeddings for similar texts',
    async () => {
      const embeddingCat = await provider.embed('cat');
      const embeddingKitten = await provider.embed('kitten');
      const embeddingSpaceship = await provider.embed('spaceship');

      const similarityCatKitten = cosineSimilarity(embeddingCat, embeddingKitten);
      const similarityCatSpaceship = cosineSimilarity(embeddingCat, embeddingSpaceship);

      // cat-kitten should be more similar than cat-spaceship
      expect(similarityCatKitten).toBeGreaterThan(similarityCatSpaceship);
      expect(similarityCatKitten).toBeGreaterThan(0.5);
    },
    120_000,
  );

  it(
    'should be deterministic (same text produces same embedding)',
    async () => {
      const text = 'Deterministic test for ONNX embeddings';
      const embedding1 = await provider.embed(text);
      const embedding2 = await provider.embed(text);

      expect(embedding1).toEqual(embedding2);
    },
    120_000,
  );

  it(
    'should handle empty batch',
    async () => {
      const embeddings = await provider.embedBatch([]);

      expect(embeddings).toEqual([]);
    },
    120_000,
  );

  it(
    'should handle long text (500+ characters)',
    async () => {
      const longText = 'This is a test sentence for embedding generation. '.repeat(15);
      expect(longText.length).toBeGreaterThan(500);

      const embedding = await provider.embed(longText);

      expect(embedding).toHaveLength(384);
      expect(embedding.every((n) => typeof n === 'number')).toBe(true);
    },
    120_000,
  );
});
