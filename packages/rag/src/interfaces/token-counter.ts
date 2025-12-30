/**
 * Token Counter interface
 *
 * Defines the contract for token counting implementations.
 */

/**
 * Token Counter
 *
 * Counts tokens in text for chunking and embedding token limit management.
 */
export interface TokenCounter {
  /** Counter name: "fast", "approximate", "tiktoken", etc. */
  name: string;

  /**
   * Count tokens in text
   *
   * @param text - Text to count tokens in
   * @returns Number of tokens
   */
  count(text: string): number;

  /**
   * Count tokens in multiple texts
   *
   * @param texts - Array of texts to count tokens in
   * @returns Array of token counts
   */
  countBatch(texts: string[]): number[];
}
