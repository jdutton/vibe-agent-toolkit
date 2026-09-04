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
  createSymlinkAsync,
  FsLookupCache,
  safePath,
  setupAsyncTempDirSuite,
  symlinkCapability,
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
 * The same visible filename in two Unicode normalization forms — the on-disk
 * entry decomposed (`e` + U+0301), the href composed (U+00E9). Written as
 * escape sequences so no editor, formatter, or git checkout can renormalize
 * either literal, and created by code rather than committed for the same
 * reason: a committed accented fixture can silently arrive NFC on both sides
 * and pin nothing.
 */
const ACCENTED_ON_DISK = 'refe\u0301rence.md';
const ACCENTED_IN_HREF = 'ref\u00E9rence.md';

/**
 * Materialize the fixture tree: a source doc, a real file target, a real
 * directory target, and a dangling symlink (the one case where the parent
 * listing says "present" while the path itself does not resolve).
 */
async function createFixture(tempDir: string): Promise<void> {
  await fs.writeFile(safePath.join(tempDir, SOURCE_ENTRY), '# Source\n', 'utf-8');
  await fs.writeFile(safePath.join(tempDir, FILE_ENTRY), '# Reference\n', 'utf-8');
  await fs.mkdir(safePath.join(tempDir, DIR_ENTRY), { recursive: true });
  await fs.writeFile(safePath.join(tempDir, ACCENTED_ON_DISK), '# Accented\n', 'utf-8');
  const cap = symlinkCapability();
  if (cap) {
    // No `try`/`catch`: guarded by the same probe that skips the only test that
    // needs the link, so a throw here is a real fixture failure and must
    // surface. Swallowing it would leave that test asserting `null` against a
    // link resolving to nothing — passing, or failing, for the wrong reason.
    await createSymlinkAsync(cap, safePath.join(tempDir, 'nowhere.md'), safePath.join(tempDir, DANGLING_ENTRY));
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

  /**
   * Ledger D7 — the user-facing half, and the whole verdict in one place.
   *
   * The target exists. Only its Unicode normalization form differs from the
   * href's. Three answers are possible and only the third is true:
   *
   * 1. `LINK_BROKEN_FILE` — what VAT emitted before D7, when the listing
   *    comparison found no match at all (not even the case-mismatch hint, which
   *    needs the case-insensitive branch to match). A false positive: the file
   *    is plainly there.
   * 2. `null` — what VAT emitted after D7 folded both sides before comparing.
   *    Also wrong, in the opposite direction and far more quietly: on
   *    Linux/ext4 (CI, and most deploy targets) that href opens nothing, and the
   *    run was silent about it. This assertion USED to read `.toBeNull()`.
   * 3. `LINK_NORMALIZATION_MISMATCH`, a warning — both facts at once: the link
   *    resolves where it was written, and it resolves only by folding.
   *
   * ⚠️ The premise guard matters: if the two literals ever collapsed to one
   * string this test would pass while demonstrating nothing.
   */
  it('warns, rather than passing silently, for a composed href naming a decomposed file', async () => {
    // The guard that can fail: `ACCENTED_ON_DISK` is really decomposed, and
    // folding it lands exactly on the href spelling. Comparing the two
    // constants to each other is settled at authoring time and pins nothing.
    expect(ACCENTED_ON_DISK).not.toBe(ACCENTED_ON_DISK.normalize('NFC'));
    expect(ACCENTED_ON_DISK.normalize('NFC')).toBe(ACCENTED_IN_HREF);

    const issue = await validateHref(tempDir, `./${ACCENTED_IN_HREF}`, fsCache);

    expect(issue?.code).toBe('LINK_NORMALIZATION_MISMATCH');
    expect(issue?.severity).toBe('warning');
    // Not broken: D7's fix must survive. An error here is the pre-D7 regression.
    expect(issue?.severity).not.toBe('error');
    // Both spellings, escaped — quoted verbatim they are the same glyphs.
    expect(issue?.message).toContain(String.raw`ref\u{E9}rence.md`);
    expect(issue?.message).toContain(String.raw`refe\u{301}rence.md`);
  });

  /**
   * The negative control for the row above, over the SAME code path: an
   * accented filename whose href spells it exactly as disk does is silent.
   * Without it, the warning could fire on every non-ASCII filename and this
   * suite would report that as success.
   *
   * ⚠️ **The control needs its own directory, and that is not tidiness.** APFS
   * is normalization-*insensitive*: writing the composed name into the fixture
   * root, which already holds the decomposed twin, opens that same file instead
   * of creating a second entry — the listing would still hold only the
   * decomposed name and this control would silently become a second copy of the
   * positive case. A fresh directory is the only place the composed spelling is
   * genuinely the one on disk.
   */
  it('stays silent for an accented href that matches the on-disk bytes', async () => {
    const composedDir = safePath.join(tempDir, 'composed');
    await fs.mkdir(composedDir, { recursive: true });
    await fs.writeFile(safePath.join(composedDir, ACCENTED_IN_HREF), '# Composed\n', 'utf-8');

    expect(
      await validateHref(tempDir, `./composed/${ACCENTED_IN_HREF}`, fsCache)
    ).toBeNull();
  });

  /**
   * The anchor half of the same normalization split, and the reason it must be
   * fixed alongside the existence check rather than after it. The fragment index
   * is keyed by *enumerated* paths and queried with a path *derived from link
   * text*; a `Map` miss there is silent — {@link checkAnchor} answers `'skip'`,
   * so the anchor is simply never checked. Once the existence check stopped
   * reporting these links broken, that silence is the only thing left standing
   * between a wrong anchor and a report.
   */
  it('checks anchors in a decomposed file reached by a composed href', async () => {
    const fragments = fragmentIndex([
      [safePath.join(tempDir, ACCENTED_ON_DISK), new Set(['section-a'])],
    ]);

    const issue = await validateLink(
      createLink('local_file', `./${ACCENTED_IN_HREF}#nope`),
      safePath.join(tempDir, SOURCE_ENTRY),
      fragments,
      { fsCache, projectRoot: tempDir, skipGitIgnoreCheck: true },
    );

    expect(issue?.code).toBe('LINK_BROKEN_ANCHOR');
  });

  /**
   * The *lookup* side of the fragment index, and the only test that pins it.
   *
   * An anchor-only link is judged against the source file's OWN path, which is
   * an enumerated path — decomposed here — while the index key is normalized.
   * Normalizing only where the index is built would therefore have been a
   * regression rather than a fix: today both sides of this particular lookup are
   * raw and happen to agree, and anchors in an accented file are checked. The
   * companion test above pins the build side; remove either normalization and
   * exactly one of the two goes red.
   */
  it('checks an anchor-only link inside a decomposed filename', async () => {
    const onDiskPath = safePath.join(tempDir, ACCENTED_ON_DISK);
    const fragments = fragmentIndex([[onDiskPath, new Set(['section-a'])]]);

    const issue = await validateLink(createLink('anchor', '#nope'), onDiskPath, fragments, {
      fsCache,
      projectRoot: tempDir,
      skipGitIgnoreCheck: true,
    });

    expect(issue?.code).toBe('LINK_BROKEN_ANCHOR');
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
    if (!symlinkCapability()) skip();

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
