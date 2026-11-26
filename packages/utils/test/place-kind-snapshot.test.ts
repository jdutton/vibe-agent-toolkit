/**
 * `withPlaceKindSnapshot`: inside the bracket, the link-chain walk's `lstat` of a component strictly
 * beneath the bracket's root is taken once and reused, an absent answer included; a path outside the root
 * and any walk outside a bracket are asked of the kernel every time. Counted by `fs.lstat`, which
 * counts syscalls (a memo hit counts zero).
 */
import { chmodSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { assertLocalChain, withoutPlaceKindSnapshot, withPlaceKindSnapshot } from '../src/link-following.js';
import { safePath } from '../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../src/test-helpers.js';
import { hostPlaceKind } from '../src/tree-change/host-chain.js';
import { HOST_PATH_FLAVOR } from '../src/tree-change/link-chain.js';
import { __resetWorkCountersForTest, readWorkCounters } from '../src/work-counters.js';

import { useCanonicalTempRoot } from './test-helpers.js';

/** The `fs.lstat` count one walk of `path` beneath `within` costs. */
function lstatsOfWalk(path: string, within: string): number {
  __resetWorkCountersForTest();
  expect(assertLocalChain(path, within, HOST_PATH_FLAVOR)).toBe('local');
  return readWorkCounters()['fs.lstat'];
}

describe('withPlaceKindSnapshot', () => {
  const tempRoot = useCanonicalTempRoot('place-kind-snapshot');
  let root: string;
  let x: string;
  let y: string;

  beforeEach(() => {
    root = tempRoot();
    mkdirSyncReal(safePath.join(root, 'a', 'b'), { recursive: true });
    x = safePath.join(root, 'a', 'b', 'x.md');
    y = safePath.join(root, 'a', 'b', 'y.md');
    writeFileSync(x, 'x');
    writeFileSync(y, 'y');
  });

  it('lstats the shared ancestors once inside the bracket', () => {
    withPlaceKindSnapshot(root, () => {
      // a, b, x.md
      expect(lstatsOfWalk(x, root)).toBe(3);
      // y.md alone: a and b are answered from the snapshot.
      expect(lstatsOfWalk(y, root)).toBe(1);
      // An identical repeat costs nothing.
      expect(lstatsOfWalk(x, root)).toBe(0);
    });
  });

  it('pays the full walk again outside a bracket', () => {
    withPlaceKindSnapshot(root, () => lstatsOfWalk(x, root));
    expect(lstatsOfWalk(x, root)).toBe(3);
    expect(lstatsOfWalk(x, root)).toBe(3);
  });

  it('keeps an absent answer for the bracket, as it keeps every other kind', () => {
    const z = safePath.join(root, 'a', 'b', 'z.md');
    withPlaceKindSnapshot(root, () => {
      expect(assertLocalChain(z, root, HOST_PATH_FLAVOR)).toBe('nothing');
      // Created by someone else mid-run: the run's first answer stands, and costs no lstat.
      writeFileSync(z, 'z');
      __resetWorkCountersForTest();
      expect(assertLocalChain(z, root, HOST_PATH_FLAVOR)).toBe('nothing');
      expect(readWorkCounters()['fs.lstat']).toBe(0);
    });
    // The next run reads it afresh.
    expect(lstatsOfWalk(z, root)).toBe(3);
  });

  it('a bracket opened inside one that already keeps its tree uses that memo, not a fresh one', () => {
    withPlaceKindSnapshot(root, () => {
      expect(lstatsOfWalk(x, root)).toBe(3);
      // The same tree, and a tree beneath it: everything they walk is the open memo's already.
      expect(withPlaceKindSnapshot(root, () => lstatsOfWalk(x, root))).toBe(0);
      expect(withPlaceKindSnapshot(safePath.join(root, 'a'), () => lstatsOfWalk(x, root))).toBe(0);
    });
  });

  it('a bracket opened inside a writing one keeps its own memo for its own work', () => {
    withPlaceKindSnapshot(root, () => {
      lstatsOfWalk(x, root);
      withoutPlaceKindSnapshot(() => {
        // Work that writes nothing inside the writer (a synchronous walk) reads each component once,
        // from an empty memo: nothing the enclosing reader kept.
        withPlaceKindSnapshot(root, () => {
          expect(lstatsOfWalk(x, root)).toBe(3);
          expect(lstatsOfWalk(x, root)).toBe(0);
        });
        expect(lstatsOfWalk(x, root)).toBe(3);
      });
    });
  });

  it('memoizes only what lies strictly beneath the bracket root', () => {
    // Rooted at root/a: the walk's own `a` component IS the bracket root, so it is asked every time.
    withPlaceKindSnapshot(safePath.join(root, 'a'), () => {
      expect(lstatsOfWalk(x, root)).toBe(3);
      expect(lstatsOfWalk(x, root)).toBe(1);
    });
    // Rooted at a sibling: nothing the walk reads is beneath it.
    mkdirSyncReal(safePath.join(root, 'other'));
    withPlaceKindSnapshot(safePath.join(root, 'other'), () => {
      expect(lstatsOfWalk(x, root)).toBe(3);
      expect(lstatsOfWalk(x, root)).toBe(3);
    });
  });

  it('matches the walk through a bracket root spelled through a link (the walk starts at the real path)', ({ skip }) => {
    // Skipped where this host cannot create a symlink (Windows without Developer Mode or the privilege).
    const cap = symlinkCapability() ?? skip();
    // root/link -> a: a tree named through the link is walked from its real path, root/a.
    const linked = safePath.join(root, 'link');
    createSymlink(cap, 'a', linked, 'dir');
    const viaLink = safePath.join(linked, 'b', 'x.md');
    withPlaceKindSnapshot(linked, () => {
      // b, x.md
      expect(lstatsOfWalk(viaLink, linked)).toBe(2);
      expect(lstatsOfWalk(viaLink, linked)).toBe(0);
    });
  });

  it('never memoizes a refused lstat', ({ skip }) => {
    // Unix permission bits; root reads through them.
    if (process.platform === 'win32' || process.getuid?.() === 0) skip();
    const a = safePath.join(root, 'a');
    withPlaceKindSnapshot(root, () => {
      chmodSync(a, 0o000);
      try {
        expect(() => assertLocalChain(x, root, HOST_PATH_FLAVOR)).toThrow(/EACCES/);
      } finally {
        chmodSync(a, 0o755);
      }
      // a was answered (a directory); b and x.md are asked now that the OS answers.
      expect(lstatsOfWalk(x, root)).toBe(2);
    });
  });

  it('walks afresh inside a writing bracket nested in a snapshot, and sees its own writes', () => {
    withPlaceKindSnapshot(root, () => {
      // The reading run memoizes a, b and x.md.
      expect(lstatsOfWalk(x, root)).toBe(3);
      withoutPlaceKindSnapshot(() => {
        // Every component is asked again: the outer snapshot is not consulted.
        expect(lstatsOfWalk(x, root)).toBe(3);
        // The writer replaces the file it read by a directory, and reads it again.
        rmSync(x);
        mkdirSyncReal(x);
        __resetWorkCountersForTest();
        expect(hostPlaceKind(x)).toBe('directory');
        expect(readWorkCounters()['fs.lstat']).toBe(1);
      });
    });
  });

  it('re-reads a memoized link replaced by a directory mid-run, never throwing readlink\'s EINVAL', ({ skip }) => {
    // Skipped where this host cannot create a symlink (Windows without Developer Mode or the privilege).
    const cap = symlinkCapability() ?? skip();
    const link = safePath.join(root, 'a', 'b', 'l');
    createSymlink(cap, 'x.md', link, 'file');
    withPlaceKindSnapshot(root, () => {
      // a, b, l (a link: memoized), then x.md through its text.
      expect(assertLocalChain(link, root, HOST_PATH_FLAVOR)).toBe('local');
      // Another process replaces the link by a directory: the memo still says 'link'.
      rmSync(link);
      mkdirSyncReal(link);
      expect(assertLocalChain(link, root, HOST_PATH_FLAVOR)).toBe('local');
      expect(hostPlaceKind(link)).toBe('directory');
    });
  });
});
