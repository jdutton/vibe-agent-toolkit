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
   * Maximum number of tokens this provider's model reads for a single input,
   * INCLUDING whatever special tokens its tokenizer adds.
   *
   * This is a hard property of the model, not a preference: text beyond it is
   * discarded before inference, so anything that decides how much text to hand
   * over (a chunker, a batcher) must size its work against THIS number.
   *
   * Required, deliberately. It was previously absent, and the only consumer —
   * the chunker in `@vibe-agent-toolkit/rag-lancedb` — filled the hole with a
   * hardcoded 8191 (OpenAI ada-002's limit) for every provider, including a
   * local model that reads 256. The result was 84-86% of chunks truncated and
   * 42-44% of every corpus never reaching the model, with the "exceeds model
   * token limit" guard permanently unable to fire. An optional field with a
   * fallback would reproduce exactly that bug for any provider that forgot it.
   */
  maxInputTokens: number;

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
