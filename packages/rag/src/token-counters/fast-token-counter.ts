/**
 * Fast Token Counter
 *
 * Uses bytes/4 heuristic for token estimation.
 * Fast but inaccurate - suitable for quick validation checks.
 */

import type { TokenCounter } from '../interfaces/token-counter.js';

/**
 * FastTokenCounter
 *
 * Estimates token count using bytes/4 heuristic.
 * Very fast, but accuracy is ~25% for English text.
 *
 * Recommended padding factor: 0.8 (80% of target)
 */
export class FastTokenCounter implements TokenCounter {
  readonly name = 'fast';

  /**
   * Count tokens using bytes/4 heuristic
   *
   * @param text - Text to count tokens in
   * @returns Estimated token count
   */
  count(text: string): number {
    if (text.length === 0) {
      return 0;
    }

    const bytes = new TextEncoder().encode(text).length;
    return Math.ceil(bytes / 4);
  }

  /**
   * Count tokens in multiple texts
   *
   * @param texts - Array of texts to count tokens in
   * @returns Array of estimated token counts
   */
  countBatch(texts: string[]): number[] {
    return texts.map((text) => this.count(text));
  }
}
