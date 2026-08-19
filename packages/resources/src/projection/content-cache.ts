/**
 * The **per-run** content cache: one read, one SHA-256, per file per population.
 *
 * ## The defect this exists for
 *
 * `readContentWithKey` caches nothing — every call is a fresh `readFile` plus a
 * fresh digest. A path realized by both the git extent and the filesystem extent
 * was therefore read and hashed **twice**, and `blob-population.ts` then read it
 * a **third** time to parse it. Measured on this repository: base pass 1 12.9s
 * (filesystem 8.2s, git 4.4s) plus ~13s of blob population, over a 40.8 MB
 * corpus that is 4,882 files. The corpus bytes were traversed ~3× per run.
 *
 * ## Why it is an object threaded through the run, and never a module global
 *
 * A module-level memo would outlive the run: it would leak across two
 * populations in one process (every test file in this package runs in one
 * process), and — the part that is correctness rather than hygiene — two
 * populations of a *changed* tree would silently share bytes, so the second run
 * would describe the first run's corpus. The lifetime of this cache is exactly
 * the lifetime of the `ProjectionBuilder` that holds it, which is exactly one
 * population.
 *
 * ## The key covers the parser kind, not only the path
 *
 * `content-key.ts` states the rule this follows: *a key must cover every input
 * the cached value depends on*. A {@link KeyedContent} is a function of the
 * bytes **and** the parser they route to — `computeContentKey` mixes the parser
 * kind into the hash preimage, because identical bytes at `x.md` and `x.html`
 * legitimately produce different parse results. Keying on the path alone would
 * let a caller asking for the `markdown` reading of a path be served the `html`
 * reading of the same path: a well-formed entry with the wrong contents, the one
 * failure class fail-soft handling explicitly does not cover.
 *
 * The path component is `toForwardSlash(safePath.resolve(path))` — deliberately
 * the **same** spelling `ResourceIdentityMap.idFor` memoizes on, and deliberately
 * **not** a `realpath`. Node's two `realpath` implementations disagree about the
 * casing they return (`realpathSync` preserves the casing asked for, the async
 * one returns the casing on disk), and this module is not the place to add a
 * third opinion about canonicalization. The cost of not resolving symlinks here
 * is that a link and its target are two entries holding the same bytes — a
 * missed saving, never a wrong answer.
 *
 * ## What this changes about mid-run corpus changes — decided, not accidental
 *
 * See {@link RunContentCache.read}. A population now describes **one consistent
 * instant** rather than a smear across whichever contributor read first.
 *
 * ## Memory
 *
 * Entries are held for the whole run and nothing evicts them, so a run holds its
 * corpus's decoded bytes. That is the honest trade for reading each file once,
 * and an LRU would undo it while making the semantics above depend on eviction
 * order. What actually bounds the footprint is **not keying bytes nobody reads**
 * — the demand-driven keying work — not a smaller cache.
 */

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { type KeyedContent, type ParserKind, readContentWithKey } from '../content-key.js';

/** What one run's cache did, for anyone measuring it. */
export interface ContentCacheStats {
  /** Reads served from an entry already held for the same path. */
  readonly hits: number;
  /** Reads that touched the disk. */
  readonly misses: number;
  /**
   * Reads served from a **different path** that an enumeration source said holds
   * identical bytes — see {@link RunContentCache.read}. Counted separately from
   * `hits` because it is the only saving whose soundness rests on something
   * outside this class, and a number nobody can see is a claim nobody can check.
   */
  readonly hintHits: number;
  /** Distinct `(path, parserKind)` pairs held. */
  readonly entries: number;
  /** Raw bytes held, summed over the entries. */
  readonly bytesHeld: number;
}

/**
 * One population's read-and-key memo.
 *
 * Construct one per run and thread it — `populate` → `ProjectionBuilder` →
 * `ProjectionBase` → a contributor's `RealizationContext` → `collectRealization`,
 * and the blob-derivation stage reads it back off the same base. See the module
 * docstring for why it is not a singleton.
 */
