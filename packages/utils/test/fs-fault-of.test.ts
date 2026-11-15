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

import { fsFaultOf, LINK_CHAIN_REFUSED_CODE } from '../src/errors/errno-table.js';
import { classifyFsFault } from '../src/errors/fs-fault.js';
import { LinkChainRefusedError } from '../src/tree-change/host-chain.js';

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
      'UNKNOWN',  // libuv src/win/error.c:172's default: a share that is not there, refused credentials, an unready drive
    ];

    for (const code of REFUSALS) {
      it(`treats ${code} as environmental`, () => {
        expect(isFilesystemFault(errno(code))).toBe(true);
      });
    }
  });

  // A file call on a share whose network failed raises these (libuv src/win/error.c :131, :100, :94,
  // :152) — and so does every socket. They are the filesystem's only when a filesystem call raised
  // them: one that names the path it acted on, or a descriptor-only fs call.
  describe('classifies a network errno only from a filesystem call', () => {
    const NETWORK = ['ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ENOTCONN'];

    it.each(NETWORK)('treats %s from a file call on a share as a device fault', (code) => {
      expect(fsFaultOf(Object.assign(errno(code), { syscall: 'open', path: '//host/share/x' }))).toMatchObject({ errno: code, faultClass: 'device' });
      expect(fsFaultOf(Object.assign(errno(code), { syscall: 'fstat' }))?.faultClass).toBe('device');
    });

    it.each(NETWORK)('leaves %s from a socket, a bare code, or a failed fetch alone', (code) => {
      expect(isFilesystemFault(errno(code))).toBe(false);
      expect(isFilesystemFault(Object.assign(errno(code), { syscall: 'connect', address: 'host.invalid', port: 443 }))).toBe(false);
      // A socket's read names no path, exactly as undici's `fetch failed` cause does.
      expect(isFilesystemFault(Object.assign(errno(code), { syscall: 'read' }))).toBe(false);
      expect(isFilesystemFault(new TypeError('fetch failed', { cause: Object.assign(errno(code), { syscall: 'read' }) }))).toBe(false);
    });
  });

  // The table is not the guarantee. An errno it does not list — `EFAULT`, `ECHARSET` (libuv
  // src/win/error.c :98, :89), whatever a later libuv adds — on an error a system call raised is the
  // filesystem failing all the same: classified, of the `device` class, never handed back raw.
  describe('classifies an errno no table lists', () => {
    it.each(['EWHATEVER', 'EFAULT', 'ECHARSET'])('treats %s from a system call as a device fault', (code) => {
      expect(fsFaultOf(Object.assign(errno(code), { syscall: 'lstat', path: '/p' }))).toMatchObject({ errno: code, faultClass: 'device', path: '/p', syscall: 'lstat' });
    });

    it('finds it through a cause chain, and prefers a listed errno further down', () => {
      expect(fsFaultOf(new Error('outer', { cause: Object.assign(errno('EWHATEVER'), { syscall: 'scandir', path: '/d' }) }))?.faultClass).toBe('device');
      const both = Object.assign(errno('EWHATEVER'), { syscall: 'open', cause: Object.assign(errno('EACCES'), { syscall: 'open' }) });
      expect(fsFaultOf(both)).toMatchObject({ errno: 'EACCES', faultClass: 'refused' });
    });

    it('leaves an unlisted code with no filesystem call, a Node API code, and a name-resolution, socket or spawn errno alone', () => {
      expect(isFilesystemFault(errno('EWHATEVER'))).toBe(false);
      expect(isFilesystemFault(Object.assign(errno('ERR_INVALID_ARG_TYPE'), { syscall: 'open', path: '/p' }))).toBe(false);
      for (const syscall of ['getaddrinfo', 'connect', 'spawn git', 'queryA', 'read', 'write', 'close']) {
        expect(isFilesystemFault(Object.assign(errno('ECONNREFUSED'), { syscall })), syscall).toBe(false);
      }
    });
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

  // A chain VAT would not hand the kernel is a refusal like any other — not a bug that a
  // `if (fsFaultOf(e) === undefined) throw e` catch turns into an internal error.
  describe('recognises a link chain VAT declined to follow', () => {
    const refused = new LinkChainRefusedError('/t/a', { why: 'network', link: '/t/smb', text: String.raw`\\h\s` });

    it('as a refused fault on the path asked, raw', () => {
      expect(fsFaultOf(refused)).toEqual({ errno: LINK_CHAIN_REFUSED_CODE, faultClass: 'refused', path: '/t/a', dest: undefined, syscall: undefined });
    });

    it('and once classified on a side', () => {
      const classified = classifyFsFault(refused, { side: 'destination', action: 'write', path: '/t/a' });
      expect(fsFaultOf(classified)).toMatchObject({ errno: LINK_CHAIN_REFUSED_CODE, faultClass: 'refused' });
    });

    it('but not a stray code without the refusal', () => {
      expect(isFilesystemFault(Object.assign(new Error('x'), { code: LINK_CHAIN_REFUSED_CODE }))).toBe(false);
    });
  });
});
