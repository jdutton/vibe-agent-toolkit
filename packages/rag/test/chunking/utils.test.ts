/**
 * Tests for chunking utilities
 */

import { describe, expect, it } from 'vitest';

import {
  calculateEffectiveTarget,
  generateChunkId,
  generateContentHash,
  splitByLines,
  splitByParagraphs,
  splitBySentences,
  splitByWords,
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
  it('should split text by sentence boundaries, retaining the terminator', () => {
    const text = 'Sentence one. Sentence two! Sentence three?';
    const sentences = splitBySentences(text);

    expect(sentences).toEqual(['Sentence one.', 'Sentence two!', 'Sentence three?']);
  });

  it('should handle mixed punctuation', () => {
    const text = 'First! Second? Third.';
    const sentences = splitBySentences(text);

    expect(sentences).toEqual(['First!', 'Second?', 'Third.']);
  });

  it('should lose no non-whitespace character', () => {
    // The pieces are re-joined onto the shipping chunk path: a dropped '.' is a
    // content-loss bug, not a cosmetic one.
    const text = 'Ellipses... then a question? And an exclamation!! Finally, no terminator';
    const sentences = splitBySentences(text);

    const strip = (value: string): string => value.replaceAll(/\s+/gu, '');
    expect(strip(sentences.join(''))).toBe(strip(text));
  });

  it('should return the whole text when there is no terminator', () => {
    expect(splitBySentences('no terminator here')).toEqual(['no terminator here']);
  });

  it('should return punctuation-only text rather than dropping it', () => {
    expect(splitBySentences('...')).toEqual(['...']);
  });

  it('should return an empty array for whitespace-only text', () => {
    expect(splitBySentences('   \n  ')).toEqual([]);
  });
});

describe('splitByLines', () => {
  it('should split on newlines and drop blank lines', () => {
    expect(splitByLines('one\ntwo\n\n   \nthree')).toEqual(['one', 'two', 'three']);
  });

  it('should return a single-line text unchanged', () => {
    expect(splitByLines('only one line')).toEqual(['only one line']);
  });
});

describe('splitByWords', () => {
  it('should split on any run of whitespace', () => {
    expect(splitByWords('one  two\tthree\nfour')).toEqual(['one', 'two', 'three', 'four']);
  });

  it('should ignore leading and trailing whitespace', () => {
    expect(splitByWords('  padded  ')).toEqual(['padded']);
  });

  it('should return a single atom when there is no whitespace', () => {
    expect(splitByWords('unbreakable')).toEqual(['unbreakable']);
  });
});
