/**
 * The three realpath-backed helpers in `path-utils` — `normalizePath`,
 * `normalizedTmpdir`, `mkdirSyncReal` — used to answer EVERY realpath failure
 * with the lexical path: native throws → try the JS walk → that throws → hand
 * back the input. Absence is the one case that answer is documented for (a
 * path that does not exist has no realpath). A refusal — `EACCES` on an
 * ancestor, `ELOOP` on a symlink cycle — is a path that IS there, and handing
 * back its lexical spelling put a lexical path where every caller compares
 * canonical ones: `marketplace/validate.ts`'s containment check judged such a
 * path by the spelling the OS had just refused to resolve.
 *
 * Injected through a `realpathSync.native` spy scoped to one path, for the
 * usual reason (`chmod` reaches one errno, only where POSIX modes bind, and not
 * as root). The symlink-cycle case is real where the host can make symlinks.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import fs from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdirSyncReal, normalizedTmpdir, normalizePath, safePath, toForwardSlash } from '../src/path-utils.js';
import { createSymlink, setupSyncTempDirSuite, symlinkCapability } from '../src/test-helpers.js';

import { errnoOf } from './test-helpers.js';

/** Make `realpathSync.native` throw `code` for ONE path; everything else passes through. */
function refuseNativeRealpathOf(target: string, code: string): () => void {
  const refused = toForwardSlash(target);
  const original = fs.realpathSync.native;
  const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((asked: fs.PathLike, options?: unknown) => {
    if (toForwardSlash(String(asked)) === refused) {
      throw Object.assign(new Error(`${code}: injected, realpath '${String(asked)}'`), { code });
    }
    return (original as (...args: unknown[]) => string)(asked, options);
  }) as typeof fs.realpathSync.native);
  return () => spy.mockRestore();
}

describe('path-utils realpath helpers: absence is the only failure answered lexically', () => {
  const suite = setupSyncTempDirSuite('path-utils-realpath');
  let root: string;
  let restore: (() => void) | undefined;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    root = suite.getTempDir();
  });
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  describe('normalizePath', () => {
    it('answers an absent path with its lexical resolution (positive control)', () => {
      const missing = safePath.join(root, 'no', 'such', 'file.md');
      expect(toForwardSlash(normalizePath(missing))).toBe(safePath.resolve(missing));
    });

    it('answers a present path with its realpath', () => {
      const present = safePath.join(root, 'present.md');
      fs.writeFileSync(present, '');
      expect(normalizePath(present)).toBe(fs.realpathSync.native(present));
    });

    it.each(['EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG'])('throws when the OS refuses the path with %s', (code) => {
      const present = safePath.join(root, 'refused.md');
      fs.writeFileSync(present, '');
      restore = refuseNativeRealpathOf(present, code);
      expect(errnoOf(() => normalizePath(present))).toBe(code);
    });

    it('falls through to the JS realpath when the native call reports a present path absent', () => {
      // Node's own docs: the native `realpath(3)` cannot work on a musl libc
      // without procfs, and reports that as ENOENT for a path that exists.
      const present = safePath.join(root, 'musl.md');
      fs.writeFileSync(present, '');
      restore = refuseNativeRealpathOf(present, 'ENOENT');
      expect(normalizePath(present)).toBe(fs.realpathSync(present));
    });

    it('throws ELOOP on a real symlink cycle rather than pretending the cycle is a path', ({ skip }) => {
      const cap = symlinkCapability() ?? skip();
      const loop = safePath.join(root, 'loop');
      createSymlink(cap, 'loop', loop);
      expect(errnoOf(() => normalizePath(loop))).toBe('ELOOP');
    });
  });

  describe('normalizedTmpdir', () => {
    it('returns the realpath of the OS tmpdir (positive control)', () => {
      expect(normalizedTmpdir()).toBe(fs.realpathSync.native(normalizedTmpdir()));
    });

    it('throws when the OS refuses the tmpdir rather than handing back a spelling it could not resolve', () => {
      // The spy must see the exact string `tmpdir()` hands over, so it is keyed
      // on what the real helper answers — the spy passes that first call through.
      const real = normalizedTmpdir();
      const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation((() => {
        throw Object.assign(new Error(`EACCES: injected, realpath '${real}'`), { code: 'EACCES' });
      }) as typeof fs.realpathSync.native);
      restore = () => spy.mockRestore();
      expect(errnoOf(() => normalizedTmpdir())).toBe('EACCES');
    });
  });

  describe('mkdirSyncReal', () => {
    it('creates the directory and returns its realpath (positive control)', () => {
      const dir = safePath.join(root, 'made');
      expect(mkdirSyncReal(dir)).toBe(fs.realpathSync.native(dir));
    });

    it('throws when the OS refuses the realpath of the directory it just created', () => {
      const dir = safePath.join(root, 'made-refused');
      restore = refuseNativeRealpathOf(dir, 'EPERM');
      expect(errnoOf(() => mkdirSyncReal(dir))).toBe('EPERM');
      // The directory was created before the refusal: the throw is about the
      // realpath, not a claim that nothing happened.
      expect(fs.existsSync(dir)).toBe(true);
    });
  });
});
