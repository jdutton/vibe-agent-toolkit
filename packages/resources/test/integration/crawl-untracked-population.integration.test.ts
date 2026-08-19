/**
 * **`ResourceRegistry.crawl`'s population is `tracked ∪ (untracked ∧ ¬ignored)`.**
 *
 * `docs/architecture/command-population-matrix.md` §1 states the ruling and
 * `docs/architecture/resource-scanning-and-caching.md` §2.1 declares it: a command
 * that cannot see a brand-new, uncommitted, un-ignored file has a defect, not a
 * scoping choice. Every `BUG:` cell that document carried traced to one line —
 * the crawl options this registry hands the file crawler, which omitted
 * `includeUntracked` and so inherited the `git ls-files` tracked-only default.
 *
 * ## Why this file needs a real repository
 *
 * The rest of the crawl tests build their fixtures under `mkdtemp`, outside any
 * working tree, so `crawlDirectorySync` takes the manual-walk fallback where
 * tracked/untracked does not exist as a concept. They cannot observe this
 * behaviour at all — which is exactly why the defect survived. The git arm below
 * is a real `git init` + commit; the non-git arm is its control, pinning that the
 * fallback still admits everything the globs allow.
 *
 * ## What each fixture member is for
 *
 * | member | arm | what it proves |
 * |---|---|---|
 * | `committed.md` | git | no regression — tracked files are still members |
 * | `untracked.md` | git | the ruling: an uncommitted, un-ignored file is a member |
 * | `ignored/hidden.md` | git | `--exclude-standard` still holds; ignored is not "untracked" |
 * | `plain.md` | non-git | the fallback walk is unchanged |
 * | `nested/deep.md` | non-git | a `.gitignore` outside a repository is inert, as §4 states |
 */

import { mkdtempSync, rmSync } from 'node:fs';

import {
  compareCodeUnits,
  normalizedTmpdir,
  resetProjectRootCaches,
  runGitOrThrow,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ResourceRegistry } from '../../src/resource-registry.js';
import { writeFileIn as plant } from '../test-helpers.js';

/** Committed before the crawl — the tracked baseline. */
const COMMITTED = 'committed.md';
/** Written and never added — the file the ruling is about. */
const UNTRACKED = 'untracked.md';
/** Under a directory named in `.gitignore`, so `--exclude-standard` must drop it. */
const IGNORED = 'ignored/hidden.md';
/** The ignore file each fixture root carries — inert in the non-git one. */
const GITIGNORE = '.gitignore';
/** The non-git control's ordinary member. */
const PLAIN = 'plain.md';
/** Named by the non-git control's inert `.gitignore`, and still a member. */
const NESTED = 'nested/deep.md';

/** Identity git needs to make a commit, without touching the developer's config. */
const COMMIT_IDENTITY = [
  '-c',
  'user.name=VAT Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

/** The repository arm's root. */
let gitRoot = '';
/** The fallback arm's root — no `.git` anywhere above it. */
let plainRoot = '';
/** What the crawl returned for {@link gitRoot}, root-relative and sorted. */
let gitMembers: string[] = [];
/** What the crawl returned for {@link plainRoot}, root-relative and sorted. */
let plainMembers: string[] = [];

/**
 * Crawl one root with this repo's default resource globs.
 *
 * Deliberately the plain `crawl` entry point with no `populationSource`: the
 * defect lives in the options that entry point builds, so a test that supplied a
 * source would route around the thing under test.
 *
 * @param rootDir - Directory to crawl
 * @returns Root-relative, forward-slashed member paths, sorted
 */
async function crawlMembers(rootDir: string): Promise<string[]> {
  const registry = new ResourceRegistry({ baseDir: rootDir });
  const resources = await registry.crawl({ baseDir: rootDir, include: ['**/*.md'] });
  return resources
    .map((resource) => toForwardSlash(safePath.relative(rootDir, resource.filePath)))
    .sort(compareCodeUnits);
}

beforeAll(async () => {
  gitRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'crawl-untracked-git-'));
  plant(gitRoot, GITIGNORE, 'ignored/\n');
  plant(gitRoot, COMMITTED, '# committed\n');
  plant(gitRoot, IGNORED, '# ignored\n');
  runGitOrThrow(['init'], { cwd: gitRoot });
  runGitOrThrow(['add', GITIGNORE, COMMITTED], { cwd: gitRoot });
  runGitOrThrow([...COMMIT_IDENTITY, 'commit', '-m', 'fixture'], { cwd: gitRoot });
  // Written AFTER the commit so nothing can have staged it by accident.
  plant(gitRoot, UNTRACKED, '# untracked\n');

  plainRoot = mkdtempSync(safePath.join(normalizedTmpdir(), 'crawl-untracked-plain-'));
  plant(plainRoot, GITIGNORE, 'nested/\n');
  plant(plainRoot, PLAIN, '# plain\n');
  plant(plainRoot, NESTED, '# nested\n');

  // `gitFindRoot` memoizes `null` for every directory a prior walk climbed
  // through, including these roots' ancestors before the repo existed.
  resetProjectRootCaches();

  gitMembers = await crawlMembers(gitRoot);
  plainMembers = await crawlMembers(plainRoot);
});

afterAll(() => {
  for (const root of [gitRoot, plainRoot]) {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('ResourceRegistry.crawl inside a git working tree', () => {
  it('admits an untracked, un-ignored markdown file', () => {
    expect(gitMembers).toContain(UNTRACKED);
  });

  it('still admits a tracked file', () => {
    expect(gitMembers).toContain(COMMITTED);
  });

  it('still excludes a gitignored file', () => {
    expect(gitMembers).not.toContain(IGNORED);
  });

  it('returns exactly `tracked ∪ (untracked ∧ ¬ignored)`', () => {
    // Asserted as an exact set rather than three memberships, so a crawl that
    // widened to the whole tree — the other way to make the first test pass —
    // fails here instead of passing quietly.
    expect(gitMembers).toEqual([COMMITTED, UNTRACKED].sort(compareCodeUnits));
  });
});

describe('ResourceRegistry.crawl outside any git working tree', () => {
  it('still admits every file the globs allow, `.gitignore` being inert there', () => {
    expect(plainMembers).toEqual([NESTED, PLAIN].sort(compareCodeUnits));
  });
});
