/**
 * Unit Tests for OnnxEmbeddingProvider
 *
 * These tests verify configuration, metadata, and edge cases
 * without requiring onnxruntime-node or model downloads.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OnnxEmbeddingProvider } from '../../src/embedding-providers/onnx-embedding-provider.js';

/** Non-public directory for test paths to satisfy sonarjs/publicly-writable-directories */
const TEST_PATH_BASE = join(homedir(), '.cache', 'vat-test');

describe('OnnxEmbeddingProvider - Unit Tests', () => {
  it('should have correct default metadata', () => {
    const provider = new OnnxEmbeddingProvider();

    expect(provider.name).toBe('onnx');
    expect(provider.model).toBe('sentence-transformers/all-MiniLM-L6-v2');
    expect(provider.dimensions).toBe(384);
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
      modelPath: join(TEST_PATH_BASE, 'my-model'),
    });

    expect(provider).toBeDefined();
    expect(provider.name).toBe('onnx');
  });

  it('should accept cacheDir configuration', () => {
    const provider = new OnnxEmbeddingProvider({
      cacheDir: join(TEST_PATH_BASE, 'custom-cache'),
    });

    expect(provider).toBeDefined();
    expect(provider.name).toBe('onnx');
  });

  it('should accept executionProviders configuration', () => {
    const provider = new OnnxEmbeddingProvider({
      executionProviders: ['cpu'],
    });

    expect(provider).toBeDefined();
    expect(provider.name).toBe('onnx');
  });

  it('should accept maxSequenceLength configuration', () => {
    const provider = new OnnxEmbeddingProvider({
      maxSequenceLength: 128,
    });

    expect(provider).toBeDefined();
    expect(provider.name).toBe('onnx');
  });

  it('should accept all configuration options together', () => {
    const provider = new OnnxEmbeddingProvider({
      model: 'custom/model',
      dimensions: 512,
      modelPath: join(TEST_PATH_BASE, 'models'),
      cacheDir: join(TEST_PATH_BASE, 'cache'),
      executionProviders: ['cpu'],
      maxSequenceLength: 512,
    });

    expect(provider.name).toBe('onnx');
    expect(provider.model).toBe('custom/model');
    expect(provider.dimensions).toBe(512);
  });

  it('should return empty array when embedBatch called with empty array', async () => {
    const provider = new OnnxEmbeddingProvider();
    const embeddings = await provider.embedBatch([]);

    expect(embeddings).toEqual([]);
  });
});
