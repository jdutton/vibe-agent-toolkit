/* eslint-disable security/detect-non-literal-fs-filename -- tempDir paths are test-generated, safe in test context */
/**
 * What `validateLink` looks up on disk while resolving a `local_file` /
 * `local_directory` link — and, as of the pass-1′ work, what it no longer does.
 *
 * Resolving a link needs exactly one filesystem fact: the parent directory's
 * entry names, read once per directory through {@link FsLookupCache}, which
 * answers both "does it exist" and "under the case asked for". It used to
 * additionally `fs.stat` every target that exists, to fill an `isDirectory`
 * flag no consumer ever read. That stat is gone.
 *
 * Two kinds of assertion below, and they carry different weight:
 *
 * - **Values** (directory / file / missing / dangling symlink): the verdicts a
 *   link's validation produces must not move now that the stat is gone. These
 *   are the output-neutrality evidence; they passed before the change too, and
 *   that is the point of keeping them.
 * - **The absence pin** (`fs.stat` is never called): this is the assertion that
 *   goes red if the deleted stat comes back. It spies the same module object the
 *   production code would have to use, so it catches a restored `fs.stat` — the
 *   actual route — rather than a route this package has never taken.
 *
 * ⚠️ An assertion that something was called ZERO times passes just as happily
 * when the spy never attached, so the stat spy is paired with a `readdir` spy
 * asserted **positive**: link validation demonstrably does list directories
 * through this same module object. Without that control, `stat: 0` would be
 * indistinguishable from an inert instrument.
 *
 * **Scope of the pin, established by mutation rather than assumed.** Restoring
 * the deleted `fs.stat` as it was actually written — a default import of
 * `node:fs/promises`, `fs.stat(path)` — kills this test and leaves the other
 * four green. Writing it as `(await import('node:fs/promises')).stat(path)`
 * does NOT: a dynamic import yields the module *namespace*, whose `stat` is a
 * different binding from the default export's property that `vi.spyOn` patches.
 * The same gap applies to `node:fs`'s synchronous `statSync`. So this catches
 * the regression as the code would naturally be rewritten, not every possible
 * route to a stat.
 */
import fs from 'node:fs/promises';

import {
  canCreateSymlinks,
  FsLookupCache,
  safePath,
  setupAsyncTempDirSuite,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { fragmentIndex, validateLink } from '../src/link-validator.js';
import type { ResourceLink } from '../src/types.js';

import { createLink } from './test-helpers.js';

const SOURCE_ENTRY = 'SKILL.md';
const FILE_ENTRY = 'reference.md';
const DIR_ENTRY = 'reference-dir';
const DANGLING_ENTRY = 'dangling-link.md';

/**
 * Materialize the fixture tree: a source doc, a real file target, a real
 * directory target, and a dangling symlink (the one case where the parent
 * listing says "present" while the path itself does not resolve).
 */
async function createFixture(tempDir: string): Promise<void> {
  await fs.writeFile(safePath.join(tempDir, SOURCE_ENTRY), '# Source\n', 'utf-8');
  await fs.writeFile(safePath.join(tempDir, FILE_ENTRY), '# Reference\n', 'utf-8');
  await fs.mkdir(safePath.join(tempDir, DIR_ENTRY), { recursive: true });
  if (canCreateSymlinks(tempDir)) {
    // No `try`/`catch`: guarded by the same probe that skips the only test that
    // needs the link, so a throw here is a real fixture failure and must
    // surface. Swallowing it would leave that test asserting `null` against a
    // link resolving to nothing — passing, or failing, for the wrong reason.
    await fs.symlink(safePath.join(tempDir, 'nowhere.md'), safePath.join(tempDir, DANGLING_ENTRY));
  }
}

/** Validate one href from the fixture's source file, using the supplied per-run cache. */
async function validateHref(
  tempDir: string,
  href: string,
  fsCache: FsLookupCache,
  type: ResourceLink['type'] = 'local_file',
) {
  return validateLink(createLink(type, href), safePath.join(tempDir, SOURCE_ENTRY), fragmentIndex(), {
    fsCache,
    projectRoot: tempDir,
    skipGitIgnoreCheck: true,
  });
}

describe('validateLink target lookups', () => {
  const suite = setupAsyncTempDirSuite('link-validator-target-lookups-');
  let tempDir: string;
  let fsCache: FsLookupCache;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    fsCache = new FsLookupCache();
    await createFixture(tempDir);
  });

  it('reports no issue for a link resolving to a directory', async () => {
    expect(await validateHref(tempDir, `./${DIR_ENTRY}`, fsCache, 'local_directory')).toBeNull();
  });

  it('reports no issue for a link resolving to a file', async () => {
    expect(await validateHref(tempDir, `./${FILE_ENTRY}`, fsCache)).toBeNull();
  });

  it('still reports LINK_BROKEN_FILE for a link resolving to nothing', async () => {
    const issue = await validateHref(tempDir, './absent.md', fsCache);

    expect(issue?.code).toBe('LINK_BROKEN_FILE');
  });

  it('reports no issue for a dangling symlink, which the parent listing still names', async ({
    skip,
  }) => {
    // Probe the real directory rather than branching on `process.platform`:
    // Windows with Developer Mode on can create symlinks, and a platform test
    // declines coverage it could have had. Report the skip rather than
    // returning early — a silently no-op'd case reads as a passing test.
    if (!canCreateSymlinks(tempDir)) skip();

    // The case the removed stat used to have to survive: the parent listing
    // names the entry, so the link resolves, while stat'ing the path itself
    // throws because the link points nowhere. No issue either way.
    expect(await validateHref(tempDir, `./${DANGLING_ENTRY}`, fsCache)).toBeNull();
  });

  it('lists the parent directory but never stats the target', async () => {
    const readdirSpy = vi.spyOn(fs, 'readdir');
    const statSpy = vi.spyOn(fs, 'stat');

    try {
      await validateHref(tempDir, `./${FILE_ENTRY}`, fsCache);
      await validateHref(tempDir, `./${DIR_ENTRY}`, fsCache, 'local_directory');
      await validateHref(tempDir, './absent.md', fsCache);

      // Positive control FIRST. This proves the spy really is attached to the
      // module object the production code calls through; without it, the
      // zero below would be satisfied by an instrument that never fired.
      expect(readdirSpy.mock.calls.length).toBeGreaterThan(0);
      expect(statSpy).not.toHaveBeenCalled();
    } finally {
      readdirSpy.mockRestore();
      statSpy.mockRestore();
    }
  });
});
