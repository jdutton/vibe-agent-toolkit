/**
 * A **dirty-corrected git tree snapshot**, rebased onto absolute paths.
 *
 * `@vibe-validate/git`'s `getGitTreeSnapshot` answers the question git is
 * uniquely good at: every path git can see under a directory, each with a blob
 * OID naming *the bytes that are actually on disk right now* — dirty working-tree
 * edits included, not the stale committed-index SHA — plus one deterministic
 * `write-tree` hash over the whole set. Membership is `git add --all` without
 * `--force`, i.e. `tracked ∪ (untracked ∧ ¬ignored)`.
 *
 * This module is the thin layer VAT needs on top, and it exists for one reason
 * that is easy to get wrong: **git spells those paths relative to the repository
 * root, not to the directory you asked about.** A caller scanning
 * `<repo>/packages/foo` gets back `packages/foo/x.md`, and a caller that joined
 * those onto its own root would build `<repo>/packages/foo/packages/foo/x.md` —
 * a path that does not exist, so every consumer reads it as "absent" rather than
 * as a bug. Resolving against the repository root here makes that unrepresentable
 * at the call site.
 *
 * ## ⚠️ This is not a pure read
 *
 * Taking a snapshot runs `git add --all` against a throwaway index, which
 * **writes loose blob objects into the target repository's `.git/objects`** for
 * any content git has not already stored. The real index and working tree are
 * never touched, and the objects are ordinary unreferenced blobs that `git gc`
 * reclaims — but a command that advertises itself as read-only is, at the byte
 * level, not. `vibe-validate` accepts this cost on every commit it gates; a VAT
 * lane that adopts it inherits the same trade rather than a different one.
 *
 * ## ⚠️ A symlink's OID names its TARGET STRING, not a file's bytes
 *
 * Git stores a symlink as a blob whose content is the link target, under mode
 * `120000`. Two links with the same relative target but different resolutions
 * therefore share an OID while a consumer that follows them reads two different
 * documents. {@link GitSnapshotEntry.isSymlink} is computed here precisely so
 * that a consumer keying work off `oid` can exclude them — see
 * `packages/resources/src/content-key.ts`, whose standing rule is that a git SHA
 * may be a *lookup hint whose miss is free* and must never be the key itself.
 *
 * ## ⚠️ Two consumers want the SAME snapshot — see {@link withGitSnapshotCache}
 *
 * One command takes this snapshot twice, of one repository, sequentially, and
 * keeps a different half of each: the projection store keeps `hash` as its
 * cache key, and the git crawl source keeps `entries`. Bracketing the command
 * makes that one snapshot. Everything outside the bracket still pays per call,
 * deliberately.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { getGitTreeSnapshot, GIT_MODE_GITLINK, GIT_MODE_SYMLINK } from '@vibe-validate/git';

import { gitFindRoot } from './git-utils.js';
import { safePath } from './path-utils.js';

/** One path in a {@link GitTreeSnapshot}, located absolutely. */
export interface GitSnapshotEntry {
  /** Absolute, forward-slashed path, resolved against the repository root. */
  absolutePath: string;
  /**
   * Blob OID for this path's **on-disk** bytes.
   *
   * Equal OIDs mean equal bytes, which is what makes this usable as a lookup
   * hint. It is NOT usable as a content key — see the module docstring.
   */
  oid: string;
  /** Git's six-digit mode, verbatim: `100644`, `100755`, `120000`, `160000`. */
  mode: string;
  /** Mode `120000`. Its {@link GitSnapshotEntry.oid} is the target string. */
  isSymlink: boolean;
  /**
   * Mode `160000` — a submodule.
   *
   * The OID is a **commit**, not a blob, so `cat-file` on it yields no file
   * bytes, and none of the submodule's own files appear anywhere in the
   * snapshot. A consumer that needs them takes a second snapshot rooted there.
   */
  isSubmodule: boolean;
}

/** One repository's snapshot. */
export interface GitTreeSnapshot {
  /**
   * `git write-tree` over the snapshot — a deterministic key for the whole set.
   *
   * Byte-identical content always produces it, because a tree object carries no
   * timestamp. (A `stash create` would not: a stash is a commit, and two calls
   * over identical content agree only within the same wall-clock second.)
   */
  hash: string;
  /** The repository root every entry was resolved against, forward-slashed. */
  repositoryRoot: string;
  /** Every path git can see, in git's own order. */
  entries: GitSnapshotEntry[];
}

/**
 * The snapshots taken inside the bracket now open, keyed by repository root.
 *
 * `AsyncLocalStorage` rather than a module-level `Map`, and the distinction is
 * the whole design. A blanket memo would dedupe the same two calls — and would
 * then hand a stale snapshot to anything that mutates a repository and
 * re-snapshots it in the same process, which is what a vitest worker running
 * many suites does all day. Scoping it to a bracket makes the memo's lifetime
 * something a caller states rather than something the module assumes; outside
 * one, {@link gitTreeSnapshot} behaves exactly as it did before this existed.
 *
 * Async-scoped rather than a plain variable because the bracket spans a whole
 * command's `await`s, and two commands may be open at once in one process —
 * `crawl-timing.ts` reaches for the same primitive for the same reason.
 *
 * `null` is a stored value, not an absence: "git could not answer" costs a full
 * `add`/`write-tree` attempt to discover, so repeating it is pure cost. Absence
 * is `undefined`, which `Map.get` returns and this module never stores.
 */
const snapshotsInBracket = new AsyncLocalStorage<Map<string, GitTreeSnapshot | null>>();

