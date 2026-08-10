/**
 * Differential behaviour of VAT's two git-ignore oracles: where they agree, and
 * the three path classes where they genuinely do not.
 *
 * `isGitIgnored()` answers from one `git check-ignore` spawn per call (plus an
 * ancestor-recovery walk when git exits 128) — i.e. from the ignore PATTERNS.
 * `GitTracker.isIgnoredByActiveSet()` answers in O(1) from the active set built
 * by `git ls-files --cached --others --exclude-standard`, and falls back to
 * `check-ignore` for the three cases its docblock names: an unpopulated active
 * set, a path outside the project root, and a path that is absent from the set
 * AND absent from disk.
 *
 * A production lane was switched from the first oracle to the second, and that
 * switch is only safe over the classes where the two agree. So the agreeing set
 * has to be a committed, falsifiable assertion rather than a one-off scratch
 * probe — and the NON-agreeing set has to be committed too, or this file reads
 * as a proof of universal equivalence that it is not.
 *
 * ## The two populations in {@link PATH_CLASSES}
 *
 * Every row records BOTH oracles' verdicts explicitly, so the table states what
 * it pins instead of merely asserting sameness:
 *
 * - **AGREE (7 rows)** — one row per branch the active-set fallback logic
 *   distinguishes: in the set via `--cached`, in it via `--others`, absent +
 *   on disk, absent + off disk under an ignore pattern, absent + off disk under
 *   no pattern, an ancestor directory answered from `activeAncestors`, and a
 *   path outside the project root. This is the population the production lane
 *   depends on. A failure here is a regression.
 *
 * - **DIVERGE (3 rows)** — path classes where the two oracles return DIFFERENT
 *   answers, pinned as expected-to-differ rather than deleted for being
 *   inconvenient. If a future change makes them agree, these rows go red and
 *   say so.
 *
 * ## Mechanism of the divergence
 *
 * `git ls-files` cannot see a path reached through a symlinked ancestor
 * directory, a path inside a submodule, or a path under `.git/`. All three are
 * therefore absent from the active set while existing on disk — and
 * `isIgnoredByActiveSet` treats "absent from the set AND `existsSync` true" as
 * authoritative for *ignored*. `isGitIgnored` asks the ignore patterns, which
 * match none of them (for the symlink case, via the exit-128 ancestor-recovery
 * walk), and answers *not ignored*.
 *
 * So: `isGitIgnored` = `false`, `isIgnoredByActiveSet` = `true`, for all three.
 *
 * ## Why this is documented rather than fixed
 *
 * The observable consequence is real: through `walkLinkGraph`, a skill linking
 * `../../link/deep.md` where `link/ -> real/` goes from
 * `bundledAssets: ["…/link/deep.md"]` to `bundledAssets: []` with
 * `excludedReferences: [{ excludeReason: "gitignored", targetExists: true }]` —
 * the file silently leaves the inventory's linked set. But the measured blast
 * radius was 0 of 766 real skills (VAT's own 54 plus 712 installed plugins),
 * and the adopter monorepo has no `.gitmodules` and no non-vendor symlinked
 * directories. Pinned, not fixed.
 *
 * ## Host capabilities
 *
 * Two of the divergent rows need a fixture the host may refuse to build: a
 * symlink (Windows without Developer Mode) and a local-path submodule. Both are
 * probed while the fixture is built and the affected row is SKIPPED with a
 * reason — skipped, not silently passed, because a symlink case that no-ops
 * while reporting green reads as a proof of a property nobody exercised.
 *
 * The positive control at the bottom proves the fixture actually produces BOTH
 * verdicts on BOTH routes — a parity test where every path came back `false`
 * everywhere would pass just as happily against two functions that were
 * hardcoded to `() => false`.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GitTracker } from '../../src/git-tracker.js';
import { isGitIgnored } from '../../src/git-utils.js';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '../../src/path-utils.js';
import { canCreateSymlinks } from '../../src/test-helpers.js';
import { createGitRepo } from '../test-helpers.js';

/** The answer each oracle gives for one path class. */
interface OracleVerdicts {
  readonly viaCheckIgnore: boolean;
  readonly viaActiveSet: boolean;
}

