/**
 * Plants a temp git repo containing REAL on-disk symlinks — the mechanical half
 * of `projection-git-extent-symlink.test.ts`,
 * `projection-filesystem-extent-symlink.test.ts` and
 * `projection-untracked-symlink-extent.test.ts`.
 *
 * ## Three tracking states, because the crawl treats them as three lanes
 *
 * `GitCrawlSource` answers a root out of three separate sources — a
 * `git add --all` tree snapshot, `ls-files --others --directory`, and
 * `ls-files --others --ignored --directory` — and a symlink can arrive from any
 * of them. A fixture that could only COMMIT its links could therefore exercise
 * exactly one lane while reading as if it covered symlinks, which is how the
 * untracked lane shipped an unfiltered symlink under a docstring saying no lane
 * emits one. So the spec has three slots: committed
 * ({@link SymlinkFixtureSpec.files}/{@link SymlinkFixtureSpec.links}), untracked
 * ({@link SymlinkFixtureSpec.untrackedFiles}/{@link
 * SymlinkFixtureSpec.untrackedLinks}, planted AFTER the commit and never
 * staged), and ignored (the same untracked slots plus a committed
 * {@link SymlinkFixtureSpec.ignore} list that matches them).
 *
 * ## Only the mechanics live here
 *
 * Those suites ask opposite questions of the same shape of tree (does the git
 * extent keep a link's identity distinct? does the filesystem extent realize a
 * link's own path at all?), and each is trustworthy only because of the controls
 * it states BEFORE its claim — the mode-`120000` staging check, the
 * shared-blob-OID check, the positive-control regular file. **None of those
 * assertions belong here.** A helper that asserted its own fixture came out
 * right would hide the one thing those suites exist to prove is checked, and
 * would be invisible to a reader of either file (see *"assertion helpers"* in
 * `docs/writing-tests.md`: return the value, let the caller assert).
 *
 * So this module does `mkdtemp` → `git init` → `mkdir` → write → `createSymlink`
 * → `git add` → `git commit` → plant the untracked half, and then hands back the
 * root plus the RAW `git ls-files` output for each of the three states. Every
 * suite re-derives and asserts its own controls from those strings.
 *
 * ## Capability gating is preserved, not bypassed
 *
 * {@link plantSymlinkFixture} calls `symlinkCapability()` itself and throws when
 * it is null, so nothing here runs at import time and an ungated caller gets a
 * message naming the fix rather than a bare `EPERM` on a host it doesn't
 * control. Both callers still gate their `describe` with
 * `describe.skipIf(!symlinkCapability())`, which is what keeps a skipped symlink
 * suite VISIBLE in the report; the throw is the backstop for a suite that
 * forgets.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import {
  createSymlink,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  symlinkCapability,
  toForwardSlash,
  type SymlinkCapability,
} from '@vibe-agent-toolkit/utils';
import {
  runGitOrThrow,
} from '@vibe-agent-toolkit/utils/git';

/**
 * Git's mode for a symlink in `git ls-files -s`. Its blob holds the TARGET
 * STRING, not file bytes — which is why two links to one target are
 * byte-identical and collide on a content key.
 */
export const GIT_MODE_SYMLINK = '120000';

