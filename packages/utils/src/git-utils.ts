/**
 * Centralized git command wrapper.
 * All git commands should go through this module for consistency and testability.
 */

import { existsSync } from 'node:fs';
import { dirname, parse } from 'node:path';

import { type DirectoryRefusal, directoryRefusalFor } from './fs-utils.js';
import { lookupGitRoot, rememberGitRoot } from './git-root-cache.js';
import { runGit } from './git-run.js';
import { safePath } from './path-utils.js';

/**
 * One line of git's stderr that means "I skipped this directory".
 *
 * `git ls-files --others` (and `--ignored`, and `git add --all`) walks the
 * working tree to find untracked files. On a directory it cannot open it prints
 * this warning, exits 0, and omits the subtree — so stdout alone is a shorter
 * list that nothing can tell from a complete one. The path is spelled
 * **relative to the worktree root** with a trailing slash, even when git was
 * run from a subdirectory (measured: cwd `docs/open`, warning names
 * `'docs/open/sub/'`).
 *
 * Anchored to the line so an unrelated warning naming a directory in passing
 * is not read as a refusal. The reason after the colon is `strerror` text —
 * see {@link STRERROR_TO_ERRNO}.
 */
const UNLISTABLE_DIRECTORY_LINE = /^warning: could not open directory '(.+?)\/?': (.*)$/gm;

/**
 * C-locale `strerror` text → errno, for the reasons git can print here.
 *
 * git does not print the errno name, only its message; every listing below
 * runs with `LC_ALL=C` so the message is the C-locale one and this table can
 * be short. An unlisted reason is still a refusal — it becomes `UNKNOWN`, the
 * same answer `listingFailure` gives an error carrying no errno — because
 * dropping the line would reinstate the silent gap for exactly the errnos
 * nobody thought of.
 */
const STRERROR_TO_ERRNO: ReadonlyMap<string, string> = new Map([
  ['Permission denied', 'EACCES'],
  ['Too many open files', 'EMFILE'],
  ['Too many open files in system', 'ENFILE'],
  ['Too many levels of symbolic links', 'ELOOP'],
  ['Resource temporarily unavailable', 'EAGAIN'],
  ['Input/output error', 'EIO'],
  ['Stale file handle', 'ESTALE'],
  ['Stale NFS file handle', 'ESTALE'],
]);

/**
 * The directories a git listing SKIPPED, read off its stderr.
 *
 * Pure. Returns each refused directory once, worktree-relative and without
 * git's trailing slash, with the errno its reason maps to.
 *
 * @param stderr - What the listing wrote to stderr
 * @returns The refusals, in the order git printed them, deduplicated
 */
export function unlistableDirectoriesIn(stderr: string): { directory: string; code: string }[] {
  const seen = new Set<string>();
  const refusals: { directory: string; code: string }[] = [];
  for (const match of stderr.matchAll(UNLISTABLE_DIRECTORY_LINE)) {
    const directory = match[1] ?? '';
    if (directory === '' || seen.has(directory)) continue;
    seen.add(directory);
    refusals.push({ directory, code: STRERROR_TO_ERRNO.get((match[2] ?? '').trim()) ?? 'UNKNOWN' });
  }
  return refusals;
}

/**
 * The option every working-tree listing here accepts.
 *
 * Without it a refused directory is invisible: git's exit status is 0 and its
 * stdout is simply shorter. With it, each directory git could not open is
 * handed over as the SAME {@link DirectoryRefusal} the filesystem walk produces
 * (`file-crawler.ts`) — absolute, forward-slashed, with `transient` derived
 * beside the errno list in `fs-utils.ts` — so a caller decides once for both
 * routes. The caller decides; this module only reports.
 */
export interface GitListingOptions {
  /** Receive every directory git could not open while walking the working tree. */
  onUnreadable?: (refusal: DirectoryRefusal) => void;
}

/**
 * Run one NUL-delimited `ls-files` listing and report what git skipped.
 *
 * `LC_ALL=C` so the stderr reason is the C-locale `strerror` text the parser
 * knows; `trim: false` because the output is NUL-delimited (see the callers).
 *
 * @param args - The `ls-files` argv
 * @param cwd - Where to run it
 * @param onUnreadable - Where a skipped directory goes, if anywhere
 * @returns The listed paths, or null when git did not answer
 */
function runListing(
  args: readonly string[],
  cwd: string,
  onUnreadable: GitListingOptions['onUnreadable'],
): string[] | null {
  const result = runGit(args, { cwd, trim: false, env: { LC_ALL: 'C' } });

  // Every failure means the same thing to this caller — no listing. That covers
  // "not a repository" (128), git missing entirely, and a listing too large for
  // the buffer, which `ok` folds in because a truncated answer here is files
  // silently missing rather than a short list.
  if (!result.ok) {
    return null;
  }

  if (onUnreadable !== undefined && result.stderr !== '') {
    // The warning is worktree-root-relative regardless of `cwd`.
    const worktreeRoot = gitFindRoot(cwd) ?? cwd;
    for (const { directory, code } of unlistableDirectoriesIn(result.stderr)) {
      onUnreadable(
        directoryRefusalFor({ outcome: 'unreadable', code }, safePath.resolve(worktreeRoot, directory)),
      );
    }
  }

  // NUL-separated (from -z), so no path can ever need quote-unescaping — a
  // trailing NUL just produces one empty string at the end, dropped here.
  return result.stdout.split('\0').filter((line) => line.length > 0);
}


