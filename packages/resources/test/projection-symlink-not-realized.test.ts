/**
 * A symlink the filesystem extent declines to realize is RECORDED, never
 * silently absent.
 *
 * The extent realizes no symlink path — *"A SYMLINK IS NOT A MEMBER"* in
 * `src/projection/crawl-source.ts`, pinned per-enumerator by
 * `projection-filesystem-extent-symlink.test.ts` — and that policy stands. What
 * this file pins is the other half: every link the enumeration met becomes one
 * `EXTENT_SYMLINK_NOT_REALIZED` condition row at the link's own path. Without it
 * a `link/CLAUDE.md -> ../other/CLAUDE.md` that Claude Code reads was absent
 * from every size, chain and rule-pattern query with nothing saying so.
 *
 * Both enumerators, every tracking state (committed, untracked, ignored), and
 * the three target shapes an author can write: inside the root, dangling, and
 * outside the root — the last of which must never leak the target it names.
 * That both populating lanes carry the rows into their projection is pinned by
 * `integration/symlink-not-realized-lanes.integration.test.ts`.
 *
 * ## The out-of-root verdict is a CODE, not a sentence
 *
 * A declined link is recorded under `EXTENT_SYMLINK_NOT_REALIZED`, or under
 * `EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT` / `EXTENT_SYMLINK_TARGET_UNRESOLVED` when
 * the host resolves it outside the root or to nothing — the same decline, carrying the one fact a consumer cannot recover from the row.
 * `claude-rule-link-unchecked` needs it (Claude Code SKIPS a rules file reached
 * through an out-of-root link) and is a predicate over rows, so before the code
 * existed the only way to read the verdict was to match the message's prose.
 * Every case below therefore asserts the CODE as well as the clause, and the
 * suite reads every code through `isDeclinedSymlinkCode` — a filter written on
 * one of them would drop exactly the rows the others exist for.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { createSymlink, safePath, symlinkCapability, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterAll, describe, expect, it } from 'vitest';

import {
  EXTENT_SYMLINK_NOT_REALIZED,
  EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT,
  EXTENT_SYMLINK_TARGET_UNRESOLVED,
  FilesystemExtentContributor,
  isDeclinedSymlinkCode,
  linkTargetRealization,
} from '../src/projection/contributors/filesystem-extent.js';
import { FilesystemCrawlSource, GitCrawlSource } from '../src/projection/crawl-source.js';

import { GIT_ARM, setupSymlinkExtentSuite, SYMLINK_ARMS, WALK_ARM } from './helpers/symlink-extent-arms.js';
import { plantSymlinkFixture, removeSymlinkFixture } from './helpers/symlink-fixture.js';
import { buildExtentContribution } from './test-helpers.js';

const CLAUDE_TARGET = 'other/CLAUDE.md';
const CLAUDE_LINK = 'link/CLAUDE.md';
const RULE_TARGET = 'shared/rule.md';
const RULE_LINK = '.claude/rules/linked.md';
const DIRECTORY_LINK = 'linkdir';
const BROKEN_LINK = 'broken.md';
const OUTSIDE_LINK = 'outside.md';
/** Named only by the out-of-root link's target text — must never appear in a message. */
const OUTSIDE_NAME = 'vat-symlink-outside-target.md';
const UNTRACKED_LINK = 'untracked-link.md';
const IGNORED_LINK = 'ignored/link.md';
const PLAIN = 'docs/plain.md';
/** A link back up to the project root — its target is the empty relative path. */
const ROOT_LINK = 'sub/up';
/** An absolute target under $HOME, which is outside any temp root and must never be named. */
const HOME_LINK = 'home.md';
const HOME_TARGET = `${toForwardSlash(homedir())}/vat-symlink-home-target.md`;
/** A target whose text carries a newline — which would split a line-oriented report. */
const NEWLINE_LINK = 'newline.md';
const NEWLINE_TARGET = 'new\nline.md';
/**
 * Target text only POSIX can plant: a newline is not a legal Windows filename
 * character, and the two Windows-absolute spellings — what Git for Windows
 * commits for a link to another drive or a share — are real absolute paths
 * there rather than the relative-looking names POSIX reads them as.
 */
