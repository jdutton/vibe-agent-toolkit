/**
 * **On POSIX a backslash is a filename character, and every lane must keep it.**
 *
 * `toForwardSlash` used to convert every `\` on every host. A tracked
 * `docs/x\y.md` then became `docs/x/y.md`: git's own listing was rewritten into
 * a phantom path nothing could read, a phantom `docs/x` directory was realized
 * as existing, and a rules file `.claude/rules/a\b.md` fell out of
 * `claude_rule_patterns` — so its dead glob was never reported and its rule read
 * as always-loaded.
 *
 * Only a REAL file with a backslash in its name can observe this: every unit
 * suite spells such a path as a string, which is exactly the input the old
 * converter was written to "fix". The git arm is a real `git init` + commit
 * (the snapshot route); the plain arm has no repository above it (the walk
 * route). Both are skipped on win32, where `\` is a separator and no such file
 * can be created.
 */

import { existsSync } from 'node:fs';
import { sep } from 'node:path';

import { resetProjectRootCaches, safePath } from '@vibe-agent-toolkit/utils';
import { crawlDirectory } from '@vibe-agent-toolkit/utils/crawl';
import { GitTracker, gitTreeSnapshot, runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CLAUDE_RULE_GLOB_INERT_CHECK } from '../../src/projection/builtin-checks.js';
import { DISCARD_BLOB_POPULATION } from '../../src/projection/merge.js';
import type { Projection } from '../../src/projection/projection.js';
import { buildResourceProjection } from '../../src/projection/resource-population.js';
import { plantTree, razeTree } from '../helpers/temp-corpus.js';

/** A document whose name carries a backslash — ONE file directly under `docs/`. */
const BACKSLASH_DOC = String.raw`docs/x\y.md`;
/** The directory the old converter invented out of {@link BACKSLASH_DOC}. */
const PHANTOM_DIR = 'docs/x';
/** A rules file whose name carries a backslash, scoped by a glob that matches nothing. */
const BACKSLASH_RULE = String.raw`.claude/rules/a\b.md`;
const DEAD_GLOB = 'nonexistent/**';

const TREE: Record<string, string> = {
  [BACKSLASH_RULE]: `---\npaths:\n  - "${DEAD_GLOB}"\n---\n# rule\n`,
  [BACKSLASH_DOC]: '# x\n\nSee [readme](../README.md)\n',
  'docs/ok.md': '# ok\n',
  'README.md': '# readme\n\nSee [docs](docs/ok.md)\n',
};

/** Locale order: the crawler's listing and the snapshot are compared as sets. */
const byName = (a: string, b: string): number => a.localeCompare(b);

/** Every file in {@link TREE}, sorted. */
const EXPECTED_FILES = Object.keys(TREE).sort(byName);

/** Identity a commit needs, without touching the developer's config. */
const COMMIT_IDENTITY = [
  '-c', 'user.name=VAT Fixture',
  '-c', 'user.email=fixture@example.invalid',
  '-c', 'commit.gpgsign=false',
];

/** `\` is a separator here, so the fixture's filenames cannot exist. */
const BACKSLASH_IS_SEPARATOR = sep === '\\';

let gitRoot: string | undefined;
let plainRoot: string | undefined;

beforeAll(async () => {
  if (BACKSLASH_IS_SEPARATOR) return;
  gitRoot = await plantTree('vat-backslash-git-', TREE);
  runGitOrThrow(['init'], { cwd: gitRoot });
  runGitOrThrow(['add', '--all'], { cwd: gitRoot });
  runGitOrThrow([...COMMIT_IDENTITY, 'commit', '-m', 'fixture'], { cwd: gitRoot });
  plainRoot = await plantTree('vat-backslash-plain-', TREE);
  // `gitFindRoot` memoizes `null` for directories a prior walk climbed through.
  resetProjectRootCaches();
}, 60_000);

