/**
 * Tests for token-aware chunking
 */

import { describe, expect, it } from 'vitest';

import { chunkByTokens } from '../../src/chunking/chunk-by-tokens.js';
import { ApproximateTokenCounter } from '../../src/token-counters/approximate-token-counter.js';

describe('chunkByTokens', () => {
  const tokenCounter = new ApproximateTokenCounter();

  it('should return single chunk if text fits in target size', () => {
    const text = 'Short text that fits easily';
    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 8191,
      paddingFactor: 0.9,
      tokenCounter,
    };

    const chunks = chunkByTokens(text, config);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(text);
  });

  it('should split text by paragraphs when too large', () => {
    const text = 'Paragraph 1 with some content.\n\nParagraph 2 with different content.';
    const config = {
      targetChunkSize: 5, // Very small to force split
      modelTokenLimit: 8191,
      paddingFactor: 0.9,
      tokenCounter,
    };

    const chunks = chunkByTokens(text, config);

    expect(chunks.length).toBeGreaterThan(1);
  });

  it('should respect padding factor', () => {
    // Create text with paragraphs that will need splitting
    const paragraph = 'word '.repeat(60); // ~60 tokens
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`; // ~240 tokens total
    const config = {
      targetChunkSize: 100,
      modelTokenLimit: 8191,
      paddingFactor: 0.9, // Effective target: 90 tokens
      tokenCounter,
    };

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
    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 8191,
      paddingFactor: 0.9,
      tokenCounter,
    };

    const chunks = chunkByTokens('', config);

    expect(chunks).toHaveLength(0);
  });

  it('should preserve heading metadata when provided', () => {
    const text = 'Some content';
    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 8191,
      paddingFactor: 0.9,
      tokenCounter,
    };
    const metadata = {
      headingPath: 'Section > Subsection',
      headingLevel: 2,
    };

    const chunks = chunkByTokens(text, config, metadata);

    expect(chunks[0]).toMatchObject({
      content: text,
      headingPath: 'Section > Subsection',
      headingLevel: 2,
    });
  });

  it('should throw error if a single unsplittable line exceeds model limit', () => {
    // One line, no paragraph or line boundary to split on: genuinely unsplittable.
    const longText = 'word '.repeat(10000);
    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 100, // Very small limit
      paddingFactor: 0.9,
      tokenCounter,
    };

    expect(() => chunkByTokens(longText, config)).toThrow();
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
    const config = {
      targetChunkSize: 256,
      modelTokenLimit: 256, // The real limit of the default local model
      paddingFactor: 0.84,
      tokenCounter,
    };

    const chunks = chunkByTokens(paragraph, config);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(tokenCounter.count(chunk.content)).toBeLessThanOrEqual(config.modelTokenLimit);
    }
  });

  it('should never emit a chunk above the model limit when targetChunkSize exceeds it', () => {
    // Misconfigured caller: target is above what the model can read. The budget
    // must be capped by the model limit, not by the caller's optimism.
    const text = Array.from(
      { length: 12 },
      (_, i) => `Paragraph ${i + 1} carries roughly forty tokens of ordinary prose about a topic of no importance whatsoever.`,
    ).join('\n\n');
    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 64,
      paddingFactor: 0.9,
      tokenCounter,
    };

    const chunks = chunkByTokens(text, config);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(tokenCounter.count(chunk.content)).toBeLessThanOrEqual(config.modelTokenLimit);
    }
  });
});