const WINDOWS_DRIVE_LINK = 'src/win-drive.md';
const WINDOWS_DRIVE_SECRET = 'vat-drive-secret';
const WINDOWS_UNC_LINK = 'src/win-unc.md';
const WINDOWS_UNC_SECRET = 'vat-unc-secret';
const POSIX_ONLY_LINKS = process.platform === 'win32' ? [] : [
  { path: NEWLINE_LINK, target: NEWLINE_TARGET },
  { path: WINDOWS_DRIVE_LINK, target: `C:/Users/${WINDOWS_DRIVE_SECRET}/CLAUDE.md` },
  // `\\server\share\<secret>\CLAUDE.md`
  { path: WINDOWS_UNC_LINK, target: ['', '', 'server', 'share', WINDOWS_UNC_SECRET, 'CLAUDE.md'].join('\\') },
];

describe.skipIf(!symlinkCapability())('filesystem extent — a declined symlink is a condition row', () => {
  const arms = setupSymlinkExtentSuite({
    prefix: 'vat-symlink-condition-',
    files: [CLAUDE_TARGET, RULE_TARGET, PLAIN],
    links: [
      { path: CLAUDE_LINK, target: '../other/CLAUDE.md' },
      { path: RULE_LINK, target: '../../shared/rule.md' },
      { path: DIRECTORY_LINK, target: 'other' },
      { path: BROKEN_LINK, target: 'nowhere.md' },
      // Enough `..` to leave any temp root, however deep the host puts it.
      { path: OUTSIDE_LINK, target: `${'../'.repeat(24)}${OUTSIDE_NAME}` },
      { path: ROOT_LINK, target: '..' },
      { path: HOME_LINK, target: HOME_TARGET },
      ...POSIX_ONLY_LINKS,
    ],
    ignore: ['ignored/'],
    untrackedFiles: ['ignored/keep.md'],
    untrackedLinks: [
      { path: UNTRACKED_LINK, target: 'docs/plain.md' },
      { path: IGNORED_LINK, target: '../docs/plain.md' },
    ],
  });

  const conditionsOf = (label: string): ReturnType<typeof arms.contribution>['conditions'] =>
    arms.contribution(label).conditions.filter((row) => isDeclinedSymlinkCode(row.code));

  const codeOf = (label: string, path: string): string | undefined =>
    conditionsOf(label).find((row) => row.path === path)?.code;

  it.each(SYMLINK_ARMS)('%s: one condition per link, at the link path, and no realization for any', (label) => {
    // ⭐ Positive control: the enumerator ran and realized the ordinary files.
    expect(arms.paths(label)).toContain(PLAIN);
    expect(arms.paths(label)).toContain(CLAUDE_TARGET);

    const links = [
      CLAUDE_LINK, RULE_LINK, DIRECTORY_LINK, BROKEN_LINK, OUTSIDE_LINK, UNTRACKED_LINK, IGNORED_LINK,
      ROOT_LINK, HOME_LINK, ...POSIX_ONLY_LINKS.map((link) => link.path),
    ];
    expect(conditionsOf(label).map((row) => row.path).sort((a, b) => a.localeCompare(b)))
      .toEqual([...links].sort((a, b) => a.localeCompare(b)));
    // The policy is unchanged: still no realization at any link path.
    expect(arms.paths(label).filter((path) => links.includes(path))).toEqual([]);
  });

  it.each(SYMLINK_ARMS)(
    '%s: ⭐ the out-of-root verdict is the row CODE, not a sentence a consumer has to parse',
    (label) => {
      // The links whose targets leave the root — including the two Windows
      // absolute spellings, which name a place no root on this host contains.
      const outside = [OUTSIDE_LINK, HOME_LINK, ...POSIX_ONLY_LINKS
        .filter((link) => link.path !== NEWLINE_LINK)
        .map((link) => link.path)];
      for (const path of outside) {
        expect(codeOf(label, path), path).toBe(EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT);
      }
      // ⭐ The control that makes the split falsifiable: every in-root shape —
      // realized, dangling, a directory, the root itself, untracked, ignored,
      // and a newline-bearing relative name — keeps the general code.
      for (const path of [
        CLAUDE_LINK, RULE_LINK, DIRECTORY_LINK, ROOT_LINK, UNTRACKED_LINK, IGNORED_LINK,
      ]) {
        expect(codeOf(label, path), path).toBe(EXTENT_SYMLINK_NOT_REALIZED);
      }
      // ⭐ An in-root target that resolves to NOTHING on this host — dangling,
      // including the newline-bearing name nothing creates — is neither in force
      // nor outside: Claude Code reads nothing through it.
      for (const path of [
        BROKEN_LINK,
        ...POSIX_ONLY_LINKS.filter((link) => link.path === NEWLINE_LINK).map((link) => link.path),
      ]) {
        expect(codeOf(label, path), path).toBe(EXTENT_SYMLINK_TARGET_UNRESOLVED);
      }
    },
  );

  it.each(SYMLINK_ARMS)('%s: neither code ever leaks a path outside the root', (label) => {
    // The property the second code must not cost: it names WHERE the target
    // lies and still never names the target.
    const { root } = arms.fixture();
    for (const row of conditionsOf(label)) {
      expect(row.message, row.path).not.toContain(root);
      expect(row.message, row.path).not.toContain(OUTSIDE_NAME);
      expect(row.message, row.path).not.toContain(homedir());
    }
  });

  it.each(SYMLINK_ARMS)('%s: a row carries no identity and is info, not a failure', (label) => {
    for (const row of conditionsOf(label)) {
      expect(row.resourceId).toBeNull();
      expect(row.severity).toBe('info');
      expect(row.sourcePath).toBeNull();
    }
  });

  it.each(SYMLINK_ARMS)('%s: an in-root target is named root-relative, and said to be realized', (label) => {
    const byPath = new Map(conditionsOf(label).map((row) => [row.path, row.message]));

    expect(byPath.get(CLAUDE_LINK)).toContain(`'${CLAUDE_TARGET}'`);
    expect(byPath.get(CLAUDE_LINK)).toContain('is realized at its own path');
    expect(byPath.get(RULE_LINK)).toContain(`'${RULE_TARGET}'`);
    expect(byPath.get(DIRECTORY_LINK)).toContain("'other'");
  });

  it.each(SYMLINK_ARMS)('%s: a dangling in-root target is named and said to resolve to nothing', (label) => {
    const message = conditionsOf(label).find((row) => row.path === BROKEN_LINK)?.message;

    expect(message).toContain("'nowhere.md'");
    expect(message).toContain('resolves to nothing on this host');
  });

  it.each(SYMLINK_ARMS)('%s: an out-of-root target is never named, nor is the root or $HOME', (label) => {
    const { root } = arms.fixture();
    const message = conditionsOf(label).find((row) => row.path === OUTSIDE_LINK)?.message ?? '';

    expect(message).toContain('outside the project root');
    expect(message).not.toContain(OUTSIDE_NAME);
    expect(message).not.toContain(root);
    expect(message).not.toContain(homedir());
    for (const row of conditionsOf(label)) {
      expect(row.message).not.toContain(root);
    }
  });

  it.each(SYMLINK_ARMS)('%s: an absolute target under $HOME is never named', (label) => {
    const message = conditionsOf(label).find((row) => row.path === HOME_LINK)?.message ?? '';

    // Positive control: the row exists and took the outside arm.
    expect(message).toContain('outside the project root');
    expect(message).not.toContain(homedir());
    expect(message).not.toContain(toForwardSlash(homedir()));
  });

  it.runIf(process.platform !== 'win32').each(SYMLINK_ARMS)(
    '%s: a Windows-absolute target read on POSIX is outside, and never named',
    (label) => {
      for (const [link, secret] of [[WINDOWS_DRIVE_LINK, WINDOWS_DRIVE_SECRET], [WINDOWS_UNC_LINK, WINDOWS_UNC_SECRET]]) {
        const message = conditionsOf(label).find((row) => row.path === link)?.message ?? '';

        expect(message).toContain('outside the project root');
        expect(message).not.toContain(secret);
      }
    },
  );

  it.each(SYMLINK_ARMS)('%s: a link to the root says so, never quoting an empty path', (label) => {
    const message = conditionsOf(label).find((row) => row.path === ROOT_LINK)?.message ?? '';

    expect(message).toContain('to the project root');
    expect(message).not.toContain("''");
  });

  it.runIf(process.platform !== 'win32').each(SYMLINK_ARMS)(
    '%s: a newline in a target is escaped, never written raw',
    (label) => {
      const message = conditionsOf(label).find((row) => row.path === NEWLINE_LINK)?.message ?? '';

      expect(message).toContain(String.raw`new\nline.md`);
      expect(message).not.toContain('\n');
    },
  );

  it.each(SYMLINK_ARMS)('%s: the target clause and the consequence are separated by a space', (label) => {
    // 🪤 `${clause}.${NOT_COUNTED_CLAUSE}` rendered "own path.VAT never
    // realizes" — one missing space, in the sentence every one of these rows
    // carries.
    for (const row of conditionsOf(label)) {
      expect(row.message).not.toContain('.VAT never');
      expect(row.message).toContain('. VAT never');
    }
  });

  it('both enumerators record the same rows', () => {
    const rows = (label: string): string[] =>
      conditionsOf(label).map((row) => `${row.path}\0${row.message}`).sort((a, b) => a.localeCompare(b));

    // Positive control first: two empty lists agree trivially.
    expect(rows(WALK_ARM).length).toBeGreaterThan(0);
    expect(rows(GIT_ARM)).toEqual(rows(WALK_ARM));
  });
});

