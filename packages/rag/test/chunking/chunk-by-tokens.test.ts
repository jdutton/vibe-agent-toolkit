/**
 * Tests for token-aware chunking
 */

import { describe, expect, it } from 'vitest';

import { chunkByTokens } from '../../src/chunking/chunk-by-tokens.js';
import type { ChunkingConfig, RawChunk } from '../../src/chunking/types.js';
import { calculateEffectiveTarget } from '../../src/chunking/utils.js';
import type { TokenCounter } from '../../src/interfaces/token-counter.js';
import { ApproximateTokenCounter } from '../../src/token-counters/approximate-token-counter.js';

const tokenCounter = new ApproximateTokenCounter();

/** The provider's real numbers for all-MiniLM-L6-v2: budget 215, hard limit 256. */
const REAL_MODEL = { targetChunkSize: 256, modelTokenLimit: 256, paddingFactor: 0.84 };

/**
 * Build a chunking config.
 *
 * @param overrides - Fields to override on the permissive default
 * @returns A complete chunking config
 */
function makeConfig(overrides: Partial<ChunkingConfig> = {}): ChunkingConfig {
  return {
    targetChunkSize: 512,
    modelTokenLimit: 8191,
    paddingFactor: 0.9,
    tokenCounter,
    ...overrides,
  };
}

/**
 * The effective per-chunk budget, computed here rather than read from the
 * implementation, so the assertion cannot be satisfied by construction.
 *
 * @param config - Chunking configuration
 * @returns Effective per-chunk token budget
 */
function budgetOf(config: ChunkingConfig): number {
  return Math.min(
    calculateEffectiveTarget(config.targetChunkSize, config.paddingFactor),
    config.modelTokenLimit,
  );
}

/**
 * Assert every chunk fits the effective BUDGET (not merely the model limit).
 *
 * @param chunks - Chunks to check
 * @param config - Chunking configuration the chunks were produced with
 */
function expectEveryChunkWithinBudget(chunks: RawChunk[], config: ChunkingConfig): void {
  const budget = budgetOf(config);
  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(config.tokenCounter.count(chunk.content)).toBeLessThanOrEqual(budget);
  }
}

/**
 * Assert every non-whitespace character of the input survives into some chunk,
 * in order. Whitespace consumed at split boundaries and by chunk trimming is
 * the only permitted loss.
 *
 * @param text - Original input text
 * @param chunks - Chunks produced from it
 */
function expectNoContentLoss(text: string, chunks: RawChunk[]): void {
  const strip = (value: string): string => value.replaceAll(/\s+/gu, '');
  expect(strip(chunks.map((chunk) => chunk.content).join(''))).toBe(strip(text));
}

const FILLER_WORD = 'methodology';

/**
 * Build a single line (no newlines, no sentence punctuation) of at least
 * `minTokens` tokens.
 *
 * @param minTokens - Lower bound on the line's token count
 * @returns One line of filler prose
 */
function lineOfTokens(minTokens: number): string {
  let line = FILLER_WORD;
  while (tokenCounter.count(line) < minTokens) {
    line += ` ${FILLER_WORD}`;
  }
  return line;
}

/** A tokenizer that declares every single character ruinously expensive. */
class HostileTokenCounter implements TokenCounter {
  readonly name = 'hostile';

  /**
   * @param text - Text to count
   * @returns A count no budget can ever accommodate
   */
  count(text: string): number {
    return text.length * 1000;
  }

  /**
   * @param texts - Texts to count
   * @returns Counts for each text
   */
  countBatch(texts: string[]): number[] {
    return texts.map((text) => this.count(text));
  }
}

