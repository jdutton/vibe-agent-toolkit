/**
 * **One crawl API, two implementations** — the seam
 * `docs/architecture/resource-scanning-and-caching.md` §3.3 specifies, and the
 * reason it is an interface rather than a branch inside the caller.
 *
 * A corpus root is enumerated either by walking the filesystem or by asking git,
 * and the two are cost models rather than behaviours: **they must answer the same
 * question and return the same set.** Expressing that as one interface with two
 * implementations is what makes the claim testable — two implementations can be
 * run against the same root and differenced (`crawl-source-parity.integration.
 * test.ts`), whereas two ad-hoc code paths chosen at each call site can only be
 * compared by noticing a wrong answer somewhere downstream.
 *
 * | | {@link GitCrawlSource} | {@link FilesystemCrawlSource} |
 * |---|---|---|
 * | non-ignored members | `write-tree` snapshot, ~10 ms for 8,496 paths | `readdir` walk |
 * | ignored members | prune list, then walk only that territory | same walk, undifferentiated |
 * | content hint | blob OID, already computed | none — bytes get read and hashed |
 * | directories | derived from paths + collapsed-directory entries | walked directly |
 * | path shape | index mode bits, so the realization never `lstat`s | none — every path is stat'ed |
 *
 * ## The shape column is where the two cost models genuinely diverge
 *
 * Until it existed they did not. Both sources returned bare paths, both fed the
 * same `FilesystemExtentContributor`, and its per-path `collectRealization`
 * opened with an unconditional `lstat` — so the git source saved ~963 `readdir`
 * calls, added several git spawns, and paid **byte-identically** for everything
 * else: 20,908 `lstat` on an 8,548-file adopter tree from either source. Git
 * already held the answer (`git add -A` stages deletions, so a snapshot entry
 * exists; a blob is not a directory; mode `120000` is a symlink and is dropped
 * from membership here anyway) and dropped it at this seam.
 *
 * Carrying it is a deliberate asymmetry, not a leak: the git source is meant to
 * be the one that does not touch the filesystem for what git can answer, and
 * {@link EnumeratedPath.shape} is `null` on every path it had to walk for —
 * ignored territory, submodule contents, collapsed untracked directory entries —
 * so the strictness stops exactly where git's knowledge does.
 *
 * ## What the git implementation is NOT allowed to do
 *
 * **Drop the ignored half.** A tree snapshot structurally cannot see gitignored
 * paths, and that half is the entire reason the `filesystem` extent exists — a
 * git source that silently returned only what git tracks would be much faster and
 * would delete a capability. So this implementation is *not purely git*: it uses
 * git for the members git knows and a bounded walk for the rest, and §3.3 names
 * that constraint first because it has already been got wrong once.
 *
 * ## Why the ignored half is still cheap
 *
 * `ls-files --others --ignored --exclude-standard` on its own is a *worse* answer
 * than the walk: 533,557 paths in 1.19 s on an 8,496-path adopter tree. Adding
 * `--directory` collapses each wholly-ignored directory to one entry — 369
 * entries in 60 ms — which is a **prune list**, not a file list. The walk then
 * descends only into ignored territory that survives {@link NEVER_CRAWL_GLOBS},
 * so `.turbo/cache` (418,518 of those paths) is skipped by name without ever
 * being entered.
 *
 * ## Why an empty directory needs its own question
 *
 * A directory with no files beneath it appears in no tree object and in no
 * `ls-files` listing, because git tracks content and an empty directory has none.
 * Deriving directories from file paths therefore finds every directory *except*
 * the empty ones — and the filesystem walk reports them, so the two sources would
 * disagree. `ls-files --others --directory` (without `--ignored`) is what closes
 * it: a wholly-untracked directory collapses to one entry whether or not it is
 * empty.
 */

import { existsSync, statSync } from 'node:fs';

