/**
 * ONNX Embedding Utilities
 *
 * Pure TypeScript utilities for ONNX-based embedding inference:
 * - WordPiece tokenizer (no native dependencies)
 * - Mean pooling and L2 normalization
 * - HuggingFace model file downloader
 */

import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// WordPiece Tokenizer
// ---------------------------------------------------------------------------

/** Output of a single tokenization call */
export interface TokenizerOutput {
  inputIds: number[];
  attentionMask: number[];
}

/** Batch tokenization result with padding info */
export interface BatchTokenizerOutput {
  inputIds: number[][];
  attentionMask: number[][];
  maxLen: number;
}

/** Special token IDs for BERT-style models */
const SPECIAL_TOKENS = {
  CLS: 101,
  SEP: 102,
  UNK: 100,
  PAD: 0,
} as const;

/**
 * Strip accents from a string using Unicode NFD normalization.
 *
 * Decomposes characters into base + combining marks, then removes the
 * combining diacritical marks (Unicode category Mn, range U+0300-U+036F).
 */
function stripAccents(text: string): string {
  return text.normalize('NFD').replaceAll(/[\u0300-\u036F]/g, '');
}

/**
 * Split text on whitespace and punctuation boundaries.
 *
 * Punctuation characters become individual tokens. Whitespace is consumed
 * as a delimiter. All other characters are grouped into word tokens.
 */
