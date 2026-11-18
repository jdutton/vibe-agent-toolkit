/**
 * Whether a suite that embeds with the local ONNX model can run without the network.
 *
 * The RAG lane's default embedder (`OnnxEmbeddingProvider` in `@vibe-agent-toolkit/rag`)
 * reads its weights from a per-machine cache and downloads them from huggingface.co on a
 * miss. A suite that embeds therefore reaches a public host whenever the cache is cold —
 * a fresh CI runner, a new machine, a TLS-intercepting proxy that refuses the certificate —
 * and fails on that host's reachability rather than on VAT's code. Network access belongs
 * only behind `NET_AVAILABLE=1` (docs/writing-tests.md), so such a suite runs when the model
 * is already cached (no network is touched) or when the network is declared available.
 *
 * ⚠️ This module states the cache layout a SECOND time; the provider owns it. The two are
 * held together by tests in `@vibe-agent-toolkit/rag`: the provider's default call names
 * {@link ONNX_MODEL_CACHE_DIR}, and its own cache lookup resolves the files
 * {@link ONNX_MODEL_FILES} names without a fetch.
 *
 * ⛔ Framework-free, like everything under `testing/`. Evaluated once at module load, like
 * `CANNOT_DENY_READS`: `describe.skipIf(...)` takes a constant, and the cache under the
 * REAL home is the one that matters, read before any test stubs `HOME`.
 */

import { homedir } from 'node:os';

import { everywhere } from '../errors/fs-fault.js';
import { pathPresent } from '../errors/path-present.js';
import { safePath } from '../path-utils.js';

/** The embedding provider's default model cache, under the real home directory. */
export const ONNX_MODEL_CACHE_DIR: string = safePath.join(homedir(), '.cache', 'vat-onnx-models');

/** The files the default model (int8-quantized all-MiniLM-L6-v2) needs, relative to the cache. */
export const ONNX_MODEL_FILES: readonly string[] = [
  'Xenova_all-MiniLM-L6-v2/model_quantized.onnx',
  'Xenova_all-MiniLM-L6-v2/vocab.txt',
];

/**
 * Whether every file of the default model is already cached, so embedding fetches nothing.
 * Read as the provider reads it, links beneath the cache followed; a probe the OS refuses
 * throws rather than reading as "not cached".
 */
export const ONNX_MODEL_CACHED: boolean = ONNX_MODEL_FILES.every((file) =>
  pathPresent(safePath.join(ONNX_MODEL_CACHE_DIR, file), { follow: ONNX_MODEL_CACHE_DIR }, everywhere('source'), 'probe'),
);

/**
 * Whether a suite that embeds must skip: the model is not cached AND the network is not
 * declared available. Gate on this, never on `CI` (`bun run validate` sets `CI=1` locally).
 * CI's `validate` and `coverage` jobs set `NET_AVAILABLE=1`, so there every such suite runs.
 */
export const ONNX_MODEL_UNREACHABLE: boolean = !ONNX_MODEL_CACHED && process.env['NET_AVAILABLE'] !== '1';
