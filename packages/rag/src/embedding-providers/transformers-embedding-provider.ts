/**
 * Transformers Embedding Provider
 *
 * Uses @xenova/transformers for local embedding generation.
 * No API key required, runs entirely in Node.js.
 */

import { pipeline } from '@xenova/transformers';

import type { EmbeddingProvider } from '../interfaces/embedding.js';

/**
 * Configuration for TransformersEmbeddingProvider
 */
export interface TransformersEmbeddingConfig {
  /** Model name (default: Xenova/all-MiniLM-L6-v2) */
  model?: string;
  /** Embedding dimensions (default: 384) */
  dimensions?: number;
}

/**
 * TransformersEmbeddingProvider
 *
 * Local embedding generation using transformers.js.
 * Default model: all-MiniLM-L6-v2 (384 dimensions)
 *
 * Benefits:
 * - No API key required
 * - Runs locally in Node.js
 * - Fast inference
 * - Good quality embeddings
 * - No network latency
 *
 * Note: First run downloads model (~20MB for all-MiniLM-L6-v2)
 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'transformers-js';
  readonly model: string;
  readonly dimensions: number;

  private pipelinePromise: Promise<unknown> | null = null;

  /**
   * Create TransformersEmbeddingProvider
   *
   * @param config - Optional configuration
   */
  constructor(config: TransformersEmbeddingConfig = {}) {
    this.model = config.model ?? 'Xenova/all-MiniLM-L6-v2';
    this.dimensions = config.dimensions ?? 384;
  }

  /**
   * Get or initialize the embedding pipeline
   */
  private async getPipeline(): Promise<unknown> {
    this.pipelinePromise ??= pipeline('feature-extraction', this.model, {
      quantized: true, // Use quantized model for better performance
    });
    return this.pipelinePromise;
  }

  /**
   * Embed a single text chunk
   *
   * @param text - Text to embed
   * @returns Vector embedding (normalized)
   */
  async embed(text: string): Promise<number[]> {
    const extractor = (await this.getPipeline()) as (text: string, options: { pooling: string; normalize: boolean }) => Promise<{
        data: Float32Array;
      }>;

    const output = await extractor(text, {
      pooling: 'mean',
      normalize: true,
    });

    return [...output.data];
  }

  /**
   * Embed multiple text chunks efficiently
   *
   * @param texts - Array of texts to embed
   * @returns Array of vector embeddings
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    // Process in parallel for better performance
    const embeddings = await Promise.all(texts.map((text) => this.embed(text)));
    return embeddings;
  }
}
