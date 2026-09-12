/**
 * Filesystem utilities
 */

// ⚠️ The sync half is reached through the DEFAULT object (`nodeFs.existsSync`),
// not as named imports, and that is load-bearing rather than stylistic. Node
// snapshots a builtin's named ESM exports at import time, so `vi.spyOn(fs,
// 'existsSync')` cannot see a call made through a named binding — the spy
// attaches and counts zero, which reads exactly like "this function performs no
// I/O". `pathSpellingFrom` and `realpathFrom` are guarded by precisely that
// assertion (they must reach neither `readdir` nor this pair), so a "tidy-up"
// back to named imports would silently disarm the guard. The async half below
// already uses the default object for the same reason.
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { toForwardSlash, toNfc } from './path-core.js';
import { safePath } from './path-utils.js';

/**
 * What one path looked like the first time this run asked.
 *
 * The two fields are deliberately NOT collapsed into a single `stat` result:
 * they record the outcome of `existsSync` and of `statSync` *separately*,
 * because callers distinguish three states and only two of them are "the stat
 * worked". See {@link FsLookupCache.probe}.
 */
export interface PathProbe {
  /** `existsSync` — follows symlinks, so a dangling link reads as absent. */
  readonly exists: boolean;
  /**
   * `statSync().isDirectory()`.
   *
   * `null` means *no answer*, which happens two ways: the path is absent, or
   * it exists and `statSync` threw anyway (a permission change or a delete
   * between the two calls). Callers that must tell those apart read
   * {@link PathProbe.exists} alongside it.
   */
  readonly isDirectory: boolean | null;
}

/**
 * What one `readdir` answered: the entries, or which of the two ways it failed.
 *
 * ⛔ **The two failures are NOT one answer, and collapsing them is a wrong
 * verdict rather than a lost nicety.** This used to be `string[] | null`, where
 * one `null` meant both *"there is no such directory"* and *"I was refused"*.
 * Only the first is absence. A POSIX `--x` directory (mode `0111`) is
 * *traversable* — every file below it opens exactly as written — while
 * `readdir` returns `EACCES`; a judge that walks a path component by component
 * then declared a link that opens fine to be a missing file, and said so with
 * the confident wrong diagnosis *"File not found"*. The condition to report is
 * that a **directory could not be listed**, which is the caller's to decide, and
 * it cannot decide what this type will not carry.
 *
 * The sibling proof that the distinction is real: `resources/src/okf/discovery.ts`
 * already reports an unlistable subdirectory as its own `OKF_SUBDIRECTORY_UNREADABLE`
 * finding rather than as a missing one.
 */
export type DirectoryListing =
  /** The directory was read. `names` is exactly what `readdir` handed back. */
  | { readonly outcome: 'listed'; readonly names: string[] }
  /** There is no such directory (`ENOENT`), or a path component is a file (`ENOTDIR`). */
  | { readonly outcome: 'absent' }
  /**
   * The directory may well hold the entry asked about; the OS refused the
   * question. `code` is the errno, for a caller that reports the reason.
   */
  | { readonly outcome: 'unreadable'; readonly code: string };

/**
 * Turn a `readdir` rejection into the failure it actually is.
 *
 * ⚠️ **`isFilesystemAccessError` is deliberately NOT used here, and that is not
 * an oversight.** It answers a different question — *"is this the environment's
 * fault or a bug in our code?"* — and to answer it, it deliberately groups
 * `ENOENT` together with `EACCES`. That grouping IS the conflation this function
 * exists to undo, so reusing the predicate would reinstate the defect while
 * looking like sharing.
 *
 * Anything that is not a recognised *absence* errno reads as unreadable,
 * including an error carrying no errno at all: "I could not ask" is the answer
 * that fabricates no finding, and an unrecognised failure has not established
 * that the directory is missing.
 *
 * @param error - Whatever `fs.readdir` rejected with
 * @returns The listing outcome that error stands for
 */
export function listingFailure(error: unknown): DirectoryListing {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code: unknown }).code
      : undefined;

  // `ENOTDIR` is absence too: a path component that is a file is a directory
  // that does not exist, which is exactly what the caller has to report.
  if (code === 'ENOENT' || code === 'ENOTDIR') return { outcome: 'absent' };
  return { outcome: 'unreadable', code: typeof code === 'string' ? code : 'UNKNOWN' };
}

/**
 * Refusal errnos that a *re-ask* can legitimately answer differently.
 *
 * ⚠️ **This set decides what may be MEMOIZED, which makes it a correctness
 * boundary rather than a taxonomy.** `EACCES` (a mode bit) and `ELOOP` (a
 * committed symlink cycle) are facts about the tree: they hold for the whole
 * run, re-asking buys the same refusal, and caching them is exactly what
 * {@link FsLookupCache} is for. Descriptor exhaustion is not a fact about the
 * tree at all — it is a fact about this process at one instant — and a memo
 * that keeps one un-verifies every path under that directory for the rest of
 * the run, producing a burst of findings that a re-run does not reproduce.
 *
 * **Deliberately short, and everything unlisted is treated as stable.** The two
 * mistakes are not symmetric: memoizing a transient refusal costs a burst of
 * wrong answers *within one run*, while re-asking a stable one costs an
 * unbounded number of syscalls on a `--x` directory that will refuse every one
 * of them — and on a dead network mount, each of those blocks. `EAGAIN` is
 * included because it is literally "try again"; `ETIMEDOUT`/`ESTALE`/`EBUSY`
 * are not, because a re-ask against failing hardware or a hung mount is the
 * storm this set exists to avoid.
 */
const TRANSIENT_LISTING_ERRNOS: ReadonlySet<string> = new Set(['EMFILE', 'ENFILE', 'EAGAIN']);

/**
 * The clause a finding prints about a refusal {@link TRANSIENT_LISTING_ERRNOS}
 * calls transient — owned here, beside the list, so it describes every member.
 *
 * 🪤 Both consumers of `AbsenceCause.transient` used to write their own: "`X`
 * is descriptor exhaustion" — true of `EMFILE`/`ENFILE` and false of `EAGAIN`,
 * which is a retryable shortage of some other resource. Two lanes each carrying
 * the wording for a fact this module was made the single owner of is exactly
 * how the lanes come to disagree with it; the errno list and the sentence about
 * it move together only if they live together.
 *
 * @param code - The errno the listing was refused with
 * @returns A clause naming the errno and what kind of condition it is, with no
 *   trailing punctuation so a caller can continue the sentence
 */
export function transientRefusalClause(code: string): string {
  return `${code} is a transient shortage (a descriptor or other resource this process ran out of for a moment), not a permission`;
}

