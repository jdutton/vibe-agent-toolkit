/**
 * Behavioral unit tests for OnnxEmbeddingProvider's WASM session lifecycle.
 *
 * Mocks onnxruntime-web and the model-download/tokenizer utilities so these
 * tests exercise config effects (quantized, numThreads, modelPath) and
 * error/dispose paths without a real model download or WASM inference.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { OnnxEmbeddingProvider } from '../../src/embedding-providers/onnx-embedding-provider.js';
import { BertTokenizer, ensureModelFiles } from '../../src/embedding-providers/onnx-utils.js';
import type * as OnnxUtils from '../../src/embedding-providers/onnx-utils.js';

const mockRelease = vi.fn();
const mockRun = vi.fn();
const mockSessionCreate = vi.fn();
const mockEnv = { wasm: { numThreads: 0 } };

vi.mock('onnxruntime-web', () => ({
  Tensor: class MockTensor {
    constructor(
      public type: string,
      public data: unknown,
      public dims: readonly number[],
    ) {}
  },
  InferenceSession: {
    create: (path: string) => mockSessionCreate(path) as unknown,
  },
  env: mockEnv,
}));

vi.mock('../../src/embedding-providers/onnx-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof OnnxUtils>();
  return {
    ...actual,
    ensureModelFiles: vi.fn(),
    BertTokenizer: {
      fromVocabFile: vi.fn(),
    },
  };
});

const mockEnsureModelFiles = vi.mocked(ensureModelFiles);
const mockFromVocabFile = vi.mocked(BertTokenizer.fromVocabFile);

const EMBEDDING_DIM = 384;
const SEQ_LEN = 2;

describe('OnnxEmbeddingProvider - session lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.wasm.numThreads = 0;

    mockEnsureModelFiles.mockResolvedValue({
      modelPath: '/cache/model_quantized.onnx',
      vocabPath: '/cache/vocab.txt',
    });
    mockFromVocabFile.mockResolvedValue({
      tokenizeBatch: () => ({
        inputIds: [[101, 102]],
        attentionMask: [[1, 1]],
        maxLen: SEQ_LEN,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked module surface
    } as any);
    mockSessionCreate.mockResolvedValue({ run: mockRun, release: mockRelease });
    mockRun.mockResolvedValue({
      last_hidden_state: { data: new Float32Array(SEQ_LEN * EMBEDDING_DIM) },
    });
    mockRelease.mockResolvedValue(undefined);
  });

  it('dispose() before any embed call is a no-op', async () => {
    const provider = new OnnxEmbeddingProvider();

    await expect(provider.dispose()).resolves.toBeUndefined();

    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('dispose() releases the WASM session after a successful embed', async () => {
    const provider = new OnnxEmbeddingProvider();
    await provider.embed('hello');

    await provider.dispose();

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('reinitializes on the next embed() after dispose(), instead of reusing the released session', async () => {
    // A single provider instance may be shared across multiple RAG-provider
    // lifetimes (e.g. one shared local model amortized across several vector-DB
    // stores). Disposing it via one owner must not permanently break it for
    // whoever else still holds a reference and calls embed() again.
    const provider = new OnnxEmbeddingProvider();
    await provider.embed('hello');
    await provider.dispose();

    await provider.embed('hello again');

    expect(mockSessionCreate).toHaveBeenCalledTimes(2);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('dispose() does not throw when initialization failed', async () => {
    mockEnsureModelFiles.mockRejectedValueOnce(new Error('network down'));
    const provider = new OnnxEmbeddingProvider();
    await expect(provider.embed('hello')).rejects.toThrow(/Failed to download ONNX model/);

    await expect(provider.dispose()).resolves.toBeUndefined();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('quantized: true (the default) requests the quantized model file', async () => {
    const provider = new OnnxEmbeddingProvider();

    await provider.embed('hello');

    expect(mockEnsureModelFiles).toHaveBeenCalledWith(expect.any(String), expect.any(String), true);
  });

  it('quantized: false requests the full-precision model file', async () => {
    const provider = new OnnxEmbeddingProvider({ quantized: false });

    await provider.embed('hello');

    expect(mockEnsureModelFiles).toHaveBeenCalledWith(expect.any(String), expect.any(String), false);
  });

  it('applies the numThreads config to the WASM runtime env', async () => {
    const provider = new OnnxEmbeddingProvider({ numThreads: 4 });

    await provider.embed('hello');

    expect(mockEnv.wasm.numThreads).toBe(4);
  });

  it('modelPath skips ensureModelFiles and loads directly from the given directory', async () => {
    const provider = new OnnxEmbeddingProvider({ modelPath: '/pre-downloaded/model' });

    await provider.embed('hello');

    expect(mockEnsureModelFiles).not.toHaveBeenCalled();
    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.stringContaining('model_quantized.onnx'),
    );
  });

  it('wraps a session-creation failure with model context', async () => {
    mockSessionCreate.mockRejectedValueOnce(new Error('bad onnx file'));
    const provider = new OnnxEmbeddingProvider();

    await expect(provider.embed('hello')).rejects.toThrow(/Failed to load ONNX model/);
  });

  it('throws a descriptive error when the model does not return last_hidden_state', async () => {
    mockRun.mockResolvedValueOnce({});
    const provider = new OnnxEmbeddingProvider();

    await expect(provider.embed('hello')).rejects.toThrow(/last_hidden_state/);
  });
});