describe('chunkByTokens', () => {
  it('should return single chunk if text fits in target size', () => {
    const text = 'Short text that fits easily';
    const config = makeConfig();

    const chunks = chunkByTokens(text, config);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(text);
  });

  it('should split text by paragraphs when too large', () => {
    const text = 'Paragraph 1 with some content.\n\nParagraph 2 with different content.';
    const config = makeConfig({ targetChunkSize: 5 }); // Very small to force split

    const chunks = chunkByTokens(text, config);

    expect(chunks.length).toBeGreaterThan(1);
  });

  it('should respect padding factor', () => {
    // Create text with paragraphs that will need splitting
    const paragraph = 'word '.repeat(60); // ~60 tokens
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`; // ~240 tokens total
    const config = makeConfig({ targetChunkSize: 100 }); // Effective target: 90 tokens

    const chunks = chunkByTokens(text, config);

    // Should split because 240 > 90
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk should be under or close to target
    for (const chunk of chunks) {
      const tokens = tokenCounter.count(chunk.content);
      expect(tokens).toBeLessThanOrEqual(150); // Allow some margin for paragraph boundaries
    }
  });

  it('should handle empty text', () => {
    const chunks = chunkByTokens('', makeConfig());

    expect(chunks).toHaveLength(0);
  });

  it('should preserve heading metadata when provided', () => {
    const text = 'Some content';
    const metadata = {
      headingPath: 'Section > Subsection',
      headingLevel: 2,
    };

    const chunks = chunkByTokens(text, makeConfig(), metadata);

    expect(chunks[0]).toMatchObject({
      content: text,
      headingPath: 'Section > Subsection',
      headingLevel: 2,
    });
  });

  it('should split, not reject, a single line with no line boundary left to split on', () => {
    // One line, no paragraph or line boundary: the chunker must descend to
    // words rather than throw and lose the whole document.
    const longText = 'word '.repeat(10000);
    const config = makeConfig({ modelTokenLimit: 100 }); // budget = min(460, 100) = 100

    const chunks = chunkByTokens(longText, config);

    expect(chunks.length).toBeGreaterThan(1);
    expectEveryChunkWithinBudget(chunks, config);
    expectNoContentLoss(longText, chunks);
  });

  it('should split a multi-line paragraph larger than the model limit instead of rejecting it', () => {
    // A prose block with no blank lines is ONE paragraph, so its token count
    // exceeds any realistic model limit — but every individual line fits, so it
    // is splittable and must not be rejected.
    const paragraph = Array.from(
      { length: 20 },
      (_, i) =>
        `Line ${i + 1}: detailed content for line ${i + 1} with extensive information about methodology, results and analysis.`,
    ).join('\n');
    const config = makeConfig(REAL_MODEL);

    const chunks = chunkByTokens(paragraph, config);

    expect(chunks.length).toBeGreaterThan(1);
    expectEveryChunkWithinBudget(chunks, config);
    expectNoContentLoss(paragraph, chunks);
  });

  it('should never emit a chunk above the model limit when targetChunkSize exceeds it', () => {
    // Misconfigured caller: target is above what the model can read. The budget
    // must be capped by the model limit, not by the caller's optimism.
    const text = Array.from(
      { length: 12 },
      (_, i) => `Paragraph ${i + 1} carries roughly forty tokens of ordinary prose about a topic of no importance whatsoever.`,
    ).join('\n\n');
    const config = makeConfig({ modelTokenLimit: 64 });

    const chunks = chunkByTokens(text, config);

    expect(chunks.length).toBeGreaterThan(1);
    expectEveryChunkWithinBudget(chunks, config);
    expectNoContentLoss(text, chunks);
  });

  it('should chunk a document whose single line dwarfs the model limit', () => {
    // The shipped blocker: one wide markdown table row or unwrapped bullet in a
    // real repo file made the whole document index at zero chunks.
    const config = makeConfig(REAL_MODEL);
    const line = lineOfTokens(400);
    expect(tokenCounter.count(line)).toBeGreaterThan(config.modelTokenLimit);
    const text = `Intro paragraph that fits comfortably on its own.\n\n${line}\n\nOutro paragraph.`;

    const chunks = chunkByTokens(text, config);

    expect(chunks.length).toBeGreaterThan(1);
    expectEveryChunkWithinBudget(chunks, config);
    expectNoContentLoss(text, chunks);
  });

  it('should not emit an over-budget chunk for a line between the budget and the model limit', () => {
    // The (215, 256] band: under the old guard this line passed the
    // `> modelTokenLimit` check and became its own over-budget chunk, so 35% of
    // its tokens never reached the model.
    const config = makeConfig(REAL_MODEL);
    const budget = budgetOf(config);
    const line = lineOfTokens(budget + 1);
    expect(tokenCounter.count(line)).toBeGreaterThan(budget);
    expect(tokenCounter.count(line)).toBeLessThanOrEqual(config.modelTokenLimit);
    const text = `Preamble paragraph.\n\n${line}`;

    const chunks = chunkByTokens(text, config);

    expectEveryChunkWithinBudget(chunks, config);
    expectNoContentLoss(text, chunks);
  });

  it('should split an atom with no whitespace and no sentence punctuation', () => {
    // A base64 blob: no paragraph, line, sentence or word boundary anywhere.
    const config = makeConfig(REAL_MODEL);
    const blob = 'aGVsbG93b3JsZFRoaXNJc0Jhc2U2NA'.repeat(200);

    const chunks = chunkByTokens(blob, config);

    expect(chunks.length).toBeGreaterThan(1);
    expectEveryChunkWithinBudget(chunks, config);
    expectNoContentLoss(blob, chunks);
  });

  it('should split a single enormous URL', () => {
    const config = makeConfig(REAL_MODEL);
    const url = `https://example.com/${'segment-of-a-very-long-path/'.repeat(150)}?q=1`;

    const chunks = chunkByTokens(url, config);

    expect(chunks.length).toBeGreaterThan(1);
    expectEveryChunkWithinBudget(chunks, config);
    expectNoContentLoss(url, chunks);
  });

  it('should terminate when no slice can ever fit the budget', () => {
    // Guard against an infinite loop in the character window: this tokenizer
    // prices even one character above the budget, so the window can only make
    // progress by emitting single code points.
    const config = makeConfig({ ...REAL_MODEL, tokenCounter: new HostileTokenCounter() });
    const text = 'abcdefghij';

    const chunks = chunkByTokens(text, config);

    expect(chunks).toHaveLength(text.length);
    expectNoContentLoss(text, chunks);
  });
});
