import type fs from 'node:fs';
import { symlinkSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { crawlDirectorySync } from '../src/file-crawler.js';
import { mkdirSyncReal, safePath, toForwardSlash } from '../src/path-utils.js';
import { canCreateSymlinks, setupSyncTempDirSuite } from '../src/test-helpers.js';

/**
 * `readdirSync` order is filesystem-defined, not alphabetical — so a real
 * repro of "the symlink alias happens to list before the real directory"
 * cannot be forced portably by naming entries. Instead this file mocks
 * `node:fs`'s `readdirSync` to always sort symlink entries before
 * non-symlink entries for one specific directory (set via
 * `setForcedOrderDir`), which is exactly the adversarial ordering the bug
 * depends on. Every other directory, and every other `fs` function, passes
 * straight through to the real implementation — this is not a fake
 * filesystem, just a controlled ordering knob on one real directory.
 */
const { getForcedOrderDir, setForcedOrderDir } = vi.hoisted(() => {
  let forcedDir: string | null = null;
  return {
    getForcedOrderDir: (): string | null => forcedDir,
    setForcedOrderDir: (dir: string | null): void => {
      forcedDir = dir;
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    default: {
      ...actual,
      readdirSync: ((dir: fs.PathLike, options?: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- delegating to the real implementation across its many overloads
        const entries = (actual.readdirSync as any)(dir, options);
        const forced = getForcedOrderDir();
        if (forced !== null && String(dir) === forced && Array.isArray(entries)) {
          // Symlink entries first, non-symlinks second — the exact ordering
          // that lets a symlink alias claim a real directory's realpath
          // before the real directory itself gets a turn.
          return [...(entries as fs.Dirent[])].sort((a, b) => {
            const aRank = a.isSymbolicLink() ? 0 : 1;
            const bRank = b.isSymbolicLink() ? 0 : 1;
            return aRank - bRank;
          });
        }
        return entries;
      }) as typeof actual.readdirSync,
    },
  };
});

describe('file-crawler: symlink-vs-real-directory dedup ordering', () => {
  const suite = setupSyncTempDirSuite('file-crawler-symlink-order');
  let testDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    testDir = suite.getTempDir();
    setForcedOrderDir(null);
  });

  it('keeps a directory contents under its REAL name even when readdir lists the symlink alias first', () => {
    if (!canCreateSymlinks(testDir)) {
      console.warn('SKIPPED: host cannot create symlinks (needs Developer Mode on Windows)');
      return;
    }

    // real-dir/file.md, plus alias -> real-dir (same real path, two names).
    const realDir = safePath.join(testDir, 'real-dir');
    mkdirSyncReal(realDir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDir is a controlled temp directory
    writeFileSync(safePath.join(realDir, 'file.md'), '# file');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDir is a controlled temp directory
    symlinkSync(realDir, safePath.join(testDir, 'alias'), 'dir');

    // Force readdirSync(testDir) to list `alias` before `real-dir`,
    // regardless of what the real filesystem's order happens to be.
    setForcedOrderDir(testDir);

    const files = crawlDirectorySync({
      baseDir: testDir,
      include: ['**/*.md'],
      followSymlinks: true,
      respectGitignore: false,
    }).map(toForwardSlash);

    // Exactly one copy of the file, and it must be recorded under the real
    // directory's own name — not under the alias that happened to be
    // listed first. Before the two-pass fix, `alreadyWalked` claims the
    // shared realpath for whichever spelling readdir lists first, so a
    // symlink-first order stamps the alias's name over the real directory's
    // own name and skips `real-dir` outright.
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\/real-dir\/file\.md$/);
    expect(files[0]).not.toContain('/alias/');
  });
});