const CAPABILITY = symlinkCapability();

describe.skipIf(CAPABILITY === null)('a link git records whose checkout is a plain file', () => {
  let root: string | undefined;

  afterAll(() => {
    removeSymlinkFixture(root);
  });

  it('says it is not a link on disk, not that its target could not be read', async () => {
    root = plantSymlinkFixture({
      prefix: 'vat-symlink-flat-',
      files: [PLAIN],
      links: [{ path: 'flat.md', target: PLAIN }],
    }).root;
    // What a Windows checkout with `core.symlinks=false` leaves: git's index still
    // says mode 120000, and the working tree holds a file carrying the target text.
    runGitOrThrow(['config', 'core.symlinks', 'false'], { cwd: root });
    rmSync(safePath.join(root, 'flat.md'));
    writeFileSync(safePath.join(root, 'flat.md'), PLAIN);

    const { contribution } = await buildExtentContribution(
      root,
      new FilesystemExtentContributor((at) => new GitCrawlSource(at)),
    );
    const row = contribution.conditions.find((condition) => condition.path === 'flat.md');

    expect(row?.message).toContain('is not a symbolic link on disk');
    expect(row?.message).not.toContain('could not be read');
    // ⛔ Never the out-of-root code: `readlink` refused, so nothing is known
    // about where this link points, and a code that said "outside the root"
    // would be a guess the reader cannot check.
    expect(row?.code).toBe(EXTENT_SYMLINK_NOT_REALIZED);
  });
});