/** Whether this listing failed in a way a later ask could get past. */
function isTransientRefusal(listing: DirectoryListing): boolean {
  return listing.outcome === 'unreadable' && TRANSIENT_LISTING_ERRNOS.has(listing.code);
}

/** How many probes a {@link FsLookupCache} answered, and how many cost syscalls. */
export interface PathProbeStats {
  /** Probe calls received. */
  readonly probes: number;
  /** Probes that were not already memoized, i.e. that hit the filesystem. */
  readonly misses: number;
}

/**
 * Per-run memo for the two filesystem lookups that validation repeats on values
 * which are constant for the whole run: `realpath` of roots, and `readdir` of the
 * directories link targets live in.
 *
 * A markdown corpus resolves thousands of links into a few hundred directories, so
 * the uncached form is an N+1: measured at 9,963 `readdir` calls on a 3,437-document
 * tree and 7,443 on a 1,132-document monorepo. Concurrent callers share the
 * in-flight promise rather than each starting their own syscall.
 *
 * **Instance-based on purpose — never make this a module-level singleton.** The
 * cache holds a *snapshot* of directory contents, and a long-lived process (watch
 * mode, a language server, a daemon) would then answer from a listing taken
 * arbitrarily long ago. The intended lifetime is one instance per validation run,
 * constructed as a local and collected with the run.
 *
 * Fill first, then judge. The loop holds no `await`, because every listing the
 * loop could have needed was already taken:
 *
 * @example
 * ```typescript
 * const fsCache = new FsLookupCache();          // one per run
 * const requests = links.map((link) => ({ referrer: link.from, target: link.target }));
 * const spellings = await fillPathSpellings(requests, fsCache);   // all the I/O, once
 * for (const { referrer, target } of requests) {
 *   pathSpellingFrom(spellings, referrer, target);                // pure — no syscall
 * }
 * ```
 */
export class FsLookupCache {
  /** Directory path → its entry names, or why the listing has none. */
  readonly #listings = new Map<string, Promise<DirectoryListing>>();

  /** Path → its canonical path, falling back to the resolved path. */
  readonly #realpaths = new Map<string, Promise<string>>();

  /** Path → the existence/kind pair recorded the first time it was probed. */
  readonly #probes = new Map<string, PathProbe>();

  /** Probe calls received, and how many of them reached the filesystem. */
  #probeCount = 0;
  #probeMisses = 0;

  /** The listings turned into spelling indexes, built on first use. */
  #spellingIndex: DirectorySpellingIndex | undefined;

  /**
   * The three-way spelling index over this cache's listings — one per run, for
   * the same reason the listings themselves are.
   *
   * ⚠️ **It hangs off the cache rather than off a fill, and that is what makes
   * the index pay.** A caller that judges its paths in one `fillPathSpellings`
   * would be fine either way; a caller that judges them one at a time — which
   * `validateLink` exists to serve — would otherwise re-index the same listing
   * per path, and the cost would go straight back to
   * O(paths × entries-in-that-directory) with the listing memo hiding the
   * syscalls but not the work.
   *
   * Lazily built: a run that never judges a path allocates nothing.
   */
  get spellingIndex(): DirectorySpellingIndex {
    this.#spellingIndex ??= new DirectorySpellingIndex(this);
    return this.#spellingIndex;
  }

  /**
   * Probe counters, for tests and `--debug` output.
   *
   * A memo whose tests never assert its hit count is theatre: every assertion
   * about *values* still passes when the memo is disabled, because an
   * always-miss cache returns the same answers — only more slowly. This is the
   * one observable that dies when the memo does.
   */
  get probeStats(): PathProbeStats {
    return { probes: this.#probeCount, misses: this.#probeMisses };
  }

  /**
   * Does this path exist, and is it a directory — asked once per run.
   *
   * **Both syscalls are preserved, in order, exactly as an uncached caller
   * would make them.** `existsSync` then `statSync` is not the same as one
   * `statSync`: the pair distinguishes "absent" from "present but unstattable",
   * and the link walker's classifier branches differently on each. Collapsing
   * them would be a behaviour change wearing the shape of an optimization, so
   * this method deduplicates the pair rather than replacing it.
   *
   * Synchronous, unlike this class's other two lookups, because its caller (the
   * skill link-graph walker) is synchronous throughout. One oracle answering
   * both shapes beats a second class that differs only in colour.
   *
   * @param targetPath - Path to probe
   * @returns The recorded existence/kind pair
   */
  probe(targetPath: string): PathProbe {
    this.#probeCount++;
    const cached = this.#probes.get(targetPath);
    if (cached !== undefined) return cached;

    this.#probeMisses++;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-validated path
    const exists = nodeFs.existsSync(targetPath);
    let isDirectory: boolean | null = null;
    if (exists) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-validated path
        isDirectory = nodeFs.statSync(targetPath).isDirectory();
      } catch {
        // Present to `existsSync` but unstattable. `null` records "no answer"
        // rather than guessing `false`, which would read as "it is a file".
        isDirectory = null;
      }
    }

