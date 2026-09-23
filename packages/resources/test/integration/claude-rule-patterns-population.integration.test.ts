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
import { GitTracker, runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DISCARD_BLOB_POPULATION } from '../../src/projection/merge.js';
import type { Projection } from '../../src/projection/projection.js';
import { buildResourceProjection } from '../../src/projection/resource-population.js';
import type { ClaudeRulePatternRow } from '../../src/schemas/projection-claude-rules.js';
import { FakeProjectionStore } from '../fake-projection-store.js';
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
}, 60_000);

afterAll(async () => {
  // Generous on purpose: a recursive `rm` over a temp tree has exceeded
  // Vitest's 10s hook default on Windows CI, failing the file for a reason that
  // has nothing to do with what it tests.
  await razeTree(treeDir);
}, 60_000);

/** The tree's root, refused rather than coerced when `beforeAll` never got there. */
function root(): string {
  if (treeDir === undefined) throw new Error('tree not planted — read it inside a test');
  return treeDir;
}

/**
 * Populate the fixture tree through the resources lane.
 *
 * @param store - A store to cache through, or omitted to re-derive
 * @param onContributor - Receives every contributor invocation; an EMPTY record
 *   list is the only observable signature of a store hit
 * @returns The projection the lane produced
 */
async function populateTree(
  store?: FakeProjectionStore,
  onContributor?: (id: string) => void,
): Promise<Projection> {
  return buildResourceProjection({
    root: root(),
    onBlobPopulation: DISCARD_BLOB_POPULATION,
    ...(store === undefined ? {} : { cache: { store, treeUnchanged: () => true, treeHash: TREE_HASH } }),
    ...(onContributor === undefined
      ? {}
      : { onContributorTiming: (timing) => onContributor(timing.contributorId) }),
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
function patternsByRulePath(projection: Projection): {
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
    const projection = await populateTree();

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
    const store = new FakeProjectionStore();
    const populated = await populateTree(store);
    const filed: string[] = [];
    const hydrated = await populateTree(store, (id) => filed.push(id));

    // Asserted FIRST, and it is not decoration: two correct populations of an
    // unchanged tree produce identical rows, so the row comparison below is
    // green whether the store answered or not. Only the absence of contributor
    // work proves a hydration happened.
    expect(filed).toEqual([]);
    expect(hydrated.claudeRulePatterns).toEqual(populated.claudeRulePatterns);
    // ...and it is not two empty arrays agreeing.
    expect(hydrated.claudeRulePatterns).toHaveLength(2);
  });
});

/** Identity a commit needs, without touching the developer's config. */
const COMMIT_IDENTITY = [
  '-c', 'user.name=VAT Fixture',
  '-c', 'user.email=fixture@example.invalid',
  '-c', 'commit.gpgsign=false',
];

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
 * Plant a tree as a committed repository, then write its ignored build output,
 * and populate it with a real ignore oracle.
 *
 * @param tree - The committed files
 * @param built - Ignored files written after the commit; none leaves `dist/` unbuilt
 * @returns `[pattern, status]` per pattern row, in table order
 */
async function populateIgnoredTree(
  tree: Record<string, string>,
  built: readonly string[],
): Promise<Array<[string, string]>> {
  const dir = await plantTree('vat-rule-patterns-ignored-', tree);
  try {
    runGitOrThrow(['init'], { cwd: dir });
    runGitOrThrow(['add', '--all'], { cwd: dir });
    runGitOrThrow([...COMMIT_IDENTITY, 'commit', '-m', 'fixture'], { cwd: dir });
    for (const file of built) {
      const absolute = safePath.join(dir, file);
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
    const projection = await buildResourceProjection({
      root: dir, gitTracker, onBlobPopulation: DISCARD_BLOB_POPULATION,
    });
    // The premise: the ignored file is never realized, so no witness can exist.
    expect(projection.resourceRealizations.filter((row) => built.includes(toForwardSlash(row.path)))).toEqual([]);
    expect(projection.resourceRealizations.some((row) => row.path === SCOPED_RULE)).toBe(true);
    return projection.claudeRulePatterns.map((row): [string, string] => [row.pattern, row.status]);
  } finally {
    await razeTree(dir);
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
    ['an unbuilt root dist/', IGNORED_TREE, [], IGNORED_TREE_ROWS],
    ['a built root dist/', IGNORED_TREE, ['dist/app.js'], IGNORED_TREE_ROWS],
    // ⛔ The unanchored glob's territory is ignored only below the root, so the
    // answer comes from git's ignored LISTING through the real contributor.
    ['a built packages/a/dist/ ignored below the root', NESTED_DIST_TREE, ['packages/a/dist/index.js'], [
      ['dist/**', 'gitignored'],
      ['dist', 'gitignored'],
      // The control: a slash before the last character ANCHORS this one to the
      // root, so it can never reach `packages/a/dist/` and stays inert.
      ['dist/**/*.js', 'inert'],
      ['gone/**/*.md', 'inert'],
    ]],
  ] as const)('reports each glob over %s', async (_what, tree, built, rows) => {
    expect(await populateIgnoredTree(tree, built)).toEqual(rows);
  }, 60_000);
});
