import { mkdir, writeFile } from 'node:fs/promises';
// `dirname` only — `join`/`resolve`/`relative` are ESLint-banned in favour of
// `safePath`, which has no `dirname` because it never needed one.
import { dirname } from 'node:path';

import { compareCodeUnits, GitTracker, runGitOrThrow, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildResourcePopulation } from '../src/projection/resource-population.js';

import { setupSubdirTestSuite } from './test-helpers.js';

/** The plain markdown member every fixture below starts from. */
const DOC_A = 'a.md';

/** Present in two fixtures, and a member in both — it is a file like any other. */
const GITIGNORE = '.gitignore';

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
  runGitOrThrow([...args], { cwd: suite.tempDir, stdio: 'pipe' });
}

/** The population as root-relative, forward-slashed paths — the readable unit. */
async function populationOf(gitTracker?: GitTracker): Promise<string[]> {
  const paths = await buildResourcePopulation({
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
    // The population's whole product claim in one fixture. Committing first is
    // not ceremony: `git ls-files` answers nothing for a repository with no
    // commit, so a fixture that only writes files would report every path as
    // untracked and BOTH assertions below would pass for the wrong reason.
    git(['init', '--quiet']);
    await write('committed.md', '# Committed\n');
    await write(GITIGNORE, 'build/\n');
    git(['add', '-A']);
    git(['-c', 'user.name=VAT Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
    // Written AFTER the commit, so each one's status is unambiguous.
    await write('uncommitted.md', '# Not yet committed\n');
    await write('build/generated.md', '# Generated\n');

    const tracker = new GitTracker(suite.tempDir);
    await tracker.initialize();

    // `build/generated.md` is on disk and IS enumerated by the extent — it is
    // declined here, by this consumer. `uncommitted.md` is the file the walker
    // cannot see at all, and admitting it is the reason this lane exists.
    expect(await populationOf(tracker)).toEqual([GITIGNORE, 'committed.md', 'uncommitted.md']);
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
