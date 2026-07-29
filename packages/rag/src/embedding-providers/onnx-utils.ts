/**
 * ONNX Embedding Utilities
 *
 * Pure TypeScript utilities for ONNX-based embedding inference:
 * - WordPiece tokenizer (no native dependencies)
 * - Mean pooling and L2 normalization
 * - HuggingFace model file downloader
 */

import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { safePath } from '@vibe-agent-toolkit/utils';

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

/**
 * Special token literals every BERT-style WordPiece vocabulary defines.
 *
 * Only the *literals* are fixed — the ids are resolved from the loaded vocab
 * file (see `resolveSpecialTokens`). Hardcoding the classic BERT ids
 * (101/102/100/0) would silently mis-frame any model whose vocab orders these
 * differently, degrading embeddings with no error and no dimension mismatch.
 */
const SPECIAL_TOKEN_LITERALS = {
  cls: '[CLS]',
  sep: '[SEP]',
  unk: '[UNK]',
  pad: '[PAD]',
} as const;

/**
 * Special token literals used by RoBERTa / XLM-R derived encoders.
 *
 * These models use byte-level BPE or SentencePiece, not WordPiece, so their
 * vocabularies are unusable here. Detecting them lets the error tell the caller
 * *why* their model is incompatible rather than just what is missing.
 */
const NON_WORDPIECE_TOKEN_LITERALS = ['<s>', '</s>', '<pad>', '<unk>', '<mask>'] as const;

/** Special token ids resolved from a loaded vocabulary. */
export interface SpecialTokenIds {
  cls: number;
  sep: number;
  unk: number;
  pad: number;
}

/**
 * Build the message for an incompatible vocabulary.
 *
 * Names the configured model, the vocab file, which special tokens were
 * missing, and (when recognizable) which family the vocab actually belongs to.
 */
function buildIncompatibleVocabMessage(details: {
  vocabPath: string;
  missingTokens: readonly string[];
  foundInstead: readonly string[];
  modelId: string | undefined;
}): string {
  const subject =
    details.modelId === undefined
      ? 'The configured ONNX embedding model'
      : `ONNX embedding model '${details.modelId}'`;

  const lines = [
    `${subject} does not ship a BERT-style WordPiece vocabulary.`,
    `Vocab file: ${details.vocabPath}`,
    `Expected special tokens: ${Object.values(SPECIAL_TOKEN_LITERALS).join(', ')}`,
    `Missing from the vocab: ${details.missingTokens.join(', ')}`,
  ];

  if (details.foundInstead.length > 0) {
    lines.push(
      `Found instead: ${details.foundInstead.join(', ')} — these belong to RoBERTa/XLM-R style ` +
        'byte-level BPE or SentencePiece tokenizers, which this WordPiece tokenizer cannot use.',
    );
  }

  lines.push(
    "Use a BERT-family embedding model (the default 'Xenova/all-MiniLM-L6-v2' is one), or supply " +
      'a model whose vocab.txt defines the tokens above.',
  );

  return lines.join('\n');
}

/**
 * Thrown at load time when a vocabulary file is not a BERT-style WordPiece
 * vocabulary.
 *
 * Failing loudly here is deliberate: framing a non-WordPiece vocab with BERT
 * special tokens produces embeddings that are wrong but structurally valid, so
 * the index would silently degrade with no way for a user to notice. There is
 * no bypass flag by design.
 */
export class IncompatibleVocabError extends Error {
  readonly vocabPath: string;
  readonly missingTokens: readonly string[];
  readonly modelId: string | undefined;

  constructor(details: {
    vocabPath: string;
    missingTokens: readonly string[];
    foundInstead: readonly string[];
    modelId: string | undefined;
  }) {
    super(buildIncompatibleVocabMessage(details));
    this.name = 'IncompatibleVocabError';
    this.vocabPath = details.vocabPath;
    this.missingTokens = details.missingTokens;
    this.modelId = details.modelId;
  }
}

/**
 * Resolve the BERT special token ids from a loaded vocabulary.
 *
 * @throws IncompatibleVocabError if any special token literal is absent — the
 *   signal that this vocabulary is not WordPiece-shaped.
 */