/**
 * Find the git repository root by walking up from the given directory.
 *
 * Memoized module-wide via `git-root-cache.ts`: the walk seeds an entry for
 * every directory it climbs, not just for `startDir`, because the redundancy
 * this removes is overlapping walks from *different* start directories rather
 * than repeated calls with the same one. A `null` answer is memoized too — that
 * is the case that costs a walk to the filesystem root.
 *
 * The memo therefore does NOT see a `.git` directory created or removed after
 * the fact. Anything that mutates repositories in-process (tests; a host that
 * re-enters a command) must call `resetProjectRootCaches()`, which clears this
 * cache along with the project-root one.
 *
 * @param startDir - Directory to start searching from
 * @returns Path to git root, or null if not in a git repository
 */
export function gitFindRoot(startDir: string): string | null {
  let currentDir = safePath.resolve(startDir);
  const root = parse(currentDir).root;
  const climbed: string[] = [];

  while (currentDir !== root) {
    const memoized = lookupGitRoot(currentDir);
    if (memoized !== undefined) return rememberGitRoot(climbed, memoized);
    climbed.push(currentDir);

    const gitDir = safePath.join(currentDir, '.git');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walking up from validated startDir
    if (existsSync(gitDir)) {
      return rememberGitRoot(climbed, currentDir);
    }
    currentDir = dirname(currentDir);
  }

  return rememberGitRoot(climbed, null);
}

/**
 * List files tracked by git, optionally filtered by patterns.
 *
 * @param options - Configuration options
 * @param options.cwd - Working directory (git repository root or subdirectory)
 * @param options.patterns - Optional glob patterns to filter files (e.g., '*.md', 'docs/**\/*.ts')
 * @param options.includeUntracked - Include untracked files that aren't gitignored (default: false)
 * @param options.onUnreadable - See {@link GitListingOptions}. Only the untracked
 *   listing walks the working tree, so only it can have skipped a directory
 * @returns Array of file paths relative to the git root, or null if not in a git repo
 *
 * @example
 * ```typescript
 * // List all tracked markdown files
 * const files = gitLsFiles({ cwd: '/project', patterns: ['*.md', 'docs/**\/*.md'] });
 *
 * // List all non-ignored files (tracked + untracked)
 * const allFiles = gitLsFiles({ cwd: '/project', includeUntracked: true });
 * ```
 */
export function gitLsFiles(options: GitListingOptions & {
  cwd: string;
  patterns?: string[];
  includeUntracked?: boolean;
}): string[] | null {
  // -z emits NUL-separated, UNQUOTED paths regardless of byte content. Without
  // it, git quotes any path containing non-ASCII bytes (wraps it in double
  // quotes with octal escapes, e.g. `café.md` -> `"caf\303\251.md"`), which is
  // unusable to any exact-string lookup against the real filename.
  const args = ['ls-files', '-z'];

  // Include untracked files that aren't gitignored
  if (options.includeUntracked) {
    args.push('--cached', '--others', '--exclude-standard');
  }

  // Add patterns if provided
  if (options.patterns && options.patterns.length > 0) {
    args.push('--', ...options.patterns);
  }

  // `trim: false` (inside `runListing`) because the output is NUL-delimited:
  // git sorts by byte value, so a path beginning with a space sorts FIRST and a
  // trim would silently rename it to a path that does not exist.
  return runListing(args, options.cwd, options.onUnreadable);
}

