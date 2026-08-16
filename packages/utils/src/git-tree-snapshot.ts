/**
 * A **dirty-corrected git tree snapshot** — every path git can see, with a blob
 * OID naming the bytes that are actually on disk, in three subprocesses.
 *
 * `git ls-files -s` against the *real* index is not this: for a tracked file
 * with unsaved edits it returns the OID of the **committed** bytes, which is a
 * confident wrong answer rather than a miss. The fix is a throwaway index:
 * copy `.git/index` to a temp file, point `GIT_INDEX_FILE` at the copy, run
 * `git add --all` against it, and read *that*. The real index and the working
 * tree are never written.
 *
 * ## Why `write-tree` and not `stash create`
 *
 * A stash is a **commit** object, and every commit hashes an author/committer
 * timestamp with one-second granularity. Two `stash create` calls over
 * byte-identical content therefore return the *same* SHA within one second and
 * a *different* one across a second boundary — intermittent nondeterminism,
 * which is a worse failure mode than a reliably wrong answer because it reads
 * as a flake rather than as a mechanism. `write-tree` has no timestamp field at
 * all, so the same content always yields the same tree OID.
 *
 * ## What is in the population, and what is not
 *
 * `git add --all` **without** `--force`, so the membership is
 * `tracked ∪ (untracked ∧ ¬ignored)` — the same set
 * `git ls-files --cached --others --exclude-standard` reports. Gitignored paths
 * are deliberately absent: checksumming build output and secrets is a liability,
 * not a feature, and a consumer that needs the ignored remainder must source it
 * separately (`ls-files --others --ignored --directory` yields a *prune list*
 * rather than a file list — see
 * `docs/architecture/resource-scanning-and-caching.md` §6).
 *
 * ## ⚠️ A symlink's OID is NOT its target's content
 *
 * Git stores a symlink as a blob whose bytes are the link's **target string**,
 * under mode `120000`. So two symlinks with the same relative target but
 * different resolutions share an OID, while a consumer that follows links reads
 * two different documents. {@link GitTreeEntry.mode} is returned precisely so
 * such a consumer can exclude `120000` rather than discover this as a wrong
 * answer downstream; `packages/resources/src/content-key.ts` documents the same
 * trap from the other side.
 *
 * ## ⚠️ This may run INSIDE a git hook, and inside one that already did this
 *
 * `vat resources validate` is invoked from `vibe-validate`'s `pre-commit`, which
 * is itself a git hook — so this code can execute two levels inside `git commit`.
 * Two consequences, and the first is a correctness bug that the environment
 * handling below exists to prevent (see {@link cleanGitEnv}); the second is
 * not yet addressed:
 *
 * 1. **Inherited git environment retargets the child.** Handled here.
 * 2. **vibe-validate has usually ALREADY computed a tree hash** for the same
 *    working tree by the time it calls into VAT. A consumer that snapshots again
 *    pays the `add --all` re-hash twice and writes a second set of loose objects
 *    for identical content. 🔷 The eventual wiring should accept a
 *    caller-supplied snapshot rather than always taking its own — this function
 *    is the fallback for when nobody upstream has one, not the only way in.
 *
 * ## Two honest costs
 *
 * - `git add --all` **writes loose blob objects** into the target repository's
 *   `.git/objects`. This is not a pure read. It writes only objects, never refs
 *   or the index, so nothing is reachable and `git gc` reclaims it — but a
 *   read-only filesystem will fail here.
 * - `git add --all` re-hashes whatever the index's stat cache reports as
 *   changed, so a clean tree reads nothing and a wholly-dirty tree reads
 *   everything. The cost scales with dirtiness, not with tree size.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';

import which from 'which';

import { cleanGitEnv } from './git-env.js';
import { normalizedTmpdir, safePath } from './path-utils.js';

/** Git's mode for a symbolic link. Its blob holds the target string, not file bytes. */
export const GIT_MODE_SYMLINK = '120000';

/** Git's mode for a gitlink — a submodule's commit, which has no blob at all. */
export const GIT_MODE_GITLINK = '160000';

