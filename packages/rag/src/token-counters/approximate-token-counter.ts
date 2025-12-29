/**
 * Approximate Token Counter
 *
 * Uses gpt-tokenizer for accurate token counting compatible with GPT-3.5/GPT-4.
 */

import { encode } from 'gpt-tokenizer';

import type { TokenCounter } from '../interfaces/token-counter.js';

/**
 * ApproximateTokenCounter
 *
 * Uses gpt-tokenizer library for accurate token counting.
 * Compatible with GPT-3.5/GPT-4 tokenization (cl100k_base encoding).
 *
 * Recommended padding factor: 0.9 (90% of target)
 */
export class ApproximateTokenCounter implements TokenCounter {
  readonly name = 'approximate';

  /**
   * Count tokens using gpt-tokenizer
   *
   * @param text - Text to count tokens in
   * @returns Accurate token count
   */
  count(text: string): number {
    if (text.length === 0) {
      return 0;
    }

    const tokens = encode(text);
    return tokens.length;
  }

  /**
   * Count tokens in multiple texts
   *
   * @param texts - Array of texts to count tokens in
   * @returns Array of token counts
   */
  countBatch(texts: string[]): number[] {
    return texts.map((text) => this.count(text));
  }
}
