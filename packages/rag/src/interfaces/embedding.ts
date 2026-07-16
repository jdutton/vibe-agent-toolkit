/**
 * Embedding Provider interface
 *
 * Defines the contract for embedding providers (onnx, OpenAI, etc.)
 */

/**
 * Embedding Provider
 *
 * Converts text to vector embeddings for semantic search.
 */
export interface EmbeddingProvider {
  /** Provider name: "openai", "onnx", etc. */
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

  /**
   * Release any resources held by the provider (optional).
   *
   * Extension point for providers that hold onto a native or long-lived
   * resource (an inference session, a socket) and need explicit teardown.
   * No-op for pure-JS/HTTP providers.
   */
  dispose?(): Promise<void>;
}
