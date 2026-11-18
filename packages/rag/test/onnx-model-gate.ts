/**
 * The test gate for suites that embed with the default ONNX model, which downloads on a cold
 * cache (docs/writing-tests.md). The cache layout is the provider's own, re-exported here.
 * Test scaffolding, not published: other packages' suites import it by relative path.
 *
 * ⛔ Nothing here touches the filesystem at import; the probe runs when a gated suite asks.
 */

import { everywhere, pathPresent } from '@vibe-agent-toolkit/utils';

import {
  DEFAULT_ONNX_MODEL,
  DEFAULT_ONNX_QUANTIZED,
  defaultOnnxCacheDir,
  onnxModelFiles,
} from '../src/embedding-providers/onnx-utils.js';

export { DEFAULT_ONNX_MODEL, DEFAULT_ONNX_QUANTIZED, defaultOnnxCacheDir, onnxModelFiles } from '../src/embedding-providers/onnx-utils.js';

/**
 * Whether the default model is already in the default cache, so embedding fetches nothing.
 * A probe the OS refuses throws rather than reading as "not cached".
 *
 * @param home - The home directory whose cache to probe; the current user's when omitted
 * @returns True when no download would happen
 */
export function onnxModelCached(home?: string): boolean {
  const cacheDir = defaultOnnxCacheDir(home);
  const { modelPath, vocabPath } = onnxModelFiles(DEFAULT_ONNX_MODEL, cacheDir, DEFAULT_ONNX_QUANTIZED);
  return [modelPath, vocabPath].every((file) =>
    pathPresent(file, { follow: cacheDir }, everywhere('source'), 'probe'),
  );
}

/**
 * Whether a suite that embeds must skip: the model is not cached and `NET_AVAILABLE=1` is not
 * set. Call it where the suite is declared, before any test stubs `HOME`.
 *
 * @returns True when embedding would need a network nobody declared
 */
export function onnxModelUnreachable(): boolean {
  return process.env['NET_AVAILABLE'] !== '1' && !onnxModelCached();
}
