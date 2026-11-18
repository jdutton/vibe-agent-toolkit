/**
 * The ONNX model gate, checked against a real home directory with and without the
 * model's files, and with and without the network declared. The gate is evaluated
 * at module load, so each case stubs the environment and imports a fresh copy.
 */
import { writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdirSyncReal, safePath } from '../../src/path-utils.js';
import type * as GateModule from '../../src/testing/onnx-model-gate.js';
import { createTempDir, removeTempDir } from '../../src/testing/temp-dir.js';

type Gate = typeof GateModule;

/** Load the gate afresh under a home directory of the test's own. */
async function gateUnder(home: string, netAvailable: string): Promise<Gate> {
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('NET_AVAILABLE', netAvailable);
  vi.resetModules();
  return import('../../src/testing/onnx-model-gate.js');
}

describe('onnx-model-gate', () => {
  let home: string;

  beforeEach(() => {
    home = createTempDir('onnx-model-gate-');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    removeTempDir(home);
  });

  it('reads the cache under the home directory', async () => {
    const gate = await gateUnder(home, '');
    expect(gate.ONNX_MODEL_CACHE_DIR).toBe(safePath.join(home, '.cache', 'vat-onnx-models'));
  });

  it('is unreachable with a cold cache and no network declared', async () => {
    const gate = await gateUnder(home, '');
    expect(gate.ONNX_MODEL_CACHED).toBe(false);
    expect(gate.ONNX_MODEL_UNREACHABLE).toBe(true);
  });

  it('is reachable with a cold cache when the network is declared', async () => {
    const gate = await gateUnder(home, '1');
    expect(gate.ONNX_MODEL_UNREACHABLE).toBe(false);
  });

  it('is reachable offline once every model file is cached, and not before', async () => {
    const cache = safePath.join(home, '.cache', 'vat-onnx-models');
    const first = await gateUnder(home, '');
    const [model, ...rest] = first.ONNX_MODEL_FILES;
    if (model === undefined) throw new Error('the gate names no model file');
    mkdirSyncReal(safePath.join(cache, model, '..'), { recursive: true });
    writeFileSync(safePath.join(cache, model), 'planted');

    // One file short of the set is still a download.
    expect((await gateUnder(home, '')).ONNX_MODEL_UNREACHABLE).toBe(rest.length > 0);

    for (const file of rest) writeFileSync(safePath.join(cache, file), 'planted');
    const cached = await gateUnder(home, '');
    expect(cached.ONNX_MODEL_CACHED).toBe(true);
    expect(cached.ONNX_MODEL_UNREACHABLE).toBe(false);
  });
});
