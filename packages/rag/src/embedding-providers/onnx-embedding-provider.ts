/**
 * ONNX Embedding Provider (WebAssembly backend)
 *
 * Local embedding generation using onnxruntime-web's WASM backend plus a pure
 * TypeScript WordPiece tokenizer. No API key required, runs entirely in Node.js.
 *
 * Why WASM (onnxruntime-web) and not the native onnxruntime-node addon:
 * - No native build step and no platform-specific binaries to download.
 * - No native static-destructor teardown race. The native runtime aborts the
 *   process (`libc++abi: mutex lock failed`, SIGABRT / exit 134) at teardown
 *   when co-loaded with another native addon (LanceDB) in one process — the
 *   WASM backend has no such destructors, so `vat rag index/query` exits 0.
 * - Pulls the patched `protobufjs@7` line, not the vulnerable `protobufjs@6`
 *   chain the old `@xenova/transformers@2` → `onnx-proto` path dragged in.
 *
 * Ships batteries-included: `onnxruntime-web` is a regular dependency, so local
 * RAG works with no extra install. Model weights are fetched from HuggingFace on
 * first use and cached under `~/.cache/vat-onnx-models`.
 */

import { homedir } from 'node:os';

import { safePath } from '@vibe-agent-toolkit/utils';

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
  /** HuggingFace model ID (default: 'Xenova/all-MiniLM-L6-v2') */
  model?: string;
  /** Embedding dimensions (default: 384) */
  dimensions?: number;
  /** Path to a pre-downloaded model directory containing the .onnx file and vocab.txt (optional) */
  modelPath?: string;
  /** Cache directory for auto-downloaded models (default: ~/.cache/vat-onnx-models) */
  cacheDir?: string;
  /**
   * Use the int8-quantized ONNX weights (`model_quantized.onnx`, ~23MB) instead
   * of the full fp32 weights (`model.onnx`, ~90MB). Default: true — matches the
   * quantized download the previous transformers.js backend used.
   */
  quantized?: boolean;
  /** Max sequence length for tokenization (default: 256) */
  maxSequenceLength?: number;
  /**
   * Number of WASM threads (default: 1). Single-threaded avoids spawning worker
   * threads, which keeps inference deterministic and teardown clean.
   */
  numThreads?: number;
}

/** WASM runtime environment knobs we set (subset of onnxruntime-web's `env`). */
interface OrtEnv {
  wasm: { numThreads: number };
}

/** Shape of the onnxruntime-web module surface we use */
interface OrtModule {
  Tensor: new (
    type: string,
    data: BigInt64Array,
    dims: readonly number[],
  ) => OrtTensor;
  InferenceSession: {
    create: (path: string) => Promise<OrtSession>;
  };
  env: OrtEnv;
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
 * Lazily import onnxruntime-web with a clear error message.
 */
async function loadOnnxRuntime(): Promise<OrtModule> {
  try {
    const ort = await import('onnxruntime-web');
    return ort as unknown as OrtModule;
  } catch (cause) {
    throw new Error(
      'onnxruntime-web is not installed. Reinstall dependencies: npm install',
      { cause },
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
 * Local embedding generation using onnxruntime-web (WASM) for inference.
 * Default model: Xenova/all-MiniLM-L6-v2 (384 dimensions, int8-quantized).
 *
 * Benefits:
 * - No API key required
 * - Pure WASM + TypeScript — no native addon, no build step
 * - No native teardown race (safe to co-load with LanceDB in one process)
 * - Pure TypeScript WordPiece tokenizer (no native tokenizer dependency)
 * - Auto-downloads and caches models from HuggingFace
 * - Batched inference support
 *
 * Note: First run downloads model files (~23MB quantized for all-MiniLM-L6-v2).
 */
export class OnnxEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'onnx';
  readonly model: string;
  readonly dimensions: number;

  private readonly configModelPath: string | undefined;
  private readonly cacheDir: string;
  private readonly quantized: boolean;
  private readonly maxSequenceLength: number;
  private readonly numThreads: number;

  private initPromise: Promise<LoadedModel> | null = null;

  /**
   * Create OnnxEmbeddingProvider
   *
   * @param config - Optional configuration
   */
  constructor(config: OnnxEmbeddingConfig = {}) {
    this.model = config.model ?? 'Xenova/all-MiniLM-L6-v2';
    this.dimensions = config.dimensions ?? 384;
    this.configModelPath = config.modelPath;
    this.cacheDir = config.cacheDir ?? safePath.join(homedir(), '.cache', 'vat-onnx-models');
    this.quantized = config.quantized ?? true;
    this.maxSequenceLength = config.maxSequenceLength ?? 256;
    this.numThreads = config.numThreads ?? 1;
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

    // Single-threaded WASM: no worker threads spawned, deterministic, clean teardown.
    ort.env.wasm.numThreads = this.numThreads;

    const onnxFileName = this.quantized ? 'model_quantized.onnx' : 'model.onnx';

    let modelPath: string;
    let vocabPath: string;

    if (this.configModelPath) {
      modelPath = safePath.join(this.configModelPath, onnxFileName);
      vocabPath = safePath.join(this.configModelPath, 'vocab.txt');
    } else {
      try {
        const files = await ensureModelFiles(this.model, this.cacheDir, this.quantized);
        modelPath = files.modelPath;
        vocabPath = files.vocabPath;
      } catch (cause) {
        throw new Error(`Failed to download ONNX model '${this.model}': ${String(cause)}`, {
          cause,
        });
      }
    }

    try {
      const session = await ort.InferenceSession.create(modelPath);
      const tokenizer = await BertTokenizer.fromVocabFile(vocabPath);

      return { session, tokenizer };
    } catch (cause) {
      throw new Error(`Failed to load ONNX model '${this.model}': ${String(cause)}`, {
        cause,
      });
    }
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