    const result: PathProbe = { exists, isDirectory };
    this.#probes.set(targetPath, result);
    return result;
  }

  /**
   * Canonical path for `targetPath`. A path that cannot be canonicalized is
   * answered from its **deepest existing ancestor** — that ancestor's realpath
   * with the missing remainder re-appended — because a non-existent file has no
   * realpath and callers comparing paths still need an answer.
   *
   * ⚠️ **The fallback must stay in the same NAMESPACE as the success path, which
   * a lexical `safePath.resolve()` is not.** The only consumer of this column
   * compares one canonical path against another (`isWithinProject` /
   * `isWithinProjectFrom`), so an answer resolved lexically is being compared
   * against an answer resolved through symlinks. Where the root traverses a
   * symlink — macOS `/tmp → /private/tmp`, bind mounts, a worktree under a
   * symlinked path — the two spellings differ and the comparison is nonsense.
   * Measured truth table for `isWithinProject(file, root)` under a `link → real`
   * root, before the walk:
   *
   * ```text
   * existing file, symlinked root : true
   * MISSING  file, symlinked root : false  ← lexical fallback, wrong namespace
   * MISSING  file, plain root     : true
   * symlink inside pointing out   : false  (correct either way)
   * ```
   *
   * The middle row is user-visible: a merely BROKEN root-absolute markdown link
   * was reported as *escaping the project*. The walk fixes it without widening
   * containment, because the ancestor is exactly where an escaping symlink
   * lives — a missing file behind a directory link that points outside still
   * canonicalizes outside.
   *
   * The recursion goes through `this.realpath(parent)`, not a private helper, so
   * ancestors land in the same memo and share in-flight promises. A missing
   * file's parent directory is almost always already cached, so the common case
   * costs no extra syscall. **The fixpoint guard is mandatory**: `path.dirname`
   * is idempotent at a root (`'/'` on posix, `'C:/'` for a drive, `'//server/share/'`
   * for a UNC share), so without it the walk never terminates.
   *
   * Errno is deliberately not inspected. EACCES on an existing file and ELOOP on
   * a symlink cycle land in the same catch as ENOENT, and for all three the
   * ancestor's namespace is a strictly better answer than the lexical one.
   *
   * ⚠️ **`promisify(nodeFs.realpath)` — NOT `fs/promises.realpath`. Node ships two
   * different realpaths and they do not agree.** `fs.realpathSync` and the
   * `fs.realpath` *callback* form run Node's own JS implementation: an
   * lstat/readlink walk that preserves the casing you asked for. `fs/promises.realpath`
   * and `fs.realpath.native` call `uv_fs_realpath` (`realpath(3)` /
   * `GetFinalPathNameByHandleW`), which reports the casing **on disk**. On a
   * case-insensitive filesystem — macOS and Windows — those are different strings,
   * and this column feeds *synchronous* judges that previously called
   * `fs.realpathSync` themselves. A column that does not match `realpathSync` byte
   * for byte flips containment verdicts and emits findings the un-refactored code
   * does not. Measured, Node v24.13.1 / darwin, disk holding `<B>/Sub/Target.TXT`,
   * asked for `<B>/sub/target.txt`:
   *
   * ```text
   * realpathSync           : <B>/sub/target.txt   ← the contract
   * promisify(fs.realpath) : <B>/sub/target.txt   ✅ matches (this call)
   * fs/promises.realpath   : <B>/Sub/Target.TXT   ❌ on-disk casing
   * fs.realpath.native     : <B>/Sub/Target.TXT   ❌ on-disk casing
   * ```
   *
   * They also disagree on `''`, where the sync form resolves to the cwd and the
   * native form throws `ENOENT`. **Do not "modernize" this back to `fs/promises`** —
   * it reads tidier and silently changes output. `packages/utils/test/fs-utils.test.ts`
   * → *"answers a mis-cased path exactly as realpathSync does, not as the native
   * resolver does"* pins the equivalence (and skips itself on a case-sensitive
   * filesystem, where the two routes cannot be told apart).
   *
   * `promisify` is applied **per call, on the default object**, not once at module
   * scope: an eagerly captured function bypasses any `vi.spyOn(nodeFs, 'realpath')`
   * installed after import, so this method's I/O would count zero — indistinguishable
   * from performing none. (`fs.realpath` carries no `util.promisify.custom`, so this
   * promisification really does get the JS implementation; it is verified, not
   * assumed — see *"routes canonicalization through the node:fs default object"*.)
   * The wrapper is allocated only on a cache MISS, i.e. once per actual syscall.
   *
   * @param targetPath - Path to canonicalize
   * @returns Canonical path with forward slashes on every platform
   */
  realpath(targetPath: string): Promise<string> {
    const cached = this.#realpaths.get(targetPath);
    if (cached !== undefined) return cached;

    // Stored before the first `await` anywhere can run, so concurrent callers
    // reaching this method share the one in-flight promise.
    //
    // No `security/detect-non-literal-fs-filename` suppression here, unlike the
    // sibling lookups: the rule matches a member call on an fs object, and the
    // path is passed to the promisified wrapper instead. The path is
    // caller-validated all the same.
    const pending = promisify(nodeFs.realpath)(targetPath)
      .then(toForwardSlash)
      .catch(() => this.#canonicalizeViaAncestor(targetPath));
    this.#realpaths.set(targetPath, pending);
    return pending;
  }

  /**
   * The ancestor walk behind {@link FsLookupCache.realpath}'s fallback: canonicalize
   * the parent — through the public method, so the memo and in-flight sharing
   * apply — and re-append this path's own basename.
   *
   * Runs inside the already-stored promise's `.catch()`, which is what keeps the
   * store-before-await property intact: the row for `targetPath` is in the map
   * before any of this can start.
   *
   * @param targetPath - Path that could not be canonicalized
   * @returns Canonical ancestor plus the missing remainder, forward-slashed
   */
  async #canonicalizeViaAncestor(targetPath: string): Promise<string> {
    const absolutePath = safePath.resolve(targetPath);
    const parent = toForwardSlash(path.dirname(absolutePath));
    // Fixpoint at a filesystem root — `/`, `C:/`, `//server/share/` — where
    // `dirname` returns its own input. Nothing left to walk, and no guard means
    // no termination.
    if (parent === absolutePath) return absolutePath;

    return safePath.join(await this.realpath(parent), path.basename(absolutePath));
  }

  /**
   * What `dirPath` holds, or which of the two ways the question went unanswered.
   *
   * A *stable* failure is cached like a success: re-asking a directory whose
   * mode bits refuse us, or whose path is a symlink cycle, is the same failed
   * syscall. A **transient** one is not — see {@link TRANSIENT_LISTING_ERRNOS}.
   *
   * ⚠️ **The transient entry is dropped only once the promise has SETTLED, and
   * that timing is the whole design.** Deleting the row up front, or refusing to
   * store it, would make every concurrent caller start its own `readdir` —
   * turning the descriptor shortage `EMFILE` reports into a descriptor storm,
   * i.e. answering the failure with more of its cause. Storing the in-flight
   * promise keeps the collapse-N-callers-to-one-syscall property intact through
   * the failure; evicting after it settles is what stops the *next* wave from
   * inheriting a verdict about a moment that has passed.
   *
   * The alternative considered and rejected was a bounded retry inside this
   * method. It re-issues the syscall *while the shortage is still in progress*
   * (which is the storm again, only self-inflicted), it needs a backoff timer to
   * be worth anything, and it hides latency inside a call every caller reads as
   * a memo lookup. Letting the next ask pay one syscall is the same cost the
   * cache already bounds: one per directory, per wave.
   *
   * @param dirPath - Directory to list
   * @returns The entry names, or why there are none to hand back
   */
  readdir(dirPath: string): Promise<DirectoryListing> {
    const cached = this.#listings.get(dirPath);
    if (cached !== undefined) return cached;

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-validated path
    const listed = fs.readdir(dirPath);
    const pending = listed
      .then((names): DirectoryListing => ({ outcome: 'listed', names }))
      .catch(listingFailure);
    this.#listings.set(dirPath, pending);
    return this.#forgetIfTransient(dirPath, pending);
  }

  /**
   * Hand back `pending`'s answer, dropping the memo row first when the answer is
   * a *transient* refusal.
   *
   * The row is stored by the caller before this is reached, so the wave that
   * provoked the shortage shares that one syscall; this only decides whether a
   * LATER wave inherits its verdict. Identity-guarded because a later ask may
   * already have installed a fresh row, and deleting that one would discard a
   * listing somebody is awaiting.
   *
   * @param dirPath - Directory the row is filed under
   * @param pending - The row itself, already stored
   * @returns The same listing `pending` settles to
   */
  async #forgetIfTransient(
    dirPath: string,
    pending: Promise<DirectoryListing>
  ): Promise<DirectoryListing> {
    const listing = await pending;
    if (isTransientRefusal(listing) && this.#listings.get(dirPath) === pending) {
      this.#listings.delete(dirPath);
    }
    return listing;
  }
}