/**
 * A fixture ingredient the host may refuse to provide.
 *
 * Rows that need one are skipped (visibly) rather than asserted when it is
 * missing; see {@link CAPABILITY_FAILURES}.
 */
type FixtureCapability = 'symlinks' | 'submodule';

/** One path class, plus the verdict EACH oracle owes it. */
interface PathClassCase {
  /** Human label — appears in the test name and in every failure message. */
  readonly label: string;
  /** Path relative to the repo root, or to the repo's PARENT when `outsideRoot` is set. */
  readonly relativePath: string;
  /**
   * Both oracles' verdicts, stated explicitly.
   *
   * Equal verdicts pin the class as AGREEING (the production lane's safe set);
   * unequal verdicts pin a known, reproduced DIVERGENCE.
   */
  readonly expected: OracleVerdicts;
  /** True for the "path outside the project root" fallback branch. */
  readonly outsideRoot?: boolean;
  /** Fixture ingredient this row needs; absent means "works on every host". */
  readonly requires?: FixtureCapability;
}

/** Shorthand for a class the two oracles are pinned to answer identically. */
function agreeOn(ignored: boolean): OracleVerdicts {
  return { viaCheckIgnore: ignored, viaActiveSet: ignored };
}

/**
 * The verdict pair every divergent class produces: the patterns say "not
 * ignored", the active set says "ignored" because `git ls-files` never listed
 * the path and it exists on disk.
 */
const ABSENT_FROM_LS_FILES: OracleVerdicts = { viaCheckIgnore: false, viaActiveSet: true };

const PATH_CLASSES: readonly PathClassCase[] = [
  // ---------------------------------------------------------------- AGREE ----
  // 1. Tracked + committed: present in the active set via `--cached`.
  { label: 'tracked committed file', relativePath: 'docs/tracked.md', expected: agreeOn(false) },
  // 2. Untracked but not gitignored: the class `--others --exclude-standard` exists for.
  {
    label: 'untracked file not matched by .gitignore',
    relativePath: 'docs/untracked.md',
    expected: agreeOn(false),
  },
  // 3. Ignored AND on disk: absent from the set, `existsSync` true -> set is authoritative.
  {
    label: 'gitignored file that exists on disk',
    relativePath: 'dist/bundle.js',
    expected: agreeOn(true),
  },
  // 4. Ignored by PATTERN but never created: absent from the set, `existsSync` false ->
  //    must fall back to check-ignore. The tracker's docblock records a shipped bug where
  //    a bare set lookup called this "ignored" for the wrong reason and callers acted on it.
  {
    label: 'gitignored-by-pattern path absent from disk',
    relativePath: 'dist/never-built.js',
    expected: agreeOn(true),
  },
  // 5. Absent from disk and matched by no pattern — the other half of the !existsSync branch.
  {
    label: 'absent path matched by no ignore pattern',
    relativePath: 'docs/typo.md',
    expected: agreeOn(false),
  },
  // 6. Directory holding a tracked file: answered from `activeAncestors`, not `activeSet`.
  {
    label: 'directory containing a tracked file',
    relativePath: 'docs',
    expected: agreeOn(false),
  },
  // 7. Outside the project root: the `isWithinProjectRoot` fallback branch.
  {
    label: 'path outside the project root',
    relativePath: 'outside/notes.md',
    expected: agreeOn(false),
    outsideRoot: true,
  },
  // 7b. Non-ASCII tracked filename: `git ls-files` quotes any path containing
  //     non-ASCII bytes by default (wraps it in double quotes with octal
  //     escapes). Without `-z`, the active set built from `gitLsFiles` would
  //     contain the mangled quoted string instead of the real name, so this
  //     genuinely-tracked file would be misclassified as ignored.
  {
    label: 'tracked file with a non-ASCII filename',
    relativePath: 'café.md',
    expected: agreeOn(false),
  },

  // -------------------------------------------------------------- DIVERGE ----
  // 8. `link/ -> real/`, so `link/deep.md` is a real, tracked blob under a path
  //    `git ls-files` never emits (it lists `link` and `real/deep.md`, never
  //    `link/deep.md`). check-ignore exits 128 "beyond a symbolic link", and the
  //    ancestor-recovery walk finds no ignored ancestor -> not ignored.
  {
    label: 'file reached through a symlinked ancestor directory',
    relativePath: 'link/deep.md',
    expected: ABSENT_FROM_LS_FILES,
    requires: 'symlinks',
  },
  // 9. A submodule is a separate repository: the superproject's `ls-files` lists
  //    the gitlink `sub`, never `sub/sub-file.md`.
  {
    label: 'file inside a git submodule',
    relativePath: 'sub/sub-file.md',
    expected: ABSENT_FROM_LS_FILES,
    requires: 'submodule',
  },
  // 10. `.git/` is not ignored by any pattern — git excludes it structurally, so
  //     nothing in it is ever listed, yet every file in it exists.
  {
    label: 'file under .git/',
    relativePath: '.git/config',
    expected: ABSENT_FROM_LS_FILES,
  },
];