export class RunContentCache {
  readonly #entries = new Map<string, KeyedContent>();
  /**
   * `(contentHint, parserKind)` → what those bytes decoded and keyed to.
   *
   * Separate from {@link #entries} rather than a second key into it, because the
   * two answer different questions: one is "did this run already read THIS
   * path", the other is "did this run already read bytes an enumerator says are
   * identical to this path's". Collapsing them would make a hint miss look like
   * a path miss in the statistics, which is the one number that makes the hint's
   * soundness auditable.
   *
   * ## ⛔ The hint is git's blob OID, and it is not a hash of what is on disk
   *
   * `crawl-source.ts` sets `contentHint` from `entry.oid`. Git hashes the
   * **cleaned** content — after `text`/`eol` conversion, after any `filter.*`
   * clean, after `working-tree-encoding`. `computeContentKey` hashes the **raw
   * working-tree bytes**, and `content-key.ts` says so where it reads them: *the
   * key must be over what was on disk*. Those are two different preimages, so
   * this map is keyed on something that is not the thing it stands in for.
   *
   * The load-bearing fact is not that conversion *may* apply. It is that one OID
   * names more than one byte string, in one repository, at one instant.
   * Measured in throwaway repos under `GIT_CONFIG_NOSYSTEM=1`, from identical
   * source content under a two-line `.gitattributes` (`dirA/*.md eol=lf`,
   * `dirB/*.md eol=crlf`):
   *
   * ```text
   * dirA/same.md  7a28df3c975fa62270a452251c4e0b24d685c4ba  worktree 23 B  ┐ one OID,
   * dirB/same.md  7a28df3c975fa62270a452251c4e0b24d685c4ba  worktree 27 B  ┘ two files
   * ```
   *
   * So the key is **many-to-one** against working-tree bytes, and that settles
   * the shape of the remedy: **no normalize-on-read can repair a many-to-one
   * key.** Whichever path did not populate the entry is handed the other path's
   * content *and* the other path's `contentKey` — the well-formed-entry-wrong-
   * contents failure the rest of this module is built to exclude, arriving with
   * no error and nothing in the key to read it off.
   *
   * Four mechanisms produce the divergence, all silent on the read path,
   * measured against a 23 B LF source, with a control that must not diverge:
   *
   * | mechanism | worktree | blob | equal |
   * |---|---|---|---|
   * | `*.md text eol=crlf` | 27 B | 23 B | no |
   * | `core.autocrlf=true`, no attributes | 27 B | 23 B | no |
   * | `filter=demo` clean/smudge | 17 B | 19 B | no |
   * | `working-tree-encoding=UTF-16` | 26 B | 12 B | no |
   * | `*.bin -text` — the control | 17 B | 17 B | yes |
   *
   * The control is what proves the harness was not printing `no` at everything.
   * `working-tree-encoding` moved 12 B → 26 B and the clean filter changed the
   * token text itself, so neither "it is only CRLF, strip it" nor a byte-length
   * comparison is a detector. (Git LFS pointer blobs are a further route by
   * LFS's own design; that one is asserted from the design, **not** measured —
   * `git-lfs` was not installed.) None of this needs a hostile repository: a
   * monorepo with per-directory `.gitattributes` produces it, and
   * `core.autocrlf=true` is the Windows installer default on trees that are not
   * ours.
   *
   * ## Why this repository's own corpora cannot detect it
   *
   * VAT's root `.gitattributes` pins `* text=auto eol=lf` with explicit per-type
   * `eol=lf`, and sets no `core.autocrlf`, no `core.eol` and no `filter.*`; on
   * macOS the worktree bytes and the blob bytes are then equal by construction.
   * All 313 hint hits measured over this repository's 8,548-file corpus were
   * sound. An equality assertion over these corpora is therefore **vacuous** —
   * it holds for a reason that has nothing to do with the hint being safe, which
   * is exactly how this survived being looked at.
   *
   * ## Which lane is exposed
   *
   * A hint reaches this map only from `GitCrawlSource` (`FilesystemCrawlSource`
   * reports `contentHint: null`) and only when the read happens at all.
   * `buildResourcePopulation` registers the filesystem extent with
   * `contentDemand: 'deferred'`, so `keyOrState` returns before
   * `readKeyedContent` and the resources lane consumes no hint. Inventory's
   * `buildInventoryPopulation` registers it with the default
   * `deferGitignored` and runs the blob stage over what it keys, so the hint is
   * **live** there.
   *
   * Dormant is not fixed. The safe direction for anyone widening where a hint is
   * offered or consumed is to **stop using the hint**, not to normalize what it
   * names.
   */
  readonly #byHint = new Map<string, KeyedContent>();
  #hits = 0;
  #misses = 0;
  #hintHits = 0;
  #bytesHeld = 0;

