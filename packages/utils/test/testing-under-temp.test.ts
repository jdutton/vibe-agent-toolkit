/**
 * `underTemp` vouches that a path handed over by code under test sits in a temp dir the test
 * owns. The built-output rule trusts its result as a temp path, so the check behind it must
 * refuse a root outside the host tmpdir and a path that leaves the root.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { normalizedTmpdir, safePath } from '../src/index.js';
import { createTempDir, removeTempDir, underTemp } from '../src/testing.js';

describe('underTemp', () => {
  const made: string[] = [];
  const mint = (): string => {
    const dir = createTempDir('vat-under-temp-');
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0)) removeTempDir(dir);
  });

  it('returns a canonical path inside the temp root unchanged, whether or not it exists yet', () => {
    const root = mint();
    const path = safePath.join(root, 'install', 'node_modules', 'pkg', 'dist', 'bin.js');
    expect(underTemp(path, root)).toBe(path);
  });

  it('refuses a path that climbs out of the temp root', () => {
    const root = mint();
    expect(() => underTemp(safePath.join(root, '..', 'elsewhere'), root)).toThrow(/is not inside the temp dir/);
  });

  it('returns the canonical path for one with a `..` segment, so what is built from it is the place it vouched for', () => {
    const root = mint();
    expect(underTemp(`${root}/a/../dist`, root)).toBe(safePath.join(root, 'dist'));
  });

  it('refuses a root that is not inside the host tmpdir', () => {
    const repoDist = safePath.resolve(import.meta.dirname, '..', 'dist');
    expect(normalizedTmpdir()).not.toBe(repoDist);
    expect(() => underTemp(safePath.join(repoDist, 'bin.js'), repoDist)).toThrow(/is not inside the host tmpdir/);
  });
});