/** A {@link PathClassCase} with the AGREE/DIVERGE label derived from its own verdicts. */
interface PathClassRow extends PathClassCase {
  readonly parity: 'AGREE' | 'DIVERGE';
}

const PATH_CLASS_ROWS: readonly PathClassRow[] = PATH_CLASSES.map((testCase) => ({
  ...testCase,
  parity: testCase.expected.viaCheckIgnore === testCase.expected.viaActiveSet ? 'AGREE' : 'DIVERGE',
}));

const GITIGNORE_BODY = 'dist/\n*.log\n';
const COMMIT_IDENTITY_EMAIL = 'oracle-parity@example.com';
const COMMIT_IDENTITY_NAME = 'Oracle Parity';

/**
 * Why a capability is unavailable, keyed by capability.
 *
 * Populated during fixture construction; a row naming a key present here is
 * skipped with this string as its reason.
 */
const CAPABILITY_FAILURES = new Map<FixtureCapability, string>();

let suiteDir = '';
let repoRoot = '';
let tracker: GitTracker;

/**
 * Run git and throw on failure.
 *
 * A fixture whose `git commit` silently no-ops (no committer identity, a signing
 * hook) leaves `git ls-files --cached` empty, which quietly turns every row below
 * into a comparison of two "not ignored" answers. Fail loudly instead.
 */
