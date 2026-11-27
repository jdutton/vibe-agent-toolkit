/**
 * The `git_content` relation through the built CLI (`vat resources query` and `vat resources check`).
 *
 * `git_content` is git's own content under the analysis root, read off the run's memoized snapshot
 * through the one membership function the git crawl is built on: tracked files present in the
 * worktree plus untracked files no ignore rule covers, symlinks as one listed name, never an ignored
 * file, a deleted one, an absent skip-worktree one, or a submodule's gitlink.
 *
 * Proved here, each over one fixture built once for the suite:
 * - **membership**, store off, cold and warm alike, and identical with and without ignored entries;
 * - **no snapshot of its own:** `git.snapshots` equal between the same run with and without a
 *   statement naming `git_content`, per arm, on the default git crawl source;
 * - **the warm unlistable seed** (POSIX): a warm run served its extent from the store refuses, as the
 *   cold crawl does, a directory git cannot list;
 * - **Git LFS:** a path pulled and not pulled is git content either way;
 * - **no git answer:** git off `PATH`, and a root outside any work tree (with the filesystem crawl
 *   forced too), store on and off: the snapshot's own coded error, for a statement naming
 *   `git_content` and for one naming a `tsconfig_*` relation (whose step reads git content).
 *
 * Reds, each seeded once and reverted:
 * - `gitContentListing` taking `freshGitTreeSnapshot` in place of the memoized snapshot: the
 *   `git.snapshots` equality failed on every arm (store off 1 against 2).
 * - `gitContentListing` without its `assertListable` call: the warm unlistable seed answered at exit 0
 *   with `d/new.test.ts` missing.
 */