afterAll(async () => {
  await razeTree(gitRoot);
  await razeTree(plainRoot);
}, 60_000);

/** A planted root, refused rather than coerced when `beforeAll` never set it. */
function planted(dir: string | undefined): string {
  if (dir === undefined) throw new Error('tree not planted — read it inside a test');
  return dir;
}

/** Every file the crawler lists under `root`, root-relative and sorted. */
async function crawled(root: string): Promise<string[]> {
  const files = await crawlDirectory({
    baseDir: root,
    absolute: false,
    includeUntracked: true,
    unreadable: { refuse: { root, remedy: 'fixture' } },
  });
  return [...files].sort(byName);
}

/** The resources lane over `root`, with a real ignore oracle when it is a repository. */
async function populate(root: string, withGit: boolean): Promise<Projection> {
  if (!withGit) return buildResourceProjection({ root, onBlobPopulation: DISCARD_BLOB_POPULATION });
  const gitTracker = new GitTracker(root);
  await gitTracker.initialize();
  // Positive control: an unusable tracker would silently turn this into the walk arm.
  expect(gitTracker.isUsable()).toBe(true);
  return buildResourceProjection({ root, gitTracker, onBlobPopulation: DISCARD_BLOB_POPULATION });
}

/** Assert the backslash names survived the lane, in both realization and rule tables. */
function expectBackslashNamesKept(projection: Projection): void {
  const doc = projection.resourceRealizations.find((row) => row.path === BACKSLASH_DOC);
  expect(doc).toMatchObject({ exists: true, isDirectory: false, dir: 'docs' });
  expect(doc?.contentKey).not.toBeNull();
  // The phantom: neither the invented directory nor the invented file.
  expect(projection.resourceRealizations.filter((row) => row.path === PHANTOM_DIR)).toEqual([]);
  expect(projection.resourceRealizations.filter((row) => row.path === 'docs/x/y.md')).toEqual([]);

  const ruleId = projection.resourceRealizations.find((row) => row.path === BACKSLASH_RULE)?.resourceId;
  expect(ruleId).toBeDefined();
  expect(
    projection.claudeRulePatterns
      .filter((row) => row.resourceId === ruleId)
      .map((row) => [row.pattern, row.status]),
  ).toEqual([[DEAD_GLOB, 'inert']]);

  const issues = CLAUDE_RULE_GLOB_INERT_CHECK.run(projection);
  expect(issues.map((issue) => [issue.code, issue.location, issue.field])).toEqual([
    ['CLAUDE_RULE_GLOB_INERT', BACKSLASH_RULE, 'paths'],
  ]);
}

// Gated: on win32 a backslash is a path separator, so a file named `x\y.md` cannot be created there.
describe.skipIf(BACKSLASH_IS_SEPARATOR)('a POSIX filename containing a backslash', () => {
  it('is returned unchanged by the git tree snapshot', () => {
    const root = planted(gitRoot);
    const snapshot = gitTreeSnapshot({ cwd: root });
    expect(snapshot).not.toBeNull();
    const relative = (snapshot?.entries ?? []).map((entry) => safePath.relative(root, entry.absolutePath));
    expect(relative.toSorted(byName)).toEqual(EXPECTED_FILES);
  });

  it.each([
    ['the git route', () => planted(gitRoot)],
    ['the walk route', () => planted(plainRoot)],
  ])('is listed by the crawler and exists, through %s', async (_route, rootOf) => {
    const root = rootOf();
    const files = await crawled(root);
    expect(files).toEqual(EXPECTED_FILES);
    expect(existsSync(safePath.join(root, BACKSLASH_DOC))).toBe(true);
  });

  it.each([
    ['a repository', true, () => planted(gitRoot)],
    ['a plain directory', false, () => planted(plainRoot)],
  ])('is realized, keyed and rule-scanned under its own name in %s', async (_where, withGit, rootOf) => {
    expectBackslashNamesKept(await populate(rootOf(), withGit));
  }, 60_000);
});