/**
 * Recursively copy a directory
 *
 * @param src - Source directory path
 * @param dest - Destination directory path
 *
 * @example
 * await copyDirectory('/source/dir', '/dest/dir');
 */
export async function copyDirectory(src: string, dest: string): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths from validated sources
  await fs.mkdir(dest, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths from validated sources
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = safePath.join(src, entry.name);
    const destPath = safePath.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Which spelling rule matched a name, and therefore how faithfully the
 * asked-for spelling matches disk.
 *
 * The three that are not `absent` are ordered from most to least faithful, and
 * every consumer that reports to a human needs the distinction: only `exact`
 * opens on every filesystem.
 *
 * **The three rules are tried strictly in the order below, first match wins —
 * the order IS the contract**, because each accepts a strictly weaker notion of
 * sameness and a weaker rule reached first would mislabel a file that is
 * genuinely there. {@link DirectorySpellingIndex} implements them as three
 * lookups over one pre-built index (`indexEntry`/`lookupIn`); it is the only
 * judge, so nothing upstream can disagree with it about what "the same
 * filename" means.
 *
 * ⚠️ **`exact` and `normalized` are not the same verdict, and collapsing them
 * is a silently-wrong answer rather than a lost nicety.** Folding both sides
 * *before* comparing repairs the false "missing" on macOS/APFS — `é` has two
 * encodings (NFC `U+00E9` vs NFD `e` + `U+0301`) that are `!==` and that
 * case-folding does not reconcile, so an accented file that plainly exists was
 * once reported flatly *missing* — and over-corrects into the opposite error on
 * Linux/ext4, where the filesystem is byte-exact: a markdown link spelling a
 * filename NFD while disk holds NFC genuinely 404s there, and a folded judge
 * answers "exists, exact match, no issue". Keeping both facts is the point —
 * the link resolves (so it must not be reported broken), *and* it resolves only
 * by folding (so a caller can warn). `@vibe-agent-toolkit/resources` turns
 * `'normalized'` into `LINK_NORMALIZATION_MISMATCH`. This is one of three sites
 * on that seam; the class is collected in
 * `docs/architecture/resource-scanning-and-caching.md` §3.6 (ledger entry D7).
 *
 * ⚠️ **Case-folding is applied to the NFC-folded form, not to raw bytes.**
 * `toLowerCase()` does not reconcile NFC against NFD, so a name that differs in
 * *both* case and normalization would fall out as `absent` and the author would
 * lose the suggestion. The prohibition that bounds every fold — it yields a
 * comparison key, never a path to open — is stated once at {@link toNfc}, which
 * is also where the reason it is not folded into `safePath.resolve` lives.
 */
export type FilenameMatch =
  /** The asked-for name and a directory entry are the same bytes. Opens anywhere. */
  | 'exact'
  /**
   * They are different bytes that are equal after Unicode NFC folding — the same
   * visible filename in two normalization forms. Opens on macOS/APFS and
   * Windows; **does not open on a byte-exact filesystem** (Linux/ext4, i.e. CI
   * and most deploy targets), where the two forms simply name different files.
   */
  | 'normalized'
  /** They differ by letter case (after folding). Opens only on a case-insensitive filesystem. */
  | 'case_mismatch'
  /** Nothing in the listing matches, or the directory could not be read. */
  | 'absent';

// ─────────────────────────────────────────────────────────────────────────────
// Judging a whole PATH, component by component.
//
// ## ⛔ Why a basename is not a path
//
// A basename-only judge — the shape this replaced — answers about ONE name in
// ONE directory, and a caller that asks it only about `basename(target)` has
// handed every DIRECTORY component of that path straight back to the host
// filesystem's own folding: the exact oracle the whole classifier exists to
// replace.
// `readdir('<root>/Docs')` succeeds on macOS/APFS when the directory is really
// `docs`, the basename then matches byte for byte, and the caller reports
// nothing for a link that 404s on every case-sensitive filesystem. The Unicode
// half is silent the same way, and that one 404s on Linux.
//
// Worse than incomplete, the *remedy* is wrong: with two components misspelled,
// a basename-only correction names only the last one, and an author who follows
// it verbatim still has a broken path. {@link DirectorySpellingIndex.judgePath}
// walks from a trusted root DOWN, judges each component against the directory
// that actually holds it, and descends into the CORRECTED spelling — so a wrong
// directory cannot hide a wrong filename beneath it.
//
// ## ⛔ Why the listing is INDEXED rather than scanned
//
// The judge this replaced ran up to three linear scans over the parent listing
// **per name**, folding each entry to NFC and lower case on the way, so a
// caller judging many paths paid O(paths × entries-in-that-directory). Judging
// every component multiplies that by the path depth, which is why it had to
// stop being a scan first. {@link DirectorySpellingIndex} lists each directory
// once and indexes it once, under all three spellings the judge can ask for, so
// a lookup is a `Map.get`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a name is not in a listing — the two are a different fact about the tree
 * and a different thing to tell a human.
 *
 * ⛔ **Kept off {@link FilenameMatch} deliberately.** That union names the
 * *spelling rules* a name can match under, and "the directory refused to be
 * listed" is not a spelling rule — it is the reason no rule could be tried. It
 * carries no rank in {@link SPELLING_RANK} and no corrected spelling, and
 * folding it in as a fifth verdict would silently un-exhaust every switch over
 * a spelling (the OKF cross-link lane has one) without moving what those
 * switches actually decide.
 */
export type AbsenceCause =
  /** The directory was listed and holds nothing matching, under any rule. */
  | { readonly kind: 'no_such_entry' }
  /**
   * A directory on the path could not be listed, so the question was never
   * asked. ⚠️ **This is not evidence of absence** — a `--x` directory is
   * traversable, so the target may well open. A caller reporting it as a
   * missing file is asserting something it has not learned.
   *
   * 🔑 **It carries WHICH directory and WHICH errno because the alternative was
   * a remedy nobody can aim.** Collapsing every refusal to the bare word left
   * each consumer able to say only "a directory on that path refused" — useless
   * to a reader staring at a five-segment path, and identical whether the cause
   * was a mode bit they can fix or a descriptor shortage they should just
   * re-run past.
   */
  | {
      readonly kind: 'directory_unreadable';
      /** The errno `readdir` refused with: `EACCES`, `EMFILE`, `ENFILE`, `ELOOP`, … */
      readonly code: string;
      /**
       * The directory that refused — **absolute**, forward-slashed.
       *
       * 🔒 **Sanitize before quoting it to a human.** An absolute path in a
       * finding is the developer's `$HOME` in every CI log, and both consumers
       * of this field re-express it against a root they own
       * (`issueLocation(dir, projectRoot)` in the link lane,
       * `safePath.relative(bundleRoot, dir)` in the OKF lane) before it reaches
       * a message. It is absolute *here* because those two roots differ and the
       * walk root this was found under is neither of them.
       */
      readonly directory: string;
      /**
       * Whether re-running could get a different answer — see
       * {@link TRANSIENT_LISTING_ERRNOS}.
       *
       * Derived once, here, rather than by each consumer: two lanes write a
       * "re-run before investigating" remedy off this fact, and a second errno
       * list is exactly how those two come to disagree about it.
       */
      readonly transient: boolean;
    };

/** The refusal half of {@link AbsenceCause}: a directory that would not be listed. */
export type DirectoryRefusal = Extract<AbsenceCause, { kind: 'directory_unreadable' }>;

/**
 * The refusal a `readdir` that was refused stands for — errno, directory and
 * whether a re-ask could answer differently, derived ONCE beside the errno list.
 *
 * Shared by the spelling judge (through {@link absenceCauseFor}) and the crawl
 * that defines the population (`file-crawler.ts`), so the two lanes cannot
 * disagree about which refusals are transient.
 *
 * @param listing - A `readdir` outcome that was refused
 * @param directory - The directory that was asked about
 * @returns The refusal, with `directory` forward-slashed
 */
export function directoryRefusalFor(
  listing: Extract<DirectoryListing, { outcome: 'unreadable' }>,
  directory: string
): DirectoryRefusal {
  return {
    kind: 'directory_unreadable',
    code: listing.code,
    directory: toForwardSlash(directory),
    transient: TRANSIENT_LISTING_ERRNOS.has(listing.code),
  };
}

/**
 * The cause for a listing that produced no index.
 *
 * @param listing - A `readdir` outcome that is not `listed`
 * @param directory - The directory that was asked about
 * @returns Which absence this is, and — when it is a refusal — its detail
 */
function absenceCauseFor(
  listing: Exclude<DirectoryListing, { outcome: 'listed' }>,
  directory: string
): AbsenceCause {
  if (listing.outcome === 'absent') return { kind: 'no_such_entry' };
  return directoryRefusalFor(listing, directory);
}

/** What one directory entry name matched, and how the directory spells it. */
export type ComponentMatch =
  | { match: Exclude<FilenameMatch, 'absent'>; actualName: string }
  | { match: 'absent'; because: AbsenceCause };

/**
 * How much worse each spelling is than the one above it.
 *
 * A path can be wrong in more than one way at once (`Café/Guide.md` against
 * `café/guide.md`), and a report has to pick one verdict. The worst component
 * wins: a case mismatch is broken on more machines than a normalization
 * mismatch is, so reporting the milder one would understate what the author has
 * to fix. The corrected path is carried either way, so nothing is lost.
 */
const SPELLING_RANK: Readonly<Record<Exclude<FilenameMatch, 'absent'>, number>> = {
  exact: 0,
  normalized: 1,
  case_mismatch: 2,
};

/**
 * One directory listing, pre-indexed under every spelling rule the judge asks.
 *
 * The three maps are the three rules of {@link FilenameMatch}, in the same
 * order and with the same meaning — byte-exact, then equal after NFC folding,
 * then equal after folding and case-folding — turned from a scan into a
 * lookup. First entry wins in each map, which is what preserves "first match
 * wins" from the scan it replaces: a case-insensitive filesystem can hold both
 * `readme.md` and `README.md`, and the answer must not depend on `readdir`
 * order.
 */
interface DirectoryIndex {
  exact: Map<string, string>;
  nfc: Map<string, string>;
  folded: Map<string, string>;
}

/**
 * A directory's index, or why it has none — the same two-way distinction
 * {@link DirectoryListing} draws, carried one layer up so a lookup against an
 * unlistable directory cannot come back wearing the shape of absence.
 */
type IndexedDirectory =
  | { readonly index: DirectoryIndex }
  | { readonly index: null; readonly because: AbsenceCause };

/** Whether this build failed in a way a later build could get past. */
function isTransientlyUnreadable(indexed: IndexedDirectory): boolean {
  return (
    indexed.index === null &&
    indexed.because.kind === 'directory_unreadable' &&
    indexed.because.transient
  );
}

/** Record an entry under whichever of the three spellings it is first for. */
function indexEntry(index: DirectoryIndex, entry: string): void {
  if (!index.exact.has(entry)) index.exact.set(entry, entry);

  const folded = toNfc(entry);
  if (!index.nfc.has(folded)) index.nfc.set(folded, entry);

  const lowered = folded.toLowerCase();
  if (!index.folded.has(lowered)) index.folded.set(lowered, entry);
}

/** Ask one indexed listing for a name, under each rule in turn. */
function lookupIn(index: DirectoryIndex, name: string): ComponentMatch {
  const exact = index.exact.get(name);
  if (exact !== undefined) return { match: 'exact', actualName: exact };

  const folded = toNfc(name);
  const normalized = index.nfc.get(folded);
  if (normalized !== undefined) return { match: 'normalized', actualName: normalized };

  const insensitive = index.folded.get(folded.toLowerCase());
  return insensitive === undefined
    ? { match: 'absent', because: { kind: 'no_such_entry' } }
    : { match: 'case_mismatch', actualName: insensitive };
}

/**
 * What judging a whole path said, and the two spellings a message quotes.
 *
 * A union rather than one interface with an optional field: {@link AbsenceCause}
 * is required exactly when the verdict is `absent` and unreachable otherwise, so
 * a caller cannot report a path as missing without having read *which* absence
 * it is.
 */
export type PathSpelling =
  | {
      /** The worst spelling defect on the path. */
      match: Exclude<FilenameMatch, 'absent'>;
      /** The path relative to the walk root, spelled as the caller asked for it. */
      askedPath: string;
      /** The same path as disk spells it. */
      actualPath: string;
    }
  | {
      /** No component matched — see `because` before calling anything missing. */
      match: 'absent';
      /** The path relative to the walk root, spelled as the caller asked for it. */
      askedPath: string;
      /** Empty: nothing matched, so there is no disk spelling to quote. */
      actualPath: string;
      /** Whether the entry is really gone, or the listing was refused. */
      because: AbsenceCause;
      /**
       * What the walk DID establish before it stopped: the components above
       * the one it could not find or could not ask about.
       *
       * 🪤 Carried because dropping it discarded a verdict. `Locked/t.md`
       * against a disk `locked/` that then refuses to list: component 1 was
       * judged and found a case mismatch — a defect that 404s on a
       * case-sensitive filesystem whatever the mode bit below says — and a
       * bare `absent` threw it away, so the report called the spelling
       * "unverified" about a component VAT had verified and found wrong.
       */
      verified: VerifiedPrefix;
    };

/**
 * The components of a path a walk judged before it stopped, and their verdict.
 *
 * Both paths are `/`-joined and relative to the walk root, like the
 * {@link PathSpelling} they ride on; both are empty when the FIRST component
 * is the one that could not be judged.
 */
export interface VerifiedPrefix {
  /** The worst spelling defect among the judged components. */
  readonly match: Exclude<FilenameMatch, 'absent'>;
  /** The judged components as the caller spelled them. */
  readonly askedPath: string;
  /** The same components as disk spells them. */
  readonly actualPath: string;
}

/**
 * Every directory a run asks about, listed once and indexed once.
 *
 * ⚠️ **It owns the listings and never hands one out.** That is deliberate: the
 * defect it replaced was a per-path scan over a shared raw array, and an
 * implementation that cannot reach the array cannot scan it. The only ways to
 * ask a question are {@link DirectorySpellingIndex.lookup} and
 * {@link DirectorySpellingIndex.judgePath}, both `Map.get` over an index built
 * at most once per directory — {@link DirectorySpellingIndex.directoriesIndexed}
 * and {@link DirectorySpellingIndex.entriesIndexed} are what a test counts to
 * prove the work did not go back to being per-path.
 *
 * **Instance-per-run, like the {@link FsLookupCache} it borrows** — it holds a
 * snapshot of directory contents and must not outlive the run that took it.
 */
export class DirectorySpellingIndex {
  readonly #fsCache: FsLookupCache;
  /** Directory → its index, or why it has none. */
  readonly #indexes = new Map<string, Promise<IndexedDirectory>>();
  #directoriesIndexed = 0;
  #entriesIndexed = 0;

  constructor(fsCache: FsLookupCache) {
    this.#fsCache = fsCache;
  }

  /**
   * How many times a listing was turned into an index.
   *
   * Counted at the BUILD, not as `#indexes.size`: the size is the number of
   * distinct directories asked about, which stays put even if every lookup
   * rebuilds — the exact regression this number exists to catch.
   */
  get directoriesIndexed(): number {
    return this.#directoriesIndexed;
  }

  /** How many directory entries were examined, across every index built. */
  get entriesIndexed(): number {
    return this.#entriesIndexed;
  }

  /** Every directory that has been listed, for never-reached-above-the-root pins. */
  get indexedDirectories(): string[] {
    return [...this.#indexes.keys()];
  }

  /**
   * Ask what `directory` really calls `name`.
   *
   * @param directory - Absolute path of the directory to ask about
   * @param name - One path component, spelled as the caller asked for it
   * @returns Which rule matched and the entry's own spelling, or `absent`
   */
  async lookup(directory: string, name: string): Promise<ComponentMatch> {
    const indexed = await this.#indexFor(directory);
    return indexed.index === null
      ? { match: 'absent', because: indexed.because }
      : lookupIn(indexed.index, name);
  }

  /**
   * Judge every component of `resolvedPath`, from `root` down.
   *
   * Each component is judged against the directory that actually holds it —
   * which is the corrected spelling of the previous component, not the
   * asked-for one, so a wrong directory name does not hide a wrong filename
   * beneath it.
   *
   * ⛔ **It never looks above `root`.** The walk starts there and only
   * descends, and a path that does not live under `root` is refused outright
   * rather than walked from somewhere else: a verdict that depends on a
   * directory above the root is a verdict that changes when the tree is moved.
   * Pick a root the caller has already enumerated, and every component below it
   * is one the *reference text* contributed — exactly the ones worth judging.
   *
   * @param root - Absolute path of a directory known to exist, and an ancestor
   *   of `resolvedPath` (or `resolvedPath` itself)
   * @param resolvedPath - Absolute path to judge
   * @returns The worst spelling defect on the path, plus both spellings of it
   * @throws If `resolvedPath` does not live at or under `root`
   */
  async judgePath(root: string, resolvedPath: string): Promise<PathSpelling> {
    // `safePath.relative` already answers in forward slashes; saying so out loud
    // is what makes both the traversal test and the split below safe on Windows.
    const askedPath = toForwardSlash(safePath.relative(root, resolvedPath));
    // The root itself: the caller enumerated it to get here, so it resolves,
    // and there is no component to judge. Asking would mean listing its PARENT.
    if (askedPath === '') return { match: 'exact', askedPath, actualPath: askedPath };

    // Tested as a whole SEGMENT rather than as a prefix: `startsWith('..')`
    // would refuse a real directory named `..cache`.
    const segments = toForwardSlash(askedPath).split('/');
    if (segments[0] === '..') {
      throw new Error(
        `Path spelling asked about "${askedPath}", which is above the walk root "${root}". ` +
          `A verdict that depends on a directory above the root changes when the tree moves.`
      );
    }

    return await this.#walk(root, askedPath, segments);
  }

  /** The component-by-component descent behind {@link judgePath}. */
  async #walk(
    root: string,
    askedPath: string,
    segments: readonly string[]
  ): Promise<PathSpelling> {
    const actual: string[] = [];
    let worst: Exclude<FilenameMatch, 'absent'> = 'exact';
    let directory = root;

    for (const segment of segments) {
      // Sequential by necessity: which directory holds the next component
      // depends on how this one is really spelled. Every listing is memoized,
      // so a run pays per DIRECTORY, not per path and not per component.
      const found = await this.lookup(directory, segment);
      if (found.match === 'absent') {
        // The cause travels with the verdict rather than being re-derived: by
        // the time a caller reports this, the directory that refused is
        // several frames gone and nothing else can tell the two absences
        // apart. So does what was learned ABOVE it — see `verified`.
        return {
          match: 'absent',
          askedPath,
          actualPath: '',
          because: found.because,
          verified: {
            match: worst,
            askedPath: segments.slice(0, actual.length).join('/'),
            actualPath: actual.join('/'),
          },
        };
      }

      if (SPELLING_RANK[found.match] > SPELLING_RANK[worst]) worst = found.match;
      actual.push(found.actualName);
      directory = safePath.join(directory, found.actualName);
    }

    return { match: worst, askedPath, actualPath: actual.join('/') };
  }

  /**
   * The index for one directory, built at most once.
   *
   * The promise — not the resolved value — is memoized, so two components
   * resolving into the same directory concurrently share one listing and one
   * build rather than racing to do both twice.
   *
   * ⚠️ **A transient refusal is dropped here as well as in the listing memo
   * underneath, and both evictions are load-bearing.** This map caches the
   * built INDEX, so evicting only `FsLookupCache`'s listing would leave the
   * moment-in-time refusal pinned at precisely the layer every consumer reads —
   * a fix that is real and invisible. Same settle-then-evict timing, and the
   * same identity guard, for the same reason: see {@link FsLookupCache.readdir}.
   */
  async #indexFor(directory: string): Promise<IndexedDirectory> {
    const existing = this.#indexes.get(directory);
    if (existing !== undefined) return await existing;

    const building = this.#build(directory);
    this.#indexes.set(directory, building);
    const indexed = await building;
    if (isTransientlyUnreadable(indexed) && this.#indexes.get(directory) === building) {
      this.#indexes.delete(directory);
    }
    return indexed;
  }

  /** List one directory and index every entry it holds. */
  async #build(directory: string): Promise<IndexedDirectory> {
    this.#directoriesIndexed += 1;
    const listing = await this.#fsCache.readdir(directory);
    if (listing.outcome !== 'listed') {
      // Two failures, two answers: a directory that is not there is absence,
      // and a directory that refused to be listed is a question nobody got to
      // ask. Mapping both to `no_such_entry` here is what used to report a
      // link that opens as a missing file.
      return { index: null, because: absenceCauseFor(listing, directory) };
    }

    const index: DirectoryIndex = { exact: new Map(), nfc: new Map(), folded: new Map() };
    for (const name of listing.names) {
      indexEntry(index, name);
      this.#entriesIndexed += 1;
    }
    return { index };
  }
}

