/**
 * Tests for OpenAIEmbeddingProvider
 *
 * These tests are primarily type and configuration tests.
 * Real API tests require OPENAI_API_KEY and are skipped by default.
 */

import Module from 'node:module';

import { beforeEach, describe, expect, it } from 'vitest';

import { OpenAIEmbeddingProvider } from '../../src/embedding-providers/openai-embedding-provider.js';

const TEST_API_KEY = 'test-key';
const SMALL_MODEL = 'text-embedding-3-small';

describe('OpenAIEmbeddingProvider - Unit Tests', () => {
  it('should have correct metadata for text-embedding-3-small', () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: TEST_API_KEY,
      model: SMALL_MODEL,
    });

    expect(provider.name).toBe('openai');
    expect(provider.model).toBe(SMALL_MODEL);
    expect(provider.dimensions).toBe(1536);
  });

  it('should have correct metadata for text-embedding-3-large', () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: TEST_API_KEY,
      model: 'text-embedding-3-large',
    });

    expect(provider.name).toBe('openai');
    expect(provider.model).toBe('text-embedding-3-large');
    expect(provider.dimensions).toBe(3072);
  });

  it('should use text-embedding-3-small as default', () => {
    const provider = new OpenAIEmbeddingProvider({ apiKey: TEST_API_KEY });

    expect(provider.model).toBe('text-embedding-3-small');
    expect(provider.dimensions).toBe(1536);
  });

  it('should support custom dimensions', () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: TEST_API_KEY,
      model: SMALL_MODEL,
      dimensions: 512,
    });

    expect(provider.dimensions).toBe(512);
  });

  it('should create provider successfully when OpenAI SDK is installed', () => {
    // This test verifies provider can be created when openai package is available
    const provider = new OpenAIEmbeddingProvider({ apiKey: TEST_API_KEY });
    expect(provider).toBeDefined();
    expect(provider.name).toBe('openai');
  });

  it('should use default dimensions when model not in map', () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: TEST_API_KEY,
      model: 'unknown-model',
    });

    expect(provider.dimensions).toBe(1536); // fallback default
  });

  it('should throw an install hint when the OpenAI SDK is not installed', () => {
    // The provider `require()`s `openai` lazily in its constructor because the SDK is an
    // optional dependency. `vi.mock` cannot intercept that: `openai` is externalized, so
    // the require reaches Node's real loader. Simulate the SDK being absent by making the
    // loader itself fail for that one specifier.
    const loader = Module as unknown as {
      _load: (request: string, ...rest: unknown[]) => unknown;
    };
    const originalLoad = loader._load;
    loader._load = function patchedLoad(request: string, ...rest: unknown[]): unknown {
      if (request === 'openai') {
        throw new Error("Cannot find module 'openai'");
      }
      return originalLoad.call(this, request, ...rest);
    };

    try {
      expect(() => new OpenAIEmbeddingProvider({ apiKey: TEST_API_KEY })).toThrow(
        'OpenAI SDK not installed. Install with: bun add openai'
      );
    } finally {
      loader._load = originalLoad;
    }
  });
});

describe('OpenAIEmbeddingProvider - Integration Tests', () => {
  const apiKey = process.env.OPENAI_API_KEY;
  const skipMessage = 'Skipping OpenAI integration test (no OPENAI_API_KEY)';

  beforeEach(() => {
    if (!apiKey) {
      console.log(skipMessage);
    }
  });

  it.skipIf(!apiKey)('should embed a single text', async () => {
    if (!apiKey) return;
    const provider = new OpenAIEmbeddingProvider({ apiKey });
    const embedding = await provider.embed('Hello world');

    expect(embedding).toBeInstanceOf(Array);
    expect(embedding).toHaveLength(1536);
    expect(embedding.every((n: number) => typeof n === 'number')).toBe(true);
  });

  it.skipIf(!apiKey)('should embed batch of texts', async () => {
    if (!apiKey) return;
    const provider = new OpenAIEmbeddingProvider({ apiKey });
    const embeddings = await provider.embedBatch(['Hello', 'world', 'test']);

    expect(embeddings).toHaveLength(3);
    expect(embeddings[0]).toHaveLength(1536);
  });

  it.skipIf(!apiKey)('should handle empty string', async () => {
    if (!apiKey) return;
    const provider = new OpenAIEmbeddingProvider({ apiKey });
    const embedding = await provider.embed('');

    expect(embedding).toBeInstanceOf(Array);
    expect(embedding).toHaveLength(1536);
  });

  it.skipIf(!apiKey)('should produce different embeddings for different texts', async () => {
    if (!apiKey) return;
    const provider = new OpenAIEmbeddingProvider({ apiKey });
    const embedding1 = await provider.embed('cat');
    const embedding2 = await provider.embed('dog');

    expect(embedding1).not.toEqual(embedding2);
  });

  it.skipIf(!apiKey)('should produce semantically consistent embeddings for same text', async () => {
    if (!apiKey) return;
    const provider = new OpenAIEmbeddingProvider({ apiKey });
    const text = 'Deterministic test';
    const embedding1 = await provider.embed(text);
    const embedding2 = await provider.embed(text);

    // OpenAI embeddings are NOT guaranteed to be bit-identical across requests
    // due to distributed infrastructure and floating-point variations.
    // Instead, verify semantic consistency via cosine similarity.
    const dotProduct = embedding1.reduce((sum, val, i) => sum + val * (embedding2[i] ?? 0), 0);
    const magnitude1 = Math.sqrt(embedding1.reduce((sum, val) => sum + val * val, 0));
    const magnitude2 = Math.sqrt(embedding2.reduce((sum, val) => sum + val * val, 0));
    const cosineSimilarity = dotProduct / (magnitude1 * magnitude2);

    // Same text should have very high similarity (> 0.95)
    // Note: This may still be flaky if OpenAI's infrastructure varies significantly
    expect(cosineSimilarity).toBeGreaterThan(0.95);
  });

  it('should return empty array when embedBatch called with empty array', async () => {
    const provider = new OpenAIEmbeddingProvider({ apiKey: TEST_API_KEY });
    const embeddings = await provider.embedBatch([]);

    expect(embeddings).toEqual([]);
  });
});
