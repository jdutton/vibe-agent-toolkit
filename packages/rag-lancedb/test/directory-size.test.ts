/**
 * `getDirectorySize` feeds `getStats().dbSizeBytes`. Its one tolerated failure
 * is absence: a database directory that is not there (or a file compacted away
 * between the listing and its stat) has no bytes to count. A directory the OS
 * refuses to list is not "0 bytes" — that is the number a reader trusts least
 * when it is most wrong.
 */

import fs from 'node:fs';
import { dirname } from 'node:path';

import { normalizedTmpdir, safePath, setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { withReaddirSyncRefused } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDirectorySize } from '../src/directory-size.js';

/* eslint-disable security/detect-non-literal-fs-filename -- test file with dynamic temp paths */

const suite = setupSyncTempDirSuite('lancedb-dir-size');
let root: string;

beforeAll(suite.beforeAll);
afterAll(suite.afterAll);
beforeEach(() => {
  suite.beforeEach();
  root = suite.getTempDir();
});

/** Lay down `files` (relative path → byte count) under `root`. */
function layDown(files: Record<string, number>): void {
  for (const [relative, bytes] of Object.entries(files)) {
    const absolute = safePath.join(root, relative);
    fs.mkdirSync(dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, Buffer.alloc(bytes, 0x41));
  }
}

describe('getDirectorySize', () => {
  it('sums every file, recursing into subdirectories', () => {
    layDown({ 'a.lance': 10, 'nested/b.lance': 20, 'nested/deeper/c.lance': 30 });

    expect(getDirectorySize(root)).toBe(60);
  });

  it('is 0 for a directory that does not exist', () => {
    expect(getDirectorySize(safePath.join(normalizedTmpdir(), 'no-such-lancedb-dir'))).toBe(0);
  });

  it('skips a file that vanished between the listing and its stat, counting the rest', () => {
    layDown({ 'kept.lance': 10, 'compacted.lance': 20 });
    const compacted = safePath.join(root, 'compacted.lance');
    const original = fs.statSync;
    fs.statSync = ((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path) === compacted) {
        throw Object.assign(new Error(`ENOENT: no such file, stat '${compacted}'`), { code: 'ENOENT' });
      }
      return (original as (...args: unknown[]) => fs.Stats)(path, ...rest);
    }) as typeof fs.statSync;
    try {
      expect(getDirectorySize(root)).toBe(10);
    } finally {
      fs.statSync = original;
    }
  });

  it('throws rather than reporting 0 when a directory inside the tree cannot be listed', async () => {
    layDown({ 'a.lance': 10, 'locked/b.lance': 20 });

    await withReaddirSyncRefused(safePath.join(root, 'locked'), 'EACCES', () => {
      expect(() => getDirectorySize(root)).toThrow(/EACCES/);
    });
  });

  it('throws rather than reporting 0 when the root itself cannot be listed', async () => {
    layDown({ 'a.lance': 10 });

    await withReaddirSyncRefused(root, 'EACCES', () => {
      expect(() => getDirectorySize(root)).toThrow(/EACCES/);
    });
  });
});
