/**
 * The ONNX model gate, checked against a home directory of the test's own with and without
 * the model's files, and with and without the network declared.
 */
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { createTempDir, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ONNX_MODEL,
  DEFAULT_ONNX_QUANTIZED,
  defaultOnnxCacheDir,
  onnxModelCached,
  onnxModelFiles,
  onnxModelUnreachable,
} from '../../src/testing.js';

/** Point the current user's home, and the network declaration, at the test's own. */
function stubHome(home: string, netAvailable: string): void {
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('NET_AVAILABLE', netAvailable);
}

describe('onnx model gate', () => {
  let home: string;

  beforeEach(() => {
    home = createTempDir('onnx-model-gate-');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    removeTempDir(home);
  });

  it('reads the cache under the home directory', () => {
    stubHome(home, '');
    expect(defaultOnnxCacheDir()).toBe(safePath.join(home, '.cache', 'vat-onnx-models'));
  });

  it('is unreachable with a cold cache and no network declared', () => {
    stubHome(home, '');
    expect(onnxModelCached()).toBe(false);
    expect(onnxModelUnreachable()).toBe(true);
  });

  it('is reachable with a cold cache when the network is declared', () => {
    stubHome(home, '1');
    expect(onnxModelUnreachable()).toBe(false);
  });

  it('is reachable offline once every model file is cached, and not before', () => {
    stubHome(home, '');
    const { modelPath, vocabPath } = onnxModelFiles(DEFAULT_ONNX_MODEL, defaultOnnxCacheDir(), DEFAULT_ONNX_QUANTIZED);
    mkdirSyncReal(dirname(modelPath), { recursive: true });
    writeFileSync(modelPath, 'planted');

    // One file short of the set is still a download.
    expect(onnxModelUnreachable()).toBe(true);

    writeFileSync(vocabPath, 'planted');
    expect(onnxModelCached()).toBe(true);
    expect(onnxModelCached(home)).toBe(true);
    expect(onnxModelUnreachable()).toBe(false);
  });
});
