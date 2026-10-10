/**
 * `snapshotTree` against real directories: what it records, what it refuses to follow,
 * and that a special file never blocks it.
 */
import { createHash } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { mkdirSyncReal, safePath } from '../../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../../src/test-helpers.js';
import { PERMISSIONS_ENFORCED } from '../../src/testing/platform-gates.js';
import { tempDirTracker } from '../../src/testing/temp-dir.js';
import { diffSnapshots, snapshotTree, subtree } from '../../src/testing/tree-snapshot.js';

const scratch = tempDirTracker('tree-snapshot-');
afterEach(() => scratch.cleanupAll());

const sha = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
const POSIX = process.platform !== 'win32';
const byName = (a: string, b: string): number => a.localeCompare(b);

function fixture(): string {
  const root = scratch.create();
  mkdirSyncReal(safePath.join(root, 'a', 'b'), { recursive: true });
  writeFileSync(safePath.join(root, 'a', 'one.txt'), 'one\n');
  writeFileSync(safePath.join(root, 'a', 'b', 'two.txt'), 'two\n');
  return root;
}

describe('snapshotTree', () => {
  it('records every entry under forward-slash relative keys, the root as "."', () => {
    const snap = snapshotTree(fixture());
    expect([...snap.keys()].toSorted(byName)).toEqual(['.', 'a', 'a/b', 'a/b/two.txt', 'a/one.txt']);
    expect(snap.get('a/one.txt')).toMatchObject({ kind: 'file', sha256: sha('one\n') });
    expect(snap.get('a')).toMatchObject({ kind: 'dir' });
  });

  it('an absent root is the empty map', () => {
    expect(snapshotTree(safePath.join(scratch.create(), 'nope')).size).toBe(0);
  });

  it('a root that is a file is one entry', () => {
    const root = scratch.create();
    writeFileSync(safePath.join(root, 'f'), 'x');
    expect([...snapshotTree(safePath.join(root, 'f')).keys()]).toEqual(['.']);
  });

  it.skipIf(!POSIX)('captures the mode, so a chmod is a difference', () => {
    const root = fixture();
    const before = snapshotTree(root);
    chmodSync(safePath.join(root, 'a', 'one.txt'), 0o600);
    const lines = diffSnapshots(before, snapshotTree(root));
    expect(lines).toEqual([expect.stringContaining('a/one.txt')]);
    expect(snapshotTree(root).get('a/one.txt')).toMatchObject({ mode: 0o600 });
  });

  it.skipIf(!POSIX)('records a link by its target and never follows it', ({ skip }) => {
    const cap = symlinkCapability() ?? skip();
    const root = fixture();
    const outside = scratch.create();
    writeFileSync(safePath.join(outside, 'secret'), 's');
    createSymlink(cap, outside, safePath.join(root, 'out'));
    createSymlink(cap, 'missing-target', safePath.join(root, 'dangling'));
    const snap = snapshotTree(root);
    expect(snap.get('out')).toEqual({ kind: 'link', target: outside });
    expect(snap.get('dangling')).toEqual({ kind: 'link', target: 'missing-target' });
    expect([...snap.keys()].some((key) => key.startsWith('out/'))).toBe(false);
  });

  // A socket stands in for a FIFO: it is a special inode Node can make with no spawn
  // (the integration tier forbids one), and `open()` on it would fail where a FIFO's would hang.
  it.skipIf(!POSIX)('records a special file as special without opening it', async () => {
    const root = fixture();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(safePath.join(root, 's'), resolve));
    try {
      expect(snapshotTree(root).get('s')).toEqual({ kind: 'special' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('applies a content rewrite before hashing, only to the files it names', () => {
    const root = scratch.create();
    writeFileSync(safePath.join(root, 'reg.json'), `{"at":"2026-10-07T01:02:03.456Z","root":"${root}"}`);
    writeFileSync(safePath.join(root, 'other.txt'), `${root}`);
    const options = {
      rewrites: [{
        applies: (path: string) => path.endsWith('.json'),
        rewrite: (text: string) => text.replaceAll(root, '<ROOT>').replaceAll(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<TS>'),
      }],
    };
    const snap = snapshotTree(root, options);
    expect(snap.get('reg.json')).toMatchObject({ sha256: sha('{"at":"<TS>","root":"<ROOT>"}') });
    expect(snap.get('other.txt')).toMatchObject({ sha256: sha(root) });
  });

  it('applies a byte rewrite to a binary file, untouched by text decoding, only to the files it names', () => {
    const root = scratch.create();
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x01]);
    writeFileSync(safePath.join(root, 'a.zip'), binary);
    writeFileSync(safePath.join(root, 'b.bin'), binary);
    const snap = snapshotTree(root, { rewrites: [{ applies: (path: string) => path.endsWith('.zip'), rewriteBytes: (bytes: Buffer) => bytes.subarray(2) }] });
    expect(snap.get('a.zip')).toMatchObject({ sha256: sha(binary.subarray(2)) });
    expect(snap.get('b.bin')).toMatchObject({ sha256: sha(binary) });
  });

  it('prefixes every key with keyPrefix, the root entry becoming the prefix itself', () => {
    const snap = snapshotTree(fixture(), { keyPrefix: 'home/x' });
    expect([...snap.keys()].toSorted(byName)).toEqual(['home/x', 'home/x/a', 'home/x/a/b', 'home/x/a/b/two.txt', 'home/x/a/one.txt']);
  });
});

describe('diffSnapshots / subtree', () => {
  it('names added, removed and changed entries, sorted; identical is empty', () => {
    const root = fixture();
    const before = snapshotTree(root);
    expect(diffSnapshots(before, snapshotTree(root))).toEqual([]);
    writeFileSync(safePath.join(root, 'a', 'one.txt'), 'changed\n');
    writeFileSync(safePath.join(root, 'z.txt'), 'new');
    const lines = diffSnapshots(before, snapshotTree(root));
    expect(lines).toEqual([expect.stringContaining('a/one.txt'), expect.stringContaining('z.txt')]);
    expect(lines[0]).toMatch(/^~/);
    expect(lines[1]).toMatch(/^\+/);
    expect(diffSnapshots(snapshotTree(root), before)[1]).toMatch(/^-/);
  });

  it('two files whose hashes differ only past the digits a diff line prints are still a change', () => {
    const shared = 'a'.repeat(12);
    const file = (tail: string) => new Map([['f', { kind: 'file' as const, mode: 0o644, sha256: `${shared}${tail.repeat(52)}` }]]);
    expect(diffSnapshots(file('0'), file('1'))).toHaveLength(1);
  });

  it('subtree keeps the prefix entry and what is under it, never a sibling that shares the spelling', () => {
    const root = fixture();
    writeFileSync(safePath.join(root, 'ab'), 'sibling');
    expect([...subtree(snapshotTree(root), 'a').keys()].toSorted(byName)).toEqual(['a', 'a/b', 'a/b/two.txt', 'a/one.txt']);
  });

  it.skipIf(!PERMISSIONS_ENFORCED || !POSIX)('an unreadable directory is a loud failure naming it, not a silent gap', () => {
    const root = fixture();
    chmodSync(safePath.join(root, 'a', 'b'), 0o000);
    try {
      expect(() => snapshotTree(root)).toThrow(/a\/b/);
    } finally {
      chmodSync(safePath.join(root, 'a', 'b'), 0o755);
    }
  });
});
