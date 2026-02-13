/**
 * Embedding Provider Comparison Tests
 *
 * Compare different embedding providers.
 * Providers with optional dependencies are skipped when unavailable.
 */

import { describe, it, expect } from 'vitest';

// Detect optional dependency availability
let transformersAvailable = false;
try {
  await import('@xenova/transformers');
  transformersAvailable = true;
} catch {
  // @xenova/transformers not installed
}

let onnxAvailable = false;
try {
  await import('onnxruntime-node');
  onnxAvailable = true;
} catch {
  // onnxruntime-node not installed
}

const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Transformers.js Provider Comparison
// ---------------------------------------------------------------------------

describe.skipIf(!transformersAvailable)('Transformers.js Provider Comparison', () => {
  // Lazy import to avoid errors when @xenova/transformers is not installed
  const getProvider = async () => {
    const mod = await import('../../src/embedding-providers/transformers-embedding-provider.js');
    return new mod.TransformersEmbeddingProvider();
  };

  it('should produce consistent embedding dimensions', async () => {
    const transformers = await getProvider();
    const text = 'Test embedding';
    const embedding = await transformers.embed(text);

    expect(embedding).toHaveLength(transformers.dimensions);
    expect(transformers.dimensions).toBe(384);
  });

  it('should show transformers.js is deterministic', async () => {
    const transformers = await getProvider();
    const text = 'Deterministic test';
    const embedding1 = await transformers.embed(text);
    const embedding2 = await transformers.embed(text);

    expect(embedding1).toEqual(embedding2);
  });

  it('should produce normalized embeddings', async () => {
    const transformers = await getProvider();
    const text = 'Normalized test';
    const embedding = await transformers.embed(text);

    const magnitude = Math.sqrt(
      embedding.reduce((sum, val) => sum + val * val, 0),
    );

    expect(magnitude).toBeCloseTo(1, 2);
  });
});

// ---------------------------------------------------------------------------
// ONNX Provider Comparison
// ---------------------------------------------------------------------------

describe.skipIf(!onnxAvailable || isWindows)('ONNX Provider Comparison', () => {
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
      transformers: {
        speed: 'fast',
        quality: 'good',
        cost: 'free',
        apiKey: false,
        dimensions: 384,
        runtime: '@xenova/transformers (WASM)',
      },
      onnx: {
        speed: 'fast',
        quality: 'good',
        cost: 'free',
        apiKey: false,
        dimensions: 384,
        runtime: 'onnxruntime-node (native C++)',
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

    // Local providers are free
    expect(tradeoffs.transformers.cost).toBe('free');
    expect(tradeoffs.onnx.cost).toBe('free');
    expect(tradeoffs.openai.cost).toBe('paid');

    // Both local providers use the same model and dimensions
    expect(tradeoffs.transformers.dimensions).toBe(tradeoffs.onnx.dimensions);

    // OpenAI has higher dimensionality
    expect(tradeoffs.openai.dimensions).toBeGreaterThan(tradeoffs.transformers.dimensions);
    expect(tradeoffs.openai.dimensions).toBeGreaterThan(tradeoffs.onnx.dimensions);

    // Only OpenAI requires an API key
    expect(tradeoffs.transformers.apiKey).toBe(false);
    expect(tradeoffs.onnx.apiKey).toBe(false);
    expect(tradeoffs.openai.apiKey).toBe(true);
  });
});