/**
 * List paths git does NOT track, with each wholly-untracked directory collapsed
 * to a single entry.
 *
 * This is the **prune list**, not a file list, and the distinction is the whole
 * value. `--others --ignored --exclude-standard` alone returns every ignored file
 * individually: measured on an 8,496-path adopter working tree that is 533,557
 * paths in 1.19 s — worse than the crawl it was meant to replace, because
 * `.turbo/cache` alone contributed 418,518 of them. Adding `--directory`
 * collapses each wholly-ignored directory to one entry: **369 entries in 60 ms**.
 * A caller can then decide per directory whether to descend, and skip a
 * half-million paths by name without ever entering them.
 *
 * A collapsed directory entry is returned with a trailing `/`, exactly as git
 * spells it. That is how a caller tells "this whole subtree" from "this one
 * file", so it is deliberately not normalized away here.
 *
 * @param options - Configuration options
 * @param options.cwd - Working directory inside the repository
 * @param options.ignored - Restrict to ignored paths. Off, the listing is
 *   untracked-but-not-ignored paths — which is the only way to see an EMPTY
 *   untracked directory, since a directory with no files in it is invisible to
 *   `ls-files` and to any tree object
 * @param options.directory - Collapse a wholly-untracked directory to one entry
 * @param options.onUnreadable - See {@link GitListingOptions}. ⚠️ Only the
 *   `ignored` listing reports anything: without `--ignored`, git collapses a
 *   wholly-untracked directory WITHOUT opening it, so the not-ignored prune list
 *   never meets the refusal (measured on git 2.50)
 * @returns Paths relative to the git root, or null if git did not answer
 *
 * @example
 * ```typescript
 * // The prune list: where the ignored territory is, without enumerating it.
 * const prune = gitLsOthers({ cwd: root, ignored: true, directory: true });
 * // → ['dist/', 'node_modules/', '.turbo/', 'notes.local.md']
 * ```
 */
export function gitLsOthers(options: GitListingOptions & {
  cwd: string;
  ignored?: boolean;
  directory?: boolean;
}): string[] | null {
  // `--exclude-standard` is unconditional: `--ignored` is rejected outright by
  // git without an exclude source, and without it the not-ignored listing would
  // report every ignored path as merely untracked — the exact inversion of what
  // either caller asked for.
  const args = ['ls-files', '-z', '--others', '--exclude-standard'];

  if (options.ignored) {
    args.push('--ignored');
  }
  if (options.directory) {
    args.push('--directory');
  }

  // See `gitLsFiles`: NUL-delimited output must not be trimmed, or a path
  // beginning with a space — which git sorts FIRST — comes back renamed.
  return runListing(args, options.cwd, options.onUnreadable);
}

/**
 * Check if a file path is ignored by git
 *
 * Uses git check-ignore which respects .gitignore, .git/info/exclude, and global gitignore.
 *
 * **Symlink handling**: When `git check-ignore` fails with exit code 128 ("beyond a symbolic
 * link"), this function walks up ancestor directories and checks each one. If any ancestor is
 * gitignored (e.g., `data/` is in `.gitignore`), the file is considered gitignored too. This
 * handles the common pattern where a gitignored directory contains symlinks to external content
 * (e.g., OneDrive, shared drives).
 *
 * **Outside a repository**: answered from the filesystem, with zero subprocesses (see below).
 *
 * **Performance warning**: This spawns a git subprocess for each file (plus up to N ancestor
 * checks when the path traverses a symlink). For bulk workflows, initialize a
 * {@link GitTracker} once and use `isIgnoredByActiveSet()` for O(1) in-repo lookups.
 *
 * @param filePath - Absolute or relative path to check
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns true if file is gitignored, false otherwise
 */
export function isGitIgnored(filePath: string, cwd: string = process.cwd()): boolean {
  // `git check-ignore` exits 128 for two unrelated conditions: "not a git repository"
  // and "beyond a symbolic link". The exit code alone cannot distinguish them, and the
  // symlink recovery below (walk the ancestors, re-spawning git for each) is exactly
  // the wrong response to the first: with no repository *every* ancestor also exits
  // 128, so the walk never breaks, climbs to the filesystem root, and returns `false`
  // after (1 + depth) spawns — per call, for every link in the corpus. It is the right
  // answer by the wrong route, which is why no assertion ever caught it; on a
  // 3,437-document tree with no `.git` ancestor, spawnSync was 87.6% of the run.
  //
  // "Is there a repository here?" is a filesystem question, so settle it from the
  // filesystem before spawning anything.
  if (gitFindRoot(cwd) === null) {
    return false;
  }

  const checkIgnoreArgs = ['check-ignore', '-q'] as const;

  // git check-ignore returns exit code 0 if file is ignored, 1 if not
  const result = runGit([...checkIgnoreArgs, filePath], { cwd });

  if (result.status === 0) {
    return true;
  }

  // Exit code 128 = fatal error (e.g., path beyond a symbolic link).
  // Walk up ancestor directories to check if a parent is gitignored.
  // Example: data/ is gitignored, data/symlink/deep/file.md fails with 128,
  // but checking data/ directly returns 0.
  if (result.status !== 1) {
    const resolvedCwd = safePath.resolve(cwd);
    const resolvedFile = safePath.resolve(cwd, filePath);
    let current = dirname(resolvedFile);

    while (current !== resolvedCwd && !current.endsWith(parse(current).root)) {
      const ancestorResult = runGit([...checkIgnoreArgs, current], { cwd });
      if (ancestorResult.status === 0) {
        return true;
      }
      // If this ancestor check also fails fatally, keep walking up
      // If it returns 1 (not ignored), the parent is tracked — stop walking
      if (ancestorResult.status === 1) {
        break;
      }
      current = dirname(current);
    }
  }

  return false;
}