/** One path to judge, paired with the file whose text asked for it. */
export interface PathSpellingRequest {
  /** The referring file, whose own path was enumerated and is therefore trusted. */
  referrer: string;
  /** The absolute path the reference resolved to. */
  target: string;
}

/**
 * Where to start judging `target`, given that `referrer`'s own path came off
 * the filesystem rather than out of a document.
 *
 * ⚠️ **The root is the deepest directory the two paths share, and that choice
 * is doing real work in both directions.** Everything *above* it was enumerated
 * (so judging it would compare disk against disk, and on a macOS crawl that
 * routinely means reporting an NFD component nobody wrote); everything *below*
 * it is what the reference text contributed, and is precisely what a
 * misspelling can hide in.
 *
 * Falls back to the target's own parent — i.e. judging the basename alone, the
 * weakest useful answer — when the two paths share no meaningful ancestor
 * (different drives on Windows, or a relative path).
 *
 * @param referrer - Path of the file holding the reference
 * @param target - Absolute path the reference resolved to
 * @returns The directory to walk down from
 */
export function spellingWalkRoot(referrer: string, target: string): string {
  const referrerDir = toForwardSlash(path.dirname(referrer)).split('/');
  const targetDir = toForwardSlash(path.dirname(target)).split('/');

  let shared = 0;
  while (
    shared < referrerDir.length &&
    shared < targetDir.length &&
    referrerDir[shared] === targetDir[shared]
  ) {
    shared += 1;
  }

  // `< 2` rather than `=== 0`: a single shared segment is the filesystem root
  // (`''` on POSIX) or the drive (`C:` on Windows), and walking down from there
  // would list directories no caller owns.
  return shared < 2 ? path.dirname(target) : targetDir.slice(0, shared).join('/');
}

