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

import { existsSync, lstatSync, statSync } from 'node:fs';

import {
  readTextContentSync,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import {
  crawlDirectory,
  crawlPathFilter,
  type DirectoryRefusal,
  NEVER_CRAWL_GLOBS,
  refuseListing,
} from '@vibe-agent-toolkit/utils/crawl';
import {
  gitFindRoot,
  gitLsOthers,
  gitTreeSnapshot,
  isGitIgnored,
} from '@vibe-agent-toolkit/utils/git';

import type { PathShape } from './realizations.js';

/** The key a `.git` pointer file uses to name the real gitdir. */
const GITDIR_PREFIX = 'gitdir:';

/**
 * What the projection tells an adopter about a refused listing — true for THIS
 * lane, which is why it is not the registry's sentence.
 *
 * The projection enumerates every path beneath the root that
 * {@link NEVER_CRAWL_GLOBS} admits; `resources.include`/`exclude` narrow the
 * registry's view of the population, not the population. A remedy naming that
 * knob here would be one the adopter can apply and see nothing change (it was,
 * and four spellings of it were tried). The knob this lane DOES honour is the
 * one git honours: an ignored directory is outside the population, and a
 * refusal met inside ignored territory is recorded rather than fatal — see
 * {@link ListingRefusals}.
 */
export const PROJECTION_LISTING_REMEDY =
  'Fix the permissions on that directory, or — if it is not part of the project — gitignore it: '
  + 'the projection enumerates every non-ignored path beneath the root, and no include or exclude setting narrows it.';

/**
 * 🚨 **The projection lane STOPS on a refused listing inside the population;
 * inside ignored territory it records and continues.** Both are honest; only
 * silence is not.
 *
 * *Inside the population* — a directory git would have to open to find
 * untracked files, or a submodule's contents — every file beneath it is a
 * member that would be absent from every count, and this lane cannot degrade
 * the way the registry's walk does: its population is built by contributors,
 * merged, and — when a store is open — CACHED, and a cached population
 * enumerated around a gap would answer every later run with the narrowed list
 * and no finding. The only answer that cannot be mistaken for a complete one is
 * to refuse the run, by name, with {@link PROJECTION_LISTING_REMEDY}.
 *
 * *Inside ignored territory* — beneath a collapsed `--ignored --directory`
 * entry — nothing beneath the directory was ever in git's population; the
 * bounded walk is there only to populate `gitignored: true` rows. Aborting the
 * whole run for a root-owned cache under an ignored `build/` was the mirror of
 * the silent gap: a gate firing on something outside the population it guards.
 * The directory itself stays a member (its row says `isDirectory`,
 * `gitignored: true`) and the refusal is kept on {@link CrawlSource.unlistable}
 * for the contributor to carry as a condition row.
 *
 * ⚠️ The two arms must reach the SAME verdict for the same directory, and only
 * the git arm knows from construction which territory it is walking. The
 * filesystem arm therefore ASKS — `isGitIgnored`, one `check-ignore` spawn per
 * refusal, which is rare by nature and free outside a repository.
 */
class ListingRefusals {
  readonly #root: string;
  readonly #recorded: DirectoryRefusal[] = [];
  readonly #seen = new Set<string>();
  readonly #refuse: (refusal: DirectoryRefusal) => never;

  constructor(root: string) {
    this.#root = root;
    this.#refuse = refuseListing({ root, remedy: PROJECTION_LISTING_REMEDY });
  }

  /** Every refusal met inside ignored territory, in the order met, once each. */
  get recorded(): readonly DirectoryRefusal[] {
    return this.#recorded;
  }

  /** The handler for a walk whose every directory is known to be in the population. */
  get inPopulation(): (refusal: DirectoryRefusal) => never {
    return this.#refuse;
  }

  /** The handler for a walk known to be inside gitignored territory. */
  get inIgnoredTerritory(): (refusal: DirectoryRefusal) => void {
    return (refusal) => this.#record(refusal);
  }

  /** The handler for a walk that does not know which territory it is in. */
  get undetermined(): (refusal: DirectoryRefusal) => void {
    return (refusal) => {
      if (isGitIgnored(refusal.directory, this.#root)) {
        this.#record(refusal);
        return;
      }
      this.#refuse(refusal);
    };
  }

  #record(refusal: DirectoryRefusal): void {
    if (this.#seen.has(refusal.directory)) return;
    this.#seen.add(refusal.directory);
    this.#recorded.push(refusal);
  }
}

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
   * @throws {DirectoryListingRefusedError} For a directory inside the population
   *   that could not be listed — see {@link ListingRefusals}
   */
  enumerate(): Promise<readonly EnumeratedPath[]>;
  /**
   * The GITIGNORED directories the last {@link CrawlSource.enumerate} could not
   * list, once each. Each is still a member; what is unknown is what lies
   * beneath it. Empty until `enumerate` has run — and a source that replays
   * another's enumeration replays this with it, or the fact is lost at the seam.
   * `FilesystemExtentContributor` carries each as a `realization_conditions`
   * row.
   */
  readonly unlistable: readonly DirectoryRefusal[];
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
  readonly #refusals: ListingRefusals;

  /**
   * @param root - Absolute corpus root to enumerate
   */
  constructor(root: string) {
    this.#root = root;
    this.#refusals = new ListingRefusals(root);
  }

  get unlistable(): readonly DirectoryRefusal[] {
    return this.#refusals.recorded;
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
      // The walk does not know whether a refused directory is ignored, so it
      // asks — the git arm knows from construction, and the two must agree.
      onUnreadable: this.#refusals.undetermined,
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
 * One path a half of {@link GitCrawlSource} found, before the membership rule
 * has been applied to it.
 *
 * Identical to {@link EnumeratedPath} but for the extra `'symlink'` its shape
 * may carry, and that difference is the entire point: **the two halves observe
 * symlink-ness by different means and neither may decide what to do about it.**
 * The snapshot half reads git's mode bits; the walked half `lstat`s the
 * collapsed `ls-files --others --directory` entries git spells exactly like
 * files. Each states only WHAT IT SAW, and {@link GitCrawlSource.enumerate}'s
 * `record` is the single place that acts on it.
 *
 * 🪤 Two copies of one rule is how this diverged the first time: the
 * mode-`120000` drop lived in the snapshot half alone, so a committed symlink
 * was excluded and an UNTRACKED one walked in through the prune list — under
 * four docstrings and one published `vat claude budget` limit all saying that no
 * lane emits a symlink's own path. The link and its target then realized the
 * same `contentKey` under two identities, which is a budget charging one set of
 * bytes twice.
 */
interface CrawlCandidate {
  /** Absolute, forward-slashed. */
  absolutePath: string;
  /**
   * As {@link EnumeratedPath.contentHint}, and always `null` for a symlink: its
   * OID is the TARGET STRING, which does not imply byte equality.
   */
  contentHint: string | null;
  /**
   * As {@link EnumeratedPath.shape}, plus `'symlink'` — the one value that ends
   * membership rather than describing it.
   */
  shape: PathShape | 'symlink' | null;
}

/**
 * A path some walk produced, about which nothing is known for free.
 *
 * `shape: null` is the honest answer rather than a conservative one: these come
 * from a `readdir` walk that deliberately does not report its dirent type (see
 * {@link FilesystemCrawlSource}), and `'symlink'` is not among the answers it
 * could give — that walk runs `followSymlinks: false`, so it never offers a
 * link's own path in the first place.
 *
 * @param absolutePath - The path
 * @returns A candidate carrying no claims
 */
function walkedCandidate(absolutePath: string): CrawlCandidate {
  return { absolutePath, contentHint: null, shape: null };
}

/**
 * Whether one collapsed `ls-files --others --directory` entry is a symlink.
 *
 * **The one filesystem call git's own answer does not cover.** Git marks a
 * *directory* in that listing with a trailing slash by `lstat`ing it, so a link
 * to a directory arrives spelled exactly like a file, and the listing carries no
 * mode bits at all — this is the single input to this source where membership
 * cannot be decided from what git said. One `lstat` per COLLAPSED entry buys it
 * (369 of them on the 8,496-path adopter tree the module docstring measures, not
 * one per path), and nothing is opened, read or hashed.
 *
 * **Anything this call cannot answer answers `null`, and that is deliberate.**
 * A path that vanished between the listing and this `lstat`, or one whose
 * directory lost read permission mid-run, stays a member and reaches
 * `statObservation` in `realizations.ts` — which already has a vocabulary for
 * "we could not look" (`exists: false`, every other column defaulted). Refusing
 * it here instead would delete a row on the strength of a failed syscall and say
 * nothing, which is a silently narrowed population; a symlink that got dropped
 * is the only thing this function is entitled to decide.
 *
 * @param absolutePath - The entry to inspect
 * @returns `'symlink'` when it is one, else `null`
 */
function symlinkShape(absolutePath: string): 'symlink' | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path git just listed, resolved against the repository root
    return lstatSync(absolutePath).isSymbolicLink() ? 'symlink' : null;
  } catch {
    return null;
  }
}

/**
 * Git plus a bounded walk. See the module docstring for what it may not do.
 */
export class GitCrawlSource implements CrawlSource {
  readonly kind: CrawlSourceKind = 'git';

  readonly #root: string;
  readonly #refusals: ListingRefusals;

  /**
   * @param root - Absolute corpus root, inside a git working tree
   */
  constructor(root: string) {
    this.#root = root;
    this.#refusals = new ListingRefusals(root);
  }

  get unlistable(): readonly DirectoryRefusal[] {
    return this.#refusals.recorded;
  }

  /**
   * Ask git what it can see, then walk only what it cannot.
   *
   * @returns Every admitted path, with content hints on the regular files git
   *   already hashed and shapes on everything git described rather than walked
   * @throws When git does not answer. An empty population would be
   *   indistinguishable from a repository with no files, which is the same
   *   confusion `GitExtentContributor` refuses to ship
   * @throws {DirectoryListingRefusedError} When git could not open a directory
   *   in its own territory — read off its stderr, the only place git says so
   */
  async enumerate(): Promise<readonly EnumeratedPath[]> {
    const isMember = crawlPathFilter(['**/*'], [...NEVER_CRAWL_GLOBS]);
    const admits = (absolutePath: string): boolean =>
      isMember(relativeToRoot(absolutePath, this.#root));

    const found = new Map<string, EnumeratedPath>();
    /**
     * ⚠️ **A SYMLINK IS NOT A MEMBER, and this is the ONE place THIS SOURCE
     * decides so** — for the snapshot half and the prune list, the two halves
     * that can offer one. The bounded walk cannot: it runs `followSymlinks:
     * false`, whose `processSymlink` returns before recording anything, so a
     * link's own path never reaches `record` from that lane and there is nothing
     * here for this rule to drop. That is a third decision site only in the sense
     * that it is upstream and shared with the filesystem source; it is not a copy
     * of this rule.
     *
     * Dropping it is what makes this source a re-sourcing rather than a
     * redefinition. The walk it replaces runs `followSymlinks: false`, whose
     * `processSymlink` returns before recording anything, so the filesystem
     * extent has never contained a link's own path. Git has no such notion and
     * reports one like any other entry — the divergence `file-crawler.ts`'s
     * KNOWN DIVERGENCE block describes between its own two branches. Admitting
     * them here would import that divergence into an extent that does not have
     * it, and would do it silently: the rows would look like ordinary files
     * whose bytes are a target string, and each would mint its OWN identity over
     * its TARGET's `contentKey` — one set of bytes, two billable names.
     *
     * 🪤 The observation belongs to whichever half made it ({@link
     * CrawlCandidate}); only the decision is here. Two halves each deciding for
     * themselves is exactly what shipped: mode `120000` was dropped from the
     * snapshot, nothing was dropped from the prune list, and an untracked
     * symlink was a member for as long as the two rules lived apart.
     */
    const record = (candidate: CrawlCandidate): void => {
      if (candidate.shape === 'symlink') return;
      if (found.has(candidate.absolutePath)) return;
      found.set(candidate.absolutePath, {
        absolutePath: candidate.absolutePath,
        contentHint: candidate.contentHint,
        shape: candidate.shape,
      });
    };

    // Snapshot first, because `record` is first-wins and git's entries carry a
    // content hint and a shape the walked ones cannot.
    const { members, submodules } = this.#snapshotMembers(admits);
    for (const candidate of members) record(candidate);
    for (const candidate of await this.#untrackedTerritory(admits, submodules)) record(candidate);
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
    members: CrawlCandidate[];
    submodules: string[];
  } {
    const snapshot = gitTreeSnapshot({ cwd: this.#root });
    if (snapshot === null) {
      throw new Error(
        `git did not answer for "${this.#root}" — it is not a git repository, or git could not read it.`
        + ' Returning an empty population would be indistinguishable from an empty repository, so this is an error.',
      );
    }

    const members: CrawlCandidate[] = [];
    const submodules: string[] = [];

    for (const entry of snapshot.entries) {
      // A snapshot covers the whole REPOSITORY, which may be an ancestor of the
      // corpus root. Narrowing is this caller's job — see `gitTreeSnapshot`.
      if (!isUnderRoot(entry.absolutePath, this.#root)) continue;
      if (!admits(entry.absolutePath)) continue;

      // A symlink is REPORTED here, never dropped here. This is the only code
      // that reads git's mode bits, so the observation has to be made here — but
      // the DECISION is `enumerate`'s `record`, once, for both halves. See
      // {@link CrawlCandidate} for why those are deliberately separate.
      //
      // `contentHint: null` keeps {@link EnumeratedPath.contentHint}'s invariant
      // literally true even for a candidate that never becomes one: a symlink's
      // OID is its TARGET STRING and does not imply byte equality.
      if (entry.isSymlink) {
        members.push({ absolutePath: entry.absolutePath, contentHint: null, shape: 'symlink' });
        continue;
      }

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
      // git lists no directories at all; and it is NOT A SYMLINK because every
      // mode-`120000` entry took the branch above and never reaches here.
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
   * @returns Candidates, files and directories alike, each carrying the prune
   *   list's `lstat` observation so `enumerate` can apply the one membership rule
   */
  async #untrackedTerritory(
    admits: (absolutePath: string) => boolean,
    submodules: readonly string[],
  ): Promise<CrawlCandidate[]> {
    const candidates: CrawlCandidate[] = [];

    // A submodule's own files belong to its own repository, so the outer
    // snapshot cannot see them while the outer WALK reads them like any other
    // directory. Descending is what keeps the two sources equal.
    for (const submodule of submodules) {
      candidates.push(
        walkedCandidate(submodule),
        ...(await expandDirectory(submodule, admits, this.#refusals.inPopulation)).map(walkedCandidate),
      );
    }

    // Ignored territory: descend, because the extent this feeds must still
    // report `gitignored: true` rows. `NEVER_CRAWL_GLOBS` is applied to the
    // COLLAPSED entry before descending, which is where the saving is — a
    // pruned directory is skipped by name and never entered.
    //
    // ⚠️ This is the ONLY lane that can offer a symlink `git add --all` never
    // staged: an ignored path is in no tree snapshot, so nothing upstream has
    // seen its mode. `collapsed.shape` is where that gap is closed.
    for (const collapsed of this.#prune({ ignored: true })) {
      if (!admits(collapsed.absolutePath)) continue;
      candidates.push({
        absolutePath: collapsed.absolutePath,
        contentHint: null,
        shape: collapsed.shape,
      });
      // A DIFFERENT question from membership — whether to descend — and it is
      // asked of the link rather than of its target deliberately: following one
      // would enumerate a subtree under a second name, which is the same reason
      // the walk sets `followSymlinks: false`. Git's trailing slash comes from
      // its own `lstat`, so a link never carries one and this is belt-and-braces
      // rather than a second copy of the drop.
      // A refusal met down here is inside IGNORED territory by construction —
      // recorded, never fatal. See {@link ListingRefusals}.
      if (collapsed.isDirectory && collapsed.shape !== 'symlink') {
        candidates.push(
          ...(await expandDirectory(collapsed.absolutePath, admits, this.#refusals.inIgnoredTerritory)).map(walkedCandidate),
        );
      }
    }

    // Untracked-but-not-ignored territory: the entries themselves only, never a
    // descent. Every FILE beneath such a directory is already in the snapshot
    // (`git add --all` staged it), so walking here would re-enumerate what git
    // just handed over. What this recovers is the directory entry itself —
    // including the empty ones no tree object can represent.
    //
    // 🪤 "Already in the snapshot" is why this lane needs `collapsed.shape` too,
    // not why it can skip it: `record` is first-wins, so a path the snapshot
    // supplied is a no-op here — but a path the snapshot DROPPED is not, and a
    // symlink is precisely the path it drops. Re-offering one bare is how an
    // untracked link became a member while the committed ones were excluded.
    for (const collapsed of this.#prune({ ignored: false })) {
      if (!admits(collapsed.absolutePath)) continue;
      candidates.push({
        absolutePath: collapsed.absolutePath,
        contentHint: null,
        shape: collapsed.shape,
      });
    }

    return candidates;
  }

  /**
   * One `ls-files --others --directory` listing, located and shape-tagged.
   *
   * @param options - Whether to ask for the ignored side
   * @param options.ignored - Restrict to ignored paths
   * @returns Collapsed entries under this root, each with the one property the
   *   listing cannot express — see {@link symlinkShape}
   */
  #prune(options: { ignored: boolean }): {
    absolutePath: string;
    isDirectory: boolean;
    shape: 'symlink' | null;
  }[] {
    // 🚨 git's stderr is the ONLY witness to a directory it could not open: it
    // exits 0 and lists fewer paths. Such a directory is in git's own territory
    // (it had to be opened to look for untracked files, so it is not ignored),
    // which makes every file beneath it a member absent from every count — the
    // stop-not-degrade case. `--ignored --directory` is the listing that walks
    // the same tree the snapshot did, so this is where the snapshot's own
    // refusals surface too; the not-ignored prune list opens nothing.
    const listing = gitLsOthers({
      cwd: this.#root,
      ignored: options.ignored,
      directory: true,
      onUnreadable: (refusal) => {
        if (isUnderRoot(refusal.directory, this.#root) && admitsUnderRoot(refusal.directory, this.#root)) {
          this.#refusals.inPopulation(refusal);
        }
      },
    });
    if (listing === null) return [];

    // Relative to the REPOSITORY root, like every other `ls-files` output.
    const repositoryRoot = gitFindRoot(this.#root) ?? this.#root;

    const entries: { absolutePath: string; isDirectory: boolean; shape: 'symlink' | null }[] = [];
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
        entries.push({ absolutePath, isDirectory, shape: symlinkShape(absolutePath) });
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
 * @param onUnreadable - What a refused listing beneath it means — decided by
 *   the caller, which knows whose territory this directory is in
 * @returns Every admitted path beneath it, files and directories
 */
async function expandDirectory(
  directory: string,
  admits: (absolutePath: string) => boolean,
  onUnreadable: (refusal: DirectoryRefusal) => void,
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
    onUnreadable,
  });
  // Still applied: `admits` evaluates against the CORPUS root, and it is the
  // single authority on membership for both sources.
  return found.filter((absolutePath) => admits(absolutePath));
}

/**
 * Whether {@link NEVER_CRAWL_GLOBS} admits a directory — the same question
 * `enumerate`'s `admits` asks of a path, asked of a refusal before it is raised,
 * so a locked directory under a `node_modules/` nobody walks is not a gap.
 *
 * @param absolutePath - The directory
 * @param root - The corpus root the globs are evaluated against
 * @returns True when no never-crawl glob drops it
 */
function admitsUnderRoot(absolutePath: string, root: string): boolean {
  return crawlPathFilter(['**/*'], [...NEVER_CRAWL_GLOBS])(relativeToRoot(absolutePath, root));
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
 * measured 2026-09-11 on an 8,548-file adopter tree (`vat-lab io run --command
 * resources-scan`, warm, 3 runs, both arms load-clean) the git arm costs
 * **8,760** filesystem calls against the filesystem arm's **21,684**, and 6 git
 * spawns against 1. The per-site delta closes exactly: −12,003 `lstat` in
 * `realizations` (git holds the mode bits) and −1,679 `readdir`, against +447
 * `lstat` in {@link symlinkShape} — one per collapsed `--others --directory`
 * entry, 444 distinct — plus +296 `existsSync`/`statSync` for the bounded walk
 * of ignored territory, +5 spawns and +10 for the temp index and the
 * `.git`-readability guard.
 *
 * The 447 is the whole cost of {@link symlinkShape}: bounded by the number of
 * COLLAPSED entries, not by the corpus. An earlier reading of 7,705 against
 * 18,454 (2026-08-20) predates it and was taken on a smaller tree — the arms are
 * compared against EACH OTHER at one date, never against the older pair.
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
