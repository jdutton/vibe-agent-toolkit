/**
 * **The two crawl sources must return the same set.** This file is the reason
 * `crawl-source.ts` is an interface rather than a branch inside the contributor.
 *
 * `docs/architecture/resource-scanning-and-caching.md` §3.3: "Two implementations
 * of one interface can be differentially tested against each other on the same
 * root; two ad-hoc code paths cannot, and a divergence between them shows up only
 * as a wrong answer somewhere downstream." That is the whole test.
 *
 * ## The fixture is built to make a vacuous pass impossible
 *
 * Equality of two sets proves nothing if both are empty, or if neither contains
 * anything the two implementations reach by different routes. Every path below
 * exists because it is reached DIFFERENTLY by the two sources, and a git source
 * that took any of the tempting shortcuts would fail on it:
 *
 * | fixture path | walk finds it by | git finds it by | shortcut it kills |
 * |---|---|---|---|
 * | `tracked.md` | readdir | tree snapshot | — |
 * | `untracked.md` | readdir | snapshot (`add --all` stages it) | "tracked files only" |
 * | `ignored.md` | readdir | ignored prune list | "drop the ignored half" |
 * | `ignored-dir/deep/buried.md` | readdir | prune entry, then descend | "prune list IS the file list" |
 * | `empty-dir` | readdir | `--others --directory` | "derive dirs from file paths" |
 * | `ignored-empty-dir` | readdir | ignored prune list | as above, on the ignored side |
 * | `docs/nested` | readdir | derived from its file | "git lists directories" |
 * | `café.md` | readdir | snapshot, `-z` unquoted | "`ls-files` output is ASCII" |
 * | `node_modules/**` | excluded | pruned by name | "walk everything ignored" |
 *
 * The `node_modules` row is the one asserted by ABSENCE, so it is checked
 * explicitly below rather than left to the set comparison — two sources that both
 * wrongly included it would still be equal.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import {
  GitTracker,
  mkdirSyncReal,
  normalizedTmpdir,
  runGitOrThrow,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RunContentCache } from '../../src/projection/content-cache.js';
import { FilesystemExtentContributor } from '../../src/projection/contributors/filesystem-extent.js';
import {
  FilesystemCrawlSource,
  GitCrawlSource,
  type EnumeratedPath,
} from '../../src/projection/crawl-source.js';
import { ProjectionBuilder } from '../../src/projection/projection.js';
import { writeFileIn as writeIn } from '../test-helpers.js';

/** An ordinary committed file — the baseline both sources reach first. */
const TRACKED = 'tracked.md';
/** Ignored by name, and asserted both as a member and in the ignore file. */
const IGNORED_FILE = 'ignored.md';
/** Wholly-ignored directory: one prune entry the git source must descend into. */
const IGNORED_DIR = 'ignored-dir';
/** Untracked and empty — invisible to every tree object and every `ls-files -s`. */
const EMPTY_DIR = 'empty-dir';
/** Ignored and empty: the same hole, on the ignored side. */
const IGNORED_EMPTY_DIR = 'ignored-empty-dir';
/** Excluded by NEVER_CRAWL_GLOBS, so both sources must prune it by name. */
const NEVER_CRAWL_DIR = 'node_modules';
/** A file nested inside {@link IGNORED_DIR}, so a prune entry is not a file list. */
const BURIED = 'ignored-dir/deep/buried.md';
/** Written after the first enumeration — the planted-file control. */
const PLANTED = 'ignored-dir/planted.md';

/** Byte-identical to {@link DUPLICATE_B}, so the two share one blob OID. */
const DUPLICATE_A = 'dup/a.md';
/** Byte-identical to {@link DUPLICATE_A}. */
const DUPLICATE_B = 'dup/b.md';
/** The bytes both duplicates hold. */
const DUPLICATE_BYTES = '# same bytes, two paths\n';