/** Identity and authorship for the fixture commit, so a host's own config cannot fail it. */
const COMMIT_CONFIG = [
  '-c',
  'user.name=VAT Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

/** One symlink to plant. */
export interface SymlinkPlan {
  /** Root-relative, forward-slashed path of the link itself. */
  readonly path: string;
  /** The link's target text, spelled relative to the link's OWN directory. */
  readonly target: string;
}

/** What to plant in the fixture repo. */
export interface SymlinkFixtureSpec {
  /** `mkdtemp` basename prefix, so a leaked temp dir names the suite that made it. */
  readonly prefix: string;
  /** Root-relative, forward-slashed paths of regular files to write and commit. */
  readonly files: readonly string[];
  /** The symlinks to create and commit, after {@link SymlinkFixtureSpec.files} exist. */
  readonly links: readonly SymlinkPlan[];
  /**
   * Patterns for a committed `.gitignore`, one per line.
   *
   * Committed rather than merely written so the ignore rules are part of the
   * tree every lane sees, and so `ls-files --others --ignored` has something to
   * report without the suite having to stage anything itself.
   */
  readonly ignore?: readonly string[];
  /** Regular files written AFTER the commit and never staged. */
  readonly untrackedFiles?: readonly string[];
  /** Symlinks created AFTER the commit and never staged. */
  readonly untrackedLinks?: readonly SymlinkPlan[];
}

/** A planted fixture: where it is, and what git says about each tracking state. */
export interface SymlinkFixture {
  /** Absolute, forward-slashed repo root. */
  readonly root: string;
  /**
   * Raw `git ls-files -s` output for the committed index.
   *
   * Returned UNPARSED on purpose: each suite's staging control is its own, and
   * a helper that pre-digested this into "the symlink entries" would be the
   * assertion those suites must make for themselves.
   */
  readonly lsFilesStaged: string;
  /**
   * Raw `git ls-files --others --exclude-standard` output — what git considers
   * untracked and not ignored, which is the lane the tree snapshot stages and
   * the prune list re-offers.
   */
  readonly lsFilesOthers: string;
  /**
   * Raw `git ls-files --others --ignored --exclude-standard` output — the
   * ignored lane, which `git add --all` never stages and only the prune list
   * reaches.
   */
  readonly lsFilesIgnored: string;
}

/**
 * The `git ls-files -s` lines git recorded with a symlink's mode.
 *
 * A splitter, not a checker — it makes no claim about how many there are or
 * which paths they name. Callers assert the count, the paths and the blob OIDs
 * themselves, and those call-site assertions are what keep this armed.
 *
 * @param lsFilesStaged - Raw output from `git ls-files -s`
 * @returns Every line whose mode is {@link GIT_MODE_SYMLINK}, in git's order
 */
export function symlinkIndexLines(lsFilesStaged: string): string[] {
  return lsFilesStaged.split('\n').filter((line) => line.startsWith(GIT_MODE_SYMLINK));
}

/**
 * Write one regular file, creating the directory it needs.
 *
 * Content is derived from the path (`# <path>`) so no two fixture files are
 * byte-identical by accident — a content-key collision the suite never asked for
 * would be indistinguishable from the identity collapse these suites look for.
 *
 * @param root - The fixture root
 * @param file - Root-relative, forward-slashed path
 */
function writeFixtureFile(root: string, file: string): void {
  mkdirSyncReal(safePath.join(root, file, '..'), { recursive: true });
  writeFileSync(safePath.join(root, file), `# ${file}\n`);
}

/**
 * Create one symlink, creating the directory it needs.
 *
 * @param root - The fixture root
 * @param cap - The host's symlink capability, already checked
 * @param link - The link to plant
 */
function plantLink(root: string, cap: SymlinkCapability, link: SymlinkPlan): void {
  mkdirSyncReal(safePath.join(root, link.path, '..'), { recursive: true });
  createSymlink(cap, link.target, safePath.join(root, link.path));
}

/**
 * Create a temp git repo with the requested files and symlinks.
 *
 * Everything in {@link SymlinkFixtureSpec.files} and
 * {@link SymlinkFixtureSpec.links} is committed; everything in the `untracked*`
 * slots is planted afterwards and never staged, so `git ls-files -s` and
 * `git ls-files --others` partition the tree between them.
 *
 * @param spec - What to plant
 * @returns The repo root and the raw listing for each tracking state
 * @throws {Error} When this process cannot create symlinks — gate the suite on
 *   `describe.skipIf(!symlinkCapability())` so it reports as skipped instead
 */
export function plantSymlinkFixture(spec: SymlinkFixtureSpec): SymlinkFixture {
  const cap = symlinkCapability();
  if (!cap) {
    throw new Error(
      'plantSymlinkFixture: this host cannot create symlinks — gate the suite with describe.skipIf(!symlinkCapability())',
    );
  }

  const root = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), spec.prefix)));
  runGitOrThrow(['init'], { cwd: root });

  for (const file of spec.files) writeFixtureFile(root, file);
  for (const link of spec.links) plantLink(root, cap, link);

  const staged = [...spec.files, ...spec.links.map((link) => link.path)];
  if (spec.ignore !== undefined) {
    writeFileSync(safePath.join(root, '.gitignore'), `${spec.ignore.join('\n')}\n`);
    staged.push('.gitignore');
  }

  runGitOrThrow(['add', ...staged], { cwd: root });
  runGitOrThrow([...COMMIT_CONFIG, 'commit', '-m', 'fixture'], { cwd: root });

  // After the commit, so nothing here can reach the index by accident.
  for (const file of spec.untrackedFiles ?? []) writeFixtureFile(root, file);
  for (const link of spec.untrackedLinks ?? []) plantLink(root, cap, link);

  return {
    root,
    lsFilesStaged: runGitOrThrow(['ls-files', '-s'], { cwd: root }),
    lsFilesOthers: runGitOrThrow(['ls-files', '--others', '--exclude-standard'], { cwd: root }),
    lsFilesIgnored: runGitOrThrow(
      ['ls-files', '--others', '--ignored', '--exclude-standard'],
      { cwd: root },
    ),
  };
}

/**
 * Best-effort teardown for a root from {@link plantSymlinkFixture}.
 *
 * Tolerates an unset root so an `afterAll` still runs cleanly when the
 * `beforeAll` that would have set it threw.
 *
 * @param root - The fixture root, or an empty/undefined value if setup failed
 */
export function removeSymlinkFixture(root: string | undefined): void {
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
}
