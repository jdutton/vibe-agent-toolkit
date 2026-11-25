/**
 * `claude_rule_patterns`, end to end: a real tree, the resources lane, and a
 * store round trip.
 *
 * Three things are only observable here. The unit suites drive
 * `ClaudeRulesScopeContributor.contribute` against a hand-assembled base, which
 * cannot show that the lane REGISTERS it, that the blob stage actually ran (the
 * frontmatter these rows are derived from lives on `blobs`, which no
 * hand-assembled base has to earn), or that the rows survive being written to a
 * store and read back — hydration rebuilds this table by REACHABILITY rather
 * than by reading it under a context, so a dropped row there is invisible to
 * every in-memory test.
 */

import { mkdir, writeFile } from 'node:fs/promises';

import { resetProjectRootCaches, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Projection } from '../../src/projection/projection.js';
import type { QueryPopulateResult } from '../../src/projection/query-projection.js';
import { buildResourceProjection } from '../../src/projection/resource-population.js';
import type { ClaudeRulePatternRow } from '../../src/schemas/projection-claude-rules.js';
import { FakeFactStore } from '../fake-fact-store.js';
import { git } from '../helpers/git-fixture.js';
import { inOwnRun } from '../helpers/population-run.js';
import { plantTree, razeTree } from '../helpers/temp-corpus.js';

/** The rules file whose `paths:` list every assertion below is about. */
const SCOPED_RULE = '.claude/rules/scoped.md';

/** Any stable string: one tree, one hash, so a second run is a hit by key. */
const TREE_HASH = 'rule-patterns-fixture-tree';

/**
 * One live glob, one dead one, and a paths-less rule beside them.
 *
 * The paths-less rule is the control on the ROW COUNT: it is classified, tagged
 * and a member, and it declares no pattern — so a producer that emitted a row
 * per rules FILE rather than per declared glob would show up here as a third
 * row rather than as silence.
 */
const TREE: Record<string, string> = {
  [SCOPED_RULE]: '---\npaths: ["docs/**/*.md", "gone/**/*.md"]\n---\n\nScoped rules.\n',
  '.claude/rules/always.md': '---\ndescription: always on\n---\n\nAlways loaded.\n',
  'docs/guide.md': '# Guide\n\nThe file the first glob matches.\n',
  'README.md': '# Readme\n\nNot under docs, and not matched by anything.\n',
};

let treeDir: string | undefined;

beforeAll(async () => {
  treeDir = await plantTree('vat-rule-patterns-', TREE);
});

afterAll(async () => {
  // Generous on purpose: a recursive `rm` over a temp tree has exceeded
  // Vitest's 10s hook default on Windows CI, failing the file for a reason that
  // has nothing to do with what it tests.
  await razeTree(treeDir);
});

/** The tree's root, refused rather than coerced when `beforeAll` never got there. */
function root(): string {
  if (treeDir === undefined) throw new Error('tree not planted — read it inside a test');
  return treeDir;
}

/**
 * Populate the fixture tree through the resources lane.
 *
 * @param store - A store to cache through, or omitted to re-derive
 * @returns The projection the lane produced, and whether the store served it
 */
async function populateTree(store?: FakeFactStore): Promise<QueryPopulateResult> {
  return inOwnRun(buildResourceProjection, {
    root: root(),
    ...(store === undefined ? {} : { cache: { store, treeUnchanged: () => true, treeHash: TREE_HASH } }),
  });
}

/**
 * The pattern rows, with the identity column swapped for the rule's own path.
 *
 * `resourceId` is a hash nobody can read; the path is what an assertion is
 * actually about, and resolving it through `resource_realizations` is also the
 * foreign key holding — a row pointing at an identity the projection does not
 * realize would come back `undefined` here.
 *
 * @param projection - The populated projection
 * @returns One entry per pattern row, in table order
 */