/**
 * The materialized spelling column: one judged path per distinct
 * (walk root, target) pair.
 *
 * A *missing key* is never a legal input to judgement: see
 * {@link pathSpellingFrom}.
 */
export type PathSpellingTable = ReadonlyMap<string, PathSpelling>;

/**
 * The table key — derived in exactly one place so a filler and a judge cannot
 * construct different ones for the same question.
 */
function spellingKey(referrer: string, target: string): string {
  return `${spellingWalkRoot(referrer, target)}\0${target}`;
}

/**
 * Judge every request's whole path — the only place I/O is legal for this fact,
 * and the pass that must run *before* any judging.
 *
 * Distinct (root, target) pairs are walked **concurrently**, and every listing
 * they need goes through the cache's own {@link DirectorySpellingIndex}
 * ({@link FsLookupCache.spellingIndex}), so a directory holding N referenced
 * targets is listed once, not N times, a directory on the path to M of them is
 * listed once, not M times, and a caller that fills once per path still indexes
 * each directory only once for the whole run.
 *
 * @param requests - Targets to judge, each paired with its referring file
 * @param fsCache - Per-run lookup cache (one instance per validation run)
 * @returns The filled table; empty input yields an empty table with no syscalls
 */
export async function fillPathSpellings(
  requests: Iterable<PathSpellingRequest>,
  fsCache: FsLookupCache
): Promise<PathSpellingTable> {
  const distinct = new Map<string, PathSpellingRequest>();
  for (const request of requests) {
    const key = spellingKey(request.referrer, request.target);
    if (!distinct.has(key)) distinct.set(key, request);
  }

  const index = fsCache.spellingIndex;
  const table = new Map<string, PathSpelling>();
  await Promise.all(
    [...distinct].map(async ([key, request]) => {
      const root = spellingWalkRoot(request.referrer, request.target);
      table.set(key, await index.judgePath(root, request.target));
    })
  );

  return table;
}