  /**
   * Read and key a path, or return what this run already read there.
   *
   * ## First read wins, and that is the semantics being chosen
   *
   * A file rewritten *during* a population is not re-observed: every later
   * consumer in the run is handed the bytes the run first saw. This is a
   * deliberate behaviour change, and it is what makes a population describe one
   * consistent instant instead of a smear across whichever contributor happened
   * to read first — a projection whose realization row names one blob while its
   * `blobs` row describes different bytes is not a more truthful projection, it
   * is an inconsistent one.
   *
   * **What it costs:** `blob-population.ts`'s `BLOB_CONTENT_CHANGED` and
   * `BLOB_UNREADABLE` conditions become *unreachable for any path this run
   * already read* — which, inside `populate()`, is every path a blob is derived
   * from. (`BLOB_CONTENT_CHANGED` has fired in practice: an editor saving during
   * a 33-second whole-corpus run, recorded in `docs/architecture/zones.md`.)
   * Both guards deliberately stay: `populateBlobs` is also reachable from a
   * builder assembled without a cache, where a target's bytes genuinely were not
   * read by this run, and a fresh read there can still disagree with the key the
   * row carries. Filing *those* bytes under *this* key would be the well-formed-
   * entry-wrong-contents failure, cache or no cache.
   *
   * Pinned by `projection-blob-population.test.ts` — "serves the bytes the base
   * read" (with a cache) alongside "refuses to derive a blob from bytes that no
   * longer key to it" (without one). The pair is what stops either semantics
   * drifting silently.
   *
   * A read failure is **not** cached: it is not a value, and a caller that
   * treats an unreadable file as a fact about the corpus (`collectRealization`
   * records a null key) has already handled it.
   *
   * ## `contentHint` — the one saving that skips the read entirely
   *
   * An enumeration source may already know a byte identity for a path: the git
   * source hands over the blob OID from its snapshot. Two paths with the same
   * OID were taken to hold the same bytes, so the second one's content and key
   * are already in hand and no `readFile` need happen at all. On a real corpus
   * that is not a curiosity — repeated licence files, generated stubs, and every
   * empty file in the tree share one OID.
   *
   * ⛔ **That premise is false in general.** An OID names the *cleaned* bytes,
   * and one OID can name two different working-tree byte strings in one
   * repository at one instant — demonstrated on {@link #byHint}, which also
   * records which lane is exposed. Read it before widening where a hint is
   * offered or consumed.
   *
   * This is the *lookup hint whose miss is free* that `content-key.ts` permits,
   * and it stays inside three conditions — necessary, and, per {@link #byHint},
   * not sufficient:
   *
   * - **The stored key is still hashed from the bytes**, never derived from the
   *   OID. A hint only chooses which already-computed answer to reuse; it never
   *   becomes an identity. A miss reads and hashes exactly as before.
   * - **The caller must not offer a hint for a symlink** (whose OID names the
   *   link target string, not the bytes a follower reads) or for a submodule
   *   (whose OID is a commit). `EnumeratedPath.contentHint` is null for both, so
   *   the exclusion is made at the only place that can see the mode.
   * - **A hint hit returns the content too**, so a row keyed from the memo never
   *   goes back to disk for its bytes and cannot bind an old key to new ones.
   *
   * ⚠️ **What it widens.** `#entries` first-read-wins already means a file
   * rewritten mid-population is not re-observed. A hint extends that window: the
   * OID was computed when the source enumerated, so a path whose bytes changed
   * between enumeration and realization is served the bytes it had at
   * enumeration. That is the same instant the rest of the population describes —
   * a projection consistent as of when it started, rather than a smear — but it
   * is a wider window than a per-path read, and it is a deliberate choice rather
   * than an oversight.
   *
   * @param absolutePath - Absolute path to read
   * @param parserKind - The parser these bytes will actually be handed to
   * @param contentHint - A byte identity the enumerator already computed, when it
   *   has one that is sound for this path
   * @returns The content, its key, and the parser it routes to
   * @throws Whatever `readFile` throws — callers decide whether that is fatal
   */
  async read(
    absolutePath: string,
    parserKind: ParserKind,
    contentHint?: string | undefined,
  ): Promise<KeyedContent> {
    const key = cacheKey(absolutePath, parserKind);
    const held = this.#entries.get(key);
    if (held !== undefined) {
      this.#hits += 1;
      return held;
    }

    // Asked before the read, answered from bytes some other path already
    // supplied. The path entry is still recorded below, so a second visit to
    // THIS path is an ordinary hit rather than a second hint lookup.
    const hintKey = contentHint === undefined ? undefined : cacheKey(contentHint, parserKind);
    if (hintKey !== undefined) {
      const shared = this.#byHint.get(hintKey);
      if (shared !== undefined) {
        this.#hintHits += 1;
        this.#entries.set(key, shared);
        return shared;
      }
    }

    this.#misses += 1;
    const keyed = await readContentWithKey(absolutePath, parserKind);
    this.#entries.set(key, keyed);
    if (hintKey !== undefined) {
      this.#byHint.set(hintKey, keyed);
    }
    // Counted once per READ, not once per entry: a hint hit adds an `#entries`
    // row pointing at bytes already counted, and counting it again would report
    // a footprint the process is not paying.
    this.#bytesHeld += keyed.byteLength;
    return keyed;
  }