describe.skipIf(CAPABILITY === null)('an absolute in-root target spelled through a linked prefix', () => {
  let root: string | undefined;
  let aliasHome: string | undefined;

  afterAll(() => {
    removeSymlinkFixture(root);
    removeSymlinkFixture(aliasHome);
  });

  it('is named root-relative, not called outside the root', async () => {
    if (CAPABILITY === null) throw new Error('unreachable — the suite is skipped without the capability');
    root = plantSymlinkFixture({ prefix: 'vat-symlink-spelling-', files: [PLAIN], links: [] }).root;
    // The macOS case: the root is `/private/var/…` and an author writes the
    // OS's `/var/…` — the same directory under another name. Reproduced
    // portably with a directory link OUTSIDE the root that names the root, so
    // the target escapes lexically and is inside once its prefix is resolved.
    aliasHome = plantSymlinkFixture({ prefix: 'vat-symlink-alias-', files: ['placeholder.md'], links: [] }).root;
    const alias = safePath.join(aliasHome, 'alias');
    createSymlink(CAPABILITY, root, alias, 'dir');
    createSymlink(CAPABILITY, `${toForwardSlash(alias)}/${PLAIN}`, safePath.join(root, 'absolute.md'));

    const { contribution } = await buildExtentContribution(
      root,
      new FilesystemExtentContributor((at) => new FilesystemCrawlSource(at)),
    );
    const row = contribution.conditions.find((condition) => condition.path === 'absolute.md');

    expect(row?.message).toContain(`to '${PLAIN}'`);
    expect(row?.message).not.toContain('outside the project root');
    // The code follows the clause: a target that escapes the root only through
    // a symlinked PREFIX is in-root, and the row must not say otherwise.
    expect(row?.code).toBe(EXTENT_SYMLINK_NOT_REALIZED);
  });
});

