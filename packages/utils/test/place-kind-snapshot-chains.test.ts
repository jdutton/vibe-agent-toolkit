/**
 * The place-kind snapshot keeps a walk's answer beside the kinds it read: a chain that read no link
 * and nothing outside the bracket's roots is a function of kinds the bracket already keeps, so the
 * same walk asked again in the bracket is answered without walking. Counted by calls to
 * `walkLinkChain` (the module is wrapped, not replaced: every answer is the real walk's).
 */
import { writeFileSync } from 'node:fs';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assertLocalChain, withPlaceKindSnapshot } from '../src/link-following.js';
import { safePath } from '../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../src/test-helpers.js';
import type * as LinkChainModule from '../src/tree-change/link-chain.js';
import { HOST_PATH_FLAVOR, walkLinkChain } from '../src/tree-change/link-chain.js';

import { useCanonicalTempRoot } from './test-helpers.js';

vi.mock('../src/tree-change/link-chain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof LinkChainModule>();
  return { ...actual, walkLinkChain: vi.fn(actual.walkLinkChain) };
});

/** How many times the chain walk ran while `work` did. */
function walksOf(work: () => unknown): number {
  vi.mocked(walkLinkChain).mockClear();
  work();
  return vi.mocked(walkLinkChain).mock.calls.length;
}

describe('withPlaceKindSnapshot keeps each walk\'s answer', () => {
  const tempRoot = useCanonicalTempRoot('place-kind-chains');
  let root: string;
  let x: string;

  beforeEach(() => {
    root = tempRoot();
    mkdirSyncReal(safePath.join(root, 'a'), { recursive: true });
    x = safePath.join(root, 'a', 'x.md');
    writeFileSync(x, 'x');
  });

  it('answers a walk asked again in the bracket without walking, present or absent', () => {
    const missing = safePath.join(root, 'a', 'gone.md');
    withPlaceKindSnapshot(root, () => {
      expect(walksOf(() => {
        expect(assertLocalChain(x, root, HOST_PATH_FLAVOR)).toBe('local');
        expect(assertLocalChain(missing, root, HOST_PATH_FLAVOR)).toBe('nothing');
      })).toBe(2);
      expect(walksOf(() => {
        expect(assertLocalChain(x, root, HOST_PATH_FLAVOR)).toBe('local');
        expect(assertLocalChain(missing, root, HOST_PATH_FLAVOR)).toBe('nothing');
      })).toBe(0);
    });
    // Outside a bracket every ask walks.
    expect(walksOf(() => assertLocalChain(x, root, HOST_PATH_FLAVOR))).toBe(1);
    expect(walksOf(() => assertLocalChain(x, root, HOST_PATH_FLAVOR))).toBe(1);
  });

  it('walks a chain through a link every time: a link\'s text is read on every walk', ({ skip }) => {
    // Skipped where this host cannot create a symlink (Windows without Developer Mode or the privilege).
    const cap = symlinkCapability() ?? skip();
    const link = safePath.join(root, 'a', 'l');
    createSymlink(cap, 'x.md', link, 'file');
    withPlaceKindSnapshot(root, () => {
      expect(walksOf(() => assertLocalChain(link, root, HOST_PATH_FLAVOR))).toBe(1);
      expect(walksOf(() => assertLocalChain(link, root, HOST_PATH_FLAVOR))).toBe(1);
    });
  });

  it('walks a path not beneath the bracket\'s roots every time', () => {
    // Bracketed at root/a: the walk of x reads root/a itself, which the bracket does not keep.
    withPlaceKindSnapshot(safePath.join(root, 'a'), () => {
      expect(walksOf(() => assertLocalChain(x, root, HOST_PATH_FLAVOR))).toBe(1);
      expect(walksOf(() => assertLocalChain(x, root, HOST_PATH_FLAVOR))).toBe(1);
    });
  });
});
