/**
 * Unit Tests for ONNX Embedding Utilities
 *
 * Tests the pure TypeScript utilities (tokenizer, pooling, normalization)
 * without requiring onnxruntime-node or model downloads.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BertTokenizer,
  l2Normalize,
  meanPooling,
} from '../../src/embedding-providers/onnx-utils.js';

// ---------------------------------------------------------------------------
// Test Vocabulary
// ---------------------------------------------------------------------------

/**
 * Minimal BERT vocabulary for testing.
 *
 * Line number = token ID. We include the special tokens at their
 * standard BERT positions (0=[PAD], 100=[UNK], 101=[CLS], 102=[SEP])
 * plus a handful of real word/subword tokens.
 */
function buildTestVocab(): string {
  // We need tokens at specific indices:
  //   0   -> [PAD]
  //   100 -> [UNK]
  //   101 -> [CLS]
  //   102 -> [SEP]
  // Fill gaps with placeholder tokens.
  const lines: string[] = [];

  // Index 0: [PAD]
  lines[0] = '[PAD]';

  // Indices 1-99: placeholders
  for (let index = 1; index < 100; index++) {
    lines[index] = `placeholder_${index.toString()}`;
  }

  // Special tokens
  lines[100] = '[UNK]';
  lines[101] = '[CLS]';
  lines[102] = '[SEP]';

  // Real word tokens starting at 103
  lines[103] = 'hello';
  lines[104] = 'world';
  lines[105] = 'the';
  lines[106] = 'cat';
  lines[107] = 'sat';
  lines[108] = 'on';
  lines[109] = 'mat';
  lines[110] = 'test';
  lines[111] = '##ing';
  lines[112] = '##s';
  lines[113] = 'a';
  lines[114] = '.';
  lines[115] = ',';
  lines[116] = 'cafe';

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Test Setup
// ---------------------------------------------------------------------------

let vocabDir: string;
let vocabPath: string;
let tokenizer: BertTokenizer;

beforeAll(async () => {
  vocabDir = join(normalizedTmpdir(), `onnx-utils-test-${Date.now().toString()}`);
  vocabPath = join(vocabDir, 'vocab.txt');

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
  await mkdir(vocabDir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp file
  await writeFile(vocabPath, buildTestVocab(), 'utf8');

  tokenizer = await BertTokenizer.fromVocabFile(vocabPath);
});

afterAll(async () => {
  await rm(vocabDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Shared Test Helpers
// ---------------------------------------------------------------------------

/** Safely access an element from an array, returning undefined if out of bounds */
function safeGet<T>(array: T[], index: number): T | undefined {
  return array[index];
}

/** CLS token ID */
const CLS_TOKEN = 101;

/** SEP token ID */
const SEP_TOKEN = 102;

/** UNK token ID */
const UNK_TOKEN = 100;

/** Common test phrases */
const helloWorld = 'hello world';
const longPhrase = 'hello world the cat sat on the mat';

// ---------------------------------------------------------------------------
// BertTokenizer Tests
// ---------------------------------------------------------------------------

describe('BertTokenizer', () => {
  describe('fromVocabFile', () => {
    it('should create a tokenizer from a vocab file', () => {
      expect(tokenizer).toBeDefined();
    });
  });

  describe('tokenize', () => {
    it('should wrap tokens with [CLS] and [SEP]', () => {
      const result = tokenizer.tokenize('hello');

      expect(safeGet(result.inputIds, 0)).toBe(CLS_TOKEN);
      expect(safeGet(result.inputIds, result.inputIds.length - 1)).toBe(SEP_TOKEN);
    });

    it('should lowercase input text', () => {
      const result = tokenizer.tokenize('Hello');

      // "Hello" -> "hello" -> token 103
      expect(result.inputIds).toContain(103);
    });

    it('should strip accents', () => {
      // "cafe" with accent -> "cafe" after stripping -> token 116
      const result = tokenizer.tokenize('caf\u00e9');

      expect(result.inputIds).toContain(116);
    });

    it('should produce attention mask of all 1s for real tokens', () => {
      const result = tokenizer.tokenize(helloWorld);

      expect(result.attentionMask.length).toBe(result.inputIds.length);
      expect(result.attentionMask.every((v) => v === 1)).toBe(true);
    });

    it('should handle unknown tokens with [UNK]', () => {
      const result = tokenizer.tokenize('xyzzy');

      // "xyzzy" is not in the vocab -> [UNK]=100
      expect(result.inputIds).toContain(UNK_TOKEN);
    });

    it('should split on punctuation', () => {
      const result = tokenizer.tokenize('hello, world.');

      // Should include comma (115) and period (114) as separate tokens
      expect(result.inputIds).toContain(115); // comma
      expect(result.inputIds).toContain(114); // period
    });

    it('should tokenize subword pieces', () => {
      const result = tokenizer.tokenize('testing');

      // "testing" -> "test" (110) + "##ing" (111)
      expect(result.inputIds).toContain(110);
      expect(result.inputIds).toContain(111);
    });

    it('should truncate at maxLength', () => {
      // Use a very small maxLength to force truncation
      const maxLength = 5;
      const result = tokenizer.tokenize(longPhrase, maxLength);

      // maxLength=5 means at most 5 tokens total including [CLS] and [SEP]
      expect(result.inputIds.length).toBeLessThanOrEqual(maxLength);
      expect(safeGet(result.inputIds, 0)).toBe(CLS_TOKEN);
      expect(safeGet(result.inputIds, result.inputIds.length - 1)).toBe(SEP_TOKEN);
    });

    it('should handle empty string', () => {
      const result = tokenizer.tokenize('');

      // Just [CLS] and [SEP]
      expect(result.inputIds).toEqual([CLS_TOKEN, SEP_TOKEN]);
      expect(result.attentionMask).toEqual([1, 1]);
    });
  });

  describe('tokenizeBatch', () => {
    it('should tokenize multiple texts', () => {
      const result = tokenizer.tokenizeBatch(['hello', 'world']);

      expect(result.inputIds).toHaveLength(2);
      expect(result.attentionMask).toHaveLength(2);
    });

    it('should pad all sequences to the longest length', () => {
      // "hello" = 3 tokens ([CLS], hello, [SEP])
      // "hello world" = 4 tokens ([CLS], hello, world, [SEP])
      const result = tokenizer.tokenizeBatch(['hello', helloWorld]);

      const firstIds = safeGet(result.inputIds, 0);
      const secondIds = safeGet(result.inputIds, 1);

      expect(firstIds).toBeDefined();
      expect(secondIds).toBeDefined();

      // Both should be padded to the same length (maxLen)
      expect(firstIds?.length).toBe(result.maxLen);
      expect(secondIds?.length).toBe(result.maxLen);
    });

    it('should use 0 for padding in attention mask', () => {
      const result = tokenizer.tokenizeBatch(['hello', helloWorld]);

      const firstMask = safeGet(result.attentionMask, 0);
      expect(firstMask).toBeDefined();

      // The shorter sequence should have 0s at the end
      const lastMaskValue = firstMask ? safeGet(firstMask, firstMask.length - 1) : undefined;
      // If there is padding (sequences differ in length), the last value should be 0
      const clsSepHelloLength = 3; // [CLS] + hello + [SEP]
      if (firstMask && firstMask.length > clsSepHelloLength) {
        expect(lastMaskValue).toBe(0);
      }
    });

    it('should respect maxLength parameter', () => {
      const maxLength = 5;
      const result = tokenizer.tokenizeBatch(
        [longPhrase],
        maxLength,
      );

      expect(result.maxLen).toBeLessThanOrEqual(maxLength);
    });

    it('should report correct maxLen', () => {
      const result = tokenizer.tokenizeBatch(['hello', helloWorld]);

      // "hello world" = [CLS] + hello + world + [SEP] = 4 tokens
      const expectedMaxLen = 4;
      expect(result.maxLen).toBe(expectedMaxLen);
    });
  });
});

// ---------------------------------------------------------------------------
// Mean Pooling Tests
// ---------------------------------------------------------------------------

describe('meanPooling', () => {
  it('should pool a single item with uniform attention', () => {
    // 1 batch, 2 sequence positions, 3 dimensions
    // Hidden state: position 0 = [1, 2, 3], position 1 = [4, 5, 6]
    const hiddenState = new Float32Array([1, 2, 3, 4, 5, 6]);
    const attentionMasks = [[1, 1]];

    const result = meanPooling(hiddenState, attentionMasks, 1, 2, 3);

    expect(result).toHaveLength(1);

    const embedding = safeGet(result, 0);
    expect(embedding).toBeDefined();
    expect(embedding).toHaveLength(3);

    // Mean of [1,4]=2.5, [2,5]=3.5, [3,6]=4.5
    expect(safeGet(embedding ?? [], 0)).toBeCloseTo(2.5, 5);
    expect(safeGet(embedding ?? [], 1)).toBeCloseTo(3.5, 5);
    expect(safeGet(embedding ?? [], 2)).toBeCloseTo(4.5, 5);
  });

  it('should respect attention mask (ignore padding)', () => {
    // 1 batch, 3 sequence positions, 2 dimensions
    // Position 0 = [10, 20], Position 1 = [30, 40], Position 2 = [99, 99] (padding)
    const hiddenState = new Float32Array([10, 20, 30, 40, 99, 99]);
    const attentionMasks = [[1, 1, 0]]; // Position 2 is padding

    const result = meanPooling(hiddenState, attentionMasks, 1, 3, 2);

    const embedding = safeGet(result, 0);
    expect(embedding).toBeDefined();

    // Mean of [10,30]=20, [20,40]=30 (position 2 excluded by mask)
    expect(safeGet(embedding ?? [], 0)).toBeCloseTo(20, 5);
    expect(safeGet(embedding ?? [], 1)).toBeCloseTo(30, 5);
  });

  it('should handle multiple batch items', () => {
    // 2 batches, 2 sequence positions, 2 dimensions
    // Batch 0: pos0=[1,2], pos1=[3,4]
    // Batch 1: pos0=[5,6], pos1=[7,8]
    const hiddenState = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const attentionMasks = [
      [1, 1],
      [1, 1],
    ];

    const result = meanPooling(hiddenState, attentionMasks, 2, 2, 2);

    expect(result).toHaveLength(2);

    const first = safeGet(result, 0);
    const second = safeGet(result, 1);
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // Batch 0: mean([1,3])=2, mean([2,4])=3
    expect(safeGet(first ?? [], 0)).toBeCloseTo(2, 5);
    expect(safeGet(first ?? [], 1)).toBeCloseTo(3, 5);

    // Batch 1: mean([5,7])=6, mean([6,8])=7
    expect(safeGet(second ?? [], 0)).toBeCloseTo(6, 5);
    expect(safeGet(second ?? [], 1)).toBeCloseTo(7, 5);
  });

  it('should return zeros when all mask values are zero', () => {
    const hiddenState = new Float32Array([10, 20, 30, 40]);
    const attentionMasks = [[0, 0]];

    const result = meanPooling(hiddenState, attentionMasks, 1, 2, 2);

    const embedding = safeGet(result, 0);
    expect(embedding).toBeDefined();
    expect(safeGet(embedding ?? [], 0)).toBe(0);
    expect(safeGet(embedding ?? [], 1)).toBe(0);
  });

  it('should handle missing mask gracefully', () => {
    // If attentionMasks array is shorter than batchSize,
    // the missing batch should get zeros
    const hiddenState = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const attentionMasks = [[1, 1]]; // Only 1 mask but batchSize=2

    const result = meanPooling(hiddenState, attentionMasks, 2, 2, 2);

    expect(result).toHaveLength(2);

    const second = safeGet(result, 1);
    expect(second).toBeDefined();
    // Missing mask -> zeros
    expect(safeGet(second ?? [], 0)).toBe(0);
    expect(safeGet(second ?? [], 1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// L2 Normalization Tests
// ---------------------------------------------------------------------------

describe('l2Normalize', () => {
  it('should normalize a [3, 4] vector to [0.6, 0.8]', () => {
    const result = l2Normalize([3, 4]);

    expect(result).toHaveLength(2);
    expect(safeGet(result, 0)).toBeCloseTo(0.6, 10);
    expect(safeGet(result, 1)).toBeCloseTo(0.8, 10);
  });

  it('should return zero vector unchanged', () => {
    const result = l2Normalize([0, 0, 0]);

    expect(result).toEqual([0, 0, 0]);
  });

  it('should leave an already-unit vector unchanged', () => {
    // [1, 0, 0] is already a unit vector
    const result = l2Normalize([1, 0, 0]);

    expect(safeGet(result, 0)).toBeCloseTo(1, 10);
    expect(safeGet(result, 1)).toBeCloseTo(0, 10);
    expect(safeGet(result, 2)).toBeCloseTo(0, 10);
  });

  it('should produce a unit vector (magnitude = 1)', () => {
    const result = l2Normalize([1, 2, 3, 4, 5]);

    const magnitude = Math.sqrt(
      result.reduce((sum, val) => sum + val * val, 0),
    );

    expect(magnitude).toBeCloseTo(1, 10);
  });

  it('should handle single-element vectors', () => {
    const result = l2Normalize([5]);

    expect(result).toHaveLength(1);
    expect(safeGet(result, 0)).toBeCloseTo(1, 10);
  });

  it('should handle negative values', () => {
    const result = l2Normalize([-3, 4]);

    expect(safeGet(result, 0)).toBeCloseTo(-0.6, 10);
    expect(safeGet(result, 1)).toBeCloseTo(0.8, 10);
  });
});
