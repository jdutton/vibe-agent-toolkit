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

  it('should throw error if single paragraph exceeds model limit', () => {
    const longText = 'word '.repeat(10000); // Very long text
    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 100, // Very small limit
      paddingFactor: 0.9,
      tokenCounter,
    };

    expect(() => chunkByTokens(longText, config)).toThrow();
  });
});
