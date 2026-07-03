/**
 * Unit tests for `prepareHarnessRoot` — the step that tightens an existing
 * directory to 0700 before handing it to assertSafeHarnessRoot.
 *
 * Mode assertions are skipped on win32 (matching assertSafeHarnessRoot's own
 * platform guard).
 */

import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HarnessLocationError,
  prepareHarnessRoot,
} from '../../src/skill-test/harness-location.js';
import { createSymlinkedDir } from '../test-helpers.js';

describe('prepareHarnessRoot', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-prepare-test-'));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('does nothing when the path does not yet exist', () => {
    const dir = safePath.join(tmpBase, 'nonexistent');
    // Should not throw — caller will create it later.
    expect(() => prepareHarnessRoot(dir)).not.toThrow();
  });

  it('does not throw when an existing directory is already 0700', () => {
    const dir = safePath.join(tmpBase, 'good');
    mkdirSyncReal(dir, { mode: 0o700 });
    expect(() => prepareHarnessRoot(dir)).not.toThrow();
    if (process.platform !== 'win32') {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture, controlled directory
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it(
    'chmods an existing 0755 directory to 0700 without throwing',
    { skip: process.platform === 'win32' },
    () => {
      const dir = safePath.join(tmpBase, 'wide');
      mkdirSyncReal(dir, { mode: 0o755 });
      // Confirm starting mode
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture, controlled directory
      expect(statSync(dir).mode & 0o777).toBe(0o755);

      expect(() => prepareHarnessRoot(dir)).not.toThrow();

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture, controlled directory
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    },
  );

  it(
    'still throws HarnessLocationError when the path is a symlink',
    { skip: process.platform === 'win32' },
    () => {
      const { link } = createSymlinkedDir(tmpBase);
      expect(() => prepareHarnessRoot(link)).toThrow(HarnessLocationError);
    },
  );

  it(
    'chmod from 0644 to 0700 (any non-0700 mode is tightened)',
    { skip: process.platform === 'win32' },
    () => {
      const dir = safePath.join(tmpBase, 'narrow');
      mkdirSyncReal(dir, { mode: 0o755 });
      // Force a different weird mode
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture, controlled directory
      chmodSync(dir, 0o644);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture, controlled directory
      expect(statSync(dir).mode & 0o777).toBe(0o644);

      expect(() => prepareHarnessRoot(dir)).not.toThrow();

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture, controlled directory
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    },
  );
});