const COMMIT_CONFIG = [
  '-c',
  'user.name=VAT Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

let root = '';

/**
 * Run git in a fixture repo, throwing on any failure.
 *
 * The root is a parameter rather than the module-level `root`, because this file
 * builds TWO independent repositories. A helper that read an ambient root would
 * have to be bracketed by reassignments around the second fixture's setup — and
 * a fixture root that is briefly the wrong value is how a test comes to run git
 * against the developer's own checkout.
 *
 * @param rootDir - Repository to run in
 * @param args - Arguments after the `git` executable
 * @returns Trimmed stdout
 */
function gitIn(rootDir: string, args: readonly string[]): string {
  return runGitOrThrow([...args], { cwd: rootDir });
}

/**
 * Root-relative, forward-slashed, sorted — the comparable shape of a population.
 *
 * @param enumerated - What a source returned
 * @returns Sorted root-relative paths
 */
function relativePaths(enumerated: readonly EnumeratedPath[]): string[] {
  return enumerated
    .map((entry) => toForwardSlash(safePath.relative(root, entry.absolutePath)))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The content hint a source attached to one path.
 *
 * @param enumerated - What a source returned
 * @param rootDir - Root the path is expressed against
 * @param relativePath - The path to look up
 * @returns The hint, or `undefined` when the path is not a member at all —
 *   a distinction the callers rely on, since "no hint" and "not enumerated" are
 *   different failures
 */
function hintForIn(
  enumerated: readonly EnumeratedPath[],
  rootDir: string,
  relativePath: string,
): string | null | undefined {
  const absolutePath = safePath.resolve(rootDir, relativePath);
  return enumerated.find((entry) => entry.absolutePath === absolutePath)?.contentHint;
}

/**
 * {@link hintForIn} against the main fixture root.
 *
 * @param enumerated - What a source returned
 * @param relativePath - The path to look up
 * @returns The hint, or `undefined` when the path is not a member
 */
function hintFor(
  enumerated: readonly EnumeratedPath[],
  relativePath: string,
): string | null | undefined {
  return hintForIn(enumerated, root, relativePath);
}

let walked: readonly EnumeratedPath[];
let gitted: readonly EnumeratedPath[];
let walkedModes: readonly EnumeratedPath[];
let gittedModes: readonly EnumeratedPath[];

// Top-level, not inside the first `describe`: the extent-level comparison below
// reads this same tree, and a per-describe `afterAll` would delete it the moment
// the first block finished.
beforeAll(async () => {
  root = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-crawl-parity-')));
  gitIn(root, ['init', '-b', 'main']);

  // Ignored territory is declared BEFORE anything is written into it, so the
  // ignore rules are the reason those paths are ignored rather than a race.
  writeIn(
    root,
    '.gitignore',
    [IGNORED_FILE, `${IGNORED_DIR}/`, `${IGNORED_EMPTY_DIR}/`, `${NEVER_CRAWL_DIR}/`].join('\n') + '\n',
  );

  writeIn(root, TRACKED, '# tracked\n');
  writeIn(root, 'docs/nested/deep.md', '# deep\n');
  writeIn(root, 'café.md', '# non-ascii name\n');
  writeIn(root, DUPLICATE_A, DUPLICATE_BYTES);
  writeIn(root, DUPLICATE_B, DUPLICATE_BYTES);

  gitIn(root, ['add', '-A']);
  gitIn(root, [...COMMIT_CONFIG, 'commit', '-m', 'fixture']);

  // Everything below is deliberately left OUT of the commit — the population
  // question is about the working tree, not about what was committed.
  writeIn(root, 'untracked.md', '# untracked, not ignored\n');
  writeIn(root, IGNORED_FILE, '# ignored by name\n');
  writeIn(root, BURIED, '# ignored, and nested inside an ignored dir\n');
  writeIn(root, `${NEVER_CRAWL_DIR}/pkg/index.js`, 'module.exports = {};\n');
  // The same name NESTED INSIDE ignored territory, which the git source reaches
  // by descending a prune entry rather than by walking from the root. Pinned as
  // an outcome: two mechanisms currently enforce it (the sub-walk's exclude and
  // the membership predicate), so this cannot attribute the exclusion to either.
  writeIn(root, `${IGNORED_DIR}/${NEVER_CRAWL_DIR}/pkg/index.js`, 'module.exports = {};\n');
  mkdirSyncReal(safePath.resolve(root, EMPTY_DIR), { recursive: true });
  mkdirSyncReal(safePath.resolve(root, IGNORED_EMPTY_DIR), { recursive: true });

  walked = await new FilesystemCrawlSource(root).enumerate();
  gitted = await new GitCrawlSource(root).enumerate();
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('crawl sources agree on the population', () => {
  it('returns identical populations', () => {
    expect(relativePaths(gitted)).toEqual(relativePaths(walked));
  });

  // Each row of the table in the module docstring, asserted as MEMBERSHIP. If
  // any of these is absent the set comparison above is passing on a corpus that
  // cannot tell the two implementations apart.
  it.each([
    [TRACKED],
    ['untracked.md'],
    [IGNORED_FILE],
    [BURIED],
    ['ignored-dir/deep'],
    [EMPTY_DIR],
    [IGNORED_EMPTY_DIR],
    ['docs/nested'],
    ['café.md'],
  ])('both sources found %s, so the comparison is not vacuous', (relativePath) => {
    expect(relativePaths(walked)).toContain(relativePath);
    expect(relativePaths(gitted)).toContain(relativePath);
  });

  it('prunes node_modules by name rather than walking it', () => {
    // Asserted by absence, so it cannot ride on the set comparison: two sources
    // that both wrongly descended would still be equal to each other.
    expect(relativePaths(walked).some((p) => p.includes(NEVER_CRAWL_DIR))).toBe(false);
    expect(relativePaths(gitted).some((p) => p.includes(NEVER_CRAWL_DIR))).toBe(false);
  });

  it('stays in agreement when the ignored half grows', () => {
    // The planted-file control. A fixture whose two arms agree once might agree
    // because neither is looking; one that keeps agreeing as the corpus changes
    // underneath it is answering the question.
    const before = relativePaths(gitted).length;
    writeIn(root, PLANTED, '# planted after the first enumeration\n');

    return Promise.all([
      new FilesystemCrawlSource(root).enumerate(),
      new GitCrawlSource(root).enumerate(),
    ]).then(([walkedAgain, gittedAgain]) => {
      expect(relativePaths(gittedAgain)).toEqual(relativePaths(walkedAgain));
      expect(relativePaths(gittedAgain)).toContain(PLANTED);
      expect(relativePaths(gittedAgain)).toHaveLength(before + 1);
    });
  });
});

describe('content hints', () => {
  it('are supplied for a regular file and withheld from a directory', () => {
    expect(hintFor(gitted, TRACKED)).toMatch(/^[0-9a-f]{40,64}$/);
    expect(hintFor(gitted, 'docs/nested')).toBeNull();
  });

  it('are identical for byte-identical files, which is the whole saving', () => {
    // Not merely "both non-null": the hint only avoids a read when two paths
    // AGREE on it, so equality is the property, and a fixture asserting
    // well-formedness alone would pass on an implementation that hashed paths.
    const a = hintFor(gitted, DUPLICATE_A);
    const b = hintFor(gitted, DUPLICATE_B);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('are never supplied by the walk, which has not read anything yet', () => {
    expect(walked.every((entry) => entry.contentHint === null)).toBe(true);
  });
});

/**
 * Parity of the SOURCES is necessary but not sufficient: what ships is the
 * extent, and a contributor could still differ in what it makes of the same
 * population. So the same comparison is repeated one layer up, on the rows.
 *
 * `contentKey` is compared alongside `path` deliberately. It is the only column
 * the git route can reach by a different mechanism — the blob-OID hint — so a
 * hint that served the wrong bytes would show up here as two extents that
 * enumerated identically and keyed differently, which no path-only comparison
 * could see.
 */
/**
 * Run the extent with one source, through a builder that HAS a content cache.
 *
 * The cache is not incidental. A hint is only ever a lookup into it, so a
 * builder without one makes `contentHint` inert — and a comparison that cannot
 * observe the hint would report agreement no matter what the git source put in
 * that field. Verified by mutation: with the shared no-cache helper, handing
 * every file one identical hint changed nothing here.
 *
 * @param source - Which implementation to hand the contributor
 * @returns `path\tcontentKey` for every realization, sorted
 */
async function rowsFrom(source: 'git' | 'filesystem'): Promise<string[]> {
  const tracker = new GitTracker(root);
  await tracker.initialize({ includeUntracked: true });
  const builder = new ProjectionBuilder(root, tracker, new RunContentCache());

  const contributor = new FilesystemExtentContributor((r) =>
    source === 'git' ? new GitCrawlSource(r) : new FilesystemCrawlSource(r),
  );
  const contribution = await contributor.contribute(builder.base(), null);

  return contribution.realizations
    .map((row) => `${row.path}\t${row.contentKey ?? '(none)'}`)
    .sort((a, b) => a.localeCompare(b));
}

describe('the filesystem extent is unchanged by which source enumerated it', () => {
  it('produces identical realization rows either way', async () => {
    const viaWalk = await rowsFrom('filesystem');
    const viaGit = await rowsFrom('git');

    expect(viaGit).toEqual(viaWalk);
    // Not vacuous: the extent must actually have keyed something, or two empty
    // key columns would compare equal while proving nothing about the hint.
    expect(viaWalk.filter((row) => !row.endsWith('(none)')).length).toBeGreaterThan(0);
  });
});

/**
 * The two entry shapes whose OID does NOT name readable file bytes.
 *
 * Both are population questions before they are hint questions, and getting
 * either wrong is silent: a symlink would arrive as a file whose "content" is a
 * path string, and a submodule as a file that cannot be read at all. They live
 * in their own fixture because a committed symlink needs privilege on Windows,
 * and because an embedded repository makes `git add` noisy enough that mixing it
 * into the main tree would obscure what that tree is for.
 */
describe.skipIf(process.platform === 'win32')('entries whose OID is not file bytes', () => {
  let linkRoot = '';

  beforeAll(async () => {
    linkRoot = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-crawl-modes-')));

    gitIn(linkRoot, ['init', '-b', 'main']);
    writeIn(linkRoot, 'target.md', '# the real file\n');
    symlinkSync('target.md', safePath.resolve(linkRoot, 'link.md'));

    // An embedded repository: `git add` records it as a gitlink (mode 160000)
    // exactly as a registered submodule would, without the remote a real
    // `submodule add` needs. The distinction does not exist in the index.
    const embedded = safePath.resolve(linkRoot, 'embedded');
    mkdirSyncReal(embedded, { recursive: true });
    runGitOrThrow(['init', '-b', 'main'], { cwd: embedded });
    writeFileSync(safePath.resolve(embedded, 'inner.md'), '# inside the submodule\n', 'utf-8');
    runGitOrThrow(['add', '-A'], { cwd: embedded });
    runGitOrThrow([...COMMIT_CONFIG, 'commit', '-m', 'inner'], { cwd: embedded });

    gitIn(linkRoot, ['add', '-A']);
    gitIn(linkRoot, [...COMMIT_CONFIG, 'commit', '-m', 'fixture']);

    walkedModes = await new FilesystemCrawlSource(linkRoot).enumerate();
    gittedModes = await new GitCrawlSource(linkRoot).enumerate();
  });

  afterAll(() => {
    if (linkRoot) rmSync(linkRoot, { recursive: true, force: true });
  });

  /**
   * @param enumerated - What a source returned
   * @returns Sorted paths relative to this block's own root
   */
  function modePaths(enumerated: readonly EnumeratedPath[]): string[] {
    return enumerated
      .map((entry) => toForwardSlash(safePath.relative(linkRoot, entry.absolutePath)))
      .sort((a, b) => a.localeCompare(b));
  }

  it('agree on the population', () => {
    expect(modePaths(gittedModes)).toEqual(modePaths(walkedModes));
  });

  it('drop the committed symlink, matching the walk that never saw one', () => {
    // Membership, asserted on BOTH arms: the target proves the fixture committed
    // something, so "no link" cannot be passing because nothing was enumerated.
    expect(modePaths(gittedModes)).toContain('target.md');
    expect(modePaths(gittedModes)).not.toContain('link.md');
    expect(modePaths(walkedModes)).not.toContain('link.md');
  });

  it('descend into the submodule the snapshot named but did not describe', () => {
    expect(modePaths(gittedModes)).toContain('embedded/inner.md');
    expect(hintForIn(gittedModes, linkRoot, 'embedded')).toBeNull();
  });

  it('never hand a hint to a file inside the submodule, which git did not hash', () => {
    // Its bytes belong to the inner repository, so the outer snapshot holds no
    // OID for them — a hint here could only have been invented.
    expect(hintForIn(gittedModes, linkRoot, 'embedded/inner.md')).toBeNull();
  });
});