describe('linkTargetRealization — does the target reach a realized row on THIS host?', () => {
  // Pure over an injected real path, so both answers are exercised on every
  // platform: the filesystem case below can only take one arm per host.
  const realized = new Set([PLAIN]);
  const NONE = (): undefined => undefined;
  const NOT_A_LINK = (): boolean => false;

  it('answers "realized" for a byte-exact target, without asking the filesystem', () => {
    const asking = (): string => {
      throw new Error('the filesystem must not be asked when the set already holds the target');
    };

    expect(linkTargetRealization(PLAIN, realized, asking, NOT_A_LINK)).toEqual({ kind: 'realized' });
  });

  it('answers "unrealized" when nothing realizes the target and the host resolves nothing', () => {
    expect(linkTargetRealization('docs/gone.md', realized, NONE, NOT_A_LINK)).toEqual({ kind: 'unrealized' });
  });

  it('⭐ answers "realized-as" when the host resolves the target to a realized CASE variant', () => {
    // The defect: `foo.md -> docs/Plain.md` beside a realized `docs/plain.md`
    // resolves on macOS and Windows and was reported "not realized" because the
    // set was asked with the author's exact spelling.
    expect(linkTargetRealization('docs/Plain.md', realized, () => PLAIN, NOT_A_LINK))
      .toEqual({ kind: 'realized-as', path: PLAIN });
  });

  it('accepts a Unicode NORMALIZATION variant for the same reason', () => {
    const composed = 'docs/café.md';
    const decomposed = 'docs/café.md';

    expect(linkTargetRealization(decomposed, new Set([composed]), () => composed, NOT_A_LINK))
      .toEqual({ kind: 'realized-as', path: composed });
  });

  it('⛔ refuses a resolution that is a DIFFERENT file, not a respelling', () => {
    // A link chain can resolve somewhere else entirely. Saying the named target
    // is realized would then be a lie about a path the message quotes.
    expect(linkTargetRealization('docs/other.md', realized, () => PLAIN, NOT_A_LINK))
      .toEqual({ kind: 'unrealized' });
  });

  it('⛔ refuses a case variant that is ITSELF a link — a case-sensitive host followed a chain', () => {
    // `a.md -> docs/Plain.md` where `docs/Plain.md` is its own link to the
    // realized `docs/plain.md`: on a byte-exact filesystem the host resolves the
    // chain to a case variant, and "breaks on a byte-exact filesystem" would be
    // false — it opens there too, through a link VAT does not realize.
    expect(linkTargetRealization('docs/Plain.md', realized, () => PLAIN, () => true))
      .toEqual({ kind: 'unrealized' });
  });

  it('refuses a resolution the projection does not realize either', () => {
    expect(linkTargetRealization('docs/PLAIN.md', new Set(), () => PLAIN, NOT_A_LINK))
      .toEqual({ kind: 'unrealized' });
  });
});
