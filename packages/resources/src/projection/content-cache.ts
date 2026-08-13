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
  /** Reads served from an entry already held. */
  readonly hits: number;
  /** Reads that touched the disk. */
  readonly misses: number;
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
  #hits = 0;
  #misses = 0;
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
   * @param absolutePath - Absolute path to read
   * @param parserKind - The parser these bytes will actually be handed to
   * @returns The content, its key, and the parser it routes to
   * @throws Whatever `readFile` throws — callers decide whether that is fatal
   */
  async read(absolutePath: string, parserKind: ParserKind): Promise<KeyedContent> {
    const key = cacheKey(absolutePath, parserKind);
    const held = this.#entries.get(key);
    if (held !== undefined) {
      this.#hits += 1;
      return held;
    }
    this.#misses += 1;
    const keyed = await readContentWithKey(absolutePath, parserKind);
    this.#entries.set(key, keyed);
    this.#bytesHeld += keyed.byteLength;
    return keyed;
  }

  /** What this cache has done so far. */
  get stats(): ContentCacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
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
 * @returns The content, its key, and the parser it routes to
 */
export async function readKeyedContent(
  absolutePath: string,
  parserKind: ParserKind,
  cache?: RunContentCache | undefined,
): Promise<KeyedContent> {
  return cache === undefined
    ? readContentWithKey(absolutePath, parserKind)
    : cache.read(absolutePath, parserKind);
}

/** The `(path, parserKind)` pair an entry is filed under. */
function cacheKey(absolutePath: string, parserKind: ParserKind): string {
  // The space is a separator, not decoration — the same construction
  // `mintResourceId` uses. A parser kind is `markdown` or `html` and contains no
  // space, so no two distinct pairs can spell one key.
  return `${parserKind} ${toForwardSlash(safePath.resolve(absolutePath))}`;
}
