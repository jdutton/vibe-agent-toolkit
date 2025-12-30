/**
 * Tests for chunking utilities
 */

import { describe, expect, it } from 'vitest';

import {
  calculateEffectiveTarget,
  generateChunkId,
  generateContentHash,
  splitByParagraphs,
  splitBySentences,
} from '../../src/chunking/utils.js';

describe('generateContentHash', () => {
  it('should generate consistent hash for same content', () => {
    const content = 'Test content';
    const hash1 = generateContentHash(content);
    const hash2 = generateContentHash(content);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 = 64 hex chars
  });

  it('should generate different hashes for different content', () => {
    const hash1 = generateContentHash('content1');
    const hash2 = generateContentHash('content2');

    expect(hash1).not.toBe(hash2);
  });
});

describe('generateChunkId', () => {
  it('should generate unique chunk IDs', () => {
    const id1 = generateChunkId('resource-123', 0);
    const id2 = generateChunkId('resource-123', 1);

    expect(id1).toBe('resource-123-chunk-0');
    expect(id2).toBe('resource-123-chunk-1');
    expect(id1).not.toBe(id2);
  });
});

describe('calculateEffectiveTarget', () => {
  it('should apply padding factor correctly', () => {
    expect(calculateEffectiveTarget(512, 0.9)).toBe(460);
    expect(calculateEffectiveTarget(512, 0.8)).toBe(409);
    expect(calculateEffectiveTarget(1000, 0.95)).toBe(950);
  });

  it('should floor the result', () => {
    expect(calculateEffectiveTarget(512, 0.85)).toBe(435); // 435.2 floored
  });
});

describe('splitByParagraphs', () => {
  const PARA_1 = 'Paragraph 1';
  const PARA_2 = 'Paragraph 2';

  it('should split text by double newlines', () => {
    const text = `${PARA_1}\n\n${PARA_2}\n\nParagraph 3`;
    const paragraphs = splitByParagraphs(text);

    expect(paragraphs).toEqual([PARA_1, PARA_2, 'Paragraph 3']);
  });

  it('should handle multiple newlines', () => {
    const text = `${PARA_1}\n\n\n\n${PARA_2}`;
    const paragraphs = splitByParagraphs(text);

    expect(paragraphs).toEqual([PARA_1, PARA_2]);
  });

  it('should filter empty paragraphs', () => {
    const text = `${PARA_1}\n\n\n\n${PARA_2}\n\n`;
    const paragraphs = splitByParagraphs(text);

    expect(paragraphs).toEqual([PARA_1, PARA_2]);
  });
});

describe('splitBySentences', () => {
  it('should split text by sentence boundaries', () => {
    const text = 'Sentence one. Sentence two! Sentence three?';
    const sentences = splitBySentences(text);

    expect(sentences).toEqual(['Sentence one', 'Sentence two', 'Sentence three']);
  });

  it('should handle mixed punctuation', () => {
    const text = 'First! Second? Third.';
    const sentences = splitBySentences(text);

    expect(sentences).toEqual(['First', 'Second', 'Third']);
  });
});