function patternsByRulePath(projection: Pick<Projection, 'claudeRulePatterns' | 'resourceRealizations'>): {
  path: string | undefined;
  pattern: string;
  status: string;
  witnessPath: string | null;
}[] {
  return projection.claudeRulePatterns.map((row: ClaudeRulePatternRow) => ({
    path: projection.resourceRealizations.find((r) => r.resourceId === row.resourceId)?.path,
    pattern: row.pattern,
    status: row.status,
    witnessPath: row.witnessPath,
  }));
}

describe('claude_rule_patterns through the resources lane', () => {
  it('produces one row per declared glob, with the tree-wide witness', async () => {
    const { projection } = await populateTree();

    // The positive control first: a lane that populated nothing satisfies every
    // shape assertion below, and a rules file nobody realized would make the
    // empty table read as a clean corpus.
    expect(projection.resourceRealizations.some((row) => row.path === SCOPED_RULE)).toBe(true);

    expect(patternsByRulePath(projection)).toEqual([
      { path: SCOPED_RULE, pattern: 'docs/**/*.md', status: 'matched', witnessPath: 'docs/guide.md' },
      { path: SCOPED_RULE, pattern: 'gone/**/*.md', status: 'inert', witnessPath: null },
    ]);
  });

  it('keeps every row across a store round trip, on a hit that ran no contributor', async () => {
    const store = new FakeFactStore();
    const { projection: populated } = await populateTree(store);
    const { projection: hydrated, outcome } = await populateTree(store);

    // Asserted FIRST, and it is not decoration: two correct populations of an
    // unchanged tree produce identical rows, so the row comparison below is
    // green whether the store answered or not. Only the outcome proves a
    // hydration happened.
    expect(outcome).toEqual({ population: 'store', stored: 'hit' });
    expect(hydrated.claudeRulePatterns).toEqual(populated.claudeRulePatterns);
    // ...and it is not two empty arrays agreeing.
    expect(hydrated.claudeRulePatterns).toHaveLength(2);
  });
});

/**
 * A repository whose rule scopes build output: `dist/` is ignored, and the
 * rule's first glob names it. The second glob is the control — dead, over
 * territory nothing ignores — and the third climbs out of the repository.
 */
const IGNORED_TREE: Record<string, string> = {
  '.gitignore': 'dist/\n',
  [SCOPED_RULE]: '---\npaths: ["dist/**", "gone/**/*.md", "../outside/**"]\n---\n\nBuild-output rules.\n',
  'src/index.ts': 'export {};\n',
};

/**
 * A monorepo whose build output is ignored only BELOW the root
 * (`/packages/*\/dist/`), with a rule naming it three ways. `dist/**` and
 * `dist` strip to the unanchored `dist`; no probe at the root can see
 * `packages/a/dist/`, and only git's ignored listing does.
 */
const NESTED_DIST_TREE: Record<string, string> = {
  '.gitignore': '/packages/*/dist/\n',
  [SCOPED_RULE]: '---\npaths: ["dist/**", "dist", "dist/**/*.js", "gone/**/*.md"]\n---\n\nBuild-output rules.\n',
  'packages/a/src/index.ts': 'export {};\n',
};

/**
 * A package below the repository's top level, populated as its own corpus root:
 * its `.gitignore` ignores `build/` only below it (`/lib/*\/build/`), so no
 * probe at the corpus root sees it and only git's ignored listing does. git
 * runs in the package and prints `lib/x/build/` relative to it, never to the
 * repository root; an entry read against the repository root lands outside the
 * corpus, is dropped, and the glob reads `inert`.
 */
const SUBDIRECTORY_ROOT_TREE: Record<string, string> = {
  'packages/a/.gitignore': '/lib/*/build/\n',
  [`packages/a/${SCOPED_RULE}`]: '---\npaths: ["build/**"]\n---\n\nBuild-output rules.\n',
  'packages/a/src/index.ts': 'export {};\n',
};

