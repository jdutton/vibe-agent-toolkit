/**
 * Embedding Provider Comparison Tests
 *
 * Compare different embedding providers.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// ONNX Provider Comparison
// ---------------------------------------------------------------------------

describe('ONNX Provider Comparison', () => {
  const getProvider = async () => {
    const mod = await import('../../src/embedding-providers/onnx-embedding-provider.js');
    return new mod.OnnxEmbeddingProvider();
  };

  it(
    'should produce consistent embedding dimensions',
    async () => {
      const onnx = await getProvider();
      const text = 'Test embedding';
      const embedding = await onnx.embed(text);

      expect(embedding).toHaveLength(onnx.dimensions);
      expect(onnx.dimensions).toBe(384);
    },
    120_000,
  );

  it(
    'should show ONNX provider is deterministic',
    async () => {
      const onnx = await getProvider();
      const text = 'Deterministic test';
      const embedding1 = await onnx.embed(text);
      const embedding2 = await onnx.embed(text);

      expect(embedding1).toEqual(embedding2);
    },
    120_000,
  );

  it(
    'should produce normalized embeddings',
    async () => {
      const onnx = await getProvider();
      const text = 'Normalized test';
      const embedding = await onnx.embed(text);

      const magnitude = Math.sqrt(
        embedding.reduce((sum, val) => sum + val * val, 0),
      );

      expect(magnitude).toBeCloseTo(1, 2);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// Provider Tradeoffs Documentation
// ---------------------------------------------------------------------------

describe('Embedding Provider Tradeoffs', () => {
  it('should document model selection tradeoffs', () => {
    const tradeoffs = {
      onnx: {
        speed: 'fast',
        quality: 'good',
        cost: 'free',
        apiKey: false,
        dimensions: 384,
        runtime: 'onnxruntime-web (WASM)',
      },
      openai: {
        speed: 'medium',
        quality: 'excellent',
        cost: 'paid',
        apiKey: true,
        dimensions: 1536,
        runtime: 'OpenAI API (cloud)',
      },
    };

    // Local provider is free
    expect(tradeoffs.onnx.cost).toBe('free');
    expect(tradeoffs.openai.cost).toBe('paid');

    // OpenAI has higher dimensionality
    expect(tradeoffs.openai.dimensions).toBeGreaterThan(tradeoffs.onnx.dimensions);

    // Only OpenAI requires an API key
    expect(tradeoffs.onnx.apiKey).toBe(false);
    expect(tradeoffs.openai.apiKey).toBe(true);
  });
});
