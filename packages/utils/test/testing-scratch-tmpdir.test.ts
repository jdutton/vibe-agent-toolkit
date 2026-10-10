/**
 * The parts of the scratch-TMPDIR test helper that are decisions, not filesystem work: it has
 * no directory outside a test, it changes nothing until it is entered, and registering it adds
 * exactly one hook on each side of a test. (Entering and leaving are covered against a real
 * temp directory in the integration tier.)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { safePath } from '../src/path-core.js';
import { getTestOutputBase, registerScratchTmpdir, scratchTmpdirEnv } from '../src/testing/temp-dir.js';

const TMPDIR_NAMES = ['TMPDIR', 'TEMP', 'TMP'] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('scratchTmpdirEnv', () => {
  it('has no scratch directory before it is entered: asking for one is a loud mistake, not undefined', () => {
    expect(() => scratchTmpdirEnv('unit-').current()).toThrow('no scratch outside enter()/leave()');
  });

  it('leaving without having entered changes no environment variable', () => {
    for (const name of TMPDIR_NAMES) vi.stubEnv(name, `/before/${name}`);
    scratchTmpdirEnv('unit-').leave();
    expect(TMPDIR_NAMES.map((name) => process.env[name])).toEqual(['/before/TMPDIR', '/before/TEMP', '/before/TMP']);
  });
});

describe('registerScratchTmpdir', () => {
  it('registers one hook before and one after each test, and makes nothing until a test runs', () => {
    for (const name of TMPDIR_NAMES) vi.stubEnv(name, `/before/${name}`);
    const beforeEach = vi.fn();
    const afterEachHook = vi.fn();

    const current = registerScratchTmpdir('unit-', { beforeEach, afterEach: afterEachHook });

    expect(beforeEach).toHaveBeenCalledTimes(1);
    expect(afterEachHook).toHaveBeenCalledTimes(1);
    expect(process.env['TMPDIR']).toBe('/before/TMPDIR');
    expect(() => current()).toThrow('no scratch outside enter()/leave()');
  });
});

describe('getTestOutputBase', () => {
  it('is the package\'s own .test-output directory under the working directory', () => {
    expect(getTestOutputBase('rag-lancedb')).toBe(safePath.join(safePath.resolve(process.cwd()), 'packages', 'rag-lancedb', '.test-output'));
  });
});