/**
 * Plant a tree as a committed repository, then write its ignored build output,
 * and populate it with a real ignore oracle.
 *
 * @param tree - The committed files
 * @param built - Ignored files written after the commit; none leaves `dist/` unbuilt
 * @param corpus - The corpus root, relative to the repository root (`''` for the root itself)
 * @returns `[pattern, status]` per pattern row, in table order
 */
async function populateIgnoredTree(
  tree: Record<string, string>,
  built: readonly string[],
  corpus: string,
): Promise<Array<[string, string]>> {
  const repo = await plantTree('vat-rule-patterns-ignored-', tree);
  const dir = safePath.join(repo, corpus);
  try {
    git(repo, 'init', '-q');
    git(repo, 'add', '--all');
    git(repo, 'commit', '-q', '-m', 'fixture');
    for (const file of built) {
      const absolute = safePath.join(repo, file);
      await mkdir(safePath.resolve(absolute, '..'), { recursive: true });
      await writeFile(absolute, 'export {};\n');
    }
    // `gitFindRoot` memoizes `null` for every directory a prior walk climbed
    // through, including this root's ancestors before the repository existed.
    resetProjectRootCaches();
    const gitTracker = new GitTracker(dir);
    await gitTracker.initialize();
    // Positive control on the oracle: an unusable tracker answers "nothing is
    // ignored", and every row below would be the non-repository answer.
    expect(gitTracker.isUsable()).toBe(true);
    const { projection } = await inOwnRun(buildResourceProjection, {
      root: dir, gitTracker, });
    // The premise: the ignored file is never realized, so no witness can exist.
    const realized = new Set(projection.resourceRealizations.map((row) => toForwardSlash(safePath.join(corpus, row.path))));
    expect(built.filter((file) => realized.has(file))).toEqual([]);
    expect(projection.resourceRealizations.some((row) => row.path === SCOPED_RULE)).toBe(true);
    return projection.claudeRulePatterns.map((row): [string, string] => [row.pattern, row.status]);
  } finally {
    await razeTree(repo);
  }
}

/** What {@link IGNORED_TREE} must report, built or not. */
const IGNORED_TREE_ROWS: Array<[string, string]> = [
  ['dist/**', 'gitignored'],
  ['gone/**/*.md', 'inert'],
  // Outside the repository nothing is ignored — answered without asking.
  ['../outside/**', 'inert'],
];

describe('claude_rule_patterns over gitignored territory', () => {
  it.each([
    // ⛔ `dist/` in `.gitignore` matches only a DIRECTORY, and a `dist` that
    // does not exist is not known to be one — the unbuilt arm is the one a
    // naive "is the bare prefix ignored?" answers wrongly.
    ['an unbuilt root dist/', IGNORED_TREE, [], IGNORED_TREE_ROWS, ''],
    ['a built root dist/', IGNORED_TREE, ['dist/app.js'], IGNORED_TREE_ROWS, ''],
    // ⛔ The unanchored glob's territory is ignored only below the root, so the
    // answer comes from git's ignored LISTING through the real contributor.
    ['a built packages/a/dist/ ignored below the root', NESTED_DIST_TREE, ['packages/a/dist/index.js'], [
      ['dist/**', 'gitignored'],
      ['dist', 'gitignored'],
      // The control: a slash before the last character ANCHORS this one to the
      // root, so it can never reach `packages/a/dist/` and stays inert.
      ['dist/**/*.js', 'inert'],
      ['gone/**/*.md', 'inert'],
    ], ''],
    ['a built lib/x/build/ under a corpus root below the repository root', SUBDIRECTORY_ROOT_TREE, ['packages/a/lib/x/build/out.js'], [
      ['build/**', 'gitignored'],
    ], 'packages/a'],
  ] as const)('reports each glob over %s', async (_what, tree, built, rows, corpus) => {
    expect(await populateIgnoredTree(tree, built, corpus)).toEqual(rows);
  });
});
