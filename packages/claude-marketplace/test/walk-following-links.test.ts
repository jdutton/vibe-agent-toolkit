/**
 * A symlink the walk cannot resolve is RECORDED, the way a directory it cannot
 * list is — never silently `other`.
 *
 * `entryKind` stats through a link to learn what it points at. A DANGLING link
 * has nothing there and is rightly nothing; a link whose target the OS refuses
 * (`EACCES` on a component, `ELOOP` on a link chain) used to take the same
 * exit, so a refused skill directory behind a link vanished from both compat
 * lanes with no row saying so.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- every path is under this suite's own temp root */
import * as fs from 'node:fs/promises';

import { createSymlinkAsync, normalizedTmpdir, removeScratchDir, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { refuseAsyncFs } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { walkFollowingLinks } from '../src/walk-following-links.js';


describe('walkFollowingLinks — a link whose target cannot be examined', () => {
  const cap = symlinkCapability();
  let scratch = '';
  /** The walked tree; the link's target lives BESIDE it, reachable only through the link. */
  let root = '';
  let plainFile = '';
  let link = '';

  beforeAll(async () => {
    scratch = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-walk-links-'));
    root = safePath.join(scratch, 'walk');
    await fs.mkdir(root, { recursive: true });
    plainFile = safePath.join(root, 'plain.md');
    await fs.writeFile(plainFile, '# plain\n', 'utf-8');
    if (cap !== null) {
      const target = safePath.join(scratch, 'target');
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(safePath.join(target, 'inner.md'), '# inner\n', 'utf-8');
      link = safePath.join(root, 'link');
      await createSymlinkAsync(cap, target, link, 'dir');
    }
  });

  afterAll(async () => {
    await removeScratchDir(scratch);
  });

  it.skipIf(cap === null)('records a refused link under `unlistable` and still reads its siblings', async () => {
    const restore = refuseAsyncFs('stat', link, 'EACCES');
    let tree;
    try {
      tree = await walkFollowingLinks(root);
    } finally {
      restore();
    }
    expect(tree.files).toEqual([plainFile]);
    expect(tree.unlistable).toEqual([{ path: link, reason: expect.stringContaining('EACCES') }]);
  });

  it.skipIf(cap === null)('follows the same link when nothing is refused (positive case)', async () => {
    const tree = await walkFollowingLinks(root);
    expect(tree.files.toSorted((a, b) => a.localeCompare(b))).toEqual([safePath.join(link, 'inner.md'), plainFile]);
    expect(tree.unlistable).toEqual([]);
  });

  it.skipIf(cap === null)('treats a DANGLING link as nothing, with no row', async () => {
    const dangling = safePath.join(root, 'dangling');
    await createSymlinkAsync(cap as NonNullable<typeof cap>, safePath.join(scratch, 'gone'), dangling, 'file');
    try {
      const tree = await walkFollowingLinks(root);
      expect(tree.files).not.toContain(dangling);
      expect(tree.unlistable).toEqual([]);
    } finally {
      await fs.unlink(dangling);
    }
  });
});
