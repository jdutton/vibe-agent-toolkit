/**
 * The git extent contributor, proved against a **committed** fixture repository.
 *
 * Two things this file exists to make unfalsifiable:
 *
 * 1. **The corpus has commits.** `git ls-files` answers nothing for a repository
 *    with no commit, so a fixture that only writes files reports an empty extent
 *    and every membership assertion passes vacuously. The fixture therefore
 *    `git init`s, writes, `git add`s and `git commit`s before anything is asked
 *    of it, and the gitignored/untracked files are written afterwards so their
 *    status is unambiguous.
 * 2. **Git and the filesystem DISAGREE.** The whole reason both extents exist is
 *    the visible-to-you/invisible-to-CI rung: a gitignored file is on disk and
 *    absent from git. That claim is asserted here against a *local* filesystem
 *    crawl rather than against the filesystem contributor, so this file proves
 *    it without coupling to another module's API.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { crawlDirectory, GitTracker, mkdirSyncReal, NEVER_CRAWL_GLOBS, normalizedTmpdir, runGitOrThrow, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ExtentContribution } from '../src/projection/contributor.js';
import { extentContextId } from '../src/projection/contributors/context-id.js';
import {
  GIT_EXTENT_CONTRIBUTOR_ID,
  GIT_EXTENT_ORIGIN,
  GitExtentContributor,
} from '../src/projection/contributors/git-extent.js';
import { ProjectionBuilder } from '../src/projection/projection.js';

import { expectContributionRowsValid } from './test-helpers.js';

/** Committed. The plain tracked member. */
const TRACKED_FILE = 'docs/tracked.md';
/** On disk, matched by `.gitignore` — visible to a filesystem crawl, invisible to git. */
const IGNORED_FILE = 'ignored.md';
/** On disk, never added, not ignored — the `∧ ¬ignored` half of the extent. */
const UNTRACKED_FILE = 'untracked.md';

/**
 * Identity and signing forced per-invocation: a fixture repo inherits the host's
 * global git config, and a machine with no `user.email` — or with
 * `commit.gpgsign=true` and no key — would otherwise fail to commit at all,
 * leaving an unborn HEAD and an empty, vacuously-passing extent.
 */
