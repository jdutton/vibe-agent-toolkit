/**
 * Minimal type declarations for onnxruntime-node.
 *
 * onnxruntime-node is an optional dependency used by OnnxEmbeddingProvider.
 * We define our own typed interfaces in onnx-embedding-provider.ts, so we
 * only need a bare module declaration to satisfy the dynamic import.
 */
declare module 'onnxruntime-node' {
  /** ONNX Runtime Tensor */
  export class Tensor {
    constructor(type: string, data: BigInt64Array | Float32Array, dims: readonly number[]);
    readonly data: Float32Array | BigInt64Array;
    readonly dims: readonly number[];
  }

  /** ONNX Runtime Inference Session */
  export class InferenceSession {
    static create(
      path: string,
      options?: { executionProviders?: string[] },
    ): Promise<InferenceSession>;
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  }
}