import {
  readTextContentSync,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import {
  crawlDirectory,
  crawlPathFilter,
  NEVER_CRAWL_GLOBS,
} from '@vibe-agent-toolkit/utils/crawl';
import {
  gitFindRoot,
  gitLsOthers,
  gitTreeSnapshot,
} from '@vibe-agent-toolkit/utils/git';

import type { PathShape } from './realizations.js';

/** The key a `.git` pointer file uses to name the real gitdir. */
const GITDIR_PREFIX = 'gitdir:';

/**
 * One path an enumeration source found, with whatever that source knew for free.
 */
export interface EnumeratedPath {
  /** Absolute, forward-slashed. */
  absolutePath: string;
  /**
   * A byte-identity hint for this path, or `null` when the source has none.
   *
   * Present only where it is **sound**: a git blob OID for a regular file, whose
   * equality implies byte equality. Null for a directory, and for every path the
   * filesystem walk found — the walk knows nothing about a path until it reads
   * it, and inventing a hint from `mtime` would be a guess wearing a fact's
   * clothes.
   *
   * The two OIDs that would NOT imply byte equality never reach this field at
   * all, because the paths carrying them are not members: a symlink (whose OID
   * is the link target string) is excluded outright, and a submodule (whose OID
   * is a commit) is expanded into the files beneath it. Excluding them at
   * enumeration rather than nulling the hint means a later consumer cannot
   * reintroduce the defect by reading `mode` and deciding for itself.
   *
   * ⚠️ **A hint, never a key.** `content-key.ts` states the rule: a git SHA may
   * be used as a lookup whose miss is free, and must never be the identity a
   * parse is filed under.
   */
  contentHint: string | null;
  /**
   * What this source already knows the path IS, or `null` when it must be
   * stat'ed.
   *
   * Unlike {@link EnumeratedPath.contentHint} this is **authoritative**: a
   * realization built from it never calls `lstat`, so a wrong answer here is a
   * wrong row rather than a slow one. Supply it only where {@link PathShape}'s
   * bar is met — present, not a symlink, and known to be a file or a directory.
   *
   * Required rather than optional, and `null` rather than absent, for the reason
   * `contentHint` is: a new source must *state* that it knows nothing, because
   * the failure mode of forgetting is a population that silently stops being
   * described.
   */
  shape: PathShape | null;
}

/** An enumeration strategy for one corpus root. */
export interface CrawlSource {
  /** Which implementation this is — recorded so a population says how it was found. */
  readonly kind: CrawlSourceKind;
  /**
   * Every file and directory beneath the root that {@link NEVER_CRAWL_GLOBS}
   * admits, in no guaranteed order.
   *
   * @returns The population, deduplicated by absolute path
   */
  enumerate(): Promise<readonly EnumeratedPath[]>;
}

/** Which of the two implementations answered. */
export type CrawlSourceKind = 'git' | 'filesystem';

/**
 * The walk. Enumerates the working tree directly and knows nothing else.
 *
 * This is the incumbent behaviour, preserved exactly: the same options
 * `FilesystemExtentContributor` has always passed, so selecting this source is a
 * no-op rather than a re-implementation that happens to agree.
 */
export class FilesystemCrawlSource implements CrawlSource {
  readonly kind: CrawlSourceKind = 'filesystem';

  readonly #root: string;

  /**
   * @param root - Absolute corpus root to enumerate
   */
  constructor(root: string) {
    this.#root = root;
  }

  /**
   * Walk the root.
   *
   * @returns Every admitted path, with no content hints and no shapes
   */
  async enumerate(): Promise<readonly EnumeratedPath[]> {
    const absolutePaths = await crawlDirectory({
      baseDir: this.#root,
      exclude: [...NEVER_CRAWL_GLOBS],
      // `followSymlinks` is three decisions — re-entry, membership and reach —
      // and all three come out the same way: following links would enumerate one
      // blob many times, under a distinct path each time.
      // 🪤 Do NOT justify that with "identity already collapses a symlink onto
      // its target" — it does not wherever git answers, because
      // `canonicalPathFor` takes git's spelling before it can reach `realpath`
      // (see *"🪤 A symlink and its target do NOT reliably share one identity"*
      // in `identity.ts`). So the duplicates arrive as extra MEMBERS, not merely
      // as extra realizations of one identity, which makes the case for
      // declining stronger rather than weaker.
      followSymlinks: false,
      // Directories are resources, not merely containers of them.
      filesOnly: false,
      // The whole point of the extent this feeds: build output git cannot see.
      respectGitignore: false,
    });

    // `shape: null` even though `crawlDirectory` walked with `readdir`, which
    // does carry a dirent type. Supplying it here would erase the asymmetry the
    // module docstring describes, and it is not this change's measurement to
    // take: the walk is the incumbent, its cost is the baseline every git-source
    // number is quoted against, and moving both arms at once leaves neither
    // attributable. It remains available if it is ever wanted for its own sake.
    return absolutePaths.map((absolutePath) => ({
      absolutePath,
      contentHint: null,
      shape: null,
    }));
  }
}

/**
 * Git plus a bounded walk. See the module docstring for what it may not do.
 */
export class GitCrawlSource implements CrawlSource {
  readonly kind: CrawlSourceKind = 'git';

  readonly #root: string;

  /**
   * @param root - Absolute corpus root, inside a git working tree
   */
  constructor(root: string) {
    this.#root = root;
  }

  /**
   * Ask git what it can see, then walk only what it cannot.
   *
   * @returns Every admitted path, with content hints on the regular files git
   *   already hashed and shapes on everything git described rather than walked
   * @throws When git does not answer. An empty population would be
   *   indistinguishable from a repository with no files, which is the same
   *   confusion `GitExtentContributor` refuses to ship
   */
  async enumerate(): Promise<readonly EnumeratedPath[]> {
    const isMember = crawlPathFilter(['**/*'], [...NEVER_CRAWL_GLOBS]);
    const admits = (absolutePath: string): boolean =>
      isMember(relativeToRoot(absolutePath, this.#root));

    const found = new Map<string, EnumeratedPath>();
    const record = (entry: EnumeratedPath): void => {
      if (!found.has(entry.absolutePath)) found.set(entry.absolutePath, entry);
    };

    const { members, submodules } = this.#snapshotMembers(admits);
    for (const entry of members) found.set(entry.absolutePath, entry);
    for (const absolutePath of await this.#untrackedTerritory(admits, submodules)) {
      // `shape: null`, and that is the honest answer rather than a conservative
      // one: every path here came from a filesystem walk or from a collapsed
      // `ls-files --others --directory` entry. The walk knows the dirent type but
      // deliberately does not report it (see `FilesystemCrawlSource`), and the
      // collapsed entry is worse than unknown — git marks a *directory* with a
      // trailing slash by `lstat`ing it, so a symlink pointing at a directory
      // arrives spelled exactly like a file and a shape derived from it would be
      // a wrong row.
      record({ absolutePath, contentHint: null, shape: null });
    }
    // Last, so an ancestor already recorded by the snapshot as a FILE is not
    // relabelled. `contentHint` is unconditionally null — a directory has no
    // bytes — and `shape` is unconditionally `'directory'`, which is sound
    // because these paths were DERIVED from the names of paths git or the walk
    // found beneath them: a path exists only if its ancestors do, and neither
    // git nor a `followSymlinks: false` walk reports anything beneath a symlink,
    // so no ancestor reached here can be one.
    for (const absolutePath of ancestorDirectories([...found.keys()], this.#root)) {
      record({ absolutePath, contentHint: null, shape: 'directory' });
    }

    return [...found.values()];
  }

  /**
   * The members git holds: `tracked ∪ (untracked ∧ ¬ignored)`, with OIDs.
   *
   * @param admits - The shipped include/exclude decision
   * @returns The admitted entries, and separately the submodule directories
   *   whose contents git declined to describe
   * @throws When git could not answer at all
   */
  #snapshotMembers(admits: (absolutePath: string) => boolean): {
    members: EnumeratedPath[];
    submodules: string[];
  } {
    const snapshot = gitTreeSnapshot({ cwd: this.#root });
    if (snapshot === null) {
      throw new Error(
        `git did not answer for "${this.#root}" — it is not a git repository, or git could not read it.`
        + ' Returning an empty population would be indistinguishable from an empty repository, so this is an error.',
      );
    }

    const members: EnumeratedPath[] = [];
    const submodules: string[] = [];

    for (const entry of snapshot.entries) {
      // A snapshot covers the whole REPOSITORY, which may be an ancestor of the
      // corpus root. Narrowing is this caller's job — see `gitTreeSnapshot`.
      if (!isUnderRoot(entry.absolutePath, this.#root)) continue;
      if (!admits(entry.absolutePath)) continue;

      // ⚠️ A SYMLINK IS NOT A MEMBER HERE, and dropping it is what makes this a
      // re-sourcing rather than a redefinition. The walk this replaces runs with
      // `followSymlinks: false`, whose `processSymlink` returns before recording
      // anything — so the filesystem extent has never contained a symlink's own
      // path. Git has no such notion and reports mode `120000` like any other
      // entry, which is precisely the divergence `file-crawler.ts`'s KNOWN
      // DIVERGENCE block describes between its own two branches. Admitting them
      // here would import that divergence into an extent that does not have it,
      // and would do it silently: the rows would look like ordinary files whose
      // bytes are a target string.
      if (entry.isSymlink) continue;

      // A submodule is ONE gitlink entry whose OID is a commit — none of its
      // files appear. The walk knows nothing about submodules and simply reads
      // the directory, so matching it means descending. (`.git` inside is
      // already excluded by NEVER_CRAWL_GLOBS.)
      if (entry.isSubmodule) {
        submodules.push(entry.absolutePath);
        continue;
      }

      // `shape: 'file'` on all three counts, each from the snapshot rather than
      // from a stat: it EXISTS because `getGitTreeSnapshot` is `git add --all`
      // into a throwaway index, which stages deletions — a tracked file removed
      // from the working tree is absent from `entries` rather than present and
      // stale; it is NOT A DIRECTORY because a tree object records blobs and
      // git lists no directories at all; and it is NOT A SYMLINK because mode
      // `120000` was dropped a few lines above.
      members.push({ absolutePath: entry.absolutePath, contentHint: entry.oid, shape: 'file' });
    }

    return { members, submodules };
  }

  /**
   * Everything git deliberately does not hold: the ignored half, plus the
   * directories that exist without containing anything.
   *
   * @param admits - The shipped include/exclude decision
   * @param submodules - Directories the snapshot named but did not describe
   * @returns Absolute paths, files and directories alike
   */
  async #untrackedTerritory(
    admits: (absolutePath: string) => boolean,
    submodules: readonly string[],
  ): Promise<string[]> {
    const paths: string[] = [];

    // A submodule's own files belong to its own repository, so the outer
    // snapshot cannot see them while the outer WALK reads them like any other
    // directory. Descending is what keeps the two sources equal.
    for (const submodule of submodules) {
      paths.push(submodule, ...(await expandDirectory(submodule, admits)));
    }

    // Ignored territory: descend, because the extent this feeds must still
    // report `gitignored: true` rows. `NEVER_CRAWL_GLOBS` is applied to the
    // COLLAPSED entry before descending, which is where the saving is — a
    // pruned directory is skipped by name and never entered.
    for (const collapsed of this.#prune({ ignored: true })) {
      if (!admits(collapsed.absolutePath)) continue;
      paths.push(collapsed.absolutePath);
      if (collapsed.isDirectory) {
        paths.push(...(await expandDirectory(collapsed.absolutePath, admits)));
      }
    }

    // Untracked-but-not-ignored territory: the entries themselves only, never a
    // descent. Every FILE beneath such a directory is already in the snapshot
    // (`git add --all` staged it), so walking here would re-enumerate what git
    // just handed over. What this recovers is the directory entry itself —
    // including the empty ones no tree object can represent.
    for (const collapsed of this.#prune({ ignored: false })) {
      if (admits(collapsed.absolutePath)) paths.push(collapsed.absolutePath);
    }

    return paths;
  }

  /**
   * One `ls-files --others --directory` listing, located and shape-tagged.
   *
   * @param options - Whether to ask for the ignored side
   * @param options.ignored - Restrict to ignored paths
   * @returns Collapsed entries under this root
   */
  #prune(options: { ignored: boolean }): { absolutePath: string; isDirectory: boolean }[] {
    const listing = gitLsOthers({ cwd: this.#root, ignored: options.ignored, directory: true });
    if (listing === null) return [];

    // Relative to the REPOSITORY root, like every other `ls-files` output.
    const repositoryRoot = gitFindRoot(this.#root) ?? this.#root;

    const entries: { absolutePath: string; isDirectory: boolean }[] = [];
    for (const relativePath of listing) {
      // git marks a collapsed directory with a trailing slash. That is the only
      // signal distinguishing "this whole subtree" from "this one file", so it
      // is read before being resolved away.
      const isDirectory = relativePath.endsWith('/');
      const absolutePath = safePath.resolve(
        repositoryRoot,
        isDirectory ? relativePath.slice(0, -1) : relativePath,
      );
      if (isUnderRoot(absolutePath, this.#root)) {
        entries.push({ absolutePath, isDirectory });
      }
    }
    return entries;
  }
}

/**
 * Walk one directory that git declined to enumerate.
 *
 * @param directory - Absolute path to descend into
 * @param admits - The shipped include/exclude decision, applied per path
 * @returns Every admitted path beneath it, files and directories
 */
async function expandDirectory(
  directory: string,
  admits: (absolutePath: string) => boolean,
): Promise<string[]> {
  const found = await crawlDirectory({
    baseDir: directory,
    // Passed so the walk PRUNES rather than enumerating and discarding. Safe to
    // re-base only because every glob in this list is `**/`-prefixed and so is
    // position-independent: `**/node_modules/**` selects the same paths whether
    // it is evaluated against the corpus root or against a directory inside it.
    // It can therefore only drop paths `admits` would drop anyway, which is what
    // keeps it an optimization rather than a second, quieter policy. Without it
    // an ignored directory containing its own `node_modules` is walked in full
    // and then filtered — the cost this whole lane exists to avoid.
    exclude: [...NEVER_CRAWL_GLOBS],
    followSymlinks: false,
    filesOnly: false,
    // Already inside ignored territory by construction, so consulting git again
    // would return nothing and cost a spawn.
    respectGitignore: false,
  });
  // Still applied: `admits` evaluates against the CORPUS root, and it is the
  // single authority on membership for both sources.
  return found.filter((absolutePath) => admits(absolutePath));
}

/**
 * Every directory on the way from the root down to each of these paths.
 *
 * A tree object records files; the directories are implied by their names. The
 * filesystem walk reports them as members, so a git source that did not derive
 * them would return a different set for the same tree.
 *
 * @param absolutePaths - Paths whose ancestors are wanted
 * @param root - Boundary; the root itself is never a member of its own crawl
 * @returns Absolute ancestor directories, deduplicated
 */
function ancestorDirectories(absolutePaths: readonly string[], root: string): string[] {
  const directories = new Set<string>();
  const normalizedRoot = toForwardSlash(safePath.resolve(root));

  for (const absolutePath of absolutePaths) {
    let current = parentOf(absolutePath);
    // Stop at the root, and stop the moment an ancestor is already recorded —
    // every ancestor above it necessarily is too, which turns a per-path walk to
    // the root into an amortized constant on a deep tree.
    while (current.length > normalizedRoot.length && current.startsWith(`${normalizedRoot}/`)) {
      if (directories.has(current)) break;
      directories.add(current);
      current = parentOf(current);
    }
  }

  return [...directories];
}

/**
 * The containing directory of a forward-slashed absolute path.
 *
 * `node:path.dirname` is deliberately avoided: it returns backslashes on
 * Windows, and every path in this module is forward-slashed so that a `Set` of
 * them can compare by string.
 *
 * @param absolutePath - Forward-slashed absolute path
 * @returns Its parent, or the path itself when it has no separator left
 */
function parentOf(absolutePath: string): string {
  const lastSlash = absolutePath.lastIndexOf('/');
  return lastSlash <= 0 ? absolutePath : absolutePath.slice(0, lastSlash);
}

/**
 * Whether a path lies strictly beneath a root.
 *
 * @param absolutePath - Path to test
 * @param root - Root it must be under
 * @returns True when the path is a strict descendant
 */
function isUnderRoot(absolutePath: string, root: string): boolean {
  return toForwardSlash(absolutePath).startsWith(`${toForwardSlash(safePath.resolve(root))}/`);
}

/**
 * A path expressed the way the crawl globs are written — relative to the root,
 * forward-slashed.
 *
 * @param absolutePath - Path to express
 * @param root - Basis
 * @returns Root-relative forward-slashed path
 */
function relativeToRoot(absolutePath: string, root: string): string {
  return toForwardSlash(safePath.relative(root, absolutePath));
}

/**
 * The env var selecting which implementation enumerates the `filesystem` extent.
 *
 * An environment switch rather than a config field, for the reason
 * `VAT_RESOURCES_CRAWL` is one: it selects which INSTRUMENT runs, not what the
 * project means, and it has to be reachable from the lab, which spawns the binary
 * and controls its environment. A config field would put the A and B arms inside
 * the subject's own tree, where a measurement edits the thing it measures.
 */
export const EXTENT_SOURCE_ENV = 'VAT_EXTENT_SOURCE';

/** {@link EXTENT_SOURCE_ENV}'s value that selects {@link GitCrawlSource}. */
export const EXTENT_SOURCE_GIT = 'git';

/**
 * {@link EXTENT_SOURCE_ENV}'s value that opts BACK to {@link FilesystemCrawlSource}.
 *
 * The git enumerator is the default now, so this is the escape hatch rather than
 * the selector — an opt-OUT, per the house preference for opt-outs over
 * experimental flags. It also stays the way the lab names the filesystem arm
 * explicitly instead of relying on the absence of a variable, which is
 * indistinguishable from a build too old to have the switch.
 */
export const EXTENT_SOURCE_FILESYSTEM = 'filesystem';

/**
 * What this process's environment asks the enumerator to be, verbatim.
 *
 * Exported for the projection store's key. {@link crawlSourceFor} decides the
 * *effective* source, which also depends on whether the root is in a
 * repository; this is the raw **selector**, and the store wants the selector
 * rather than the outcome. Two runs with the same selector always resolve the
 * same way for the same root, so keying on it can only over-separate — a run
 * that asked for git on a non-repository is filed apart from one that asked for
 * nothing, though both walked. Conservative in the safe direction, and the safe
 * direction is the one where a cache never hands back the other answer.
 *
 * @returns The selector as set, or `undefined` when it is not set at all
 */
export function crawlSourceSelector(): string | undefined {
  return process.env[EXTENT_SOURCE_ENV];
}

/**
 * Choose the enumeration source for a root.
 *
 * **Defaults to git wherever there is a git working tree** — the end state §3.3
 * specifies, taken now that the population was compared on real corpora rather
 * than reasoned about. Both arms enumerate `tracked ∪ (untracked ∧ ¬ignored)`;
 * measured on an 8,548-file adopter the git arm costs 7,705 filesystem calls
 * against the filesystem arm's 18,454, and 6 git spawns.
 *
 * ⚠️ Outside a git working tree this is not a preference but a REQUIREMENT to
 * fall back — see the guard in {@link gitExtentSelected}.
 *
 * Read from the environment at each call rather than memoized at module load:
 * `vitest.setup.js` deletes every `VAT_*` variable before any test module loads,
 * so a module-level binding would make the switch unobservable to every test that
 * sets it.
 *
 * @param root - Absolute corpus root
 * @returns The selected source — {@link GitCrawlSource} inside a repository,
 *   {@link FilesystemCrawlSource} outside one or when
 *   {@link EXTENT_SOURCE_FILESYSTEM} is asked for. The fallback is not a
 *   preference: a root outside git has no git answer, and failing there would
 *   make the default unusable across a mixed corpus
 */
export function crawlSourceFor(root: string): CrawlSource {
  if (gitExtentSelected(root)) {
    return new GitCrawlSource(root);
  }
  return new FilesystemCrawlSource(root);
}

/**
 * Will {@link crawlSourceFor} hand back the git enumerator for this root?
 *
 * Exported so a caller can act on the consequence of that choice BEFORE the
 * crawl runs, without duplicating the condition — two copies of "is the git
 * lane on" is exactly how one of them ends up stale.
 *
 * The consequence that matters today: the git enumerator takes a
 * `gitTreeSnapshot` during enumeration no matter what. A caller inside a
 * `withGitSnapshotCache` bracket can therefore take that same snapshot early,
 * pay nothing extra for it (the bracket memoizes, so the enumerator's own call
 * becomes free), and let other consumers read the answers off it. Doing that
 * when this returns FALSE would be a pure loss — a snapshot is `git add --all`
 * plus two more spawns, bought to save something smaller.
 *
 * @param root - The corpus root the crawl will run against
 * @returns Whether the git enumerator is both requested and usable here
 */
/**
 * Does the `.git` entry at this root describe a repository git can read?
 *
 * {@link gitFindRoot} answers a *filesystem* question — "is there a `.git`
 * entry at or above this path" — and that is **not** the question the git
 * enumerator needs answered. {@link GitCrawlSource} throws when git declines to
 * describe the tree, so selecting it on the strength of a `.git` entry alone
 * turns every unreadable repository into a hard failure of a command that used
 * to work: an aborted clone that left an empty `.git/`, a linked worktree whose
 * parent checkout was deleted, a submodule pointer into a missing gitdir, or a
 * directory somebody simply named `.git`.
 *
 * Checked **structurally rather than by asking git**, because asking costs a
 * spawn on the hot path and the snapshot the enumerator takes is `git add
 * --all` — far too dear to buy as a probe. `HEAD` is the discriminator: every
 * repository git will describe has one, and none of the broken shapes above
 * does.
 *
 * ⚠️ This is a *necessary* condition, not a sufficient one — a readable `HEAD`
 * does not prove the git binary exists or that its objects are intact. The
 * enumerator's own throw remains the backstop for those.
 *
 * @param gitRoot - The repository root {@link gitFindRoot} returned
 * @returns Whether the marker looks like a repository git can describe
 */
function gitMarkerIsReadable(gitRoot: string): boolean {
  const marker = safePath.join(gitRoot, '.git');
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from a resolved corpus root
    const stat = statSync(marker);
    if (stat.isDirectory()) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from a resolved corpus root
      return existsSync(safePath.join(marker, 'HEAD'));
    }

    // A `.git` FILE is a pointer — a linked worktree or a submodule. It is only
    // as good as the gitdir it names, which is exactly what goes missing when
    // the parent checkout is deleted out from under it.
    const pointer = readTextContentSync(marker)
      .text.split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith(GITDIR_PREFIX));
    if (pointer === undefined) return false;
    const target = safePath.resolve(gitRoot, pointer.slice(GITDIR_PREFIX.length).trim());
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from a resolved corpus root
    return existsSync(safePath.join(target, 'HEAD'));
  } catch {
    // Unreadable for any reason is the same answer as absent: do not select an
    // enumerator that will throw on it.
    return false;
  }
}

export function gitExtentSelected(root: string): boolean {
  if (process.env[EXTENT_SOURCE_ENV] === EXTENT_SOURCE_FILESYSTEM) return false;

  // ⭐ THE FALLBACK, and it is the reason this is a function of the ROOT rather
  // than of the environment alone. `GitCrawlSource` THROWS when git cannot
  // answer — deliberately, since an empty population is indistinguishable from
  // an empty repository — so a default of "git" would turn every tree without a
  // repository into a hard failure. A corpus synced from SharePoint, an
  // extracted tarball, a plain documentation folder: no `.git` anywhere above
  // it, and each must still scan. Answering `false` here routes them to
  // `FilesystemCrawlSource`, and the command reports `extentSource: filesystem`
  // — the enumerator that RAN, not the one that was asked for.
  const gitRoot = gitFindRoot(root);
  return gitRoot !== null && gitMarkerIsReadable(gitRoot);
}
