/**
 * `withRunContext`'s `tree`: a `'read-only'` run walks its tree under the place-kind snapshot (each
 * component `lstat`ed once), a `'writes'` run walks afresh and sees its own writes — also when it is
 * opened inside a reading bracket. Counted by `fs.lstat`, which counts syscalls (a memo hit counts zero).
 */
import { rmSync, writeFileSync } from 'node:fs';

import { assertLocalChain, HOST_PATH_FLAVOR, mkdirSyncReal, readWorkCounters, safePath, withPlaceKindSnapshot, withTempDir } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { NO_HOME_SETTLED_LISTENER, withRunContext } from '../../src/utils/resource-loader.js';

/** The `fs.lstat` count one walk of `path` beneath `root` costs. */
function lstatsOfWalk(path: string, root: string): number {
  const before = readWorkCounters()['fs.lstat'];
  assertLocalChain(path, root, HOST_PATH_FLAVOR);
  return readWorkCounters()['fs.lstat'] - before;
}

/** A tree holding `docs/guide.md`, and that file's path. */
function seeded(root: string): string {
  mkdirSyncReal(safePath.join(root, 'docs'));
  const guide = safePath.join(root, 'docs', 'guide.md');
  writeFileSync(guide, '# guide\n', 'utf-8');
  return guide;
}

const RUN = { projectionStore: 'none', homeSettledListener: NO_HOME_SETTLED_LISTENER } as const;

describe('withRunContext tree', () => {
  it('a read-only run reads each component once', async () => {
    await withTempDir('vat-run-tree-', async (root) => {
      const guide = seeded(root);
      const [first, second] = await withRunContext({ ...RUN, root, tree: 'read-only', outputs: [] }, () =>
        Promise.resolve([lstatsOfWalk(guide, root), lstatsOfWalk(guide, root)]),
      );
      expect(first).toBeGreaterThan(0);
      expect(second).toBe(0);
    });
  });

  it('a writing run, inside a reading bracket, walks afresh and sees its own writes', async () => {
    await withTempDir('vat-run-tree-', async (root) => {
      const guide = seeded(root);
      await withPlaceKindSnapshot(root, async () => {
        const read = lstatsOfWalk(guide, root);
        await withRunContext({ ...RUN, root, tree: 'writes', outputs: [] }, () => {
          // The enclosing snapshot is not consulted: the whole walk is paid again.
          expect(lstatsOfWalk(guide, root)).toBe(read);
          // The run replaces the file it read by a directory: a walk beneath it now finds a file.
          rmSync(guide);
          mkdirSyncReal(guide);
          writeFileSync(safePath.join(guide, 'inner.md'), 'inner', 'utf-8');
          expect(assertLocalChain(safePath.join(guide, 'inner.md'), root, HOST_PATH_FLAVOR)).toBe('local');
          return Promise.resolve();
        });
      });
    });
  });

  it('refuses, at compile time, a read-only run that declares outputs', () => {
    // Type-level only: never opened.
    const declare = (): Promise<void> =>
      // @ts-expect-error -- a run that declares what it writes cannot be read-only
      withRunContext({ ...RUN, root: '/tree', tree: 'read-only', outputs: ['/tree/dist'] }, () => Promise.resolve());
    expect(typeof declare).toBe('function');
  });
});
