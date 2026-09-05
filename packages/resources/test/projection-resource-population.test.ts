import { mkdir, writeFile } from 'node:fs/promises';
// `dirname` only — `join`/`resolve`/`relative` are ESLint-banned in favour of
// `safePath`, which has no `dirname` because it never needed one.
import { dirname } from 'node:path';

import { compareCodeUnits, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { GitTracker, runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  EXTENT_SOURCE_ENV,
  EXTENT_SOURCE_GIT,
  type CrawlSourceKind,
} from '../src/projection/crawl-source.js';
import { DISCARD_BLOB_POPULATION } from '../src/projection/merge.js';
import {
  buildResourcePopulation,
  buildResourceProjection,
} from '../src/projection/resource-population.js';
import type {
  BlobScopedRows,
  ExtentKey,
  ExtentScopedRows,
  ProjectionStore,
} from '../src/projection/store.js';

import { setupSubdirTestSuite } from './test-helpers.js';

/** The plain markdown member every fixture below starts from. */
const DOC_A = 'a.md';

/** Present in two fixtures, and a member in both — it is a file like any other. */
const GITIGNORE = '.gitignore';

/** Tracked: the half `git ls-files` and this lane agree about. */
const COMMITTED = 'committed.md';

/** Untracked but not ignored — the member the incumbent walk cannot see at all. */
const UNCOMMITTED = 'uncommitted.md';

/** Ignored, and the directory holding it. The half this lane declines. */
const IGNORED_DIR = 'build';
const IGNORED_DOC = `${IGNORED_DIR}/generated.md`;

/** Any stable string: {@link CapturingStore} never reads, so it names nothing. */
const FIXTURE_TREE_HASH = 'fixture-tree';

const suite = setupSubdirTestSuite('resource-population-');

/** Write one fixture file, creating its parent directory. */
async function write(relativePath: string, content: string): Promise<void> {
  const absolute = safePath.join(suite.tempDir, relativePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path beneath a mkdtemp root
  await mkdir(dirname(absolute), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path beneath a mkdtemp root
  await writeFile(absolute, content, 'utf-8');
}

/** Run git in the fixture tree, throwing on any failure. */
function git(args: readonly string[]): void {
  runGitOrThrow([...args], { cwd: suite.tempDir });
}

/**
 * A repository holding one committed, one untracked and one ignored markdown
 * file, plus the ignored directory containing the third.
 *
 * Committing first is not ceremony: `git ls-files` answers nothing for a
 * repository with no commit, so a fixture that only wrote files would report
 * every path as untracked and the assertions would pass for the wrong reason.
 * The two files written AFTER the commit have unambiguous status by construction.
 *
 * @returns The tracker built over the finished fixture
 */
async function buildIgnoredFixture(): Promise<GitTracker> {
  git(['init', '--quiet']);
  await write(COMMITTED, '# Committed\n');
  await write(GITIGNORE, `${IGNORED_DIR}/\n`);
  git(['add', '-A']);
  git(['-c', 'user.name=VAT Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
  await write(UNCOMMITTED, '# Not yet committed\n');
  await write(IGNORED_DOC, '# Generated\n');

  const tracker = new GitTracker(suite.tempDir);
  await tracker.initialize();
  return tracker;
}

/**
 * Run the lane against the fixture tree, capturing the rows it built.
 *
 * @param tracker - The run's ignore oracle
 * @returns The store double, holding whatever was written
 */
async function populateCapturing(tracker: GitTracker): Promise<CapturingStore> {
  const store = new CapturingStore();
  await buildResourcePopulation({
    root: suite.tempDir,
    gitTracker: tracker,
    cache: { store, treeHash: FIXTURE_TREE_HASH },
  });
  return store;
}

/** The enumerator the run actually used, as the population reports it. */
async function extentSourceOf(): Promise<CrawlSourceKind> {
  const { extentSource } = await buildResourcePopulation({ root: suite.tempDir });
  return extentSource;
}

/** The population as root-relative, forward-slashed paths — the readable unit. */
async function populationOf(gitTracker?: GitTracker): Promise<string[]> {
  const { paths } = await buildResourcePopulation({
    root: suite.tempDir,
    ...(gitTracker !== undefined && { gitTracker }),
  });
  // Code-unit order, never `localeCompare`: the expected arrays below are
  // written in ASCII order, and a locale-dependent sort makes them pass or fail
  // by environment.
  return paths
    .map((absolute) => toForwardSlash(safePath.relative(suite.tempDir, absolute)))
    .sort(compareCodeUnits);
}

describe('buildResourcePopulation', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('enumerates files and declines the directories that contain them', async () => {
    await write(DOC_A, '# A\n');
    await write('docs/b.md', '# B\n');

    // `docs` is a real member of the filesystem extent — the `claude-context`
    // lens keys on a directory — so this asserts the CONSUMER declines it, not
    // that the extent failed to produce it.
    expect(await populationOf()).toEqual([DOC_A, 'docs/b.md']);
  });

  it('admits a file no glob would reach, leaving include/exclude to the caller', async () => {
    await write(DOC_A, '# A\n');
    await write('tools/run.sh', 'echo hi\n');
    await write('assets/logo.png', 'not really a png\n');

    // The population answers ENUMERATION only. Narrowing here as well as in the
    // registry would put the project's globs in two places, and the two would
    // eventually disagree about what the project meant.
    expect(await populationOf()).toEqual([DOC_A, 'assets/logo.png', 'tools/run.sh']);
  });

  it('declines the gitignored half and admits the untracked one', async () => {
    // The population's whole product claim in one fixture.
    const tracker = await buildIgnoredFixture();

    // ⭐ THE BEHAVIOUR-PRESERVATION GATE for declining the ignored half at the
    // extent instead of here: this expectation is unchanged by that work, and it
    // must stay that way. `build/generated.md` is on disk and no longer costs a
    // row; `uncommitted.md` is the file the walker cannot see at all, and
    // admitting it is the reason this lane exists.
    expect(await populationOf(tracker)).toEqual([GITIGNORE, COMMITTED, UNCOMMITTED]);
  });

  it('admits everything outside a git repository, because there is no ignore oracle', async () => {
    await write(DOC_A, '# A\n');
    await write(GITIGNORE, 'ignored/\n');
    await write('ignored/generated.md', '# Generated\n');

    // No repository, so no tracker, so no row is `gitignored` — and a bare
    // `.gitignore` file is not an oracle. Declining here on the strength of the
    // file's mere presence would be a guess dressed up as a rule.
    expect(await populationOf()).toEqual([GITIGNORE, DOC_A, 'ignored/generated.md']);
  });
});

/**
 * A store that records the rows it was handed and answers no read.
 *
 * The only window onto what this lane actually BUILT. `buildResourcePopulation`
 * returns paths and discards its `Projection`, so "the ignored half was never
 * realized" — a claim about rows, not about the returned paths — is otherwise
 * unobservable from outside. Answering no read keeps every run a full
 * enumeration, so the assertion is about work that happened rather than about a
 * cache hit.
 */
class CapturingStore implements ProjectionStore {
  /** The extent-scoped rows of the most recent write, if there was one. */
  written: ExtentScopedRows | undefined;

  async writeExtent(_key: ExtentKey, rows: ExtentScopedRows): Promise<void> {
    this.written = rows;
  }

  async readExtent(_key: ExtentKey): Promise<ExtentScopedRows | undefined> {
    return undefined;
  }

  async writeBlobFacts(_rows: BlobScopedRows): Promise<void> {
    // Unreachable under `CONTENT_PARSING_SKIP`; nothing to record.
  }

  async readBlobFacts(_contentKeys: readonly string[]): Promise<BlobScopedRows> {
    // Loud rather than a fiction: this lane declares it reads no blob table, so
    // a call here is that declaration being false and must not return [].
    throw new Error('the resource population lane must never read blob facts');
  }

  async close(): Promise<void> {
    // Nothing is held open.
  }
}

describe('buildResourcePopulation declines the ignored half before paying for it', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('never realizes a gitignored path, so it never lstats or realpaths one', async () => {
    // ⛔ THE ROT GUARD, and it is the reason this test exists rather than the
    // path-level one above. Dropping the `parameters:` line from the lane leaves
    // the RETURNED PATHS byte-identical — the loop's own `if (row.gitignored)
    // continue` still filters them — so every other test in this file stays
    // green while the lane silently goes back to building 11,122 rows it throws
    // away. Measured before the fix, on an 8,548-file adopter tree: 20,908
    // `lstat` and 12,362 `realpathSync.native` calls, against the walk's zero.
    //
    // The row set is where the saving is observable, so the row set is what this
    // asserts. `build/` — the ignored DIRECTORY — is named explicitly because a
    // predicate that skipped ignored files but descended their directories would
    // still pay for every one of them.
    const store = await populateCapturing(await buildIgnoredFixture());

    const realized = (store.written?.resourceRealizations ?? []).map((row) => row.path);
    expect(realized).not.toContain(IGNORED_DOC);
    expect(realized).not.toContain(IGNORED_DIR);
    // The discriminator: without it an extent that realized NOTHING would pass.
    expect(realized).toContain(COMMITTED);
    expect(realized).toContain(UNCOMMITTED);
  });

  it('declares the decline in provenance, which is what keeps the cache honest', async () => {
    // Stated as a parameter set rather than a constructor argument precisely so
    // it lands here: `selectRequestedContexts` keys a stored context on
    // `(contributorId, parameterSet)`, so a run asking the wide question MISSES
    // this extent instead of being served a population with half the tree
    // missing and reporting success. A `null` here is a poisoned cache key.
    const store = await populateCapturing(await buildIgnoredFixture());

    const provenance = (store.written?.zoneProvenance ?? [])
      .find((row) => row.contributorId === 'builtin:filesystem');
    expect(provenance?.parameterSet).toEqual({ ignored: 'decline' });
  });
});

describe('buildResourcePopulation reports which enumerator ran', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  afterEach(() => {
    delete process.env[EXTENT_SOURCE_ENV];
  });

  // ⚠️ Not "when nothing selects git" any more — git IS what nothing selects.
  // This fixture is a bare temp directory with no repository above it, so what
  // it pins is the FALLBACK, and the title has to say so or the next reader
  // takes it as evidence the default is still the walk.
  it('reports the filesystem enumerator on a tree with no repository above it', async () => {
    await write(DOC_A, '# A\n');

    expect(await extentSourceOf()).toBe('filesystem');
  });

  it('reports git when git is selected inside a repository', async () => {
    await write(DOC_A, '# A\n');
    git(['init', '--quiet']);
    process.env[EXTENT_SOURCE_ENV] = EXTENT_SOURCE_GIT;

    expect(await extentSourceOf()).toBe('git');
  });

  it('reports the walk when git is selected OUTSIDE a repository', async () => {
    await write(DOC_A, '# A\n');
    // Deliberately no `git init`. `crawlSourceFor` declines git here and hands
    // back the walk WITHOUT saying so anywhere else, which is the whole reason
    // this field exists: an A/B varying only this variable would otherwise run
    // one enumerator twice, agree with itself, and read as "safe to flip".
    process.env[EXTENT_SOURCE_ENV] = EXTENT_SOURCE_GIT;

    // The request was `git`; the answer is what RAN. If this ever reports
    // `git`, the report has become a copy of the environment and every
    // comparison built on it is void.
    expect(await extentSourceOf()).toBe('filesystem');
  });
});

describe('buildResourceProjection', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('derives the blob rows its sibling deliberately never pays for', async () => {
    // The whole reason this lane exists. `buildResourcePopulation` runs under
    // `contentParsing: CONTENT_PARSING_SKIP` and `contentDemand: 'deferred'`, so
    // a query about headings, links or sections against ITS projection would
    // return nothing and report success. These counts are what make the query
    // surface answerable at all — and they are asserted as counts rather than as
    // "not undefined", because four empty tables is exactly the failure shape.
    await write(DOC_A, '# A\n\nSee [b](./docs/b.md).\n');
    await write('docs/b.md', '# B\n');

    const projection = await buildResourceProjection({
      root: suite.tempDir,
      onBlobPopulation: DISCARD_BLOB_POPULATION,
    });

    expect(projection.blobs.length).toBeGreaterThan(0);
    expect(projection.blobSections.length).toBeGreaterThan(0);
    expect(projection.blobReferences.length).toBeGreaterThan(0);
  });

  it('describes the same membership as the population lane', async () => {
    // The claim `resourceContributors` makes by being shared: two lanes, one
    // registry, one population. If these ever disagree, `vat resources query` is
    // answering about a corpus `vat resources validate` never looked at — and
    // the disagreement would be silent, because each command is self-consistent.
    //
    // Compared on the FILES only: this lane's projection also carries the
    // directory rows the population loop drops, which is a difference in what
    // the caller reads rather than in what was enumerated.
    await write(DOC_A, '# A\n');
    await write('docs/b.md', '# B\n');

    const projection = await buildResourceProjection({
      root: suite.tempDir,
      onBlobPopulation: DISCARD_BLOB_POPULATION,
    });
    const realizedFiles = projection.resourceRealizations
      .filter((row) => !row.isDirectory && row.exists && !row.gitignored)
      .map((row) => toForwardSlash(row.path))
      .sort(compareCodeUnits);

    expect(realizedFiles).toEqual(await populationOf());
  });

  it('declines the gitignored half exactly as the population lane does', async () => {
    // The shared `DECLINE_IGNORED` parameter set, asserted where it is
    // observable. A query that could answer about `build/generated.md` would be
    // answering about a file the project told git to forget and validation never
    // sees.
    const tracker = await buildIgnoredFixture();

    const projection = await buildResourceProjection({
      root: suite.tempDir,
      gitTracker: tracker,
      onBlobPopulation: DISCARD_BLOB_POPULATION,
    });
    const realized = projection.resourceRealizations.map((row) => toForwardSlash(row.path));

    expect(realized).not.toContain(IGNORED_DOC);
    expect(realized).not.toContain(IGNORED_DIR);
    // The discriminator: an extent that realized nothing would pass without it.
    expect(realized).toContain(COMMITTED);
    expect(realized).toContain(UNCOMMITTED);
  });

  it('files a contributor record when it derived, which is the cache tell', async () => {
    // 🔑 The observable half of "did the store answer". A hit short-circuits
    // before any contributor runs, so an EMPTY record list is the tell — and
    // this is its negative control: a lane that filed nothing even while
    // deriving would make every future hit unfalsifiable, since a correct hit
    // and a correct re-derivation produce identical rows.
    await write(DOC_A, '# A\n');
    const filed: string[] = [];

    await buildResourceProjection({
      root: suite.tempDir,
      onBlobPopulation: DISCARD_BLOB_POPULATION,
      onContributorTiming: (timing) => filed.push(timing.contributorId),
    });

    expect(filed).toContain('builtin:filesystem');
  });
});
