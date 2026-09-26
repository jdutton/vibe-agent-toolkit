/**
 * Declined-link codes decided by THIS host's resolution, from real trees.
 *
 * The unit file `projection-symlink-not-realized.test.ts` pins the row shape
 * and the pure `linkTargetRealization` verdicts; these cases plant real links —
 * a case variant, a link that escapes only when followed, a root reached through
 * a link — and walk them, because the verdict is `realpathSync.native`'s and no
 * seam can stand in for the filesystem that answers it. Integration tier because
 * planting and walking a tree does not fit the unit budget.
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs';

import { createSymlink, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import {
  EXTENT_SYMLINK_NOT_REALIZED,
  EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT,
  EXTENT_SYMLINK_TARGET_UNRESOLVED,
  FilesystemExtentContributor,
} from '../../src/projection/contributors/filesystem-extent.js';
import { FilesystemCrawlSource } from '../../src/projection/crawl-source.js';
import { plantSymlinkFixture, removeSymlinkFixture } from '../helpers/symlink-fixture.js';
import { buildExtentContribution } from '../test-helpers.js';

const PLAIN = 'docs/plain.md';
const CAPABILITY = symlinkCapability();

type ConditionRow = Awaited<ReturnType<typeof buildExtentContribution>>['contribution']['conditions'][number];

/**
 * Walk `root` on the filesystem lane and look condition rows up by path.
 *
 * @param root - The tree to walk
 * @returns A lookup from a link's root-relative path to its condition row
 */
async function walkConditionAt(root: string): Promise<(path: string) => ConditionRow | undefined> {
  const { contribution } = await buildExtentContribution(
    root,
    new FilesystemExtentContributor((at) => new FilesystemCrawlSource(at)),
  );
  return (path) => contribution.conditions.find((condition) => condition.path === path);
}

describe.skipIf(CAPABILITY === null)('a link whose target differs from the realized file only in case', () => {
  let root: string | undefined;

  afterAll(() => {
    removeSymlinkFixture(root);
  });

  it('is judged by THIS filesystem, not by a byte-exact lookup', async () => {
    root = plantSymlinkFixture({
      prefix: 'vat-symlink-case-',
      files: [PLAIN],
      links: [{ path: 'cased.md', target: 'docs/PLAIN.md' }],
    }).root;
    // The probe, not the platform: an APFS volume can be created case-SENSITIVE
    // and a Linux host can mount a case-insensitive filesystem, so `darwin` is
    // not the question. Writing one file and asking for it back in another case
    // is.
    const probe = safePath.join(root, 'vat-case-probe.md');
    writeFileSync(probe, 'probe');
    const caseInsensitive = existsSync(safePath.join(root, 'VAT-CASE-PROBE.md'));
    rmSync(probe);

    const cased = (await walkConditionAt(root))('cased.md');
    const message = cased?.message ?? '';

    // Positive control: the row exists and named the target it was given.
    expect(message).toContain("'docs/PLAIN.md'");
    if (caseInsensitive) {
      // The host opens the link, so the row must not call the target absent.
      expect(message).toContain(`is realized at '${PLAIN}'`);
      expect(message).not.toContain('is not realized');
    } else {
      // A byte-exact filesystem: the link genuinely dangles, so it resolves to
      // nothing and carries the code that says so.
      expect(message).toContain('resolves to nothing on this host');
      expect(cased?.code).toBe(EXTENT_SYMLINK_TARGET_UNRESOLVED);
    }
  });
});

/**
 * The code is decided by where the HOST resolves the link, never by the text.
 *
 * Claude Code skips a rules file or directory whose target resolves outside the
 * directory the session started in, following every link on the way
 * (`docs/external/claude-code-rules-paths-behaviour.md`, "Symlinked rules"). A
 * lexical containment test called both shapes below in-root — and the
 * `claude-rule-link-unchecked` check then told the author a rule was "in force"
 * that Claude Code never loads.
 */
