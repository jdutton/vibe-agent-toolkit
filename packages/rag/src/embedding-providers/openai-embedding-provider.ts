/**
 * OpenAI Embedding Provider
 *
 * Uses OpenAI API for high-quality embedding generation.
 * Requires API key and internet connection.
 */

import type { EmbeddingProvider } from '../interfaces/embedding.js';

/**
 * Configuration for OpenAIEmbeddingProvider
 */
export interface OpenAIEmbeddingConfig {
  /** OpenAI API key */
  apiKey: string;
  /** Model name (default: text-embedding-3-small). Supports text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002, etc. */
  model?: string;
  /** Custom dimensions (only for text-embedding-3-* models) */
  dimensions?: number;
}

/**
 * Model dimensions map
 */
const MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

/**
 * OpenAIEmbeddingProvider
 *
 * Cloud-based embedding generation using OpenAI API.
 * Default model: text-embedding-3-small (1536 dimensions)
 *
 * Benefits:
 * - State-of-art quality
 * - Well-tested, production-ready
 * - Higher dimensions for better accuracy
 *
 * Considerations:
 * - Requires API key
 * - API cost per token
 * - Network latency
 * - Rate limits
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly dimensions: number;

  private readonly client: {
    embeddings: {
      create: (params: {
        model: string;
        input: string | string[];
        dimensions?: number;
      }) => Promise<{
        data: Array<{ embedding: number[] }>;
      }>;
    };
  };

  /**
   * Create OpenAIEmbeddingProvider
   *
   * @param config - Configuration with API key
   */
  constructor(config: OpenAIEmbeddingConfig) {
    this.model = config.model ?? 'text-embedding-3-small';
    this.dimensions = config.dimensions ?? MODEL_DIMENSIONS[this.model] ?? 1536;

    // Lazy load OpenAI SDK (optional dependency)
    // Using dynamic import in constructor requires synchronous initialization,
    // so we throw an error if the import fails and provide installation instructions
    try {
      // Dynamic import in constructor context - this will fail at runtime if openai isn't installed
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { OpenAI } = require('openai');
      this.client = new OpenAI({ apiKey: config.apiKey });
    } catch {
      throw new Error(
        'OpenAI SDK not installed. Install with: bun add openai'
      );
    }
  }

  /**
   * Embed a single text chunk
   *
   * @param text - Text to embed
   * @returns Vector embedding
   */
  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
      dimensions: this.dimensions,
    });

    const firstItem = response.data[0];
    if (!firstItem) {
      throw new Error('OpenAI API returned no embeddings');
    }
    return firstItem.embedding;
  }

  /**
   * Embed multiple text chunks efficiently
   *
   * Uses OpenAI's batch API for better performance.
   *
   * @param texts - Array of texts to embed
   * @returns Array of vector embeddings
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      dimensions: this.dimensions,
    });

    return response.data.map((item) => item.embedding);
  }
}
