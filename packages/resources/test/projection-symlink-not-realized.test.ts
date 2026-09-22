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
 */

import { rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { createSymlink, safePath, symlinkCapability, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterAll, describe, expect, it } from 'vitest';

import {
  EXTENT_SYMLINK_NOT_REALIZED,
  FilesystemExtentContributor,
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
    arms.contribution(label).conditions.filter((row) => row.code === EXTENT_SYMLINK_NOT_REALIZED);

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

  it.each(SYMLINK_ARMS)('%s: a dangling in-root target is said to be unrealized', (label) => {
    const message = conditionsOf(label).find((row) => row.path === BROKEN_LINK)?.message;

    expect(message).toContain("'nowhere.md'");
    expect(message).toContain('is not realized');
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
    const message = contribution.conditions.find((row) => row.path === 'flat.md')?.message ?? '';

    expect(message).toContain('is not a symbolic link on disk');
    expect(message).not.toContain('could not be read');
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
    const message = contribution.conditions.find((row) => row.path === 'absolute.md')?.message ?? '';

    expect(message).toContain(`to '${PLAIN}'`);
    expect(message).not.toContain('outside the project root');
  });
});
