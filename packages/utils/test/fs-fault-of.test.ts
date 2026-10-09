/**
 * Whether `fsFaultOf` classifies an error at all decides, for two different lanes, whether an error is
 * the environment's fault: `vat audit` uses it to degrade a scan over a tree it
 * does not own instead of aborting, and the skill packager uses it to attribute a
 * failed copy to the `files:` entry that caused it.
 *
 * It shipped with no direct tests, and that is precisely how its first version
 * came to omit `ENOTSUP` — the errno of the issue it was written for — and
 * `EEXIST`, which an ordinary two-entry `files:` config reaches with no
 * permissions involved. Both escaped raw to the user. These cases pin the
 * membership and the shape rules so the next omission fails here rather than in
 * someone's build.
 */

import { describe, expect, it } from 'vitest';

import { fsFaultOf } from '../src/errors/errno-table.js';

/** Whether `fsFaultOf` classifies `error` at all: the environment's fault, not a bug. */
const isFilesystemFault = (error: unknown): boolean => fsFaultOf(error) !== undefined;

/** Shape of a real `node:fs` rejection: an Error carrying an errno `code`. */
function errno(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe('fsFaultOf: is this the filesystem refusing a path?', () => {
  describe('recognises the OS refusing a path', () => {
    // Each of these has been observed escaping to a user at least once, or is one
    // syscall away from a case that did.
    const REFUSALS = [
      'EACCES',   // unreadable file or directory — issue #180
      'EPERM',    // owned by another user
      'ENOENT',   // listed by readdir, gone by the time it is opened
      'ENOTSUP',  // copyFile on a symlink-to-directory — issue #183
      'EEXIST',   // mkdir where a file already sits — reachable with no chmod at all
      'EISDIR',
      'EFTYPE',   // a named pipe where content was expected — readDecodableBytes refuses it unread
      'ENOTDIR',
      'ELOOP',
      'ENOSPC',   // full disk mid-build
      'EROFS',
      'EMFILE',
      'EIO',
      'UNKNOWN',  // Windows reparse points and some network paths
    ];

    for (const code of REFUSALS) {
      it(`treats ${code} as environmental`, () => {
        expect(isFilesystemFault(errno(code))).toBe(true);
      });
    }
  });

  describe('does not launder a bug into an environment problem', () => {
    // THE property that matters. Every caller responds to `true` by degrading or
    // by rewriting the message as "check your permissions" — doing that to a
    // defect in our own code makes the tool quietest exactly when it is most wrong.
    it('rejects a plain Error', () => {
      expect(isFilesystemFault(new Error('boom'))).toBe(false);
    });

    it('rejects a TypeError from our own code', () => {
      expect(isFilesystemFault(new TypeError('x is not a function'))).toBe(false);
    });

    it('rejects a non-errno `code`, however Error-shaped', () => {
      // Node uses this shape for its own API misuse errors too, which are bugs.
      expect(isFilesystemFault(errno('ERR_INVALID_ARG_TYPE'))).toBe(false);
      expect(isFilesystemFault(errno('MODULE_NOT_FOUND'))).toBe(false);
    });

    it('rejects non-objects and a numeric code', () => {
      expect(isFilesystemFault(undefined)).toBe(false);
      expect(isFilesystemFault(null)).toBe(false);
      expect(isFilesystemFault('EACCES')).toBe(false);
      expect(isFilesystemFault({ code: 13 })).toBe(false);
    });
  });

  describe('sees through wrapping', () => {
    // A `code`-only check is defeated by any layer that adds context. The CLI
    // config loader does exactly that — `new Error('Failed to load config: …')` —
    // and an unreadable config consequently aborted an entire `vat audit` run
    // while the guard meant to prevent that looked on.
    it('finds the errno through one layer of `cause`', () => {
      const wrapped = new Error('Failed to load config: EACCES', { cause: errno('EACCES') });
      expect(isFilesystemFault(wrapped)).toBe(true);
    });

    it('finds the errno through several layers', () => {
      const deep = new Error('a', { cause: new Error('b', { cause: errno('ENOSPC') }) });
      expect(isFilesystemFault(deep)).toBe(true);
    });

    it('still rejects a wrapped bug', () => {
      const wrapped = new Error('context', { cause: new TypeError('real defect') });
      expect(isFilesystemFault(wrapped)).toBe(false);
    });

    it('terminates on a self-referential cause chain', () => {
      // Not hypothetical enough to ignore: a cycle here would hang the process
      // inside an error path, which is the worst place to hang.
      const cyclic: { code: string; cause?: unknown } = { code: 'NOPE' };
      cyclic.cause = cyclic;
      expect(isFilesystemFault(cyclic)).toBe(false);
    });
  });
});