import { chmodSync, rmSync, writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, resolveFromImportMeta, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';
import { CANNOT_DENY_READS, createLfsFixtureRepo, lfsPointerOf } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { answeredRows, countedQuery, freshDataArm, refusalOf, type CountedQuery, type DataArm } from '../helpers/data-rows.js';
import { commitTestFixture, writeCorpus } from '../test-helpers.js';

import { createSuiteContext, executeCli, isolatedScratchEnv } from './test-common.js';

/** Every `git_content` row, its root joined to the run's root so the column is proved the root id. */
const GIT_CONTENT_SQL = 'SELECT g.repository AS repository, g.path AS path FROM git_content g JOIN roots r ON r.id = g.root ORDER BY g.path';

/** The same run's question with and without `git_content`: the snapshot counter is compared across the two. */
const WITHOUT_SQL = 'SELECT COUNT(*) AS n FROM resource_realizations';
const WITH_SQL = 'SELECT (SELECT COUNT(*) FROM resource_realizations) AS n, (SELECT COUNT(*) FROM git_content) AS g';

/** A check over `git_content`, so `vat resources check` demands it too. */
const CHECK_CONFIG = [
  'resources:',
  '  include:',
  '    - "**/*.md"',
  '  checks:',
  '    git-src:',
  '      description: Every source file git holds',
  '      sql: "SELECT path FROM git_content WHERE path LIKE \'src/%\' ORDER BY path"',
  '      severity: warning',
  '',
].join('\n');

const COMMIT = ['-c', 'user.name=VAT Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm'];

const SYMLINK_CAPABILITY = symlinkCapability();
const SYMLINKS = SYMLINK_CAPABILITY !== null;

const context = createSuiteContext('vat-git-content-', import.meta.url);

/** The membership fixture: every kind of entry git content admits or leaves out. */
let tree = '';

/** What `git_content` lists over {@link tree}, by path; `repository` is `''` for every row. */
const EXPECTED_PATHS = [
  '.gitignore',
  'README.md',
  'docs/notes.md',
  ...(SYMLINKS ? ['link.ts'] : []),
  'packages/a/coverage/kept.test.ts',
  'src/a.ts',
  ...(SYMLINKS ? ['srclink'] : []),
  'vibe-agent-toolkit.config.yaml',
];

/**
 * Write the membership fixture: committed files, a tracked file and directory symlink, a tracked
 * test under `coverage/`, a submodule gitlink, then a tracked file deleted from the worktree, a
 * skip-worktree file absent from disk, and an untracked, unignored file.
 *
 * @param root - Where the fixture goes
 */
function writeMembershipTree(root: string): void {
  writeCorpus(root, {
    '.gitignore': 'ignored/\n.cache/\n',
    'README.md': '# Readme\n',
    'vibe-agent-toolkit.config.yaml': CHECK_CONFIG,
    'src/a.ts': 'export const a = 1;\n',
    'packages/a/coverage/kept.test.ts': 'export {};\n',
    'gone.ts': 'export const gone = 1;\n',
    'sparse/left.ts': 'export const left = 1;\n',
  });
  if (SYMLINK_CAPABILITY !== null) {
    createSymlink(SYMLINK_CAPABILITY, 'src/a.ts', safePath.join(root, 'link.ts'), 'file');
    createSymlink(SYMLINK_CAPABILITY, 'src', safePath.join(root, 'srclink'), 'dir');
  }
  // An embedded repository, committed, which the outer `git add` records as a gitlink.
  const sub = safePath.join(root, 'sub');
  writeCorpus(sub, { 'inner.md': '# Inner\n' });
  runGitOrThrow(['init', '-q', '-b', 'main'], { cwd: sub });
  runGitOrThrow(['add', '-A'], { cwd: sub });
  runGitOrThrow([...COMMIT, 'inner'], { cwd: sub });
  commitTestFixture(root);
  expect(runGitOrThrow(['ls-files', '-s', 'sub'], { cwd: root }), 'premise: sub is a gitlink').toMatch(/^160000 /u);

  rmSync(safePath.join(root, 'gone.ts'));
  runGitOrThrow(['update-index', '--skip-worktree', 'sparse/left.ts'], { cwd: root });
  rmSync(safePath.join(root, 'sparse', 'left.ts'));
  writeCorpus(root, { 'docs/notes.md': '# Notes\n\nNot committed yet.\n' });
}

/** Plant the ignored entries: an ignored directory, and an ignored dot directory holding an `.mts`. */
function plantIgnored(root: string): void {
  writeCorpus(root, { 'ignored/x.ts': 'export const x = 1;\n', '.cache/m.mts': 'export const m = 1;\n' });
}

/** Remove what {@link plantIgnored} planted. */
function removeIgnored(root: string): void {
  rmSync(safePath.join(root, 'ignored'), { recursive: true, force: true });
  rmSync(safePath.join(root, '.cache'), { recursive: true, force: true });
}

beforeAll(() => {
  context.setup();
  tree = safePath.join(context.createTempDir(), 'tree');
  writeMembershipTree(tree);
  plantIgnored(tree);
});
afterAll(() => context.cleanup());

/** A suite temp directory laid out as {@link isolatedScratchEnv} expects: `home/.claude` and `tmp`. */
function isolatedScratch(): string {
  const scratch = context.createTempDir();
  mkdirSyncReal(safePath.join(scratch, 'home', '.claude'), { recursive: true });
  mkdirSyncReal(safePath.join(scratch, 'tmp'), { recursive: true });
  return scratch;
}

/** The rows a run answered, as `[repository, path]` pairs. */
function contentOf(run: CountedQuery): Array<[unknown, unknown]> {
  return answeredRows(run).map((row) => [row['repository'], row['path']]);
}

/** What {@link contentOf} reads over the membership fixture. */
const EXPECTED_CONTENT = EXPECTED_PATHS.map((path) => ['', path]);

/** The run's population origin. */
function populationOf(run: CountedQuery): unknown {
  return (run.document['data'] as Record<string, unknown> | undefined)?.['population'];
}

/** The three arms of one question: store off, then a store's cold run and its warm run. */
async function storeOffColdWarm(cwd: string, sql: string, env: Readonly<Record<string, string>> = {}): Promise<{ storeOff: CountedQuery; cold: CountedQuery; warm: CountedQuery }> {
  const storeOff = await countedQuery(context, cwd, freshDataArm(context, true), sql, env);
  const arm: DataArm = freshDataArm(context, false);
  const cold = await countedQuery(context, cwd, arm, sql, env);
  const warm = await countedQuery(context, cwd, arm, sql, env);
  return { storeOff, cold, warm };
}

describe('git_content through vat resources query (system test)', () => {
  it('lists git content alike store off, cold and warm, and spends no snapshot beyond the crawl\'s', async () => {
    const withIt = await storeOffColdWarm(tree, WITH_SQL);
    const without = await storeOffColdWarm(tree, WITHOUT_SQL);
    const listed = await storeOffColdWarm(tree, GIT_CONTENT_SQL);

    expect(populationOf(listed.cold)).toBe('derived');
    expect(populationOf(listed.warm), 'premise: the warm run is served from the store').toBe('store');
    for (const run of [listed.storeOff, listed.cold, listed.warm]) expect(contentOf(run)).toEqual(EXPECTED_CONTENT);

    for (const arm of ['storeOff', 'cold', 'warm'] as const) {
      expect(answeredRows(withIt[arm])[0]?.['g'], arm).toBe(EXPECTED_PATHS.length);
      expect(withIt[arm].counters['git.snapshots'], `${arm}: git_content takes no snapshot of its own`).toBe(without[arm].counters['git.snapshots']);
    }
    expect(withIt.storeOff.counters['git.snapshots'], 'one per repository on a store-off run: the crawl\'s').toBe(1);
    // The warm demand's one listing (`assertListable`), and no other.
    expect([withIt.storeOff, withIt.cold, withIt.warm].map((run) => run.counters['git.listings'])).toEqual([0, 0, 1]);
    expect([without.storeOff, without.cold, without.warm].map((run) => run.counters['git.listings'])).toEqual([0, 0, 0]);
  });

  it('answers identically with and without the ignored entries', async () => {
    const arm = freshDataArm(context, true);
    const planted = await countedQuery(context, tree, arm, GIT_CONTENT_SQL);
    removeIgnored(tree);
    try {
      const unplanted = await countedQuery(context, tree, arm, GIT_CONTENT_SQL);
      expect(contentOf(unplanted)).toEqual(contentOf(planted));
    } finally {
      plantIgnored(tree);
    }
  });

  it('answers the same with the filesystem crawl forced: git_content takes the snapshot itself', async () => {
    const forced = await storeOffColdWarm(tree, GIT_CONTENT_SQL, { VAT_EXTENT_SOURCE: 'filesystem' });
    for (const run of [forced.storeOff, forced.cold, forced.warm]) expect(contentOf(run)).toEqual(EXPECTED_CONTENT);
  });

  it('a check naming git_content reads it, store off and warm', async () => {
    const env = isolatedScratchEnv(isolatedScratch());
    const runCheck = async (arm: DataArm): Promise<Array<Record<string, unknown>>> => {
      const result = await executeCli(context.binPath, ['resources', 'check', '--format', 'json'], {
        cwd: tree,
        env: { ...env, VAT_CACHE_DIR: arm.cacheDir, ...(arm.storeOff && { VAT_PROJECTION_STORE: 'off' }) },
      });
      const document = JSON.parse(result.stdout) as { findings?: Array<Record<string, unknown>> };
      const findings = (document.findings ?? []).filter((finding) => finding['check'] === 'git-src');
      expect(findings.map((finding) => finding['location']), `${result.stdout}\n${result.stderr}`).toEqual(['src/a.ts']);
      return findings;
    };
    const storeOn = freshDataArm(context, false);
    await runCheck(storeOn);
    for (const findings of [await runCheck(freshDataArm(context, true)), await runCheck(storeOn)]) {
      expect(findings.map((finding) => finding['location'])).toEqual(['src/a.ts']);
    }
  });
});

describe.skipIf(CANNOT_DENY_READS)('a warm run naming git_content refuses a directory git cannot list (system test)', () => {
  it('refuses with the cold arm\'s code and directory', async () => {
    const root = safePath.join(context.createTempDir(), 'unlistable');
    writeCorpus(root, { 'README.md': '# Readme\n', 'd/a.ts': 'export const a = 1;\n' });
    commitTestFixture(root);
    const locked = safePath.join(root, 'd');
    const arm = freshDataArm(context, false);
    expect(contentOf(await countedQuery(context, root, arm, GIT_CONTENT_SQL)).map(([, path]) => path)).toEqual(['README.md', 'd/a.ts']);

    chmodSync(locked, 0o311);
    try {
      writeFileSync(safePath.join(locked, 'new.test.ts'), 'export {};\n');
      const warm = await countedQuery(context, root, arm, GIT_CONTENT_SQL);
      const cold = await countedQuery(context, root, freshDataArm(context, false), GIT_CONTENT_SQL);
      // The crawl's `FS_FAULT` refusal, published as `INPUT_UNREADABLE` with its message naming `d`.
      expect(refusalOf(cold), 'premise: the cold crawl refuses the locked directory').toEqual({ code: 'INPUT_UNREADABLE', message: expect.stringContaining('Listing the directory \'d\' was refused') });
      expect(refusalOf(warm)).toEqual(refusalOf(cold));
      expect(warm.counters['git.listings']).toBe(1);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe('Git LFS paths (system test)', () => {
  // The plant the spec names, a pointer whose file is "neither pointer nor content by size"
  // (`lfs-undecidable`), cannot be made: the LFS pass decides every regular file by size or by
  // parsing it, and the snapshot re-reads the worktree, so a pointer's path replaced by a directory
  // or a link leaves the snapshot's regular entries (probed: a directory drops the entry, a link
  // becomes mode 120000). What git content must hold of LFS is asserted instead: a path pulled and
  // not pulled is git content either way.
  it('lists an LFS path whether or not it is pulled', async () => {
    const scratch = isolatedScratch();
    const fixture = createLfsFixtureRepo({ dir: scratch, filterScript: resolveFromImportMeta(import.meta.url, '../../../utils/test/fixtures/lfs-filter.mjs') });
    const content = 'lfs bytes '.repeat(300);
    fixture.configureFilter();
    fixture.commit({ '.gitattributes': 'assets/*.bin filter=lfs diff=lfs merge=lfs -text\n', 'assets/blob.bin': content, 'README.md': '# Readme\n' });
    const env = { ...isolatedScratchEnv(scratch), ...fixture.env, LAB_LFS_LOG: safePath.join(scratch, 'filter.log') };
    const arm = freshDataArm(context, false);

    fixture.writeAndRefresh('assets/blob.bin', lfsPointerOf(content));
    const notPulled = await countedQuery(context, fixture.repo, arm, GIT_CONTENT_SQL, env);
    fixture.writeAndRefresh('assets/blob.bin', content);
    const pulled = await countedQuery(context, fixture.repo, arm, GIT_CONTENT_SQL, env);

    for (const run of [notPulled, pulled]) expect(contentOf(run).map(([, path]) => path)).toEqual(['.gitattributes', 'README.md', 'assets/blob.bin']);
  });
});

/** A directory holding only a link to `node`, so the CLI runs and finds no git on `PATH` (POSIX, links). */
function pathWithoutGit(): string {
  if (SYMLINK_CAPABILITY === null) throw new Error('premise: the host can create a symbolic link');
  const bin = context.createTempDir();
  createSymlink(SYMLINK_CAPABILITY, process.execPath, safePath.join(bin, 'node'));
  return bin;
}

/** A statement naming a `tsconfig_*` relation: the tsconfig step reads git content, so it fails the same way. */
const TSCONFIG_SQL = 'SELECT config, path FROM tsconfig_files';

/** Every no-answer arm, for a statement naming `git_content` and for one naming a `tsconfig_*` relation. */
const NO_ANSWER_STATEMENTS = [{ relation: 'git_content', sql: GIT_CONTENT_SQL }, { relation: 'tsconfig_files', sql: TSCONFIG_SQL }] as const;

describe('no git answer: the snapshot\'s own coded error (system test)', () => {
  it.skipIf(process.platform === 'win32' || !SYMLINKS).each(NO_ANSWER_STATEMENTS.flatMap(({ relation, sql }) => [
    { name: 'store off', storeOff: true, relation, sql },
    { name: 'store on', storeOff: false, relation, sql },
  ]))('$relation, git off PATH, $name: the snapshot\'s GIT_NOT_FOUND', async ({ storeOff, sql }) => {
    const run = await countedQuery(context, tree, freshDataArm(context, storeOff), sql, { PATH: pathWithoutGit() });
    // `GIT_NOT_FOUND`, the environment's, published as `BACKEND_UNAVAILABLE`.
    expect(refusalOf(run)).toEqual({ code: 'BACKEND_UNAVAILABLE', message: expect.stringContaining('git was not found on PATH') });
  });

  it.each(NO_ANSWER_STATEMENTS.flatMap(({ relation, sql }) => [
    { name: 'store off', storeOff: true, env: {}, relation, sql },
    { name: 'store on', storeOff: false, env: {}, relation, sql },
    { name: 'store on, filesystem crawl forced', storeOff: false, env: { VAT_EXTENT_SOURCE: 'filesystem' }, relation, sql },
  ]))('$relation, outside a work tree, $name: the snapshot\'s GIT_NO_ANSWER', async ({ storeOff, env, sql }) => {
    const outside = writeCorpus(safePath.join(context.createTempDir(), 'plain'), { 'README.md': '# Readme\n', 'package.json': '{"scripts": {"build": "tsc -p tsconfig.json"}}\n', 'tsconfig.json': '{}\n' });
    const run = await countedQuery(context, outside, freshDataArm(context, storeOff), sql, env);
    // `GIT_NO_ANSWER`, the tree's, published as `INPUT_UNREADABLE`.
    expect(refusalOf(run)).toEqual({ code: 'INPUT_UNREADABLE', message: expect.stringContaining('it is not a git repository, or git could not read it') });
  });
});