describe.skipIf(CAPABILITY === null)('a link whose target escapes the root only when links are followed', () => {
  let root: string | undefined;
  let outside: string | undefined;

  afterAll(() => {
    removeSymlinkFixture(root);
    removeSymlinkFixture(outside);
  });

  it('⭐ takes the out-of-root code through a linked PREFIX and through a CHAIN, and names nothing outside', async () => {
    if (CAPABILITY === null) throw new Error('unreachable — the suite is skipped without the capability');
    outside = plantSymlinkFixture({ prefix: 'vat-symlink-away-', files: ['rules/a.md'], links: [] }).root;
    root = plantSymlinkFixture({ prefix: 'vat-symlink-escape-', files: [PLAIN, '.claude/settings.md'], links: [] }).root;
    createSymlink(CAPABILITY, outside, safePath.join(root, 'vendor'), 'dir');
    // `.claude/rules -> ../vendor/rules`: lexically `vendor/rules`, in-root.
    createSymlink(CAPABILITY, '../vendor/rules', safePath.join(root, '.claude', 'rules'), 'dir');
    // `chain.md -> hop.md -> <outside>/rules/a.md`: lexically `hop.md`, in-root.
    createSymlink(CAPABILITY, `${outside}/rules/a.md`, safePath.join(root, 'hop.md'));
    createSymlink(CAPABILITY, 'hop.md', safePath.join(root, 'chain.md'));

    const rowAt = await walkConditionAt(root);

    for (const path of ['.claude/rules', 'chain.md', 'hop.md', 'vendor']) {
      expect(rowAt(path)?.code, path).toBe(EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT);
      expect(rowAt(path)?.message, path).not.toContain(outside);
      expect(rowAt(path)?.message, path).toContain('realized nowhere in this projection');
    }
    // The in-root spelling is still named — it leaks nothing.
    expect(rowAt('.claude/rules')?.message).toContain("'vendor/rules'");
  });
});

describe.skipIf(CAPABILITY === null)('a root reached through a symbolic link', () => {
  let real: string | undefined;
  let aliasHome: string | undefined;

  afterAll(() => {
    removeSymlinkFixture(real);
    removeSymlinkFixture(aliasHome);
  });

  it('⭐ compares real paths to the REAL root, so an in-root target stays in-root and realized', async () => {
    if (CAPABILITY === null) throw new Error('unreachable — the suite is skipped without the capability');
    real = plantSymlinkFixture({ prefix: 'vat-symlink-realroot-', files: [PLAIN], links: [] }).root;
    aliasHome = plantSymlinkFixture({ prefix: 'vat-symlink-rootalias-', files: ['placeholder.md'], links: [] }).root;
    const alias = `${aliasHome}/alias`;
    createSymlink(CAPABILITY, real, alias, 'dir');
    // Absolute, spelled through the REAL root — the macOS `/private/var` case
    // when the root was handed over as `/var/…`.
    createSymlink(CAPABILITY, `${real}/${PLAIN}`, safePath.join(real, 'absolute.md'));
    createSymlink(CAPABILITY, PLAIN, safePath.join(real, 'relative.md'));

    const rowAt = await walkConditionAt(alias);

    for (const path of ['absolute.md', 'relative.md']) {
      expect(rowAt(path)?.code, path).toBe(EXTENT_SYMLINK_NOT_REALIZED);
      expect(rowAt(path)?.message, path).toContain(`to '${PLAIN}', which is realized at its own path`);
    }
  });
});

/**
 * A dangling target spelled through an ALIAS of the root, whose parent directory
 * is missing too. Only the nearest EXISTING ancestor can be resolved; the tail
 * beneath it is re-appended. Resolving only the immediate parent left the alias
 * spelling in place, which escapes the real root lexically — and a target
 * spelled inside the root was called outside it.
 */
describe.skipIf(CAPABILITY === null)('a dangling target spelled through a root alias with a missing parent', () => {
  let real: string | undefined;
  let aliasHome: string | undefined;

  afterAll(() => {
    removeSymlinkFixture(real);
    removeSymlinkFixture(aliasHome);
  });

  it('is unresolved and named in-root, not outside the root', async () => {
    if (CAPABILITY === null) throw new Error('unreachable — the suite is skipped without the capability');
    real = plantSymlinkFixture({ prefix: 'vat-symlink-nodir-', files: [PLAIN], links: [] }).root;
    aliasHome = plantSymlinkFixture({ prefix: 'vat-symlink-nodiralias-', files: ['placeholder.md'], links: [] }).root;
    const alias = `${aliasHome}/alias`;
    createSymlink(CAPABILITY, real, alias, 'dir');
    // `nodir/` exists nowhere, so the immediate parent cannot be resolved.
    createSymlink(CAPABILITY, `${alias}/nodir/x.md`, safePath.join(real, 'alias-nodir.md'));
    // Control: the same dangling target spelled through the REAL root.
    createSymlink(CAPABILITY, `${real}/nodir/x.md`, safePath.join(real, 'real-nodir.md'));

    const rowAt = await walkConditionAt(real);

    for (const path of ['alias-nodir.md', 'real-nodir.md']) {
      expect(rowAt(path)?.code, path).toBe(EXTENT_SYMLINK_TARGET_UNRESOLVED);
      expect(rowAt(path)?.message, path).toContain("to 'nodir/x.md', which resolves to nothing on this host");
    }
  });
});