function resolveSpecialTokens(
  vocab: ReadonlyMap<string, number>,
  vocabPath: string,
  modelId: string | undefined,
): SpecialTokenIds {
  const cls = vocab.get(SPECIAL_TOKEN_LITERALS.cls);
  const sep = vocab.get(SPECIAL_TOKEN_LITERALS.sep);
  const unk = vocab.get(SPECIAL_TOKEN_LITERALS.unk);
  const pad = vocab.get(SPECIAL_TOKEN_LITERALS.pad);

  if (cls === undefined || sep === undefined || unk === undefined || pad === undefined) {
    throw new IncompatibleVocabError({
      vocabPath,
      missingTokens: Object.values(SPECIAL_TOKEN_LITERALS).filter(
        (literal) => !vocab.has(literal),
      ),
      foundInstead: NON_WORDPIECE_TOKEN_LITERALS.filter((literal) => vocab.has(literal)),
      modelId,
    });
  }

  return { cls, sep, unk, pad };
}

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
  unkId: number,
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
      return [unkId];
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
  private readonly specialTokens: SpecialTokenIds;

  private constructor(vocab: ReadonlyMap<string, number>, specialTokens: SpecialTokenIds) {
    this.vocab = vocab;
    this.specialTokens = specialTokens;
  }

  /**
   * Create a tokenizer from a vocab.txt file.
   *
   * The file should contain one token per line, where the line number
   * (0-indexed) corresponds to the token ID. The [CLS]/[SEP]/[UNK]/[PAD] ids
   * are read from the file, not assumed.
   *
   * @param vocabPath - Absolute path to vocab.txt
   * @param modelId - Configured model id, used only to make load errors actionable
   * @returns Initialized BertTokenizer
   * @throws IncompatibleVocabError if the vocab is not BERT-style WordPiece
   */
  static async fromVocabFile(vocabPath: string, modelId?: string): Promise<BertTokenizer> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- vocabPath is from model cache, not user input
    const content = await readFile(vocabPath, 'utf8');
    const vocab = parseVocab(content);
    return new BertTokenizer(vocab, resolveSpecialTokens(vocab, vocabPath, modelId));
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

    const tokenIds: number[] = [this.specialTokens.cls];

    // Reserve 2 slots for [CLS] and [SEP]
    const maxContentTokens = maxLength - 2;

    for (const word of words) {
      if (tokenIds.length - 1 >= maxContentTokens) {
        break;
      }
      const wordIds = wordPieceTokenize(word, this.vocab, this.specialTokens.unk);
      for (const id of wordIds) {
        if (tokenIds.length - 1 >= maxContentTokens) {
          break;
        }
        tokenIds.push(id);
      }
    }

    tokenIds.push(this.specialTokens.sep);

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
      padArray(item.inputIds, maxLen, this.specialTokens.pad),
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
 * Ensure that the ONNX weights and vocab.txt files are available locally.
 *
 * Downloads from HuggingFace CDN if the files are not already cached.
 * Uses the pattern:
 *   https://huggingface.co/{modelId}/resolve/main/onnx/{model.onnx|model_quantized.onnx}
 *   https://huggingface.co/{modelId}/resolve/main/vocab.txt
 *
 * @param modelId - HuggingFace model ID (e.g. 'Xenova/all-MiniLM-L6-v2')
 * @param cacheDir - Local directory for cached model files
 * @param quantized - Fetch the int8-quantized weights (`model_quantized.onnx`, ~23MB)
 *   instead of the full fp32 `model.onnx` (~90MB). Default: true.
 * @returns Paths to the model and vocab files
 */
export async function ensureModelFiles(
  modelId: string,
  cacheDir: string,
  quantized = true,
): Promise<{ modelPath: string; vocabPath: string }> {
  const onnxFileName = quantized ? 'model_quantized.onnx' : 'model.onnx';
  const modelDir = safePath.join(cacheDir, modelId.replaceAll('/', '_'));
  const modelPath = safePath.join(modelDir, onnxFileName);
  const vocabPath = safePath.join(modelDir, 'vocab.txt');

  const baseUrl = `https://huggingface.co/${modelId}/resolve/main`;

  const modelExists = await fileExists(modelPath);
  if (!modelExists) {
    const modelUrl = `${baseUrl}/onnx/${onnxFileName}`;
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