const COMMIT_CONFIG = [
  '-c',
  'user.name=VAT Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

let root: string;
let rootId: string;
let extentId: string;
let contribution: ExtentContribution;

/**
 * Run git in a fixture repo, throwing on any failure.
 *
 * @param args - Arguments after the `git` executable
 * @param cwd - Fixture directory to run in
 */
function git(args: readonly string[], cwd: string): void {
  runGitOrThrow([...args], { cwd, stdio: 'pipe' });
}

/** Root-relative paths of every realization the contributor emitted. */
function realizedPaths(): string[] {
  return contribution.realizations.map((row) => row.path);
}

/** The resource ids the contributor declared members of the git extent. */
function memberIds(): Set<string> {
  return new Set(contribution.memberships.map((row) => row.resourceId));
}

beforeAll(async () => {
  root = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-git-extent-')));

  git(['init'], root);
  mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
  writeFileSync(safePath.join(root, TRACKED_FILE), '# tracked\n');
  writeFileSync(safePath.join(root, '.gitignore'), `${IGNORED_FILE}\n`);
  git(['add', TRACKED_FILE, '.gitignore'], root);
  git([...COMMIT_CONFIG, 'commit', '-m', 'fixture'], root);

  // Written after the commit so their status is unambiguous.
  writeFileSync(safePath.join(root, IGNORED_FILE), 'secret\n');
  writeFileSync(safePath.join(root, UNTRACKED_FILE), '# untracked\n');

  const tracker = new GitTracker(root);
  await tracker.initialize({ includeUntracked: true });
  const builder = new ProjectionBuilder(root, tracker);
  rootId = builder.identities.rootId;
  // Spelled through the shared builder, with the literal kind — asserting
  // against `GIT_EXTENT_KIND` would make the id a tautology of itself.
  extentId = extentContextId('git', rootId);

  contribution = await new GitExtentContributor().contribute(builder.base(), null);
});

afterAll(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('GitExtentContributor identity', () => {
  it('is the base-stratum git contributor', () => {
    const contributor = new GitExtentContributor();

    expect(contributor.id).toBe(GIT_EXTENT_CONTRIBUTOR_ID);
    expect(contributor.kind).toBe('git');
    expect(contributor.stratum).toBe('base');
  });
});

describe('GitExtentContributor extent declaration', () => {
  it('declares exactly one extent context, of kind "git"', () => {
    expect(contribution.contexts).toHaveLength(1);
    const context = contribution.contexts.at(0);

    expect(context?.kind).toBe('git');
    expect(context?.species).toBe('extent');
    expect(context?.contextId).toBe(extentId);
    expect(context?.rootId).toBe(rootId);
    // An extent is its own base, and role is meaningful only for kind "tree".
    expect(context?.extentContextId).toBeNull();
    expect(context?.role).toBeNull();
  });

  it('realizes every member in the extent it declared', () => {
    const extentIds = new Set(contribution.realizations.map((row) => row.extentId));

    expect([...extentIds]).toEqual([extentId]);
  });
});

describe('GitExtentContributor membership — tracked ∪ (untracked ∧ ¬ignored)', () => {
  it('includes a committed tracked file', () => {
    const tracked = contribution.realizations.find((row) => row.path === TRACKED_FILE);

    expect(tracked).toBeDefined();
    expect(memberIds().has(tracked?.resourceId ?? '')).toBe(true);
  });

  it('includes an untracked file that is not ignored', () => {
    const untracked = contribution.realizations.find((row) => row.path === UNTRACKED_FILE);

    expect(untracked).toBeDefined();
    expect(memberIds().has(untracked?.resourceId ?? '')).toBe(true);
  });

  it('excludes a gitignored file that is sitting right there on disk', () => {
    expect(realizedPaths()).not.toContain(IGNORED_FILE);
  });

  it('never walks into .git itself', () => {
    // eslint-disable-next-line local/no-path-startswith -- relativize() has already forward-slashed every realization path
    expect(realizedPaths().filter((path) => path.startsWith('.git/'))).toEqual([]);
  });

  it('marks every realization gitignored: false — true by construction here', () => {
    // The column is a real question only for a path arriving from somewhere
    // else (a parse-discovered link target); nothing this contributor
    // enumerates can be ignored.
    expect(contribution.realizations.every((row) => row.gitignored === false)).toBe(true);
  });

  it('emits one resource row and one membership per distinct identity', () => {
    const resourceIds = new Set(contribution.resources.map((row) => row.resourceId));

    expect(contribution.resources).toHaveLength(resourceIds.size);
    expect(memberIds()).toEqual(resourceIds);
  });
});

describe('git and filesystem extents disagree — the proving rung', () => {
  it('sees a gitignored file on the filesystem that git does not report', async () => {
    // Deliberately a LOCAL filesystem enumeration rather than the filesystem
    // contributor: the same claim, provable without coupling two modules.
    const walked = await crawlDirectory({
      baseDir: root,
      respectGitignore: false,
      exclude: [...NEVER_CRAWL_GLOBS],
    });
    const walkedRelative = walked.map((absolutePath) => toForwardSlash(safePath.relative(root, absolutePath)));

    expect(walkedRelative).toContain(IGNORED_FILE);
    expect(realizedPaths()).not.toContain(IGNORED_FILE);
    // Positive control: the two routes are not simply disjoint — they agree
    // about the tracked file, so the disagreement above is about gitignore.
    expect(walkedRelative).toContain(TRACKED_FILE);
    expect(realizedPaths()).toContain(TRACKED_FILE);
  });
});

describe('GitExtentContributor row shapes', () => {
  it('emits rows the shipped schemas accept', () => {
    expectContributionRowsValid(contribution);
  });

  it('attributes every resource row to the git lane', () => {
    // The kind, not the contributor id — `resources` rows are extent-independent,
    // and the filesystem contributor spells its own origin the same way.
    expect(contribution.resources.every((row) => row.origin === GIT_EXTENT_ORIGIN)).toBe(true);
    expect(contribution.resources.every((row) => row.fromEnumeration)).toBe(true);
  });

  it('reports no path collisions and no tags for a plain corpus', () => {
    expect(contribution.conditions).toEqual([]);
    expect(contribution.tags).toEqual([]);
  });
});

describe('GitExtentContributor without a git oracle on the base', () => {
  it('throws rather than silently building its own tracker', async () => {
    // The oracle is the run's, not the contributor's: a contributor that
    // spawned its own `git ls-files` would pay a second subprocess and could
    // answer index-casing questions differently from the ResourceIdentityMap
    // that minted the ids in its own rows.
    const builder = new ProjectionBuilder(root);

    await expect(new GitExtentContributor().contribute(builder.base(), null))
      .rejects.toThrow(/no git oracle/iu);
  });
});

describe('GitExtentContributor outside a repository', () => {
  it('throws rather than reporting an empty git extent', async () => {
    // `git ls-files` failing and "git answered, the repo is empty" are
    // indistinguishable from the row set alone, so an empty extent here would
    // be a confident wrong answer.
    const bare = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-git-extent-nogit-')));
    try {
      const builder = new ProjectionBuilder(bare, new GitTracker(bare));

      await expect(new GitExtentContributor().contribute(builder.base(), null))
        .rejects.toThrow(/not a git repository|did not answer/iu);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