/** One path in a {@link GitTreeSnapshot}. */
export interface GitTreeEntry {
  /**
   * Root-relative path, forward-slashed, spelled exactly as git spelled it.
   *
   * Relative to the repository root — NOT to the `cwd` the snapshot was taken
   * from, which git resolves upward to that root.
   */
  path: string;
  /**
   * The blob OID for this path's **on-disk** bytes.
   *
   * For mode `120000` this names the target string, and for `160000` it is a
   * commit rather than a blob — see the module docstring.
   */
  oid: string;
  /** Git's six-digit file mode: `100644`, `100755`, `120000`, `160000`. */
  mode: string;
}

/** The result of one snapshot. */
export interface GitTreeSnapshot {
  /**
   * `git write-tree`'s output — a deterministic key for the whole snapshot.
   *
   * Byte-identical content always produces this same value, which is what makes
   * it usable as a cache-invalidation key. See the module docstring on why a
   * stash commit would not be.
   */
  treeOid: string;
  /** Every path in the snapshot, in git's own order. */
  entries: GitTreeEntry[];
}

/** `ls-files -s` emits `<mode> <oid> <stage>\t<path>`. */
const LS_FILES_STAGED = /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t(.*)$/s;

/**
 * Output cap for the git children — roughly a million paths.
 *
 * `spawnSync`'s **default is 1 MiB**, and the listing is the one call here whose
 * size scales with the tree: measured at ~104 bytes per path on an ordinary
 * monorepo and ~270 with deep paths, so the default is exhausted at a few
 * thousand files. That is not a large repository. Measured 2026-08-16: an
 * 8,496-file adopter tree emits 886 KB — **84% of the default cap** — and a
 * 4,200-file fixture with long paths emits 1.07 MiB, at which point this
 * function returned `null` for every call.
 *
 * `null` is the safe direction (a caller falls back to its own enumeration) but
 * not a distinguishable one: it is spelled exactly like "not a git repository",
 * so the degradation is invisible and lands on precisely the largest trees.
 *
 * ⚠️ Not pinned by a test here, deliberately: reproducing it needs a fixture of
 * several thousand files, which costs seconds on macOS and far more on Windows
 * CI. `@vibe-validate/git` covers the same fault in milliseconds by shrinking
 * the cap instead of growing the tree, and this module is scheduled to be
 * replaced by it.
 */
const LISTING_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Run one git subprocess against a throwaway index.
 *
 * @param gitPath - Resolved `git` binary
 * @param args - Arguments after the binary
 * @param cwd - Directory to run in
 * @param indexFile - Value for `GIT_INDEX_FILE`
 * @returns stdout on success, or null for any failure at all
 */
function runGit(
  gitPath: string,
  args: readonly string[],
  cwd: string,
  indexFile: string,
): string | null {
  const result = spawnSync(gitPath, [...args], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
    shell: false,
    // Strip first, THEN set: an inherited GIT_INDEX_FILE from an outer hook
    // would otherwise be the index we are trying not to touch.
    env: cleanGitEnv({ GIT_INDEX_FILE: indexFile }),
    maxBuffer: LISTING_MAX_BUFFER,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout;
}

/**
 * Parse `git ls-files -s -z` output into entries.
 *
 * @param stdout - NUL-separated staged-format records
 * @returns One entry per well-formed record; malformed records are skipped
 */
function parseStagedEntries(stdout: string): GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  for (const record of stdout.split('\0')) {
    if (record.length === 0) continue;
    const match = LS_FILES_STAGED.exec(record);
    // A record that does not match is not silently coerced into an entry with a
    // guessed path: a wrong path here becomes a wrong content key downstream.
    if (match === null) continue;
    const [, mode, oid, , path] = match;
    if (mode === undefined || oid === undefined || path === undefined) continue;
    entries.push({ path, oid, mode });
  }
  return entries;
}

