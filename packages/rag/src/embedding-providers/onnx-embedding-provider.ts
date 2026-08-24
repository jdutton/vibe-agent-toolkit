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
  IncompatibleVocabError,
  ensureModelFiles,
  l2Normalize,
  meanPooling,
} from './onnx-utils.js';

/**
 * What a single embed call lost to the model's sequence-length cap.
 *
 * Handed to {@link OnnxEmbeddingConfig.onTruncation} for every batch that
 * dropped content, so a caller can attribute the loss to the work it just
 * submitted rather than to a running total.
 */
export interface TruncationEvent {
  /** Texts submitted in the batch. */
  textsInBatch: number;
  /** How many of them were cut short. */
  textsTruncated: number;
  /** Content tokens discarded across the batch. */
  tokensDropped: number;
  /** The cap that did the cutting. */
  maxInputTokens: number;
  /** Model whose cap applied. */
  model: string;
}

/**
 * Running total of what this provider has discarded since construction.
 */
export interface TruncationStats {
  /** Texts handed to the model. */
  textsEmbedded: number;
  /** Texts the model read only part of. */
  textsTruncated: number;
  /** Content tokens the model never saw. */
  tokensDropped: number;
}

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
  /**
   * Max sequence length for tokenization (default: 256).
   *
   * 256 is not a placeholder to be raised when chunks overflow: all-MiniLM-L6-v2
   * was TRAINED at 256 positions, so it is a property of the model. Text past
   * the cap is discarded before inference — size the chunks, not the cap.
   * Published as {@link OnnxEmbeddingProvider.maxInputTokens} so consumers can
   * read the real number instead of assuming one.
   */
  maxSequenceLength?: number;
  /**
   * Number of WASM threads (default: 1). Single-threaded avoids spawning worker
   * threads, which keeps inference deterministic and teardown clean.
   */
  numThreads?: number;
  /**
   * Called once per batch that lost content to the sequence-length cap.
   *
   * Supplying a handler takes ownership of reporting: the provider's own
   * one-shot `console.warn` is suppressed, on the assumption that a caller who
   * asked for the events will surface them itself.
   */
  onTruncation?: (event: TruncationEvent) => void;
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
  /** Frees the session's WASM-heap resources. Must be called explicitly — the WASM backend has no finalizer. */
  release: () => Promise<void>;
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

  /**
   * The model's real sequence-length cap, including [CLS] and [SEP].
   *
   * Chunkers must size against this. The default (256) is what
   * all-MiniLM-L6-v2 was trained at.
   */
  readonly maxInputTokens: number;

  private readonly configModelPath: string | undefined;
  private readonly cacheDir: string;
  private readonly quantized: boolean;
  private readonly numThreads: number;
  private readonly onTruncation: ((event: TruncationEvent) => void) | undefined;

  private initPromise: Promise<LoadedModel> | null = null;

  private readonly stats: TruncationStats = {
    textsEmbedded: 0,
    textsTruncated: 0,
    tokensDropped: 0,
  };

  /** Warn on stderr once per provider, not once per batch, to stay readable. */
  private hasWarnedAboutTruncation = false;

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
    this.maxInputTokens = config.maxSequenceLength ?? 256;
    this.numThreads = config.numThreads ?? 1;
    this.onTruncation = config.onTruncation;
  }

  /**
   * What this provider has discarded so far, as a snapshot.
   *
   * Non-zero `tokensDropped` means the corpus that was indexed is not the
   * corpus the model saw.
   */
  get truncationStats(): TruncationStats {
    return { ...this.stats };
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
      const tokenizer = await BertTokenizer.fromVocabFile(vocabPath, this.model);

      return { session, tokenizer };
    } catch (cause) {
      // An incompatible vocabulary already explains itself in full — rewrapping
      // would only bury the diagnosis inside a generic load failure.
      if (cause instanceof IncompatibleVocabError) {
        throw cause;
      }
      throw new Error(`Failed to load ONNX model '${this.model}': ${String(cause)}`, {
        cause,
      });
    }
  }

  /**
   * Release the WASM inference session's heap resources.
   *
   * The WASM backend has no finalizer, so a session that is never released
   * leaks for the lifetime of the process. Safe to call when the provider was
   * never initialized (no-op) or failed to initialize (nothing to release).
   *
   * Resets internal state so the provider transparently reloads the model on
   * the next embed()/embedBatch() call, rather than becoming permanently
   * unusable. This matters because a single embeddingProvider instance may be
   * shared across multiple LanceDBRAGProvider instances (e.g. one shared
   * local model amortized across several vector-DB stores) — closing one of
   * them must not break the others still holding a reference to this provider.
   */
  async dispose(): Promise<void> {
    if (!this.initPromise) {
      return;
    }
    const pending = this.initPromise;
    this.initPromise = null;
    try {
      const { session } = await pending;
      await session.release();
    } catch {
      // Never successfully initialized — no session to release. The original
      // initialization failure already surfaced to whoever awaited embed()/embedBatch().
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

    const { inputIds, attentionMask, maxLen, truncatedTexts, droppedTokens } =
      tokenizer.tokenizeBatch(texts, this.maxInputTokens);

    this.recordTruncation(texts.length, truncatedTexts, droppedTokens);

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

  /**
   * Book a batch's truncation toll and make it audible.
   *
   * Dropping content is never silent here: it lands in {@link truncationStats},
   * it reaches `onTruncation` if the caller wired one, and failing both it hits
   * stderr once so a `vat rag index` run cannot quietly ship a corpus the model
   * only half read.
   *
   * @param textsInBatch - Texts submitted
   * @param truncatedTexts - How many were cut short
   * @param tokensDropped - Content tokens discarded
   */
  private recordTruncation(
    textsInBatch: number,
    truncatedTexts: number,
    tokensDropped: number,
  ): void {
    this.stats.textsEmbedded += textsInBatch;

    if (truncatedTexts === 0) {
      return;
    }

    this.stats.textsTruncated += truncatedTexts;
    this.stats.tokensDropped += tokensDropped;

    if (this.onTruncation) {
      this.onTruncation({
        textsInBatch,
        textsTruncated: truncatedTexts,
        tokensDropped,
        maxInputTokens: this.maxInputTokens,
        model: this.model,
      });
      return;
    }

    if (!this.hasWarnedAboutTruncation) {
      this.hasWarnedAboutTruncation = true;
      console.warn(
        `[vat-onnx] Input truncated: ${String(truncatedTexts)} of ${String(textsInBatch)} text(s) ` +
          `exceeded the ${String(this.maxInputTokens)}-token limit of '${this.model}' and lost ` +
          `${String(tokensDropped)} token(s), which the model will not see. ` +
          'Reduce the chunk size feeding this provider. ' +
          'Further truncations are counted in truncationStats rather than warned about again.',
      );
    }
  }
}
