/**
 * `fs.lstat` is counted by syscall: one per `lstat` the link-chain walk makes, at the call inside
 * utils. Per path, that is the components walked below the root plus one per link hop followed
 * (each hop splices the link's text in, and the text's components are walked in turn).
 *
 * The tree needs a real symlink; a host that cannot create one (Windows without Developer Mode or
 * the privilege) skips, visibly, through vitest's `skip()`.
 */
import { writeFileSync } from 'node:fs';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { assertLocalChain } from '../src/link-following.js';
import { safePath } from '../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../src/test-helpers.js';
import { HOST_PATH_FLAVOR } from '../src/tree-change/link-chain.js';
import { __resetWorkCountersForTest, readWorkCounters } from '../src/work-counters.js';

import { useCanonicalTempRoot } from './test-helpers.js';

describe('the chain walk counts one fs.lstat per lstat it makes', () => {
  const tempRoot = useCanonicalTempRoot('chain-walk-lstat-count');
  let root: string;

  beforeEach(() => {
    root = tempRoot();
    __resetWorkCountersForTest();
  });

  it('counts one fs.lstat per component walked below the root plus one per link hop', ({ skip }) => {
    // Skipped where this host cannot create a symlink (Windows without Developer Mode or the privilege).
    const cap = symlinkCapability() ?? skip();
    // root/real-a/b/file, and root/a -> real-a: the walk of root/a/b/file reads a, follows it, then
    // reads real-a, b and file.
    mkdirSyncReal(safePath.join(root, 'real-a', 'b'), { recursive: true });
    writeFileSync(safePath.join(root, 'real-a', 'b', 'file'), 'x');
    createSymlink(cap, 'real-a', safePath.join(root, 'a'), 'dir');
    const walked = ['a', 'b', 'file'];
    const hops = 1;
    __resetWorkCountersForTest();

    expect(assertLocalChain(safePath.join(root, ...walked), root, HOST_PATH_FLAVOR)).toBe('local');

    // a, real-a (the hop's one-component text), b, file.
    expect(readWorkCounters()['fs.lstat']).toBe(walked.length + hops);
    expect(readWorkCounters()['fs.stat']).toBe(0);
  });

  it('counts one fs.lstat per component for a path with no link', () => {
    const walked = ['x', 'y', 'z.md'];
    mkdirSyncReal(safePath.join(root, ...walked.slice(0, -1)), { recursive: true });
    writeFileSync(safePath.join(root, ...walked), 'x');
    __resetWorkCountersForTest();

    expect(assertLocalChain(safePath.join(root, ...walked), root, HOST_PATH_FLAVOR)).toBe('local');

    expect(readWorkCounters()['fs.lstat']).toBe(walked.length);
    expect(readWorkCounters()['fs.stat']).toBe(0);
  });
});