  /** What this cache has done so far. */
  get stats(): ContentCacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      hintHits: this.#hintHits,
      entries: this.#entries.size,
      bytesHeld: this.#bytesHeld,
    };
  }
}

/**
 * Read through a run's cache when there is one, and straight from disk when
 * there is not.
 *
 * One function rather than the same three-line conditional at every call site:
 * `collectRealization` and the blob-derivation stage must read *identically* or
 * the second one is not reusing the first one's read.
 *
 * @param absolutePath - Absolute path to read
 * @param parserKind - The parser these bytes will actually be handed to
 * @param cache - The run's cache, or absent for a caller outside a population
 * @param contentHint - A byte identity the enumerator already computed. Ignored
 *   without a cache: a hint's whole mechanism is reusing another path's read,
 *   and outside a run there is no other read to reuse
 * @returns The content, its key, and the parser it routes to
 */
export async function readKeyedContent(
  absolutePath: string,
  parserKind: ParserKind,
  cache?: RunContentCache | undefined,
  contentHint?: string | undefined,
): Promise<KeyedContent> {
  return cache === undefined
    ? readContentWithKey(absolutePath, parserKind)
    : cache.read(absolutePath, parserKind, contentHint);
}

/** The `(path, parserKind)` pair an entry is filed under. */
function cacheKey(absolutePath: string, parserKind: ParserKind): string {
  // The space is a separator, not decoration — the same construction
  // `mintResourceId` uses. A parser kind is `markdown` or `html` and contains no
  // space, so no two distinct pairs can spell one key.
  return `${parserKind} ${toForwardSlash(safePath.resolve(absolutePath))}`;
}
