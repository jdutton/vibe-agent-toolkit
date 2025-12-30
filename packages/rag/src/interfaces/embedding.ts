/**
 * Embedding Provider interface
 *
 * Defines the contract for embedding providers (transformers.js, OpenAI, etc.)
 */

/**
 * Embedding Provider
 *
 * Converts text to vector embeddings for semantic search.
 */
export interface EmbeddingProvider {
  /** Provider name: "openai", "transformers-js", etc. */
  name: string;

  /** Model name: "text-embedding-3-small", "all-MiniLM-L6-v2", etc. */
  model: string;

  /** Embedding vector dimensions */
  dimensions: number;

  /**
   * Embed a single text chunk
   *
   * @param text - Text to embed
   * @returns Vector embedding
   */
  embed(text: string): Promise<number[]>;

  /**
   * Embed multiple text chunks efficiently
   *
   * @param texts - Array of texts to embed
   * @returns Array of vector embeddings
   */
  embedBatch(texts: string[]): Promise<number[][]>;
}
