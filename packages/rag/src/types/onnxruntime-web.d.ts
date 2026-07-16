/**
 * Minimal type declarations for onnxruntime-web.
 *
 * onnxruntime-web ships types, but they are not resolvable under NodeNext
 * moduleResolution because the package's `exports` map routes the Node build to
 * `dist/ort.node.min.mjs` without a matching `types` condition. We only use a
 * tiny slice of the surface (and define our own typed interfaces in
 * onnx-embedding-provider.ts), so this bare module declaration is enough to
 * satisfy the dynamic import.
 */
declare module 'onnxruntime-web' {
  /** ONNX Runtime Tensor */
  export class Tensor {
    constructor(type: string, data: BigInt64Array | Float32Array, dims: readonly number[]);
    readonly data: Float32Array | BigInt64Array;
    readonly dims: readonly number[];
  }

  /** ONNX Runtime Inference Session */
  export class InferenceSession {
    static create(path: string): Promise<InferenceSession>;
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  }

  /** Runtime environment knobs (subset). */
  export const env: {
    wasm: { numThreads: number; wasmPaths?: string };
  };
}
