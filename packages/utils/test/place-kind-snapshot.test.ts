/**
 * `withPlaceKindSnapshot`: inside the bracket, the link-chain walk's `lstat` of a component strictly
 * beneath the bracket's root is taken once and reused; an absent answer, a path outside the root,
 * and any walk outside a bracket are asked of the kernel every time. Counted by `fs.lstat`, which
 * counts syscalls (a memo hit counts zero).
 */
import { chmodSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { assertLocalChain, withPlaceKindSnapshot } from '../src/link-following.js';
import { safePath } from '../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../src/test-helpers.js';
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

  it('asks an absent answer again, so a file created mid-bracket is seen', () => {
    const z = safePath.join(root, 'a', 'b', 'z.md');
    withPlaceKindSnapshot(root, () => {
      expect(assertLocalChain(z, root, HOST_PATH_FLAVOR)).toBe('nothing');
      writeFileSync(z, 'z');
      // a and b from the snapshot; z.md asked again and found.
      expect(lstatsOfWalk(z, root)).toBe(1);
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
});