/**
 * Run work that may snapshot the same repository more than once, and pay for
 * each repository ONCE.
 *
 * ## What this buys, in both currencies
 *
 * A snapshot is not a read — it copies the index, runs `git add --all` into it
 * and then `git write-tree`. One `vat` command took two of them, of the same
 * repository, back to back: `openPopulationCache` needs `hash` to key the
 * projection store, and `GitCrawlSource` needs `entries` to enumerate. Measured
 * on a large monorepo, the pair cost 195.22 ms and 158.55 ms.
 *
 * The cost is the smaller half. Two snapshots taken 195 ms apart are two
 * *different answers* whenever the working tree changes in between, and the
 * command then files the second one's extent under the first one's key — a
 * cache entry whose key does not describe its contents, produced silently and
 * discoverable only as a wrong answer much later. One snapshot removes the race
 * rather than merely the duplicate.
 *
 * ## Where to open it
 *
 * At the level that already brackets the whole command, so that it encloses
 * *every* snapshotting consumer. Opened deeper than one of them, the dedupe
 * silently does nothing and looks exactly like a dedupe that works.
 *
 * ## What it deliberately does NOT do
 *
 * Inside the bracket, a working-tree edit made between two calls is not
 * observed by the second — the first snapshot is the answer for the whole
 * bracket. That is the race being closed, not a limitation to work around. Work
 * that must see edits as they land does not belong inside one bracket.
 *
 * Nesting is safe and inner-most wins: an inner bracket starts an empty memo,
 * and the outer one's entries are restored when it returns.
 *
 * @param run - The work to run with the memo open. Sync or async — the return
 *   value is passed straight through, so an async `run` keeps the memo for the
 *   whole promise it returns
 * @returns Whatever `run` returned
 *
 * @example
 * ```typescript
 * return withGitSnapshotCache(async () => {
 *   const opened = await openPopulationCache(options); // snapshots
 *   return work(opened?.cache);                        // crawls, snapshots
 * });
 * ```
 */
export function withGitSnapshotCache<T>(run: () => T): T {
  return snapshotsInBracket.run(new Map<string, GitTreeSnapshot | null>(), run);
}

/**
 * Snapshot everything git can see under a directory.
 *
 * Inside a {@link withGitSnapshotCache} bracket the answer for a given
 * repository is taken once and reused — including a `null`. Outside one, every
 * call spawns git, which is what it has always done.
 *
 * @param options - Where to look
 * @param options.cwd - Any directory inside the repository of interest. Git
 *   resolves upward to the worktree root, and the snapshot covers that whole
 *   root — NOT only the subtree named here. Narrowing is the caller's job, and
 *   is why {@link GitSnapshotEntry.absolutePath} is absolute
 * @returns The snapshot, or `null` when git could not answer — no `git` on
 *   `PATH`, not a repository, a bare or unreadable one. An empty `entries` is a
 *   real answer (an initialized repository with no files) and stays
 *   distinguishable from it
 */
export function gitTreeSnapshot(options: { cwd: string }): GitTreeSnapshot | null {
  // Resolved from the filesystem BEFORE spawning anything, and deliberately not
  // from a `rev-parse` of our own: `getGitTreeSnapshot` has already paid for that
  // question internally, and asking it twice invites the two answers to disagree
  // on a worktree, where the git directory and the worktree root are different
  // places. `gitFindRoot` is memoized, so this is free after the first call.
  const repositoryRoot = gitFindRoot(options.cwd);
  if (repositoryRoot === null) {
    // Not memoized, and it does not need to be: this branch spawns nothing, and
    // `gitFindRoot` has its own memo. There is also no key to file it under —
    // the memo is keyed by repository root, and this is the case with none.
    return null;
  }

  // Keyed by the RESOLVED root rather than by `options.cwd`, because a snapshot
  // covers the whole repository however deep the directory it was asked from.
  // The two call sites this bracket exists for pass different directories — the
  // corpus root and the project root — so keying on `cwd` would produce two
  // entries holding the identical answer, i.e. a dedupe that does nothing in
  // exactly the case it was written for.
  const memo = snapshotsInBracket.getStore();
  const memoized = memo?.get(repositoryRoot);
  if (memoized !== undefined) return memoized;

  const snapshot = takeSnapshot(options.cwd, repositoryRoot);
  memo?.set(repositoryRoot, snapshot);
  return snapshot;
}

/**
 * Ask git, and rebase the answer onto absolute paths.
 *
 * Split out so {@link gitTreeSnapshot} reads as "key, look up, or take one" —
 * the memo has to sit above the spawn, and a memo interleaved with the mapping
 * is how a later edit ends up caching the wrong half.
 *
 * @param cwd - The directory to ask git from
 * @param repositoryRoot - The already-resolved root every entry is rebased onto
 * @returns The snapshot, or `null` when git could not answer
 */
function takeSnapshot(cwd: string, repositoryRoot: string): GitTreeSnapshot | null {
  const snapshot = getGitTreeSnapshot({ cwd });
  if (snapshot === null) {
    return null;
  }

  return {
    hash: snapshot.hash,
    repositoryRoot,
    entries: snapshot.entries.map((entry) => ({
      absolutePath: safePath.resolve(repositoryRoot, entry.path),
      oid: entry.oid,
      mode: entry.mode,
      isSymlink: entry.mode === GIT_MODE_SYMLINK,
      isSubmodule: entry.mode === GIT_MODE_GITLINK,
    })),
  };
}