/**
 * Read the verdict for one reference out of an already-filled table. Pure.
 *
 * **A miss throws rather than degrading to `absent`.** The fill set is derived
 * from exactly the references the judge will be asked about, so a missing row
 * is a programming error — a path judged that nobody filled. Degrading would
 * report every such reference as *missing*: a wrong answer wearing the shape of
 * a graceful degradation, and one no test of the verdict would catch.
 *
 * @param table - Table filled by {@link fillPathSpellings}
 * @param referrer - The file holding the reference
 * @param target - The absolute path it resolved to
 * @returns How faithfully the whole path is spelled
 * @throws If `table` holds no row for this (referrer, target) pair
 */
export function pathSpellingFrom(
  table: PathSpellingTable,
  referrer: string,
  target: string
): PathSpelling {
  const spelling = table.get(spellingKey(referrer, target));
  if (spelling === undefined) {
    throw new Error(
      `No path spelling for "${target}" (referenced from "${referrer}"). ` +
        `Fill it with fillPathSpellings() before judging.`
    );
  }
  return spelling;
}

/**
 * The materialized realpath column: path → its canonical path.
 *
 * Every filled row is a string — never `null`, never `undefined`.
 * {@link FsLookupCache.realpath} answers a path it cannot canonicalize from that
 * path's deepest existing ancestor rather than failing, because a path that does
 * not exist has no realpath and a caller comparing paths still needs an answer.
 * That fallback IS the contract, and it is what lets `undefined` out of this map
 * mean exactly one thing: *absent key*. See {@link realpathFrom}.
 */
