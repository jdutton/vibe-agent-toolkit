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

import { lstatSync } from 'node:fs';

import {
  countWork,
  followedKindSync,
  forEachInOrder,
  fsFaultOf,
  isLinkChainRefusedError,
  readTextContentSync,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import {
  crawlDirectory,
  crawlPathFilter,
  type DirectoryRefusal,
  NEVER_CONTENT_GLOBS,
  NEVER_CRAWL_GLOBS,
  settleCrawlRefusal,
  type UnreadablePolicy,
} from '@vibe-agent-toolkit/utils/crawl';
import {
  gitFindRoot,
  gitLsOthers,
  gitNoAnswerError,
  gitSnapshotAbsentEntries,
  gitSnapshotError,
  type GitTreeSnapshot,
  gitTreeSnapshot,
  isGitIgnored,
} from '@vibe-agent-toolkit/utils/git';

import type { PathShape } from './realizations.js';
import type { PopulationMembers } from './resource-population.js';

/** The key a `.git` pointer file uses to name the real gitdir. */
const GITDIR_PREFIX = 'gitdir:';

/**
 * What every resources lane tells an adopter about a refused listing — **one
 * sentence, decided per ROOT, printed by the projection's two arms and by the
 * registry's incumbent walk alike.**
 *
 * The projection enumerates every path beneath the root that
 * {@link NEVER_CRAWL_GLOBS} admits; `resources.include`/`exclude` narrow the
 * registry's view of the population, not the population. A remedy prescribing
 * that knob would be one the adopter can apply and see nothing change (it was,
 * and four spellings of it were tried) — and an adopter who HAS excluded the
 * directory is exactly who reads this, so the sentence says why that did not
 * help rather than pretending the knob does not exist.
 *
 * 🪤 **Route-aware, because "gitignore it" is a dead knob outside a
 * repository.** The projection falls back to a plain walk there
 * ({@link crawlSourceFor}) and the walk reads no ignore file, so the remedy
 * used to send a `.git`-less `vat build` to an ignore rule that changed
 * nothing. Decided from the root, not from which arm ran: inside a repository
 * both arms honour ignore rules (the filesystem arm asks `check-ignore` — see
 * {@link ListingRefusals}); outside one, neither can.
 *
 * ⚠️ Whether a locked directory REFUSES at all is a different question with a
 * standing answer: a locked gitignored directory is a warning row
 * (`EXTENT_DIRECTORY_UNLISTABLE`), never an abort; a locked non-ignored one
 * refuses by name under `'refuse'`, with THIS sentence, and under `{ degrade }`
 * is handed to the caller and left out of the population.
 *
 * @param root - The corpus root, whose repository (or lack of one) decides
 *   which knob is real
 * @returns The remedy clause the `refuse` policy appends to the refusal sentence
 */
export function listingRefusalRemedy(root: string): string {
  const knobs = 'regardless of resources.include or resources.exclude';
  if (gitFindRoot(root) === null) {
    return (
      'Fix the permissions on that directory, or move it out of the tree: with no git repository above the root '
      + `there is no ignore rule that could declare it outside the project, and the population is every path beneath the root ${knobs}.`
    );
  }
  return (
    'Fix the permissions on that directory, or — if it is not part of the project — gitignore it: '
    + `the population is every non-ignored path beneath the root ${knobs}, so only an ignore rule keeps a directory out of it.`
  );
}

/**
 * 🚨 **The projection lane STOPS on a refused listing inside the population;
 * inside ignored territory it records and continues.** Both are honest; only
 * silence is not.
 *
 * *Inside the population* — a directory git would have to open to find
 * untracked files, or a submodule's contents — every file beneath it is a
 * member that would be absent from every count, and this lane in particular
 * cannot degrade: its population is built by contributors, merged, and — when
 * a store is open — CACHED, and a cached population enumerated around a gap
 * would answer every later run with the narrowed list and no finding. The only
 * answer that cannot be mistaken for a complete one is to refuse the run, by
 * name, with {@link listingRefusalRemedy} — and the registry's incumbent walk
 * refuses the same directory with the same sentence. The two lanes do not agree
 * on every directory: with `VAT_EXTENT_SOURCE=filesystem` forced a locked,
 * unignored `coverage/lcov-report` is skipped where the git crawl refuses it
 * (`docs/contributing/known-defects.md`, "Git and crawl").
 *
 * 🔑 **Which directories the git arm refuses is decided by the membership
 * predicate itself** (`admitsGitContent`: under the root, admitted by
 * `NEVER_CONTENT_GLOBS`), the rule {@link gitContentMembers} admits members by.
 * One predicate decides both, so every directory that can hold a member
 * refuses when git cannot list it. Filtering refusals by the wider
 * `NEVER_CRAWL_GLOBS` instead dropped the refusal of an unignored, locked
 * `coverage/` whose files are members: the run ended at exit 0 without them.
 * A warm run, which never enumerates, gets the same refusal from
 * {@link GitCrawlSource.assertListable}.
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
 * ⚠️ The two arms aim at the SAME verdict for a directory, and only the git arm
 * knows from construction which territory it is walking (they differ where the
 * filesystem arm prunes tool-output names: see the known-defects entry cited
 * above). The filesystem arm therefore ASKS — `isGitIgnored`, one `check-ignore` spawn per
 * refusal, which is rare by nature and free outside a repository.
 */
class ListingRefusals {
  readonly #root: string;
  readonly #recorded: DirectoryRefusal[] = [];
  readonly #seen = new Set<string>();
  readonly #remedy: string;
  /** The caller's `degrade`, for a population that keeps going past a refusal inside it — see {@link PopulationUnreadablePolicy}. */
  readonly #degrade: ((refusal: DirectoryRefusal) => void) | null;
  /** The trees the calling verb writes: the crawl's one declaration of which side a refusal is on. */
  readonly outputs: readonly string[];

  /**
   * @param root - The corpus root a refused directory is expressed against
   * @param outputs - The trees the calling verb WRITES (its output, its staging), `[]` for none:
   *   a refused directory that is one of them, lies inside one or holds one — the root of a
   *   project a build writes into included — is the verb's destination; any other is the
   *   corpus's content, which the verb reads (`source`)
   * @param degrade - The caller's `degrade` for a refusal inside the population, or `null` to refuse
   */
  constructor(root: string, outputs: readonly string[], degrade: ((refusal: DirectoryRefusal) => void) | null) {
    this.#root = root;
    this.#remedy = listingRefusalRemedy(root);
    this.outputs = outputs;
    this.#degrade = degrade;
  }

  /** Every refusal met inside ignored territory, in the order met, once each. */
  get recorded(): readonly DirectoryRefusal[] {
    return this.#recorded;
  }

  /** The policy for a walk whose every directory is known to be in the population: refuse, on the side of the directory refused. */
  get inPopulation(): UnreadablePolicy {
    return { degrade: (refusal) => this.settleInPopulation(refusal) };
  }

  /** The policy for a walk known to be inside gitignored territory: record, continue. */
  get inIgnoredTerritory(): UnreadablePolicy {
    return { degrade: (refusal) => this.settleIgnored(refusal) };
  }

  /** Settle a refusal met inside ignored territory: recorded, never fatal (see {@link inIgnoredTerritory}). */
  settleIgnored(refusal: DirectoryRefusal): void {
    this.#record(refusal);
  }

  /**
   * The policy for a walk that does not know which territory it is in: ask
   * git, then settle under whichever of the two policies above applies. Spelled
   * `degrade` from the walk's side, because the walk must hand the refusal
   * over for the question to be asked — the refuse arm is reached through
   * {@link inPopulation} when the answer is "not ignored".
   */
  get undetermined(): UnreadablePolicy {
    return { degrade: (refusal) => this.settleUndetermined(refusal) };
  }

  /** Settle a refusal from a walk that does not know its territory: see {@link undetermined}. */
  settleUndetermined(refusal: DirectoryRefusal): void {
    if (isGitIgnored(refusal.directory, this.#root)) {
      this.#record(refusal);
      return;
    }
    this.settleInPopulation(refusal);
  }

  /**
   * Refuse a directory in the population: on what the verb writes, the destination's; anything
   * else, the corpus's content. A degrading population hands it to its caller instead.
   */
  settleInPopulation(refusal: DirectoryRefusal): void {
    if (this.#degrade !== null) {
      this.#degrade(refusal);
      return;
    }
    settleCrawlRefusal({ refuse: { root: this.#root, remedy: this.#remedy, side: 'source' } }, refusal, this.outputs);
  }

  /** Forget every refusal — called as an enumeration starts, so the list is ITS list. */
  clear(): void {
    this.#recorded.length = 0;
    this.#seen.clear();
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
   * What this source already knows the path IS, or `null` when it must be
   * stat'ed.
   *
   * **Authoritative**: a realization built from it never calls `lstat`, so a wrong answer here is a
   * wrong row rather than a slow one. Supply it only where {@link PathShape}'s
   * bar is met — present, not a symlink, and known to be a file or a directory.
   *
   * Required rather than optional, and `null` rather than absent: a new source
   * must *state* that it knows nothing, because
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
  /**
   * Every symbolic link the last {@link CrawlSource.enumerate} met and did NOT
   * offer as a member — absolute, forward-slashed, deduplicated, sorted. Empty
   * until `enumerate` has run, and replayed with it, exactly as
   * {@link CrawlSource.unlistable} is.
   *
   * ⚠️ Required, because the failure it closes is silence: a symlink is never a
   * member (*"A SYMLINK IS NOT A MEMBER"* below), so without this list a
   * `link/CLAUDE.md` Claude Code reads through the link is absent from every row
   * with nothing saying so. `FilesystemExtentContributor` carries each as an
   * declined-link condition row — `EXTENT_SYMLINK_NOT_REALIZED`, or
   * `EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT` when the target resolves outside the root, or
   * `EXTENT_SYMLINK_TARGET_UNRESOLVED` when it resolves to nothing, or
   * `EXTENT_SYMLINK_TARGET_UNREADABLE` when the OS would not resolve it. Both
   * sources report the same set for the same tree, as they do for members.
   */
  readonly symlinks: readonly string[];
}

/**
 * Collects the links a source declined, once each, in a stable order.
 *
 * One small class so both sources — and the walks inside the git source — feed
 * one list the same way; a second copy of "dedupe and sort" is where the two
 * sources would start disagreeing about order.
 */
class DeclinedSymlinks {
  readonly #seen = new Set<string>();

  /** The observer to hand a walk. */
  readonly add = (absolutePath: string): void => {
    this.#seen.add(toForwardSlash(absolutePath));
  };

  /** Forget every link — called as an enumeration starts, so the list is ITS list. */
  clear(): void {
    this.#seen.clear();
  }

  /** @returns Every link recorded, sorted */
  get recorded(): readonly string[] {
    // Code-unit order, not `localeCompare`: the host's locale must not decide it.
    return [...this.#seen].sort((left, right) => (left < right ? -1 : Number(left > right)));
  }
}

/** Which of the two implementations answered. */
export type CrawlSourceKind = 'git' | 'filesystem';

/** Each {@link CrawlSourceKind}, keyed so the compiler checks the list against the union both ways. */
const CRAWL_SOURCE_KIND_SET: Readonly<Record<CrawlSourceKind, true>> = { git: true, filesystem: true };

/** Every {@link CrawlSourceKind}, as a runtime list — for a schema enum that must not be a hand-typed copy. */
export const CRAWL_SOURCE_KINDS = Object.keys(CRAWL_SOURCE_KIND_SET) as [CrawlSourceKind, ...CrawlSourceKind[]];

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
  readonly #symlinks = new DeclinedSymlinks();

  /**
   * @param root - Absolute corpus root to enumerate
   * @param outputs - The trees the verb writes (see {@link crawlSourceFor})
   */
  constructor(root: string, outputs: readonly string[]) {
    this.#root = root;
    this.#refusals = new ListingRefusals(root, outputs, null);
  }


  get unlistable(): readonly DirectoryRefusal[] {
    return this.#refusals.recorded;
  }

  get symlinks(): readonly string[] {
    return this.#symlinks.recorded;
  }

  /**
   * Walk the root.
   *
   * @returns Every admitted path, with no shapes
   */
  async enumerate(): Promise<readonly EnumeratedPath[]> {
    this.#refusals.clear();
    this.#symlinks.clear();
    const absolutePaths = await crawlDirectory({
      baseDir: this.#root,
      outputs: this.#refusals.outputs,
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
      // Declined, never dropped: see `CrawlSource.symlinks`.
      onSymlinkNotFollowed: this.#symlinks.add,
      // Directories are resources, not merely containers of them.
      filesOnly: false,
      // The whole point of the extent this feeds: build output git cannot see.
      respectGitignore: false,
      // The walk does not know whether a refused directory is ignored, so it
      // asks — the git arm knows from construction, and the two must agree.
      unreadable: this.#refusals.undetermined,
    });

    // `shape: null` even though `crawlDirectory` walked with `readdir`, which
    // does carry a dirent type. Supplying it here would erase the asymmetry the
    // module docstring describes, and it is not this change's measurement to
    // take: the walk is the incumbent, its cost is the baseline every git-source
    // number is quoted against, and moving both arms at once leaves neither
    // attributable. It remains available if it is ever wanted for its own sake.
    return absolutePaths.map((absolutePath) => ({
      absolutePath,
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
 * four docstrings and one published `vat claude context` limit all saying that no
 * lane emits a symlink's own path. The link and its target then realized the
 * same `contentKey` under two identities, which is a launch total charging one set
 * of bytes twice.
 */
interface CrawlCandidate {
  /** Absolute, forward-slashed. */
  absolutePath: string;
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
  return { absolutePath, shape: null };
}

/**
 * Append a walk's paths as candidates. One at a time, never a spread: `push(...walked)` is an argument list, which throws `Maximum call stack size exceeded` past roughly 125,000 entries, and a walk is unbounded. A gitignored `.venv` holds 200,000.
 */
function appendWalked(candidates: CrawlCandidate[], walked: readonly string[]): void {
  for (const absolutePath of walked) candidates.push(walkedCandidate(absolutePath));
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
    return lstatSync(absolutePath).isSymbolicLink() ? 'symlink' : null;
  } catch (error) {
    // The filesystem would not answer: the entry stays a member and
    // `statObservation` reports what it can (see above). A bug is not that.
    if (fsFaultOf(error) === undefined) throw error;
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
  readonly #symlinks = new DeclinedSymlinks();

  /**
   * @param root - Absolute corpus root, inside a git working tree
   * @param outputs - The trees the verb writes (see {@link crawlSourceFor})
   */
  constructor(root: string, outputs: readonly string[]) {
    this.#root = root;
    this.#refusals = new ListingRefusals(root, outputs, null);
  }


  get unlistable(): readonly DirectoryRefusal[] {
    return this.#refusals.recorded;
  }

  get symlinks(): readonly string[] {
    return this.#symlinks.recorded;
  }

  /**
   * Ask git what it can see, then walk only what it cannot.
   *
   * @returns Every admitted path, with shapes on everything git described
   *   rather than walked
   * @throws When git does not answer. An empty population would be
   *   indistinguishable from a repository with no files, which is the same
   *   confusion `GitExtentContributor` refuses to ship
   * @throws {DirectoryListingRefusedError} When git could not open a directory
   *   in its own territory — read off its stderr, the only place git says so
   */
  async enumerate(): Promise<readonly EnumeratedPath[]> {
    this.#refusals.clear();
    this.#symlinks.clear();
    const isMember = crawlPathFilter(['**/*'], [...NEVER_CRAWL_GLOBS]);
    const admits = (absolutePath: string): boolean =>
      isMember(relativeToRoot(absolutePath, this.#root));
    // Git's OWN territory — tracked, or untracked and not ignored — drops only
    // what can never be content. A `coverage/` or `.turbo/` git holds is one the
    // author committed (`references/coverage/workers-comp.md`); the tool-output
    // names in NEVER_CRAWL_GLOBS exist to prune IGNORED territory, which `admits`
    // still does. The same predicate `gitContentMembers` admits by.
    const admitsContent = (absolutePath: string): boolean => admitsGitContent(absolutePath, this.#root);

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
      // Declined as a member, RECORDED as a link — see `CrawlSource.symlinks`.
      if (candidate.shape === 'symlink') {
        this.#symlinks.add(candidate.absolutePath);
        return;
      }
      if (found.has(candidate.absolutePath)) return;
      found.set(candidate.absolutePath, {
        absolutePath: candidate.absolutePath,
        shape: candidate.shape,
      });
    };

    // Snapshot first, because `record` is first-wins and git's entries carry a
    // shape the walked ones cannot.
    const { files, symlinks, submodules } = snapshotGitContentMembers(this.#root);
    // `shape: 'file'` on all three counts, each from the snapshot rather than
    // from a stat — see {@link gitContentMembers}. A symlink is REPORTED as one
    // and declined by `record`, the one decision for both halves.
    for (const absolutePath of files) record({ absolutePath, shape: 'file' });
    for (const absolutePath of symlinks) record({ absolutePath, shape: 'symlink' });
    for (const candidate of await this.#untrackedTerritory(admits, admitsContent, submodules)) record(candidate);
    // Last, so an ancestor already recorded by the snapshot as a FILE is not
    // relabelled. `shape` is unconditionally `'directory'`, which is sound
    // because these paths were DERIVED from the names of paths git or the walk
    // found beneath them: a path exists only if its ancestors do, and neither
    // git nor a `followSymlinks: false` walk reports anything beneath a symlink,
    // so no ancestor reached here can be one.
    for (const absolutePath of ancestorDirectories([...found.keys()], this.#root)) {
      record({ absolutePath, shape: 'directory' });
    }

    return [...found.values()];
  }

  /**
   * Refuse every directory git's own listing cannot open, when it can hold a
   * member — for a run that never enumerates (its extent served from the
   * store), so the crawl's own refusal never ran.
   *
   * Runs the cold crawl's ignored-side prune listing once, for its stderr alone,
   * under the same settle filter ({@link admitsGitContent}); its entries are
   * discarded. A store hit is keyed by a snapshot that `git add --all` took
   * around a directory it could not open, so a file created there since is in no
   * key, and only this listing can witness the gap. Counted as one `git.listings`.
   *
   * @throws {DirectoryListingRefusedError} For an unlistable directory under the
   *   root that {@link admitsGitContent} admits (`FS_FAULT`, naming it)
   * @throws When git did not answer the listing at all
   */
  assertListable(): void {
    countWork('git.listings', 1);
    this.#listOthers({ ignored: true });
  }

  /**
   * Everything git deliberately does not hold: the ignored half, plus the
   * directories that exist without containing anything.
   *
   * @param admits - The shipped include/exclude decision, for ignored territory
   * @param admitsContent - The decision for git's own territory: only what can never be content is dropped
   * @param submodules - Directories the snapshot named but did not describe
   * @returns Candidates, files and directories alike, each carrying the prune
   *   list's `lstat` observation so `enumerate` can apply the one membership rule
   */
  async #untrackedTerritory(
    admits: (absolutePath: string) => boolean,
    admitsContent: (absolutePath: string) => boolean,
    submodules: readonly string[],
  ): Promise<CrawlCandidate[]> {
    const candidates: CrawlCandidate[] = [];

    // A submodule's own files belong to its own repository, so the outer
    // snapshot cannot see them while the outer WALK reads them like any other
    // directory. Descending is what keeps the two sources equal.
    //
    // In order, here and below: the refusal collectors and symlink set are shared,
    // candidate order must be deterministic, and one listing at a time bounds fds.
    await forEachInOrder(submodules, async (submodule) => {
      candidates.push(walkedCandidate(submodule));
      appendWalked(candidates, await expandDirectory(submodule, admits, this.#refusals, 'inPopulation', this.#symlinks.add));
    });

    // Ignored territory: descend, because the extent this feeds must still
    // report `gitignored: true` rows. `NEVER_CRAWL_GLOBS` is applied to the
    // COLLAPSED entry before descending, which is where the saving is — a
    // pruned directory is skipped by name and never entered.
    //
    // ⚠️ This is the ONLY lane that can offer a symlink `git add --all` never
    // staged: an ignored path is in no tree snapshot, so nothing upstream has
    // seen its mode. `collapsed.shape` is where that gap is closed.
    //
    // One of the run's two prune listings, and not the same work as the other: `--ignored` lists
    // only ignored paths and the listing below only untracked paths git does not ignore, two
    // disjoint answers, and `ls-files` has no mode that gives both in one spawn.
    await forEachInOrder(this.#prune({ ignored: true }), async (collapsed) => {
      if (!admits(collapsed.absolutePath)) return;
      candidates.push({
        absolutePath: collapsed.absolutePath,
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
        appendWalked(candidates, await expandDirectory(collapsed.absolutePath, admits, this.#refusals, 'inIgnoredTerritory', this.#symlinks.add));
      }
    });

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
    //
    // The second prune listing: the ignored listing above cannot answer this, since `--ignored`
    // leaves out exactly the untracked-not-ignored paths asked for here.
    for (const collapsed of this.#prune({ ignored: false })) {
      if (!admitsContent(collapsed.absolutePath)) continue;
      candidates.push({
        absolutePath: collapsed.absolutePath,
        shape: collapsed.shape,
      });
    }

    return candidates;
  }

  /**
   * One raw `ls-files --others --directory` listing, its refusals settled: a
   * directory git could not open refuses the run when it is under the root and
   * {@link admitsGitContent} admits it — the membership predicate, so every
   * directory that can hold a member refuses when unlistable, `coverage/` and
   * the other tool-output names included.
   *
   * @param options - Whether to ask for the ignored side
   * @param options.ignored - Restrict to ignored paths
   * @returns Paths relative to this root, as git prints them
   * @throws {DirectoryListingRefusedError} For such a directory
   * @throws When git did not answer
   */
  #listOthers(options: { ignored: boolean }): string[] {
    const listing = gitLsOthers({
      cwd: this.#root,
      ignored: options.ignored,
      directory: true,
      unreadable: {
        degrade: (refusal) => {
          if (admitsGitContent(refusal.directory, this.#root)) this.#refusals.settleInPopulation(refusal);
        },
      },
    });
    // Refused, never read as "nothing there": a listing git did not answer is
    // indistinguishable from a tree with nothing untracked, and the listing
    // lane refuses the same silence (see `gitListed`).
    if (listing === null) throw gitNoAnswerError(this.#root, NO_GIT_LISTING_CONSEQUENCE);
    return listing;
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
    // refusals surface too. The not-ignored prune list collapses a WHOLLY
    // untracked directory without opening it, but it does open a locked
    // directory that holds tracked files (looking for untracked siblings) and
    // warns on that one — the same refusal the ignored listing, which runs
    // first, has already refused the run for, so it never gets a second turn.
    const listing = this.#listOthers(options);

    // Relative to `cwd`, this root, as git prints every `ls-files` path: never
    // to the repository root, which a subdirectory root is not.

    const entries: { absolutePath: string; isDirectory: boolean; shape: 'symlink' | null }[] = [];
    for (const relativePath of listing) {
      // git marks a collapsed directory with a trailing slash. That is the only
      // signal distinguishing "this whole subtree" from "this one file", so it
      // is read before being resolved away.
      const isDirectory = relativePath.endsWith('/');
      const absolutePath = safePath.resolve(
        this.#root,
        isDirectory ? relativePath.slice(0, -1) : relativePath,
      );
      if (isPathUnderRoot(absolutePath, this.#root)) {
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
 * @param unreadable - What a refused listing beneath it means — decided by
 *   the caller, which knows whose territory this directory is in
 * @returns Every admitted path beneath it, files and directories
 */
async function expandDirectory(
  directory: string,
  admits: (absolutePath: string) => boolean,
  refusals: ListingRefusals,
  territory: 'inPopulation' | 'inIgnoredTerritory',
  onSymlink: (absolutePath: string) => void,
): Promise<string[]> {
  const unreadable: UnreadablePolicy = refusals[territory];
  const found = await crawlDirectory({
    outputs: refusals.outputs,
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
    // A link met down here is declined exactly as the snapshot's are, and
    // recorded the same way — under the same `admits` decision as a member.
    onSymlinkNotFollowed: (absolutePath) => {
      if (admits(absolutePath)) onSymlink(absolutePath);
    },
    filesOnly: false,
    // Already inside ignored territory by construction, so consulting git again
    // would return nothing and cost a spawn.
    respectGitignore: false,
    unreadable,
  });
  // Still applied: `admits` evaluates against the CORPUS root, and it is the
  // single authority on membership for both sources.
  return found.filter((absolutePath) => admits(absolutePath));
}

/** {@link NEVER_CONTENT_GLOBS} as one root-relative filter, compiled once. */
const isGitContentPath = crawlPathFilter(['**/*'], [...NEVER_CONTENT_GLOBS]);

/**
 * **The git-content predicate: one rule for membership and for refusal.** A path
 * is git content's to hold when it lies under the root and {@link
 * NEVER_CONTENT_GLOBS} admits it (`node_modules`, `.git`, worktrees and a
 * build's residue are never content; `coverage/`, `.turbo/` and the other
 * tool-output names are, where git holds them).
 *
 * {@link gitContentMembers} admits each snapshot entry by it, and every git
 * listing settles a directory it could not open by it, so a directory that can
 * hold a member refuses the run when unlistable instead of running short. A
 * refusal filtered by the wider {@link NEVER_CRAWL_GLOBS} dropped exactly the
 * directories (`coverage/`) whose files this predicate admits.
 *
 * @param absolutePath - The path, absolute and forward-slashed
 * @param root - The corpus root the globs are evaluated against
 * @returns True when the path is under the root and can be git content
 */
function admitsGitContent(absolutePath: string, root: string): boolean {
  return isPathUnderRoot(absolutePath, root) && isGitContentPath(relativeToRoot(absolutePath, root));
}

/** What {@link gitContentMembers} returns: absolute, forward-slashed paths, in snapshot order. */
export interface GitContentMembers {
  /** Regular files: git content proper. */
  readonly files: readonly string[];
  /** Mode-`120000` entries: git content too (one listed name; nothing beneath a directory link). */
  readonly symlinks: readonly string[];
  /** Gitlinks (mode `160000`): a nested repository's directory, never a file. */
  readonly submodules: readonly string[];
}

/**
 * **Git content: the one membership function.** The git crawl derives its
 * snapshot half from it, and the `git_content` relation is its `files` plus
 * `symlinks`; there is no second definition.
 *
 * Pure: it reads the snapshot and the absent-entry set it is handed and touches
 * neither git nor the disk. Its contract:
 *
 * - **Under the root only.** A snapshot covers the whole repository, which may
 *   be an ancestor of the analysis root.
 * - **Admitted by {@link NEVER_CONTENT_GLOBS}** ({@link admitsGitContent}),
 *   applied to EVERY entry before it is classified, so the `submodules` returned
 *   are already filtered and a consumer filters nothing again.
 * - **Minus absent skip-worktree entries** (a sparse checkout's files): the
 *   snapshot lists them with their staged bytes, but nothing is on disk.
 * - **Gitlinks are `submodules`, never files**: a submodule's OID is a commit
 *   and none of its files appear in the outer snapshot.
 *
 * Every other entry is a present file: the snapshot is `git add --all` into a
 * throwaway index, which stages deletions, so a tracked file removed from the
 * worktree is absent rather than stale; a tree object records no directories;
 * and every mode-`120000` entry is a symlink.
 *
 * @param snapshot - The run's snapshot (`gitTreeSnapshot`)
 * @param absent - Its skip-worktree entries absent from disk (`gitSnapshotAbsentEntries`)
 * @param root - The analysis root, absolute
 * @returns The members under the root
 */
export function gitContentMembers(
  snapshot: GitTreeSnapshot,
  absent: ReadonlySet<string>,
  root: string,
): GitContentMembers {
  const files: string[] = [];
  const symlinks: string[] = [];
  const submodules: string[] = [];
  for (const entry of snapshot.entries) {
    if (!admitsGitContent(entry.absolutePath, root) || absent.has(entry.absolutePath)) continue;
    if (entry.isSymlink) symlinks.push(entry.absolutePath);
    else if (entry.isSubmodule) submodules.push(entry.absolutePath);
    else files.push(entry.absolutePath);
  }
  return { files, symlinks, submodules };
}

/**
 * {@link gitContentMembers} over the run's memoized snapshot of the repository `root` is in: the git
 * crawl's snapshot half and the `git_content` relation both read it, so neither takes a snapshot of
 * its own (inside a `withGitSnapshotCache` bracket, the snapshot and its flag listing are each taken
 * once per repository for the whole run).
 *
 * @param root - The analysis root, absolute
 * @returns The members under the root
 * @throws When git could not answer at all, coded by cause as the one classifier decides (see
 *   `gitSnapshotFailureOf`): an empty answer would be indistinguishable from an empty repository
 */
export function snapshotGitContentMembers(root: string): GitContentMembers {
  const snapshot = gitTreeSnapshot({ cwd: root });
  if (!snapshot.ok) {
    // Classified by the one classifier `changed_files` uses too, so each cause
    // — a missing binary, an unreadable file, a stray sparse path — carries
    // one code in every lane, never "not a repository" by default.
    throw gitSnapshotError(
      snapshot,
      'Returning an empty population would be indistinguishable from an empty repository, so this is an error.',
    );
  }

  // From the tree key's own flag listing, so no second spawn inside the run's
  // snapshot bracket, and no file is read.
  const absent = gitSnapshotAbsentEntries({ cwd: root, snapshot });
  if ('ok' in absent) {
    throw gitSnapshotError(
      absent,
      'Without the index flags a sparse checkout\'s absent files would be members, so this is an error.',
    );
  }

  return gitContentMembers(snapshot, absent, root);
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
 * Whether a path lies strictly beneath a root — lexically, over already
 * canonical paths. Not the utils `isPathUnderRoot(root, candidate)` sink helper
 * (which asks the filesystem, and takes its arguments the other way round);
 * the two are named apart so an import swap cannot silently invert them.
 *
 * @param absolutePath - Path to test
 * @param root - Root it must be under
 * @returns True when the path is a strict descendant
 */
function isPathUnderRoot(absolutePath: string, root: string): boolean {
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
 * An environment switch rather than a config field: it selects which INSTRUMENT
 * runs, not what the project means, and it has to be reachable from the lab, which spawns the binary
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
 * measured on an 8,548-file adopter tree (`vat-lab io run --command
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
 * 18,454 predates it and was taken on a smaller tree — the arms are
 * compared against EACH OTHER in one run, never against the older pair.
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
 * @param outputs - The trees the verb WRITES — its output and the staging it builds that output
 *   in — or `[]` for a verb that only reads: the one declaration of which side a fault is on.
 *   Required: only the caller knows. A directory the walk could not list that is one of them,
 *   lies inside one or holds one (the root of a project a build writes into included) is the
 *   verb's destination; any other is the corpus's content, a source. The git arm's base is
 *   answered by git's own snapshot, classified there
 * @returns The selected source — {@link GitCrawlSource} inside a repository,
 *   {@link FilesystemCrawlSource} outside one or when
 *   {@link EXTENT_SOURCE_FILESYSTEM} is asked for. The fallback is not a
 *   preference: a root outside git has no git answer, and failing there would
 *   make the default unusable across a mixed corpus
 */
export function crawlSourceFor(root: string, outputs: readonly string[]): CrawlSource {
  if (gitExtentSelected(root)) {
    return new GitCrawlSource(root, outputs);
  }
  return new FilesystemCrawlSource(root, outputs);
}

/**
 * What a population does with a directory inside it that cannot be listed — the
 * CALLER's decision, because the two standing rulings are per-verb and both stand:
 *
 * - `'refuse'` — STOP, by name, with {@link listingRefusalRemedy}'s sentence: the
 *   ruling for every verb whose output is acted on as a complete population.
 * - `{ degrade }` — KEEP GOING with the readable remainder and hand the refusal
 *   over: the ruling for `vat audit`, where status describes what was found and
 *   exit describes whether the run completed. The caller is promising to REPORT
 *   the gap (audit files `SCAN_PATH_UNREADABLE` on the directory), not to drop it.
 *   A refusal policy and nothing else: a degraded population is enumerated by the
 *   same source a refusing one is ({@link crawlSourceFor}), so `vat audit` and
 *   `vat skills validate` see the same files of one tree. It is never stored: the
 *   store's key cannot say which directories were left out.
 */
export type PopulationUnreadablePolicy = 'refuse' | Extract<UnreadablePolicy, { degrade: unknown }>;

/** One name a {@link RootListing} holds: its two spellings, and its shape once observed. */
interface ListedName {
  /** Absolute, forward-slashed. */
  readonly absolutePath: string;
  /** Relative to the listing's root, forward-slashed: what a member filter is asked. */
  readonly relativePath: string;
  /**
   * What the path is: `undefined` until a crawl admits it and it is `lstat`ed
   * ({@link observedShape}), `null` where the realization must stat it.
   */
  shape: PathShape | 'symlink' | 'absent' | null | undefined;
}

/** A directory a {@link RootListing} could not list, and whose territory it is in. */
interface ListedRefusal {
  readonly refusal: DirectoryRefusal;
  /**
   * `population`: known to be in it (git opened it, or it is inside a nested
   * repository); `ignored`: met walking a directory git ignores; `undetermined`:
   * a walk met it, so ask git.
   */
  readonly territory: 'population' | 'ignored' | 'undetermined';
}

/** What one listing found: its names, the links it declined, and the directories it could not list. */
interface Listed {
  readonly names: readonly ListedName[];
  readonly links: readonly ListedName[];
  readonly refusals: readonly ListedRefusal[];
  /**
   * The ignored directories git collapsed, NOT yet walked: walked for their
   * refusals only when a crawl reports them (`PopulationMembers.ignoredRefusals`).
   */
  readonly ignoredDirectories: readonly string[];
}

/** What a {@link RootListing} asks git, each answered once per run by its caller. */
interface RootListingGit {
  /** The root's names, its `GitTracker` listing, or `null` when git did not answer. */
  readonly names: () => Promise<readonly string[] | null>;
  /** The tracked links its checkout wrote as plain files (`gitLinksCheckedOutAsFiles`), read once per listed root, or `null` when git did not answer. */
  readonly linksCheckedOutAsFiles: () => ReadonlySet<string> | null;
}

/** The sentence a listing with no git answer refuses with. */
const NO_GIT_LISTING_CONSEQUENCE =
  'Returning an empty population would be indistinguishable from an empty repository, so this is an error.';

/** The sentence a listing refuses with when git would not say which tracked links its checkout wrote as files. */
const NO_LINKS_AS_FILES_CONSEQUENCE = 'Without core.symlinks and the index, a link checked out as a plain file would be read as a member.';

/**
 * Which declined links are a crawl's business: every one not under an excluded
 * path. Only the exclude half of the crawl's globs applies — a DIRECTORY link
 * matches no `**\/*.md` include by its own name, yet may hold members
 * (`.claude/rules/shared -> ~/shared-rules`) — and an excluded `vendor/CLAUDE.md`
 * link is no more the crawl's business than an excluded file. The one rule, for
 * the registry over any population and for a listing's own view.
 *
 * @param exclude - The crawl's exclude globs
 * @returns Whether a declined link at a root-relative path is reported
 */
export function declinedLinkApplies(exclude: readonly string[]): (relativePath: string) => boolean {
  return crawlPathFilter(['**/*'], [...exclude]);
}

/**
 * One root's NAMES, listed once per run and narrowed per crawl: the enumerator
 * of a population with no store, which reads, hashes and opens no file.
 *
 * ## Why a listing is names only
 *
 * A stored population reads and keys every file so that the store answers the
 * next run; a root with no store has no next run, so it pays for names alone.
 * Inside a repository the names are git's own `ls-files --cached --others
 * --exclude-standard`, the root's `GitTracker` listing, which the ignore oracle
 * holds already. Never a tree snapshot: a snapshot is `git add --all` into a
 * throwaway index, which reads and hashes every untracked file and fails the
 * whole listing on one file the OS will not let git read. Outside a repository
 * the names are one walk of the root, pruning {@link NEVER_CRAWL_GLOBS}.
 *
 * ## The same conditions as a stored population
 *
 * Each git name is `lstat`ed once: a tracked file deleted from the working tree
 * is dropped, a link is declined, and a directory (git names one only for a
 * nested repository or submodule) is walked for its refusals, as a stored
 * population walks it. Git's `ls-files --others --ignored --directory`, asked
 * by the listing itself and never read off the tracker (a tracker initialized
 * from an open snapshot asked git nothing), opens every directory git does not
 * ignore, so its stderr names each one it could not list; and each ignored
 * directory it collapses, outside {@link NEVER_CRAWL_GLOBS}, is walked for its
 * refusals, as a stored population walks it, the first time a crawl that
 * reports them asks (`PopulationMembers.ignoredRefusals`) and never for a crawl
 * that drops them: that walk exists for those rows alone, and a gitignored
 * `.venv` makes it the largest cost a listing has. Those two walks collect no
 * names and no links:
 * everything beneath an ignored directory or a nested repository is ignored,
 * and every lane a listing serves (the resources registry, with no store)
 * declines an ignored link without a row (`DECLINE_IGNORED`). A lane that
 * reports ignored links, as the marketplace inventory does, enumerates a stored
 * population, never a listing. A listing therefore refuses, records and
 * declines what the stored population of the same tree does, with the store on
 * or off, for a crawl that records ignored-territory refusals; a crawl that drops
 * them gets the same members, links and in-population refusals, and no
 * ignored-territory rows.
 *
 * A tracked link a `core.symlinks=false` checkout wrote as a plain file is a
 * declined link, as the stored population's snapshot keeps it
 * (`gitLinksCheckedOutAsFiles`).
 *
 * {@link RootListing.narrowed} is one crawl's view: its member filter applied to
 * the names, its refusals settled under that crawl's
 * {@link PopulationUnreadablePolicy}, and its declined links those
 * {@link declinedLinkApplies} keeps.
 *
 * ⚠️ Not a full population: an EMPTY untracked directory, which no listing
 * names, is not a member.
 */
export class RootListing {
  /** The enumerator that listed the names. */
  readonly kind: CrawlSourceKind;
  readonly #root: string;
  readonly #outputs: readonly string[];
  readonly #listed: Listed;
  /** The ignored directories' refusals, walked once, on the first crawl that reports them. */
  #ignoredRefusals: Promise<readonly ListedRefusal[]> | undefined;

  private constructor(kind: CrawlSourceKind, root: string, outputs: readonly string[], listed: Listed) {
    this.kind = kind;
    this.#root = root;
    this.#outputs = outputs;
    this.#listed = listed;
  }

  /**
   * List a root: git's names where {@link gitExtentSelected} holds, else one walk.
   *
   * @param root - Absolute root to list
   * @param outputs - The trees the calling verb writes (see {@link crawlSourceFor})
   * @param git - What to ask git, asked only when git is selected
   * @returns The root's names
   * @throws When git is selected and did not answer, coded by cause
   */
  static async of(root: string, outputs: readonly string[], git: RootListingGit): Promise<RootListing> {
    if (!gitExtentSelected(root)) return RootListing.#walked(root, outputs);
    const names = await git.names();
    if (names === null) throw gitNoAnswerError(root, NO_GIT_LISTING_CONSEQUENCE);
    const linksAsFiles = git.linksCheckedOutAsFiles();
    if (linksAsFiles === null) throw gitNoAnswerError(root, NO_LINKS_AS_FILES_CONSEQUENCE);
    return new RootListing('git', root, outputs, await gitListed(root, outputs, names, linksAsFiles));
  }

  /** One walk of `root`, pruning what a crawl never enters. */
  static async #walked(root: string, outputs: readonly string[]): Promise<RootListing> {
    const named = new NameSet(root);
    const links = new NameSet(root);
    const refusals: ListedRefusal[] = [];
    const found = await walkNames(root, outputs, (link) => links.add(link, 'symlink'), (refusal) => {
      refusals.push({ refusal, territory: 'undetermined' });
    });
    for (const absolutePath of found) named.add(absolutePath, null);
    return new RootListing('filesystem', root, outputs, { names: named.names, links: links.names, refusals, ignoredDirectories: [] });
  }

  /** The refusals inside the ignored directories git collapsed, walked once per listing. */
  #walkIgnored(): Promise<readonly ListedRefusal[]> {
    this.#ignoredRefusals ??= (async () => {
      const refusals: ListedRefusal[] = [];
      await forEachInOrder(this.#listed.ignoredDirectories, async (directory) => {
        await walkRefusals(directory, this.#outputs, (refusal) => refusals.push({ refusal, territory: 'ignored' }));
      });
      return refusals;
    })();
    return this.#ignoredRefusals;
  }

  /**
   * One crawl's view of the names.
   *
   * @param members - The crawl's globs, relative to the root, and whether it reports ignored-territory refusals
   * @param unreadable - What a directory the listing could not list does for this crawl
   * @returns A source over the crawl's members alone
   */
  narrowed(members: PopulationMembers, unreadable: PopulationUnreadablePolicy): CrawlSource {
    const admits = crawlPathFilter([...members.include], [...members.exclude]);
    const linkApplies = declinedLinkApplies(members.exclude);
    const refusals = new ListingRefusals(this.#root, this.#outputs, unreadable === 'refuse' ? null : unreadable.degrade);
    const symlinks = new DeclinedSymlinks();
    const { names, links, refusals: listed } = this.#listed;
    const ignored = members.ignoredRefusals === 'record' ? (): Promise<readonly ListedRefusal[]> => this.#walkIgnored() : null;
    return {
      kind: this.kind,
      // Async, so a refusal is a rejection, never a throw.
      enumerate: async () => {
        refusals.clear();
        symlinks.clear();
        for (const { refusal, territory } of listed) settleListed(refusals, refusal, territory);
        for (const { refusal, territory } of ignored === null ? [] : await ignored()) settleListed(refusals, refusal, territory);
        for (const link of links) {
          if (linkApplies(link.relativePath)) symlinks.add(link.absolutePath);
        }
        return admittedMembers(names, admits);
      },
      get unlistable() {
        return refusals.recorded;
      },
      get symlinks() {
        return symlinks.recorded;
      },
    };
  }
}

/** Settle one refusal a listing recorded, under the territory it was met in. */
function settleListed(refusals: ListingRefusals, refusal: DirectoryRefusal, territory: ListedRefusal['territory']): void {
  if (territory === 'population') refusals.settleInPopulation(refusal);
  else if (territory === 'ignored') refusals.settleIgnored(refusal);
  else refusals.settleUndetermined(refusal);
}

/**
 * What git's names under `root` hold, `lstat`ed once each, with each nested
 * repository walked for its refusals (in population) as a stored population
 * walks it, and each collapsed ignored directory named for
 * {@link RootListing}'s walk on demand.
 *
 * @param root - The listed root, inside a repository
 * @param outputs - The trees the calling verb writes
 * @param gitNames - The tracker's names, absolute
 * @param linksAsFiles - Tracked links the checkout wrote as plain files
 * @returns The names, links, refusals and ignored directories
 * @throws When git does not answer the ignored listing
 */
async function gitListed(
  root: string,
  outputs: readonly string[],
  gitNames: readonly string[],
  linksAsFiles: ReadonlySet<string>,
): Promise<Listed> {
  const isCrawled = crawlPathFilter(['**/*'], [...NEVER_CRAWL_GLOBS]);
  const named = new NameSet(root);
  const links = new NameSet(root);
  const repositories: string[] = [];
  for (const absolutePath of gitNames) {
    if (!admitsGitContent(absolutePath, root)) continue;
    const observed = lstatShape(absolutePath);
    if (observed === 'absent') continue;
    // git's own rule, which the stored population's snapshot applies: with
    // `core.symlinks=false` a tracked link is a plain file on disk and still a
    // link in the index, so it is declined, not a member.
    const shape = observed === 'file' && linksAsFiles.has(absolutePath) ? 'symlink' : observed;
    if (shape === 'symlink') {
      links.add(absolutePath, shape);
      continue;
    }
    if (shape === 'directory') repositories.push(absolutePath);
    named.add(absolutePath, shape);
  }
  named.addAncestors();

  const refusals: ListedRefusal[] = [];
  // Every directory git does not ignore is opened for this listing, so its
  // stderr is the one witness to each it could not open, however the tracker
  // was initialized.
  const collapsed = gitLsOthers({
    cwd: root,
    ignored: true,
    directory: true,
    unreadable: {
      degrade: (refusal) => {
        if (admitsGitContent(refusal.directory, root)) {
          refusals.push({ refusal, territory: 'population' });
        }
      },
    },
  });
  if (collapsed === null) throw gitNoAnswerError(root, NO_GIT_LISTING_CONSEQUENCE);
  const ignored = collapsed
    .filter((relativePath) => relativePath.endsWith('/'))
    // Relative to `cwd`, this root, as git prints it: never to the repository root.
    .map((relativePath) => safePath.resolve(root, relativePath.slice(0, -1)))
    .filter((directory) => isPathUnderRoot(directory, root) && isCrawled(relativeToRoot(directory, root)) && lstatShape(directory) === 'directory');

  await forEachInOrder(repositories, async (directory) => {
    await walkRefusals(directory, outputs, (refusal) => refusals.push({ refusal, territory: 'population' }));
  });
  return { names: named.names, links: links.names, refusals, ignoredDirectories: ignored };
}

/** The names a crawl admits, as members: an absent name dropped. */
function admittedMembers(names: readonly ListedName[], admits: (relativePath: string) => boolean): EnumeratedPath[] {
  const members: EnumeratedPath[] = [];
  for (const name of names) {
    if (!admits(name.relativePath)) continue;
    const shape = observedShape(name);
    // A link is never a member; every name that is one was declined when listed.
    if (shape === 'absent' || shape === 'symlink') continue;
    members.push({ absolutePath: name.absolutePath, shape });
  }
  return members;
}

/** Names under one root, deduplicated, the first shape kept. */
class NameSet {
  readonly #root: string;
  /** The root as every name beneath it starts, forward-slashed with its trailing slash. */
  readonly #prefix: string;
  readonly #byPath = new Map<string, ListedName>();

  constructor(root: string) {
    this.#root = root;
    this.#prefix = `${toForwardSlash(safePath.resolve(root))}/`;
  }

  get names(): ListedName[] {
    return [...this.#byPath.values()];
  }

  readonly add = (absolutePath: string, shape: ListedName['shape']): void => {
    const normalized = toForwardSlash(absolutePath);
    if (this.#byPath.has(normalized)) return;
    // Every name is beneath the root, so its relative spelling is a slice: one
    // `path.relative` per name was a measurable share of listing 20,000 names.
    const relativePath = normalized.startsWith(this.#prefix)
      ? normalized.slice(this.#prefix.length)
      : relativeToRoot(normalized, this.#root);
    this.#byPath.set(normalized, { absolutePath: normalized, relativePath, shape });
  };

  /**
   * Every directory the names imply, `lstat`ed only when a crawl admits one: a
   * name git listed may be a tracked file deleted from the working tree, and its
   * directory with it.
   */
  addAncestors(): void {
    for (const directory of ancestorDirectories([...this.#byPath.keys()], this.#root)) this.add(directory, undefined);
  }
}

/**
 * A walk of `directory` for names alone, pruning {@link NEVER_CRAWL_GLOBS}: no
 * file opened, each link declined to `onLink`.
 *
 * @param directory - The directory to walk
 * @param outputs - The trees the calling verb writes
 * @param onLink - Receives each link met
 * @param onRefusal - Receives each directory the walk could not list
 * @returns Every path the walk found, files and directories
 */
function walkNames(
  directory: string,
  outputs: readonly string[],
  onLink: (absolutePath: string) => void,
  onRefusal: (refusal: DirectoryRefusal) => void,
): Promise<string[]> {
  return crawlDirectory({
    baseDir: directory,
    outputs,
    exclude: [...NEVER_CRAWL_GLOBS],
    // See `FilesystemCrawlSource.enumerate`: a link is declined, never followed.
    followSymlinks: false,
    onSymlinkNotFollowed: onLink,
    filesOnly: false,
    respectGitignore: false,
    // Recorded and settled per crawl: crawls sharing one listing may differ in policy.
    unreadable: { degrade: onRefusal },
  });
}

/**
 * A walk of `directory` for the directories it cannot list, and nothing else:
 * pruning {@link NEVER_CRAWL_GLOBS}, collecting no name and no link. An empty
 * include admits nothing, and the walk still descends, so a 200,000-entry
 * `.venv` costs its `readdir`s and never an array of its paths. A link beneath
 * a nested repository or an ignored directory is ignored, declined without a
 * row on every lane a listing serves, so none is collected.
 *
 * @param directory - The directory to walk
 * @param outputs - The trees the calling verb writes
 * @param onRefusal - Receives each directory the walk could not list
 */
async function walkRefusals(directory: string, outputs: readonly string[], onRefusal: (refusal: DirectoryRefusal) => void): Promise<void> {
  await crawlDirectory({
    baseDir: directory,
    outputs,
    include: [],
    exclude: [...NEVER_CRAWL_GLOBS],
    followSymlinks: false,
    filesOnly: false,
    respectGitignore: false,
    unreadable: { degrade: onRefusal },
  });
}

/**
 * A name's shape, `lstat`ed the first time a crawl admits it and remembered for
 * the rest of the run. Absent is a tracked file deleted from the working tree;
 * anything else the filesystem would not answer stays a member with no shape,
 * for the realization to report (as {@link symlinkShape} decides).
 *
 * @param name - The name
 * @returns Its shape
 */
function observedShape(name: ListedName): PathShape | 'symlink' | 'absent' | null {
  // `null` is an answer (stat it later), so only `undefined` is asked.
  if (name.shape === undefined) name.shape = lstatShape(name.absolutePath);
  return name.shape;
}

/** One `lstat`, as a {@link ListedName} shape. */
function lstatShape(absolutePath: string): PathShape | 'symlink' | 'absent' | null {
  try {
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) return 'symlink';
    if (stats.isDirectory()) return 'directory';
    return stats.isFile() ? 'file' : null;
  } catch (error) {
    const fault = fsFaultOf(error);
    if (fault === undefined) throw error;
    return fault.faultClass === 'absent' ? 'absent' : null;
  }
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
  // Every probe reads its link chain beneath the repository root first (`link-following.ts`).
  const present = (path: string): boolean => followedKindSync(path, gitRoot) !== 'absent';
  try {
    const kind = followedKindSync(marker, gitRoot);
    if (kind === 'absent') return false;
    if (kind === 'directory') {
      return present(safePath.join(marker, 'HEAD'));
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
    return present(safePath.join(target, 'HEAD'));
  } catch (error) {
    // The filesystem refusing the marker is the same answer as absent: do not
    // select an enumerator that will throw on it. The command then reports
    // `extentSource: filesystem`, which is where the refusal becomes visible.
    // A marker whose chain VAT will not hand the kernel (a `.git` or `HEAD`
    // linked to a network path) is never handed to git either — git would
    // follow it — so it is not selected, on the same terms.
    if (!isLinkChainRefusedError(error) && fsFaultOf(error) === undefined) throw error;
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
