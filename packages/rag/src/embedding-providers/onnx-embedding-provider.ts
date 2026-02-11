/**
 * ONNX Embedding Provider
 *
 * Uses onnxruntime-node for native ONNX inference of embedding models.
 * No API key required, runs entirely in Node.js with native performance.
 *
 * Requires optional dependency: npm install onnxruntime-node
 *
 * Features:
 * - Pure TypeScript WordPiece tokenizer (no native tokenizer dependency)
 * - Auto-downloads models from HuggingFace CDN
 * - Batched inference for efficient multi-text embedding
 * - L2-normalized output for cosine similarity
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { EmbeddingProvider } from '../interfaces/embedding.js';

import {
  BertTokenizer,
  ensureModelFiles,
  l2Normalize,
  meanPooling,
} from './onnx-utils.js';

/**
 * Configuration for OnnxEmbeddingProvider
 */
export interface OnnxEmbeddingConfig {
  /** HuggingFace model ID (default: 'sentence-transformers/all-MiniLM-L6-v2') */
  model?: string;
  /** Embedding dimensions (default: 384) */
  dimensions?: number;
  /** Path to pre-downloaded model directory containing model.onnx and vocab.txt (optional) */
  modelPath?: string;
  /** Cache directory for auto-downloaded models (default: ~/.cache/vat-onnx-models) */
  cacheDir?: string;
  /** ONNX Runtime execution providers to try (default: let onnxruntime-node auto-detect) */
  executionProviders?: string[];
  /** Max sequence length for tokenization (default: 256) */
  maxSequenceLength?: number;
}

/** Shape of the ONNX Runtime Tensor constructor and InferenceSession we need */
interface OrtModule {
  Tensor: new (
    type: string,
    data: BigInt64Array,
    dims: readonly number[],
  ) => OrtTensor;
  InferenceSession: {
    create: (
      path: string,
      options?: { executionProviders?: string[] },
    ) => Promise<OrtSession>;
  };
}

/** Minimal ONNX tensor interface */
interface OrtTensor {
  data: Float32Array | BigInt64Array;
  dims: readonly number[];
}

/** Minimal ONNX session interface */
interface OrtSession {
  run: (feeds: Record<string, OrtTensor>) => Promise<Record<string, OrtTensor>>;
}

/** Loaded model resources */
interface LoadedModel {
  session: OrtSession;
  tokenizer: BertTokenizer;
}

/**
 * Lazily import onnxruntime-node with a clear error message.
 */
async function loadOnnxRuntime(): Promise<OrtModule> {
  try {
    const ort = await import('onnxruntime-node');
    return ort as unknown as OrtModule;
  } catch {
    throw new Error(
      'onnxruntime-node is not installed. Install with: npm install onnxruntime-node',
    );
  }
}

/**
 * Build batched ONNX tensors from tokenizer output.
 *
 * Creates int64 tensors for input_ids and attention_mask with
 * shape [batchSize, sequenceLength].
 */
function createBatchTensors(
  ort: OrtModule,
  inputIds: number[][],
  attentionMask: number[][],
  batchSize: number,
  sequenceLength: number,
): { inputIdsTensor: OrtTensor; attentionMaskTensor: OrtTensor; tokenTypeIdsTensor: OrtTensor } {
  const flatInputIds = new BigInt64Array(batchSize * sequenceLength);
  const flatMask = new BigInt64Array(batchSize * sequenceLength);

  for (let batch = 0; batch < batchSize; batch++) {
    const batchIds = inputIds[batch];
    const batchMask = attentionMask[batch];

    if (!batchIds || !batchMask) {
      continue;
    }

    for (let seq = 0; seq < sequenceLength; seq++) {
      const index = batch * sequenceLength + seq;
      flatInputIds[index] = BigInt(batchIds[seq] ?? 0);
      flatMask[index] = BigInt(batchMask[seq] ?? 0);
    }
  }

  const dims = [batchSize, sequenceLength] as const;

  // token_type_ids is all zeros for single-segment inputs (standard for embedding models)
  const flatTokenTypeIds = new BigInt64Array(batchSize * sequenceLength);

  return {
    inputIdsTensor: new ort.Tensor('int64', flatInputIds, dims),
    attentionMaskTensor: new ort.Tensor('int64', flatMask, dims),
    tokenTypeIdsTensor: new ort.Tensor('int64', flatTokenTypeIds, dims),
  };
}

