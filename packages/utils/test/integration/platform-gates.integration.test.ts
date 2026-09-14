/**
 * The read-denial gate, checked against the filesystem rather than against a
 * restatement of its own predicate (which is what the unit test it replaces
 * did — `expect(CANNOT_DENY_READS).toBe(<the same expression>)`, vacuous by
 * construction). The gate exists so a suite can tell "the OS refused" from
 * "the OS ignored the mode bit", and only a real mode-000 directory can say
 * which this host is.
 */
import { chmodSync, readdirSync, rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isFilesystemAccessError } from '../../src/errors/errno.js';
import { mkdirSyncReal, safePath } from '../../src/path-utils.js';
import { CANNOT_DENY_READS, PERMISSIONS_ENFORCED } from '../../src/testing/platform-gates.js';
import { createTempDir, removeTempDir } from '../../src/testing/temp-dir.js';

describe('platform-gates', () => {
  let dir: string;
  let locked: string;

  beforeEach(() => {
    dir = createTempDir('platform-gates-');
    locked = safePath.join(dir, 'locked');
    mkdirSyncReal(locked);
    chmodSync(locked, 0o000);
  });

  afterEach(() => {
    chmodSync(locked, 0o700);
    rmSync(dir, { recursive: true, force: true });
    removeTempDir(dir);
  });

  it('agrees with what a mode-000 directory does on this host', () => {
    let refused = false;
    try {
      readdirSync(locked);
    } catch (error) {
      // Only the OS refusing counts; anything else is a broken fixture.
      if (!isFilesystemAccessError(error)) throw error;
      refused = true;
    }
    expect(refused).toBe(!CANNOT_DENY_READS);
  });

  it('exposes the positive spelling as the exact complement', () => {
    expect(PERMISSIONS_ENFORCED).toBe(!CANNOT_DENY_READS);
  });
});
