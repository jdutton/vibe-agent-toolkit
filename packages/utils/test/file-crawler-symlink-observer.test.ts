/**
 * `onSymlinkNotFollowed` hears every link the walk DECLINED, under the same
 * include/exclude decision a result gets — and nothing when it follows them.
 */

import { writeFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { crawlDirectorySync } from '../src/file-crawler.js';
import { mkdirSyncReal, safePath } from '../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../src/test-helpers.js';
import { setupSyncTempDirSuite } from '../src/testing/temp-dir.js';
import { refuseUnreadableFixture } from '../src/testing.js';

const cap = symlinkCapability();

/** `[link path, target text]` — a live link, a dangling one, and one under an excluded directory. */
const LINKS: readonly (readonly [string, string])[] = [
  ['docs/link.md', 'real.md'],
  ['docs/dangling.md', 'nowhere.md'],
  ['skip/excluded.md', '../docs/real.md'],
];

/**
 * Plant `docs/real.md` and {@link LINKS} beneath a fresh root.
 *
 * @param root - The temp root
 */
function plantLinks(root: string): void {
  if (!cap) throw new Error('unreachable: suite is skipped without symlink capability');
  for (const directory of ['docs', 'skip']) mkdirSyncReal(safePath.join(root, directory));
  writeFileSync(safePath.join(root, 'docs', 'real.md'), '# real\n');
  for (const [link, target] of LINKS) createSymlink(cap, target, safePath.join(root, link));
}

describe.skipIf(!cap)('file-crawler: onSymlinkNotFollowed', () => {
  const suite = setupSyncTempDirSuite('file-crawler-symlink-observer');
  let root: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    root = suite.getTempDir();
    plantLinks(root);
  });

  const walk = (followSymlinks: boolean): { results: string[]; heard: string[] } => {
    const heard: string[] = [];
    const results = crawlDirectorySync({
      baseDir: root,
      respectGitignore: false,
      exclude: ['skip/**'],
      followSymlinks,
      absolute: false,
      onSymlinkNotFollowed: (path) => heard.push(path),
      unreadable: refuseUnreadableFixture(root),
    });
    return { results, heard: heard.toSorted((a, b) => a.localeCompare(b)) };
  };

  it('reports each declined link once — dangling ones too — and never an excluded one', () => {
    const { results, heard } = walk(false);

    // Positive control: the walk ran and found the real file.
    expect(results).toContain('docs/real.md');
    expect(heard).toEqual(['docs/dangling.md', 'docs/link.md']);
  });

  it('refuses the observer on the git route, which declines no link', () => {
    expect(() => crawlDirectorySync({
      baseDir: root,
      onSymlinkNotFollowed: () => undefined,
      unreadable: refuseUnreadableFixture(root),
    })).toThrow(/respectGitignore: false/);
  });

  it('is silent when links are followed, because none is declined', () => {
    const { results, heard } = walk(true);

    expect(results).toContain('docs/link.md');
    expect(heard).toEqual([]);
  });
});