/**
 * OnnxEmbeddingProvider
 *
 * Local embedding generation using ONNX Runtime for native inference.
 * Default model: sentence-transformers/all-MiniLM-L6-v2 (384 dimensions)
 *
 * Benefits:
 * - No API key required
 * - Native C++ inference performance via onnxruntime-node
 * - Pure TypeScript tokenizer (no native tokenizer dependency)
 * - Auto-downloads models from HuggingFace
 * - Batched inference support
 * - Platform-aware execution provider selection
 *
 * Note: First run downloads model files (~80MB for all-MiniLM-L6-v2 ONNX)
 */
export class OnnxEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'onnx';
  readonly model: string;
  readonly dimensions: number;

  private readonly configModelPath: string | undefined;
  private readonly cacheDir: string;
  private readonly executionProviders: string[] | undefined;
  private readonly maxSequenceLength: number;

  private initPromise: Promise<LoadedModel> | null = null;

  /**
   * Create OnnxEmbeddingProvider
   *
   * @param config - Optional configuration
   */
  constructor(config: OnnxEmbeddingConfig = {}) {
    this.model = config.model ?? 'sentence-transformers/all-MiniLM-L6-v2';
    this.dimensions = config.dimensions ?? 384;
    this.configModelPath = config.modelPath;
    this.cacheDir = config.cacheDir ?? join(homedir(), '.cache', 'vat-onnx-models');
    this.executionProviders = config.executionProviders;
    this.maxSequenceLength = config.maxSequenceLength ?? 256;
  }

  /**
   * Initialize the ONNX session and tokenizer.
   *
   * Uses a single promise to avoid race conditions when multiple
   * embed calls happen concurrently.
   */
  private async initialize(): Promise<LoadedModel> {
    this.initPromise ??= this.loadModel();
    return this.initPromise;
  }

  /**
   * Load the ONNX model and tokenizer.
   *
   * If modelPath is provided, uses it directly. Otherwise, ensures
   * model files are downloaded to the cache directory.
   */
  private async loadModel(): Promise<LoadedModel> {
    const ort = await loadOnnxRuntime();

    let modelPath: string;
    let vocabPath: string;

    if (this.configModelPath) {
      modelPath = join(this.configModelPath, 'model.onnx');
      vocabPath = join(this.configModelPath, 'vocab.txt');
    } else {
      const files = await ensureModelFiles(this.model, this.cacheDir);
      modelPath = files.modelPath;
      vocabPath = files.vocabPath;
    }

    const sessionOptions = this.executionProviders
      ? { executionProviders: this.executionProviders }
      : undefined;

    const session = await ort.InferenceSession.create(modelPath, sessionOptions);
    const tokenizer = await BertTokenizer.fromVocabFile(vocabPath);

    return { session, tokenizer };
  }

  /**
   * Embed a single text chunk
   *
   * @param text - Text to embed
   * @returns Normalized vector embedding
   */
  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);

    if (!result) {
      throw new Error('ONNX inference returned no embeddings');
    }

    return result;
  }

  /**
   * Embed multiple text chunks efficiently using batched inference.
   *
   * Tokenizes all texts, creates batched ONNX tensors, runs a single
   * inference call, then applies mean pooling and L2 normalization.
   *
   * @param texts - Array of texts to embed
   * @returns Array of normalized vector embeddings
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const { session, tokenizer } = await this.initialize();
    const ort = await loadOnnxRuntime();

    const { inputIds, attentionMask, maxLen } = tokenizer.tokenizeBatch(
      texts,
      this.maxSequenceLength,
    );

    const batchSize = texts.length;
    const { inputIdsTensor, attentionMaskTensor, tokenTypeIdsTensor } = createBatchTensors(
      ort,
      inputIds,
      attentionMask,
      batchSize,
      maxLen,
    );

    const outputs = await session.run({
      input_ids: inputIdsTensor,
      attention_mask: attentionMaskTensor,
      token_type_ids: tokenTypeIdsTensor,
    });

    const lastHiddenState = outputs['last_hidden_state'];

    if (!lastHiddenState) {
      throw new Error('ONNX model did not return last_hidden_state output');
    }

    const hiddenData = lastHiddenState.data as Float32Array;
    const pooled = meanPooling(
      hiddenData,
      attentionMask,
      batchSize,
      maxLen,
      this.dimensions,
    );

    return pooled.map((vector) => l2Normalize(vector));
  }
}