function runGit(cwd: string, args: readonly string[]): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
  const result = spawnSync('git', [...args], { cwd, stdio: 'pipe', encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (status ${String(result.status)}): ${result.stderr ?? ''}`
    );
  }
}

/** `git init` plus a LOCAL identity, so a commit cannot fail on a machine with no global git user. */
function initRepoWithIdentity(directory: string): void {
  createGitRepo(directory);
  runGit(directory, ['config', 'user.email', COMMIT_IDENTITY_EMAIL]);
  runGit(directory, ['config', 'user.name', COMMIT_IDENTITY_NAME]);
}

/** Stage the given repo-relative paths and commit them, with signing forced off. */
function commitPaths(directory: string, paths: readonly string[], message: string): void {
  runGit(directory, ['add', ...paths]);
  runGit(directory, ['-c', 'commit.gpgsign=false', 'commit', '-m', message]);
}

/** Build the standalone repository that the submodule row points at. No network. */
function createSubmoduleOrigin(directory: string): void {
  mkdirSyncReal(directory, { recursive: true });
  initRepoWithIdentity(directory);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- directory is a temp directory created by this suite
  writeFileSync(safePath.join(directory, 'sub-file.md'), '# Inside a submodule\n');
  commitPaths(directory, ['sub-file.md'], 'submodule fixture');
}

/**
 * Attach {@link createSubmoduleOrigin}'s repo as `sub/`, from a local path.
 *
 * `protocol.file.allow=always` is required because git >= 2.38 refuses
 * file-protocol submodules by default (CVE-2022-39253). Older git does not know
 * the key and ignores the `-c`, so passing it unconditionally is safe — and it
 * is what keeps this fixture hermetic: nothing is ever fetched over a network.
 */
function addLocalSubmodule(root: string, originDirectory: string): void {
  createSubmoduleOrigin(originDirectory);
  runGit(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', originDirectory, 'sub']);
  commitPaths(root, ['.gitmodules', 'sub'], 'add local submodule');
}

/**
 * Create `link/ -> real/` and report whether the host allowed it.
 *
 * Gated on {@link canCreateSymlinks} (a real create/remove probe), never on
 * `process.platform`: the privilege is a Windows ACL, not a platform constant,
 * and this branch has no CI coverage to catch a platform guess that is wrong.
 */
function tryCreateDirectorySymlink(root: string): boolean {
  if (!canCreateSymlinks(root)) {
    return false;
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- root is a temp directory created by this suite
  symlinkSync('real', safePath.join(root, 'link'), 'dir');
  return true;
}

/**
 * Build the fixture repository: init, configure a local identity, write every
 * path class, then COMMIT (uncommitted files never appear in `git ls-files --cached`).
 *
 * Capabilities the host refuses are recorded in {@link CAPABILITY_FAILURES}
 * rather than thrown, so one missing ingredient skips one row instead of
 * reddening the whole suite.
 */
function createFixtureRepo(root: string, outsideDir: string, submoduleOrigin: string): void {
  /* eslint-disable security/detect-non-literal-fs-filename -- root/outsideDir are temp directories created by this suite */
  mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
  mkdirSyncReal(safePath.join(root, 'dist'), { recursive: true });
  mkdirSyncReal(safePath.join(root, 'real'), { recursive: true });
  mkdirSyncReal(outsideDir, { recursive: true });

  writeFileSync(safePath.join(root, '.gitignore'), GITIGNORE_BODY);
  writeFileSync(safePath.join(root, 'docs', 'tracked.md'), '# Tracked\n');
  writeFileSync(safePath.join(root, 'docs', 'untracked.md'), '# Untracked\n');
  writeFileSync(safePath.join(root, 'dist', 'bundle.js'), 'export {};\n');
  writeFileSync(safePath.join(root, 'real', 'deep.md'), '# Reached through a symlink\n');
  writeFileSync(safePath.join(outsideDir, 'notes.md'), '# Outside the repo\n');
  writeFileSync(safePath.join(root, 'café.md'), '# Non-ASCII filename\n');
  /* eslint-enable security/detect-non-literal-fs-filename */

  initRepoWithIdentity(root);

  const trackedPaths = ['.gitignore', 'docs/tracked.md', 'real/deep.md', 'café.md'];
  if (tryCreateDirectorySymlink(root)) {
    trackedPaths.push('link');
  } else {
    CAPABILITY_FAILURES.set(
      'symlinks',
      'host refused to create a symlink (Windows needs Developer Mode or SeCreateSymbolicLinkPrivilege)'
    );
  }
  commitPaths(root, trackedPaths, 'fixture');

  try {
    addLocalSubmodule(root, submoduleOrigin);
  } catch (error) {
    CAPABILITY_FAILURES.set(
      'submodule',
      `local submodule fixture failed to build: ${String(error)}`
    );
  }
}

function resolveCasePath(testCase: PathClassCase): string {
  return safePath.join(testCase.outsideRoot === true ? suiteDir : repoRoot, testCase.relativePath);
}

function collectVerdicts(absolutePath: string): OracleVerdicts {
  return {
    viaCheckIgnore: isGitIgnored(absolutePath, repoRoot),
    viaActiveSet: tracker.isIgnoredByActiveSet(absolutePath),
  };
}

/** Rows whose fixture ingredient this host actually produced. */
function availableRows(): readonly PathClassRow[] {
  return PATH_CLASS_ROWS.filter(
    (row) => row.requires === undefined || !CAPABILITY_FAILURES.has(row.requires)
  );
}

function formatVerdicts(label: string, absolutePath: string, verdicts: OracleVerdicts): string {
  return [
    `path class: ${label}`,
    `path: ${absolutePath}`,
    `isGitIgnored (git check-ignore)  => ${String(verdicts.viaCheckIgnore)}`,
    `GitTracker.isIgnoredByActiveSet  => ${String(verdicts.viaActiveSet)}`,
  ].join('\n');
}

/** What it MEANS for the active-set verdict to have moved off its pinned value. */
function parityFailureHeadline(row: PathClassRow): string {
  return row.parity === 'AGREE'
    ? 'ORACLES DISAGREE on a class pinned as AGREEING — a production lane reads this class off the active set on the strength of the two matching'
    : 'PINNED DIVERGENCE MOVED — this class is documented to DIFFER between the oracles (the active set calls it ignored because `git ls-files` cannot list the path); it no longer differs that way';
}

describe('git-ignore oracle parity (isGitIgnored vs GitTracker.isIgnoredByActiveSet)', () => {
  beforeAll(async () => {
    suiteDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'git-ignore-oracle-parity-'));
    repoRoot = safePath.join(suiteDir, 'repo');
    createFixtureRepo(
      repoRoot,
      safePath.join(suiteDir, 'outside'),
      safePath.join(suiteDir, 'submodule-origin')
    );

    tracker = new GitTracker(repoRoot);
    await tracker.initialize();
    // A tracker that never got an answer from git reports everything "not ignored",
    // which would make every row below agree for the wrong reason.
    expect(tracker.isUsable(), 'git ls-files did not answer for the fixture repo').toBe(true);
  });

  afterAll(() => {
    if (suiteDir) {
      rmSync(suiteDir, { recursive: true, force: true });
    }
  });

  // `it.for`, not `it.each`: only `for` passes the TestContext as the second
  // argument. Under `it.each` the `context` parameter is `undefined`, so the
  // capability skip below throws a TypeError instead of skipping — which no
  // run on a symlink-capable host would ever reach.
  it.for(PATH_CLASS_ROWS)('$parity — $label', (row, context) => {
    if (row.requires !== undefined && CAPABILITY_FAILURES.has(row.requires)) {
      // Skipped, never silently green: a divergence nobody exercised must not
      // read as a divergence that still holds.
      context.skip(
        `fixture capability "${row.requires}" unavailable — ${CAPABILITY_FAILURES.get(row.requires) ?? ''}`
      );
    }

    const absolutePath = resolveCasePath(row);
    const verdicts = collectVerdicts(absolutePath);
    const detail = formatVerdicts(row.label, absolutePath, verdicts);

    expect(
      verdicts.viaCheckIgnore,
      `check-ignore verdict is not the documented one\n${detail}`
    ).toBe(row.expected.viaCheckIgnore);
    expect(verdicts.viaActiveSet, `${parityFailureHeadline(row)}\n${detail}`).toBe(
      row.expected.viaActiveSet
    );
  });

  it('positive control: the fixture makes BOTH verdicts occur on BOTH oracles', () => {
    const observed = availableRows().map((testCase) => {
      const absolutePath = resolveCasePath(testCase);
      return { testCase, verdicts: collectVerdicts(absolutePath), absolutePath };
    });

    const summary = observed
      .map((row) => formatVerdicts(row.testCase.label, row.absolutePath, row.verdicts))
      .join('\n---\n');

    // If either of these collapses to a single-element set, the parity assertions
    // above are vacuous: they would still pass against an oracle stuck on one answer.
    expect(
      new Set(observed.map((row) => row.verdicts.viaCheckIgnore)),
      `isGitIgnored returned a single verdict across every path class\n${summary}`
    ).toEqual(new Set([false, true]));
    expect(
      new Set(observed.map((row) => row.verdicts.viaActiveSet)),
      `isIgnoredByActiveSet returned a single verdict across every path class\n${summary}`
    ).toEqual(new Set([false, true]));
  });
});