function splitOnPunctuation(text: string): string[] {
  const tokens: string[] = [];
  let current = '';

  for (const char of text) {
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else if (/\p{P}/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      tokens.push(char);
    } else {
      current += char;
    }
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Apply the WordPiece algorithm to a single word.
 *
 * Attempts to find the longest prefix in the vocabulary, then iterates
 * with "##" prefixed subwords. Falls back to [UNK] if no decomposition
 * is possible.
 */
function wordPieceTokenize(
  word: string,
  vocab: ReadonlyMap<string, number>,
): number[] {
  const ids: number[] = [];
  let start = 0;

  while (start < word.length) {
    let end = word.length;
    let foundId: number | undefined;

    while (start < end) {
      const substr = start === 0 ? word.slice(0, end) : `##${word.slice(start, end)}`;
      const vocabId = vocab.get(substr);

      if (vocabId !== undefined) {
        foundId = vocabId;
        break;
      }
      end--;
    }

    if (foundId === undefined) {
      return [SPECIAL_TOKENS.UNK];
    }

    ids.push(foundId);
    start = end;
  }

  return ids;
}

/**
 * Pad an array of numbers to a target length with a pad value.
 */
function padArray(source: number[], targetLength: number, padValue: number): number[] {
  if (source.length >= targetLength) {
    return source;
  }
  const padded = new Array<number>(targetLength).fill(padValue);
  for (const [index, value] of source.entries()) {
    padded[index] = value;
  }
  return padded;
}

/**
 * Parse a vocab.txt file into a token-to-id map.
 *
 * Each line in the file corresponds to a token, with the line number
 * (0-indexed) as the token ID. Empty lines are skipped.
 */
function parseVocab(content: string): Map<string, number> {
  const lines = content.split('\n');
  const vocab = new Map<string, number>();

  for (const [index, token] of lines.entries()) {
    if (token.length > 0) {
      vocab.set(token, index);
    }
  }

  return vocab;
}

/**
 * A pure TypeScript WordPiece tokenizer for BERT-style models.
 *
 * Loads vocabulary from a vocab.txt file and performs basic BERT
 * preprocessing: lowercase, strip accents, split on whitespace
 * and punctuation, then apply the WordPiece algorithm.
 */
export class BertTokenizer {
  private readonly vocab: ReadonlyMap<string, number>;

  private constructor(vocab: ReadonlyMap<string, number>) {
    this.vocab = vocab;
  }

  /**
   * Create a tokenizer from a vocab.txt file.
   *
   * The file should contain one token per line, where the line number
   * (0-indexed) corresponds to the token ID.
   *
   * @param vocabPath - Absolute path to vocab.txt
   * @returns Initialized BertTokenizer
   */
  static async fromVocabFile(vocabPath: string): Promise<BertTokenizer> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- vocabPath is from model cache, not user input
    const content = await readFile(vocabPath, 'utf8');
    const vocab = parseVocab(content);
    return new BertTokenizer(vocab);
  }

  /**
   * Tokenize a single text string.
   *
   * Applies BERT preprocessing (lowercase, strip accents, split on
   * punctuation), then WordPiece tokenization. Adds [CLS] and [SEP]
   * special tokens. Truncates to maxLength if necessary.
   *
   * @param text - Input text
   * @param maxLength - Maximum sequence length including special tokens (default: 256)
   * @returns Token IDs and attention mask
   */
  tokenize(text: string, maxLength = 256): TokenizerOutput {
    const processed = stripAccents(text.toLowerCase());
    const words = splitOnPunctuation(processed);

    const tokenIds: number[] = [SPECIAL_TOKENS.CLS];

    // Reserve 2 slots for [CLS] and [SEP]
    const maxContentTokens = maxLength - 2;

    for (const word of words) {
      if (tokenIds.length - 1 >= maxContentTokens) {
        break;
      }
      const wordIds = wordPieceTokenize(word, this.vocab);
      for (const id of wordIds) {
        if (tokenIds.length - 1 >= maxContentTokens) {
          break;
        }
        tokenIds.push(id);
      }
    }

    tokenIds.push(SPECIAL_TOKENS.SEP);

    const attentionMask = new Array<number>(tokenIds.length).fill(1);

    return { inputIds: tokenIds, attentionMask };
  }

  /**
   * Tokenize a batch of texts with padding to the longest sequence.
   *
   * All sequences are padded to the same length so they can be
   * combined into a single batched tensor for ONNX inference.
   *
   * @param texts - Array of input texts
   * @param maxLength - Maximum sequence length including special tokens (default: 256)
   * @returns Padded token IDs, attention masks, and the padded sequence length
   */
  tokenizeBatch(texts: string[], maxLength = 256): BatchTokenizerOutput {
    const tokenized = texts.map((text) => this.tokenize(text, maxLength));

    let maxLen = 0;
    for (const item of tokenized) {
      if (item.inputIds.length > maxLen) {
        maxLen = item.inputIds.length;
      }
    }

    const inputIds = tokenized.map((item) =>
      padArray(item.inputIds, maxLen, SPECIAL_TOKENS.PAD),
    );
    const attentionMask = tokenized.map((item) =>
      padArray(item.attentionMask, maxLen, 0),
    );

    return { inputIds, attentionMask, maxLen };
  }
}

// ---------------------------------------------------------------------------
// Mean Pooling
// ---------------------------------------------------------------------------

/**
 * Pool a single batch item from the hidden state using its attention mask.
 *
 * Sums token embeddings weighted by the attention mask, then divides by the
 * number of non-padding tokens to produce a mean-pooled embedding.
 */
function poolSingleItem(
  lastHiddenState: Float32Array,
  mask: number[],
  batchIndex: number,
  sequenceLength: number,
  embeddingDim: number,
): number[] {
  const embedding = new Array<number>(embeddingDim).fill(0);
  let maskSum = 0;

  for (let seq = 0; seq < sequenceLength; seq++) {
    const maskValue = mask[seq] ?? 0;
    maskSum += maskValue;

    if (maskValue === 0) {
      continue;
    }

    const offset = (batchIndex * sequenceLength + seq) * embeddingDim;
    for (let dim = 0; dim < embeddingDim; dim++) {
      const current = embedding[dim] ?? 0;
      embedding[dim] = current + (lastHiddenState[offset + dim] ?? 0);
    }
  }

  if (maskSum > 0) {
    for (let dim = 0; dim < embeddingDim; dim++) {
      const current = embedding[dim] ?? 0;
      embedding[dim] = current / maskSum;
    }
  }

  return embedding;
}

/**
 * Apply mean pooling to the last hidden state of a transformer model.
 *
 * Weights each token embedding by its attention mask value (0 or 1) so
 * that padding tokens are excluded from the mean. Returns one embedding
 * vector per batch item.
 *
 * @param lastHiddenState - Raw model output, shape [batch, seq, dim], as Float32Array
 * @param attentionMasks - Attention masks for each batch item
 * @param batchSize - Number of items in the batch
 * @param sequenceLength - Padded sequence length
 * @param embeddingDim - Embedding dimensionality (e.g. 384)
 * @returns Array of embedding vectors (one per batch item)
 */
export function meanPooling(
  lastHiddenState: Float32Array,
  attentionMasks: number[][],
  batchSize: number,
  sequenceLength: number,
  embeddingDim: number,
): number[][] {
  const results: number[][] = [];

  for (let batch = 0; batch < batchSize; batch++) {
    const mask = attentionMasks[batch];

    if (!mask) {
      results.push(new Array<number>(embeddingDim).fill(0));
      continue;
    }

    results.push(
      poolSingleItem(lastHiddenState, mask, batch, sequenceLength, embeddingDim),
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// L2 Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a vector to unit length using L2 (Euclidean) norm.
 *
 * If the vector has zero magnitude, returns the vector unchanged.
 *
 * @param vector - Input vector
 * @returns Unit-length vector
 */
export function l2Normalize(vector: number[]): number[] {
  let sumSquared = 0;
  for (const value of vector) {
    sumSquared += value * value;
  }

  const magnitude = Math.sqrt(sumSquared);

  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

// ---------------------------------------------------------------------------
// Model File Download
// ---------------------------------------------------------------------------

/**
 * Check whether a file exists at the given path.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is constructed from known cache directory
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download a file from a URL to a local path.
 *
 * Creates parent directories as needed. Buffers the response body
 * and writes to disk.
 */
async function downloadFile(url: string, destination: string): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- destination is constructed from known cache directory
  await mkdir(dirname(destination), { recursive: true });

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to download ${url}: ${response.status.toString()} ${response.statusText}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- destination is constructed from known cache directory
  await writeFile(destination, Buffer.from(arrayBuffer));
}

/**
 * Ensure that model.onnx and vocab.txt files are available locally.
 *
 * Downloads from HuggingFace CDN if the files are not already cached.
 * Uses the pattern:
 *   https://huggingface.co/{modelId}/resolve/main/onnx/model.onnx
 *   https://huggingface.co/{modelId}/resolve/main/vocab.txt
 *
 * @param modelId - HuggingFace model ID (e.g. 'sentence-transformers/all-MiniLM-L6-v2')
 * @param cacheDir - Local directory for cached model files
 * @returns Paths to the model and vocab files
 */
export async function ensureModelFiles(
  modelId: string,
  cacheDir: string,
): Promise<{ modelPath: string; vocabPath: string }> {
  const modelDir = join(cacheDir, modelId.replaceAll('/', '_'));
  const modelPath = join(modelDir, 'model.onnx');
  const vocabPath = join(modelDir, 'vocab.txt');

  const baseUrl = `https://huggingface.co/${modelId}/resolve/main`;

  const modelExists = await fileExists(modelPath);
  if (!modelExists) {
    const modelUrl = `${baseUrl}/onnx/model.onnx`;
    console.log(`[vat-onnx] Downloading model: ${modelUrl}`);
    console.log(`[vat-onnx] Destination: ${modelPath}`);
    await downloadFile(modelUrl, modelPath);
    console.log('[vat-onnx] Model download complete.');
  }

  const vocabExists = await fileExists(vocabPath);
  if (!vocabExists) {
    const vocabUrl = `${baseUrl}/vocab.txt`;
    console.log(`[vat-onnx] Downloading vocab: ${vocabUrl}`);
    await downloadFile(vocabUrl, vocabPath);
    console.log('[vat-onnx] Vocab download complete.');
  }

  return { modelPath, vocabPath };
}
