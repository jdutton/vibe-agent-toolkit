/**
 * A link the place-kind snapshot kept, changed by another process mid-run, is read again: the
 * `readlink` refusal is matched to the place the walk READ (never to the spelling Node reports
 * on the error, which on Windows may be namespaced `\\?\C:\...`), and a link replaced (`EINVAL`)
 * or deleted (`ENOENT`) is dropped from the snapshot and the walk taken once more. A second
 * refusal on that retry is thrown raw, and a read lane classifies it as a fault, never a crash.
 * `node:fs` is wrapped, not replaced: every answer is the real kernel's unless a test says so.
 */
import type * as NodeFs from 'node:fs';
import { rmSync, writeFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { linkResolutionFault } from '../src/errors/fs-fault.js';
import { FsLookupCache } from '../src/fs-utils.js';
import { assertLocalChain, withoutPlaceKindSnapshot, withPlaceKindSnapshot } from '../src/link-following.js';
import { mkdirSyncReal, safePath, toForwardSlash } from '../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../src/test-helpers.js';
import { HOST_PATH_FLAVOR } from '../src/tree-change/link-chain.js';

import { useCanonicalTempRoot } from './test-helpers.js';

/** How the wrapped `readlinkSync` misbehaves: respell an error's path, or refuse one place outright. */
const readlinkFaults: { respell: ((path: string) => string) | undefined; refuse: string | undefined } = { respell: undefined, refuse: undefined };

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const readlinkSync = (path: string): string => {
    if (readlinkFaults.refuse !== undefined && toForwardSlash(path) === readlinkFaults.refuse) {
      throw Object.assign(new Error(`EINVAL: invalid argument, readlink '${path}'`), { code: 'EINVAL', errno: -22, syscall: 'readlink', path });
    }
    try {
      return actual.readlinkSync(path, 'utf8');
    } catch (error: unknown) {
      const respell = readlinkFaults.respell;
      if (respell !== undefined) Object.assign(error as object, { path: respell(path) });
      throw error;
    }
  };
  return { ...actual, readlinkSync };
});

describe('a link the snapshot kept, changed mid-run', () => {
  const tempRoot = useCanonicalTempRoot('place-kind-stale-link');
  let root: string;
  let link: string;

  beforeEach(({ skip }) => {
    readlinkFaults.respell = undefined;
    readlinkFaults.refuse = undefined;
    // Skipped where this host cannot create a symlink (Windows without Developer Mode or the privilege).
    const cap = symlinkCapability() ?? skip();
    root = tempRoot();
    mkdirSyncReal(safePath.join(root, 'a'));
    writeFileSync(safePath.join(root, 'a', 'x.md'), 'x');
    link = safePath.join(root, 'a', 'l');
    createSymlink(cap, 'x.md', link, 'file');
  });

  it('is read again when readlink reports the place in another spelling (the Windows namespaced form)', () => {
    readlinkFaults.respell = (path) => `\\\\?\\${path.replaceAll('/', '\\')}`;
    withPlaceKindSnapshot(root, () => {
      expect(assertLocalChain(link, root, HOST_PATH_FLAVOR)).toBe('local');
      rmSync(link);
      // Another process, with no snapshot of its own.
      withoutPlaceKindSnapshot(() => mkdirSyncReal(link));
      expect(assertLocalChain(link, root, HOST_PATH_FLAVOR)).toBe('local');
    });
  });

  it('is read again when another process deletes it: the walk answers nothing, never readlink\'s ENOENT', () => {
    withPlaceKindSnapshot(root, () => {
      expect(assertLocalChain(link, root, HOST_PATH_FLAVOR)).toBe('local');
      rmSync(link);
      expect(assertLocalChain(link, root, HOST_PATH_FLAVOR)).toBe('nothing');
    });
  });

  it('a second refusal on the retry is thrown raw, and a read lane reports it as a fault of that one target', () => {
    // A link readlink refuses as "not a link" every time it is asked: the retry meets it again.
    readlinkFaults.refuse = toForwardSlash(link);
    withPlaceKindSnapshot(root, () => {
      let thrown: unknown;
      try {
        assertLocalChain(link, root, HOST_PATH_FLAVOR);
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'EINVAL', syscall: 'readlink' });
      expect(linkResolutionFault(thrown)).toMatchObject({ errno: 'EINVAL', faultClass: 'unsupported' });
      expect(new FsLookupCache(root).probe(link)).toEqual({ exists: true, isDirectory: null });
    });
  });
});
