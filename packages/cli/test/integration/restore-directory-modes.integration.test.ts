/**
 * `restoreDirectoryModes`: the I0 seed suite's cleanup opens every directory a
 * plant left closed, so a seed whose own restore never ran still leaves a tree
 * that can be removed.
 */

import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { restoreDirectoryModes } from '../helpers/cache-differential.js';

describe('restoreDirectoryModes', () => {
  it.skipIf(CANNOT_DENY_READS)('opens every directory a seed left unlistable, so the tree can be removed', () => {
    const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-modes-'));
    const locked = safePath.join(root, 'a', 'locked');
    mkdirSyncReal(safePath.join(locked, 'inner'), { recursive: true });
    chmodSync(safePath.join(locked, 'inner'), 0o000);
    chmodSync(locked, 0o000);
    try {
      restoreDirectoryModes(root);
      expect(statSync(locked).mode & 0o700).toBe(0o700);
      expect(statSync(safePath.join(locked, 'inner')).mode & 0o700).toBe(0o700);
    } finally {
      // Whatever the assertion found, the tree must not outlive the test.
      chmodSync(locked, 0o755);
      chmodSync(safePath.join(locked, 'inner'), 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