/**
 * Take a dirty-corrected snapshot of everything git can see under `cwd`.
 *
 * Every way of failing returns `null` rather than throwing or returning an empty
 * snapshot: no `git` on `PATH`, a non-repository `cwd`, an unreadable or corrupt
 * `.git`, a read-only object store. An empty `entries` array is a real answer
 * (an initialized repository with no files) and must stay distinguishable from
 * "could not ask" — the same stance `gitLsFiles` takes, and the reason
 * `GitTracker` exposes `isUsable()`.
 *
 * @param options - `cwd` is any directory inside the repository; git resolves
 *   upward to the root, and every returned path is relative to that root
 * @returns The snapshot, or null if git could not answer
 *
 * @example
 * ```typescript
 * const snapshot = gitTreeSnapshot({ cwd: projectRoot });
 * if (snapshot !== null) {
 *   const readable = snapshot.entries.filter((e) => e.mode !== GIT_MODE_SYMLINK);
 * }
 * ```
 */
export function gitTreeSnapshot(options: { cwd: string }): GitTreeSnapshot | null {
  let gitPath: string;
  try {
    gitPath = which.sync('git');
  } catch {
    return null;
  }

  // Resolved before the temp index exists, and deliberately without the
  // GIT_INDEX_FILE override: this call asks WHICH repository, and pointing it at
  // an index not yet written would be circular.
  //
  // Both answers are needed, and `--show-toplevel` is the load-bearing one.
  // `git ls-files` SCOPES its listing to the cwd — `--full-name` only changes
  // how the paths it chose are spelled, not which paths it chose — so a snapshot
  // taken from a subdirectory would silently omit everything above it. Running
  // every git call at the worktree root makes "these paths are root-relative and
  // this is the whole tree" true by construction rather than by flag.
  // `cleanGitEnv()` here is the most load-bearing use of it in this file: this
  // call decides WHICH repository everything below operates on, so inheriting a
  // hook's `GIT_DIR` would silently retarget the entire snapshot and every later
  // call would then be consistently, confidently wrong.
  const revParse = spawnSync(gitPath, ['rev-parse', '--absolute-git-dir', '--show-toplevel'], {
    cwd: options.cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
    shell: false,
    env: cleanGitEnv(),
  });
  if (revParse.error || revParse.status !== 0) {
    return null;
  }
  const [gitDir, topLevel] = revParse.stdout.trim().split('\n').map((line) => line.trim());
  // A bare repository answers `--absolute-git-dir` but has no worktree to
  // snapshot, and reports an empty toplevel. That is "cannot answer", not "empty".
  if (gitDir === undefined || topLevel === undefined
    || gitDir.length === 0 || topLevel.length === 0) {
    return null;
  }

  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-git-snapshot-'));
    const tempIndex = safePath.join(tempDir, 'index');

    // A repository with nothing staged yet has no index file. Starting from an
    // absent one is correct rather than an error: `git add --all` then builds it
    // from scratch and the snapshot is simply the whole working tree.
    const realIndex = safePath.join(gitDir, 'index');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from git's own --absolute-git-dir
    if (existsSync(realIndex)) {
      copyFileSync(realIndex, tempIndex);
    }

    // `--all` without `--force`: untracked-not-ignored in, gitignored out.
    if (runGit(gitPath, ['add', '--all'], topLevel, tempIndex) === null) {
      return null;
    }

    // `--full-name` is load-bearing, not tidiness: without it `ls-files` prints
    // paths relative to the CWD, so a snapshot taken from a subdirectory would
    // return paths that silently mean something else than one taken from the
    // root. Every entry must be root-relative for the same reason the identity
    // map resolves its root once — a path is only a key if its base is fixed.
    //
    // -z for the reason gitLsFiles uses it: unquoted, NUL-separated paths, so a
    // non-ASCII filename survives as its real bytes rather than as git's
    // octal-escaped display form.
    const staged = runGit(gitPath, ['ls-files', '-s', '-z', '--full-name'], topLevel, tempIndex);
    if (staged === null) {
      return null;
    }

    const treeOut = runGit(gitPath, ['write-tree'], topLevel, tempIndex);
    if (treeOut === null) {
      return null;
    }
    const treeOid = treeOut.trim();
    if (treeOid.length === 0) {
      return null;
    }

    return { treeOid, entries: parseStagedEntries(staged) };
  } catch {
    return null;
  } finally {
    if (tempDir !== null) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
