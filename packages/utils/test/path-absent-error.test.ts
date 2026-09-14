/**
 * `isPathAbsentError` is the narrowing every `try { stat } catch { return null }`
 * site is rewritten to under `no-blind-catch`: it says YES only for the two
 * errnos that mean "there is nothing at this path" — `ENOENT`, and `ENOTDIR`
 * for a path component that turned out to be a file — and NO for everything
 * else, so a refusal (`EACCES`) or a bug (`TypeError`) is rethrown instead of
 * becoming a null.
 *
 * The property that matters is the asymmetry with `isFilesystemAccessError`:
 * that predicate deliberately groups `ENOENT` with `EACCES` ("the environment,
 * not our code"), and reusing it to mean "absent" is exactly the conflation
 * that turned an unreadable directory into an empty one.
 */

import { describe, expect, it } from 'vitest';

import { isFilesystemAccessError, isPathAbsentError } from '../src/errors/errno.js';

/** Shape of a real `node:fs` rejection: an Error carrying an errno `code`. */
function errno(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe('isPathAbsentError', () => {
  it('recognises the two absence errnos', () => {
    expect(isPathAbsentError(errno('ENOENT'))).toBe(true);
    expect(isPathAbsentError(errno('ENOTDIR'))).toBe(true);
  });

  it('is NOT the environmental predicate: a refusal is not an absence', () => {
    // Every one of these is `isFilesystemAccessError === true`, and every one
    // is a path that EXISTS. Reporting it as absent is the defect.
    for (const code of ['EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG', 'EISDIR', 'EMFILE', 'EIO']) {
      expect(isFilesystemAccessError(errno(code))).toBe(true);
      expect(isPathAbsentError(errno(code))).toBe(false);
    }
  });

  it('does not launder a bug into an absence', () => {
    expect(isPathAbsentError(new TypeError('x is not a function'))).toBe(false);
    expect(isPathAbsentError(new Error('boom'))).toBe(false);
    expect(isPathAbsentError(errno('ERR_INVALID_ARG_TYPE'))).toBe(false);
    expect(isPathAbsentError(undefined)).toBe(false);
    expect(isPathAbsentError(null)).toBe(false);
    expect(isPathAbsentError('ENOENT')).toBe(false);
  });

  it('sees through `cause` wrapping, like its sibling', () => {
    const wrapped = new Error('Failed to read', { cause: errno('ENOENT') });
    expect(isPathAbsentError(wrapped)).toBe(true);
    const wrappedRefusal = new Error('Failed to read', { cause: errno('EACCES') });
    expect(isPathAbsentError(wrappedRefusal)).toBe(false);
  });

  it('terminates on a self-referential cause chain', () => {
    const cyclic: { code: string; cause?: unknown } = { code: 'NOPE' };
    cyclic.cause = cyclic;
    expect(isPathAbsentError(cyclic)).toBe(false);
  });
});