export type RealpathTable = ReadonlyMap<string, string>;

/**
 * Canonicalize every path in `paths` — the only place I/O is legal for this
 * fact, and the pass that must run *before* any judging.
 *
 * ⚠️ **Rows are keyed by the input path string exactly as given** — not a
 * dirname, not a re-resolved form. {@link realpathFrom} looks that same string
 * up, so any normalization applied here and not there is a silent miss (a loud
 * one, in fact: the judge throws). Contrast {@link fillPathSpellings}, which
 * keys by (walk root, target) *because* many references share one walk; here the
 * answer is per path, so the path is the key.
 *
 * Distinct paths are canonicalized **concurrently**: the shape this replaces
 * asked one path at a time at judgement time, which serialised every `realpath`
 * behind the previous path's `await`. De-duplication is by path, so the same
 * path passed N times costs one syscall; the call itself goes through
 * {@link FsLookupCache.realpath}, which memoizes and shares in-flight promises
 * across fills.
 *
 * @param paths - Paths to canonicalize
 * @param fsCache - Per-run lookup cache (one instance per validation run)
 * @returns The filled table; empty input yields an empty table with no syscalls
 */
export async function fillRealpaths(
  paths: Iterable<string>,
  fsCache: FsLookupCache
): Promise<RealpathTable> {
  const distinctPaths = new Set(paths);

  const table = new Map<string, string>();
  await Promise.all(
    [...distinctPaths].map(async (filePath) => {
      table.set(filePath, await fsCache.realpath(filePath));
    })
  );

  return table;
}

/**
 * Read the canonical path for `filePath` out of an already-filled table. Pure.
 *
 * **A miss throws rather than degrading to a recomputed realpath.** The fill set
 * is derived from exactly the paths the judge will be asked about, so a missing
 * key is a programming error — a path judged that nobody filled. Recomputing it
 * would answer *correctly* and silently reintroduce the per-path syscall this
 * column exists to remove: a regression no test of the verdict could catch,
 * because the verdict would be identical, only slower.
 *
 * The row IS the answer here — nothing further has to judge it — so this lookup
 * is itself the judge for this column.
 *
 * **The signature is not what keeps this free of I/O — a test is.** As with
 * {@link pathSpellingFrom}, this module imports `node:fs` and
 * `node:fs/promises` at module scope, so withholding a {@link FsLookupCache} from
 * the parameter list prevents nothing. The guard is
 * `packages/utils/test/fs-utils.test.ts` → *"judges from a filled table, reaching
 * neither the async nor the sync realpath"*, which spies `nodeFs.realpath` and
 * `nodeFs.realpathSync` on the module default objects, proves both instruments
 * attached with a positive control, and asserts zero calls across judgement.
 *
 * @param table - Table filled by {@link fillRealpaths}
 * @param filePath - Path being asked about, as it was handed to the fill
 * @returns The canonical path, with forward slashes on every platform
 * @throws If `table` holds no row for `filePath`
 */
export function realpathFrom(table: RealpathTable, filePath: string): string {
  // `undefined` can only mean "absent key": a filled row is always a string,
  // because `FsLookupCache.realpath` falls back to the deepest existing
  // ancestor's canonical path rather than leaving an unresolvable path without
  // an answer.
  const realPath = table.get(filePath);
  if (realPath === undefined) {
    throw new Error(
      `No canonical path for "${filePath}". Fill it with fillRealpaths() before judging.`
    );
  }

  return realPath;
}

/**
 * Errno codes meaning "the filesystem refused this path", as opposed to a defect
 * in our own code.
 *
 * Shared because two lanes need the same answer and must not drift: `vat audit`
 * decides whether to degrade a scan over a tree it does not own, and the skill
 * packager decides whether a `files:` match is copyable. A second, independently
 * written list is how those two come to disagree about what counts as the
 * environment's fault.
 *
 * The set is deliberately broad. An earlier, "conservative" version omitted
 * `ENOTSUP` — the errno of the very issue this was written for — along with
 * `EEXIST`, which an ordinary two-entry `files:` config reaches with no
 * permissions involved at all. Both escaped raw. Every code here means the OS
 * refused a syscall on a path; none of them can be produced by a type error or a
 * logic bug in our own code, which is the only distinction the callers need.
 *
 * `EIO` and `EBUSY` are included even though they can indicate failing hardware:
 * neither caller *swallows* anything, each reports the path and the OS message,
 * so a dying disk surfaces once per affected path. Aborting the run instead would
 * report less. `ENOENT` is included because a bulk scan races real filesystems —
 * an entry listed by `readdir` can be gone by the time it is opened.
 */
const FILESYSTEM_ACCESS_ERRNOS: ReadonlySet<string> = new Set([
  // Permission and ownership
  'EACCES', 'EPERM', 'EROFS',
  // Presence and shape
  'ENOENT', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'ELOOP', 'ENAMETOOLONG',
  // Capability of the object or filesystem
  'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ETXTBSY', 'EINVAL',
  // Resource exhaustion and transient device state
  'ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE', 'EIO', 'EBUSY', 'EAGAIN',
  // Network filesystems
  'ESTALE', 'ETIMEDOUT', 'EHOSTDOWN', 'ENETDOWN',
  // Windows surfaces this for reparse points and some network paths
  'UNKNOWN',
]);

/**
 * Whether `error` is the filesystem refusing a path rather than a bug.
 *
 * Deliberately NOT `error instanceof Error`: the point of every caller is to
 * degrade on a hostile tree, and a `TypeError` from a validator is not that.
 * Treating one as environmental turns a real defect into a warning about
 * whichever file it happened on — which makes a tool quietest exactly when it is
 * most wrong.
 *
 * Walks `cause`, because the errno is routinely re-wrapped on its way up. The CLI
 * config loader turns a read failure into `new Error('Failed to load config: …')`;
 * without following the chain the predicate answered "not a filesystem error" for
 * a plain `EACCES`, and an unreadable config aborted a whole `vat audit` run. Any
 * layer that adds context to an OS error defeats a `code`-only check, so the check
 * cannot be `code`-only.
 */
export function isFilesystemAccessError(error: unknown): boolean {
  // Bounded: a malformed `cause` chain must not become an infinite loop here.
  for (let current: unknown = error, depth = 0; depth < 10; depth++) {
    if (typeof current !== 'object' || current === null) return false;
    if ('code' in current) {
      const { code } = current as { code: unknown };
      if (typeof code === 'string' && FILESYSTEM_ACCESS_ERRNOS.has(code)) return true;
    }
    if (!('cause' in current)) return false;
    current = (current as { cause: unknown }).cause;
  }
  return false;
}
