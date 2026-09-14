/**
 * `resolveExecutable` walks `PATH` with the filesystem. The one answer the
 * walk must NOT give is a directory: `accessSync(X_OK)` succeeds on a
 * directory named `git` (X_OK is search permission there), so a planted
 * directory earlier on `PATH` would have been returned as the binary. The
 * fixture plants exactly that ahead of a real file and expects the file.
 */

import { writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { mkdirSyncReal, safePath } from '../../src/path-utils.js';
import { resolveExecutable } from '../../src/testing/executables.js';
import { setupSyncTempDirSuite } from '../../src/testing/temp-dir.js';

const NAME = 'vat-planted-9f3a';

describe('resolveExecutable over a planted PATH', () => {
  const suite = setupSyncTempDirSuite('vat-executables');
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('skips a DIRECTORY carrying the name and returns the first regular file', () => {
    const root = suite.getTempDir();
    const decoyDir = safePath.join(root, 'decoy');
    mkdirSyncReal(safePath.join(decoyDir, NAME), { recursive: true });
    const realDir = safePath.join(root, 'real');
    mkdirSyncReal(realDir);
    // On Windows the walk tries PATHEXT names first; `.CMD` is in the default set.
    const real = safePath.join(realDir, process.platform === 'win32' ? `${NAME}.CMD` : NAME);
    writeFileSync(real, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });

    const previous = process.env['PATH'];
    process.env['PATH'] = [decoyDir, realDir].join(delimiter);
    try {
      expect(resolveExecutable(NAME)).toBe(real);
    } finally {
      process.env['PATH'] = previous;
    }
  });
});
