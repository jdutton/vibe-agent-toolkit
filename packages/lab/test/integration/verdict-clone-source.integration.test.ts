/**
 * `readCloneSource` over a real tree: the walk the build-verb clone plans from.
 * Integration-tier because it lists a temp directory.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { readCloneSource } from '../../src/facets/verdict/clone.js';

describe('readCloneSource', () => {
  it('descends only into directories that hold a skipped entry, never into one, nor into node_modules', () => {
    const tree = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-lab-clone-source-'));
    try {
      for (const dir of ['packages/a/coverage/lcov', 'packages/a/src', 'packages/b/src', 'node_modules/dep/.turbo', '.turbo/cache']) {
        mkdirSyncReal(safePath.join(tree, dir), { recursive: true });
      }
      writeFileSync(safePath.join(tree, 'README.md'), '# r\n');

      const listed = readCloneSource(tree, 'probe');
      if (!listed.ok) throw new Error(listed.refusal);
      const { root } = listed.source;

      expect(Object.keys(root.descend)).toEqual(['packages']);
      expect(Object.keys(root.descend['packages']?.descend ?? {})).toEqual(['a']);
      expect(root.descend['packages']?.descend['a']?.descend).toEqual({});
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it.skipIf(CANNOT_DENY_READS)('refuses, naming the subject, when a directory beneath it will not list', () => {
    const tree = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-lab-clone-locked-'));
    const locked = safePath.join(tree, 'packages', 'locked');
    mkdirSyncReal(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const listed = readCloneSource(tree, 'probe');

      expect(listed).toMatchObject({ ok: false, refusal: expect.stringContaining("subject 'probe'") });
    } finally {
      chmodSync(locked, 0o755);
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
