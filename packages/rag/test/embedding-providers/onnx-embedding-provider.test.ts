/**
 * Unit Tests for OnnxEmbeddingProvider
 *
 * These tests verify configuration, metadata, and edge cases
 * without requiring model downloads.
 */

import { homedir } from 'node:os';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { OnnxEmbeddingProvider } from '../../src/embedding-providers/onnx-embedding-provider.js';

/** Non-public directory for test paths to satisfy sonarjs/publicly-writable-directories */
const TEST_PATH_BASE = safePath.join(homedir(), '.cache', 'vat-test');

describe('OnnxEmbeddingProvider - Unit Tests', () => {
  it('should have correct default metadata', () => {
    const provider = new OnnxEmbeddingProvider();

    expect(provider.name).toBe('onnx');
    expect(provider.model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(provider.dimensions).toBe(384);
  });

  it('should publish the real input-token limit of the local model', () => {
    // all-MiniLM-L6-v2 was TRAINED at 256 positions — this is a property of the
    // model, not a tunable. Consumers must be able to read it instead of
    // guessing (the chunker used to assume 8191, OpenAI ada-002's limit, 32x too big).
    const provider = new OnnxEmbeddingProvider();

    expect(provider.maxInputTokens).toBe(256);
  });

  it('should start with an all-zero truncation ledger', () => {
    const provider = new OnnxEmbeddingProvider();

    expect(provider.truncationStats).toEqual({
      textsEmbedded: 0,
      textsTruncated: 0,
      tokensDropped: 0,
    });
  });

  it('should accept custom model configuration', () => {
    const provider = new OnnxEmbeddingProvider({
      model: 'sentence-transformers/paraphrase-MiniLM-L3-v2',
      dimensions: 384,
    });

    expect(provider.name).toBe('onnx');
    expect(provider.model).toBe('sentence-transformers/paraphrase-MiniLM-L3-v2');
    expect(provider.dimensions).toBe(384);
  });

  it('should accept custom dimensions', () => {
    const provider = new OnnxEmbeddingProvider({
      dimensions: 768,
    });

    expect(provider.dimensions).toBe(768);
  });

  it('should accept modelPath configuration', () => {
    const provider = new OnnxEmbeddingProvider({
      modelPath: safePath.join(TEST_PATH_BASE, 'my-model'),
    });

    expect(provider).toBeDefined();
    expect(provider.name).toBe('onnx');
  });

  it('should accept cacheDir configuration', () => {
    const provider = new OnnxEmbeddingProvider({
      cacheDir: safePath.join(TEST_PATH_BASE, 'custom-cache'),
    });

    expect(provider).toBeDefined();
    expect(provider.name).toBe('onnx');
  });

  it('should accept quantized configuration', () => {
    const provider = new OnnxEmbeddingProvider({
      quantized: false,
    });

    expect(provider).toBeDefined();
    expect(provider.name).toBe('onnx');
  });

  it('should accept maxSequenceLength configuration', () => {
    const provider = new OnnxEmbeddingProvider({
      maxSequenceLength: 128,
    });

    expect(provider.name).toBe('onnx');
    // The configured cap IS the published limit — a consumer that reads
    // maxInputTokens must see the value this provider will actually enforce.
    expect(provider.maxInputTokens).toBe(128);
  });

  it('should accept all configuration options together', () => {
    const provider = new OnnxEmbeddingProvider({
      model: 'custom/model',
      dimensions: 512,
      modelPath: safePath.join(TEST_PATH_BASE, 'models'),
      cacheDir: safePath.join(TEST_PATH_BASE, 'cache'),
      quantized: false,
      maxSequenceLength: 512,
      numThreads: 2,
    });

    expect(provider.name).toBe('onnx');
    expect(provider.model).toBe('custom/model');
    expect(provider.dimensions).toBe(512);
    expect(provider.maxInputTokens).toBe(512);
  });

  it('should return empty array when embedBatch called with empty array', async () => {
    const provider = new OnnxEmbeddingProvider();
    const embeddings = await provider.embedBatch([]);

    expect(embeddings).toEqual([]);
  });
});
