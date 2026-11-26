/**
 * `withRunContext`'s `tree`: a `'read-only'` run walks its tree under the place-kind snapshot (each
 * component `lstat`ed once), a `'writes'` run walks afresh and sees its own writes — also when it is
 * opened inside a reading bracket. Counted by `fs.lstat`, which counts syscalls (a memo hit counts zero).
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';

import { assertLocalChain, HOST_PATH_FLAVOR, isVatError, mkdirSyncReal, readWorkCounters, safePath, VAT_CACHE_DIR_ENV, withPlaceKindSnapshot, withTempDir, WRITE_UNDER_PLACE_KIND_SNAPSHOT_CODE, writeFileUnder } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

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

const RUN = { memberBytes: 'git', projectionStore: 'none', homeSettledListener: NO_HOME_SETTLED_LISTENER } as const;

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

  it('a read-only run that writes under its tree is refused at the write, nothing written', async () => {
    await withTempDir('vat-run-tree-', async (root) => {
      seeded(root);
      const out = safePath.join(root, 'reports');
      const refused = await withRunContext({ ...RUN, root, tree: 'read-only', outputs: [] }, () =>
        writeFileUnder(out, 'report.json', '{}', { existing: 'refuse', writing: 'a report' }).then(() => undefined, (error: unknown) => error),
      );
      expect(isVatError(refused, WRITE_UNDER_PLACE_KIND_SNAPSHOT_CODE)).toBe(true);
      expect(existsSync(out)).toBe(false);
    });
  });

  it('a read-only run whose VAT cache root is inside its tree writes its cache there, and walks afresh', async () => {
    await withTempDir('vat-run-tree-', async (root) => {
      const guide = seeded(root);
      const cacheRoot = safePath.join(root, '.vat-cache');
      vi.stubEnv(VAT_CACHE_DIR_ENV, cacheRoot);
      try {
        const [first, second] = await withRunContext({ ...RUN, root, tree: 'read-only', outputs: [] }, () => {
          // What the store and the parse cache do when they open: VAT's own state, inside the tree.
          mkdirSyncReal(safePath.join(cacheRoot, 'namespace'), { recursive: true });
          return Promise.resolve([lstatsOfWalk(guide, root), lstatsOfWalk(guide, root)]);
        });
        expect(existsSync(safePath.join(cacheRoot, 'namespace'))).toBe(true);
        // VAT writes under the tree, so nothing read there is kept: the second walk is paid again.
        expect(second).toBe(first);
      } finally {
        vi.unstubAllEnvs();
      }
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
