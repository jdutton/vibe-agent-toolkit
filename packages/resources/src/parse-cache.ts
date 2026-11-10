/**
 * Cross-process, content-addressed, disk-backed cache of markdown/HTML parse
 * facts.
 *
 * Parsing dominates every resource-reading command in the toolkit — measured at
 * 80.4% of `vat resources validate`'s library time. Over VAT's own 265 tracked
 * markdown files, against the real built parser:
 *
 * ```text
 * cold parse      1,177 ms   (4.44 ms/doc)
 * warm hit           26 ms   (0.098 ms/doc)   → 45x
 * entries on disk   484 KiB against a 2,322 KiB corpus (21%)
 * deepStrictEqual over all 265 docs: 0 divergences
 * ```
 *
 * ## Why disk, and not a per-process memo
 *
 * `vat validate`, `vat verify` and `vat build` enumerate nothing in-process —
 * each `spawnSync`s the vat binary once per phase. A per-process cache is
 * therefore worth exactly zero to the three top-level verbs a user actually
 * runs. Only a cache that outlives the process helps them.
 *
 * ## What an entry holds — and what it deliberately does NOT
 *
 * An entry stores **parse facts only**. It never stores `content`. The caller
 * has already read the file (it had to, in order to compute the key — see
 * `content-key.ts`), so `content` and `sizeBytes` are re-attached from that
 * fresh read on every hit. Two consequences, both intended:
 *
 * - **Size.** Entries are ~21% of corpus size instead of ~120%.
 * - **Confidentiality.** The exposure in a world-visible temp directory shrinks
 *   from "a full plaintext copy of the corpus" to "link text, heading text and
 *   frontmatter". That is still not nothing, which is why directories are
 *   created `0700` (see below).
 *
 * | Field | Fate |
 * |---|---|
 * | `links`, `headings`, `estimatedTokenCount` | stored |
 * | `anchors`, `parseErrors`, `unresolvedReferences`, `lexicalReferences`, `contentMeasures` | stored when present |
 * | `frontmatterSource`, `frontmatterError`, `frontmatterNotAMapping` | stored when present |
 * | `frontmatterValue` | the decoded mapping, encoded (`frontmatter-codec.ts`), when present |
 * | `content`, `sizeBytes` | **never stored** — re-attached from `KeyedContent` |
 * | `frontmatter` | **never stored as an object** — rebuilt from `frontmatterValue` |
 *
 * ## Why frontmatter is cached as the worker's ENCODED decode, never re-decoded
 *
 * A hit never decodes YAML. `yaml` recurses once per nesting level, so a
 * decode on this thread is an unbounded parse beside the bounded one (ADR I8):
 * a 1,000-level `a: [[[…]]]` overflows the main thread's stack, and its
 * outcome would hang on the stack, not on the bytes. The decode runs once, in
 * the parse worker under its `stackMb`, and its result is stored in the tagged,
 * flat encoding `frontmatter-codec.ts` defines — lossless for every value
 * `yaml` produces (`.inf`, `.nan`, `-0`, `!!binary`, `!!set`, `!!omap`,
 * `!!timestamp`, shared and cyclic anchors), which plain JSON is not.
 * {@link rehydrate} rebuilds `frontmatter` from it with a loop, at any depth.
 *
 * ## Standing constraint: never hand out a shared object
 *
 * `packages/agent-skills/src/skill-packager.ts` mutates `link.resolvedId` **in
 * place** on links that came out of a parse. If two callers were served the
 * same `ParseResult`, one skill's bundle would change which branch another
 * skill's link walker takes — a real, previously-verified defect class.
 * `JSON.parse` mints a fresh object graph on every read, which is exactly what
 * makes the disk path safe.
 *
 * **Therefore: no in-memory memo of a deserialized entry.** If a future
 * in-process layer is added it must memoize the serialized *string* and
 * `JSON.parse` per `get` — never the object.
 *
 * ## Versioning
 *
 * There is no version number here or anywhere else, on purpose. The content key
 * covers the parser's *inputs* and cannot see a change to the parser itself, so
 * that is handled one level up by the namespace directory in
 * `cache-namespace.ts`: an installed VAT gets a namespace per release, a dev
 * checkout one per worktree.
 *
 * What guards the *shape* stored here is {@link ParseFactsSchema} — a real
 * schema at the read boundary, so an entry that disagrees with this build about
 * what a link or a heading is becomes a miss rather than a plausible answer.
 * Read that schema's docstring before changing `dehydrate`/`rehydrate`: it is
 * explicit about the one class it cannot catch (adding an *optional* field,
 * where "written before the field existed" and "legitimately absent" are the
 * same bytes), and `vat cache clear` is the escape hatch for exactly that case.
 *
 * ## Layout
 *
 * `<normalizedTmpdir()>/.vat-cache/<namespace>/parse/<shard>/<key>.json`, where
 * `<namespace>` identifies the build of VAT (see `cache-namespace.ts`) and
 * `<shard>` is the last two characters of the key. Those are hex, so this is a clean
 * 256-way fan-out that needs no parsing of the key's internal structure. The
 * `parse/` level exists so a future `vat cache clear` — and the OS's own temp
 * purge — have a coarse handle on this tenant alone.
 *
 * `<tmpdir>/.vat-cache/` is **shared**: the external-link validation cache
 * lives at `<tmpdir>/.vat-cache/external-links.json`, and linkAuth's content
 * cache at `<tmpdir>/.vat-cache/auth-<user>/`. Those two stay OUTSIDE the
 * namespace deliberately — URL reachability and fetched link content are facts
 * about the world, not about this build, so re-fetching them on every VAT
 * upgrade would be waste. Only tenants whose contents VAT's own code determines
 * (this one, and a `projection-<shapeDigest>/` store when it lands) sit under
 * the namespace.
 *
 * ## Failure model
 *
 * Fail-soft, in both directions: any read failure (ENOENT, EACCES, corrupt
 * JSON, structurally wrong payload) is a **miss**; any write failure (EACCES,
 * ENOSPC, EROFS, or an unsafe pre-existing shard directory) is a **no-op**,
 * counted in {@link ParseCacheStats.writeFailures} so it stays distinguishable
 * from a legitimately cold cache. A non-persisted entry costs one cold parse
 * on the next run; an exception costs the whole current run.
 *
 * Be precise about what that does *not* cover: fail-soft catches **corruption,
 * not wrongness**. A well-formed entry filed under the wrong key is
 * indistinguishable from a correct hit, and no amount of defensive IO handling
 * will notice. That is why the key rules in `content-key.ts` (hash the raw
 * bytes, hash on read, mix in the parser kind) are load-bearing rather than
 * fussy.
 */

import { promises as fs, type Stats } from 'node:fs';
import { threadId } from 'node:worker_threads';

import {
  applyTreePlan,
  fsFaultOf,
  isPathAbsentError,
  isVatError,
  parseEnvBoolean,
  planTreeChanges,
  renameFileAtomic,
  safePath,
  VatError,
} from '@vibe-agent-toolkit/utils';

import { parseCacheDirectory } from './cache-namespace.js';
import { CONTENT_KEY_PATTERN, type KeyedContent } from './content-key.js';
import { decodeFrontmatterValue, encodeFrontmatterValue, FRONTMATTER_VALUE_MALFORMED } from './frontmatter-codec.js';
import type { ParseResult } from './link-parser.js';
import type { DocumentParserKind } from './mime-type.js';
import { storableUnderDefaultLimits } from './parse-limits.js';
import {
  parseTimingStart,
  recordTierPass,
  TierPass,
} from './parse-timing.js';
import type { HarnessId } from './projection/harness/profile.js';
import { type ParseFacts, ParseFactsSchema } from './schemas/parse-facts.js';

/**
 * Directory mode for every directory this cache creates.
 *
 * **POSIX only.** On Windows, `mode`/`chmod` toggles nothing but the read-only
 * bit — the confidentiality argument in the module docstring simply does not
 * apply there, and nothing in this file should be read as claiming otherwise.
 */
const CACHE_DIR_MODE = 0o700;

/** Last-two-characters fan-out. See "Layout" in the module docstring. */
const SHARD_LENGTH = 2;

/**
 * Keys are produced by `computeContentKey`, but `get`/`set` take them from a
 * caller-supplied struct. Pinned to the exact shape `computeContentKey`
 * produces — `<parserKind>.<64 lowercase hex chars>` — rather than a loose
 * charset: a charset like `[\w.-]+` still accepts `..` (both characters are
 * in it, and two in a row are not specially excluded), which would let a key
 * of exactly `..` escape the cache directory by one level in the joins below.
 * Pinning to the real shape rules that out structurally. An unexpected shape
 * is treated as a miss/no-op.
 */
const SAFE_KEY = CONTENT_KEY_PATTERN;

/**
 * Disambiguates concurrent temp files within one ISOLATE.
 *
 * ⚠️ Per-isolate, not per-process, and the difference became load-bearing when
 * {@link ParseCache.setByKey} started being called from parse workers. Each
 * worker thread gets its own module instance and therefore its own counter at
 * zero, while `process.pid` is shared across every thread — so pid + counter
 * alone mints the SAME temp path in two threads that write their first entry
 * concurrently. `threadId` is the third term that closes it, and it is `0` on
 * the main thread so single-threaded names are unchanged in shape.
 *
 * Together the three are collision-free without `Math.random()` or `Date.now()`,
 * neither of which is actually a uniqueness guarantee.
 */
let tempFileCounter = 0;

export type { ParseFacts } from './schemas/parse-facts.js';

/**
 * The entry envelope.
 *
 * No version field: the namespace directory (see `cache-namespace.ts`) carries
 * the build discrimination — per release when installed, per worktree in a dev
 * checkout — and {@link ParseFactsSchema} carries the shape discrimination on
 * read. A serialization change therefore needs no number bumped anywhere; what
 * it needs, in a dev checkout whose namespace deliberately survives a rebuild,
 * is either a shape the schema can reject or a `vat cache clear`.
 */
interface StoredEntry {
  facts: ParseFacts;
}

/**
 * How many parses a cache instance served versus handed back to the parser.
 *
 * Exposed because the cache is otherwise unobservable: it is content-addressed
 * and fail-soft, so a cache that never hits produces exactly the same results as
 * one that always does. Any test asserting cold/warm equivalence is asserting
 * nothing at all unless it can also show the warm run hit.
 */
export interface ParseCacheStats {
  /** Lookups that returned an entry — the parser never ran. */
  hits: number;
  /**
   * Lookups that returned nothing, for any reason: no entry, a corrupt entry,
   * an unusable key, or a disabled cache. Every one of them costs the caller a
   * parse, which is what makes them one number.
   */
  misses: number;
  /**
   * `set()` calls that could not persist an entry: a write error (EACCES,
   * ENOSPC, EROFS, ...) or a pre-existing shard directory that failed the
   * ownership/permission check (see `set`). Tracked separately from `misses`
   * so a persistent write failure cannot masquerade as a legitimately cold
   * cache — both would otherwise report the exact same `{hits: 0, misses: N}`.
   */
  writeFailures: number;
}

/** Options for {@link ParseCache}. Every one of them is injectable for tests. */
export interface ParseCacheOptions {
  /**
   * Explicit on/off. When omitted, the cache is enabled unless `VAT_CACHE` is
   * exactly `'0'` — an explicit option always wins over the environment.
   */
  enabled?: boolean;
  /** Root for entries. Defaults to {@link parseCacheDirectory}. */
  cacheDir?: string;
  /** Environment map. Defaults to `process.env`; read per construction. */
  env?: NodeJS.ProcessEnv;
}

export { parseCacheDirectory, vatCacheNamespace, vatCacheNamespaceRoot, vatCacheRoot } from './cache-namespace.js';


/**
 * Reduce a parse result to the facts an entry may hold.
 *
 * Pure, and exported separately from the IO so the interesting half is unit
 * testable on its own. Uses conditional spread rather than assigning
 * `undefined`, so no own property is ever valued `undefined` — that is what
 * makes the JSON round trip exact under `toStrictEqual`.
 *
 * @param result - A fresh parse result
 * @returns Only the fields that are a function of the parsed bytes
 */
export function dehydrate(result: ParseResult): ParseFacts {
  return {
    links: result.links,
    headings: result.headings,
    estimatedTokenCount: result.estimatedTokenCount,
    ...(result.anchors !== undefined && { anchors: result.anchors }),
    ...(result.parseErrors !== undefined && { parseErrors: result.parseErrors }),
    ...(result.unresolvedReferences !== undefined && {
      unresolvedReferences: result.unresolvedReferences,
    }),
    ...(result.lexicalReferences !== undefined && {
      lexicalReferences: result.lexicalReferences,
    }),
    ...(result.contentMeasures !== undefined && {
      contentMeasures: result.contentMeasures,
    }),
    ...(result.frontmatterSource !== undefined && {
      frontmatterSource: result.frontmatterSource,
    }),
    ...(result.frontmatter !== undefined && {
      frontmatterValue: encodeFrontmatterValue(result.frontmatter),
    }),
    ...(result.frontmatterError !== undefined && { frontmatterError: result.frontmatterError }),
    ...(result.frontmatterNotAMapping === true && { frontmatterNotAMapping: true }),
  };
}

/**
 * Rebuild a full parse result from stored facts plus a **fresh read**.
 *
 * `content` and `sizeBytes` come from `keyed`, never from the entry: the caller
 * already holds the bytes, and `sizeBytes` is a raw byte count that is not
 * recoverable from the decoded string (invalid UTF-8 decodes to U+FFFD and
 * re-encodes to three bytes, so the round trip does not preserve length).
 *
 * `frontmatter` is rebuilt from `frontmatterValue`, the worker's own decode,
 * so a cache hit and a cold parse cannot disagree — and no YAML is decoded on
 * this thread (see "Why frontmatter is cached as the worker's ENCODED decode").
 *
 * @param facts - The stored facts
 * @param keyed - The fresh read whose key selected those facts
 * @returns A parse result equal to what the parser would have produced
 * @throws A `VatError` coded `FRONTMATTER_VALUE_MALFORMED` when the stored
 *   encoding is not one this build wrote; `get` reads that as a miss
 */
export function rehydrate(facts: ParseFacts, keyed: KeyedContent): ParseResult {
  return {
    links: facts.links,
    headings: facts.headings,
    ...(facts.anchors !== undefined && { anchors: facts.anchors }),
    ...(facts.parseErrors !== undefined && { parseErrors: facts.parseErrors }),
    ...(facts.unresolvedReferences !== undefined && {
      unresolvedReferences: facts.unresolvedReferences,
    }),
    ...(facts.lexicalReferences !== undefined && {
      lexicalReferences: facts.lexicalReferences,
    }),
    ...(facts.contentMeasures !== undefined && {
      contentMeasures: facts.contentMeasures,
    }),
    ...(facts.frontmatterSource !== undefined && {
      frontmatterSource: facts.frontmatterSource,
    }),
    ...(facts.frontmatterValue !== undefined && {
      frontmatter: decodeFrontmatterValue(facts.frontmatterValue),
    }),
    ...(facts.frontmatterError !== undefined && { frontmatterError: facts.frontmatterError }),
    ...(facts.frontmatterNotAMapping === true && { frontmatterNotAMapping: true }),
    content: keyed.content,
    sizeBytes: keyed.byteLength,
    estimatedTokenCount: facts.estimatedTokenCount,
  };
}

/**
 * {@link rehydrate}, with an entry whose frontmatter encoding is not one this
 * build wrote read as a miss — the same fail-soft rule as every other
 * malformed entry ({@link readFacts}). The caller then parses the document
 * again through the worker, so a corrupt entry costs one re-parse, never the
 * run. The codec refuses everything it did not write with
 * `FRONTMATTER_VALUE_MALFORMED`; any other throw is a defect in VAT, not in
 * the entry, and stays loud, as a bug in this class does in `get`.
 *
 * @param facts - Facts that passed the schema
 * @param keyed - The fresh read whose key selected them
 * @returns The parse result, or `null` when the entry's encoding is malformed
 */
function rehydrateOrMiss(facts: ParseFacts, keyed: KeyedContent): ParseResult | null {
  try {
    return rehydrate(facts, keyed);
  } catch (error) {
    if (!isVatError(error, FRONTMATTER_VALUE_MALFORMED)) throw error;
    return null;
  }
}

/**
 * Disk-backed store of parse facts, keyed by content.
 *
 * Every caller reaches it through `parse-dispatcher.ts` (`parseFileCached`,
 * `parseContentCached`, a run's `ParseDispatcher`): a hit is served here, a
 * miss is parsed in the bounded worker pool and filed back. Nothing parses on
 * the calling thread.
 */
export class ParseCache {
  /** Whether reads and writes touch the filesystem at all. */
  readonly enabled: boolean;

  /**
   * Root this instance files entries under.
   *
   * Public because a parse WORKER has to be told which store to write into.
   * Each worker isolate builds its own `ParseCache`, and one built from the
   * default directory while the parent used another would write entries the
   * parent never finds — a silent fall back to re-parsing on the main thread,
   * with every test still green and every result still correct. The pool
   * forwards this through `workerData`.
   */
  readonly directory: string;

  /**
   * Counters behind {@link stats}, cumulative for this instance's life.
   *
   * They live on the cache rather than on each caller because every dispatcher
   * would otherwise keep its own pair, and a run's sizing reads them as deltas.
   */
  private hitCount = 0;
  private missCount = 0;

  /**
   * One in-flight or settled shard preparation per directory — see
   * {@link prepareShard}. Per INSTANCE, never module-level: two caches may be
   * rooted at two directories, and a shared map would answer one's question
   * with the other's directory.
   */
  private readonly preparedShards = new Map<string, Promise<boolean>>();
  private writeFailureCount = 0;

  constructor(options: ParseCacheOptions = {}) {
    // Read the env per construction, never at module load: a module-level read
    // is unobservable to a caller that sets the variable later, and untestable
    // without mutating the real `process.env`.
    const env = options.env ?? process.env;
    // `parseEnvBoolean`, not a comparison against the literal `'0'`: under the
    // old shape `VAT_CACHE=false` left caching ON. An UNPARSABLE value reads as
    // "cache stays on" — this gates a cache, so the cheap failure is a cache
    // the operator meant to disable, not a run that silently changes behaviour.
    // The linkAuth kill switch reads the same `undefined` as "deny" because it
    // gates a capability; the parser deliberately picks neither for you.
    this.enabled = options.enabled ?? parseEnvBoolean(env['VAT_CACHE']) ?? true;
    this.directory = options.cacheDir ?? parseCacheDirectory();
  }

  /**
   * Hit/miss counts for this instance.
   *
   * @returns A snapshot of the counters, cumulative since construction
   */
  get stats(): ParseCacheStats {
    return { hits: this.hitCount, misses: this.missCount, writeFailures: this.writeFailureCount };
  }

  /**
   * Look up the parse facts for an already-read document.
   *
   * Every call is counted, including the ones that short-circuit: a disabled
   * cache and an unusable key are misses in the only sense that matters to a
   * caller — the parser has to run.
   *
   * @param keyed - Content, key and byte length from one read
   * @returns A freshly-minted parse result, or `null` on any kind of miss
   */
  async get(keyed: KeyedContent): Promise<ParseResult | null> {
    const found = await this.read(keyed);
    if (found === null) return this.miss();
    this.hitCount += 1;
    return found;
  }

  /**
   * Look up parse facts WITHOUT counting the lookup as a hit or a miss.
   *
   * The read {@link get} performs, minus the bookkeeping — and the split exists
   * because of one caller that would otherwise corrupt the meaning of both
   * counters. Under cache-as-transport a parse worker files the entry and the
   * parent reads it straight back; that read finds the entry every time, so
   * going through `get` would score a HIT for a document this run demonstrably
   * had to parse. A cold run would then report roughly as many hits as misses,
   * and `ParseDispatcher`'s activation policy — which reads `misses` precisely
   * because "a hit costs no parse" — would be reasoning about a statistic that
   * no longer means that.
   *
   * The TIER rows are charged here rather than in `get`, so a read-back still
   * shows up as the parent-side cost it genuinely is. That is the whole number
   * the transport experiment turns on: what the cache costs the parent per
   * document, counted separately from what the cache SAVED.
   *
   * @param keyed - Content, key and byte length from one read
   * @returns A freshly-minted parse result, or `null` when there is no usable entry
   */
  async read(keyed: KeyedContent): Promise<ParseResult | null> {
    // Before the brackets, deliberately: a disabled cache and an unusable key
    // touch no disk, so charging `cache-read-io` here would publish a
    // per-document read cost for a run that never read anything.
    if (!this.enabled || !SAFE_KEY.test(keyed.key)) return null;

    let raw: string;
    const readStartedAt = parseTimingStart();
    try {

      // eslint-disable-next-line local/no-raw-text-decode -- reading back this cache's own entry, written as UTF-8 by `set()`; a corpus document never lands here
      raw = await fs.readFile(this.entryPath(keyed.key), 'utf-8');
    } catch (error) {
      // ENOENT (never written), EACCES (perms), EISDIR — all a miss. A bug in
      // this class is not a miss and stays loud.
      if (fsFaultOf(error) === undefined) throw error;
      return null;
    } finally {
      // Charged on the miss path too: a failed open is what a COLD document
      // costs the parent, and the arm-A number is worthless without it.
      recordTierPass(TierPass.CacheReadIo, readStartedAt);
    }

    // A second bracket rather than one `cache-read`, because a hit and a miss
    // cost completely different things: a miss pays only the failed open above,
    // a hit pays that plus `JSON.parse`, schema validation and rehydrate. One
    // averaged row would describe neither, and this decode is exactly the work
    // "cache as transport" would make a cold run pay per document.
    const decodeStartedAt = parseTimingStart();
    try {
      const facts = readFacts(raw);
      if (facts === null) return null;

      // `readFacts` returns the product of a fresh `JSON.parse`, so this graph is
      // not shared with any previous caller. See the standing constraint in the
      // module docstring — do NOT memoize this object.
      return rehydrateOrMiss(facts, keyed);
    } finally {
      recordTierPass(TierPass.CacheReadDecode, decodeStartedAt);
    }
  }

  /**
   * Persist the parse facts for an already-read document.
   *
   * Writes to a unique temp name in the destination directory and `rename`s it
   * into place, so two phase processes racing on the same key are benign rather
   * than merely unlikely: `rename` within a directory is atomic, and the loser
   * simply overwrites an identical entry.
   *
   * @param keyed - Content, key and byte length from one read
   * @param result - The parse result to file under that key
   * @returns True when the entry was persisted; see {@link setByKey}
   */
  set(keyed: KeyedContent, result: ParseResult): Promise<boolean> {
    return this.setByKey(keyed.key, result);
  }

  /**
   * Persist parse facts under a content key, without holding the bytes.
   *
   * The primitive {@link set} always was: an entry stores facts only, so the
   * key is the only part of a `KeyedContent` a write has ever consulted.
   * Exposed because a **parse worker** files entries and has no `KeyedContent`
   * to offer — it received a decoded string and a key over the boundary, never
   * a read. Making it fabricate the other fields to reach `set` would put
   * invented decode provenance into a struct nothing reads, which is the same
   * mistake `parse-pool.ts`'s `attachContent` docstring refuses.
   *
   * ⛔ **Every write files only what a default bounded run would admit.** The
   * cache is shared by every run, whatever limits produced an entry, so an
   * entry past the default input or output caps — written by an in-process
   * parse, or by a pool given looser limits, on either side of the thread
   * boundary — would be served to a later default run as an admission that run
   * would have refused: the outcome would hang on what ran first (I0). This is
   * the one place every write passes, so the guard lives here and no caller
   * can forget it. `result.sizeBytes` is the raw byte count every parser is
   * handed.
   *
   * @param key - The content key to file under
   * @param result - The parse result whose facts to store
   * @returns True when the entry was persisted; false when it is not storable
   *   under the default limits, the cache is off, or the write failed. A write
   *   failure is REPORTED here as well as counted, never thrown — see below.
   */
  async setByKey(key: string, result: ParseResult): Promise<boolean> {
    // Outside the bracket for the same reason `get`'s guards are — see there.
    if (!this.enabled || !SAFE_KEY.test(key)) return false;
    if (!storableUnderDefaultLimits(result.sizeBytes, result)) return false;

    const startedAt = parseTimingStart();
    try {
      return await this.write(key, result);
    } finally {
      recordTierPass(TierPass.CacheWrite, startedAt);
    }
  }

  /**
   * The whole of a `set`, so {@link setByKey} is one bracket and one guard.
   *
   * Split out rather than wrapping the body inline because the write is the one
   * cost on either side of the parse tier that a WORKER can pay in parallel:
   * under cache-as-transport it moves off the parent entirely, and it has to be
   * one measurable unit for that move to be readable in a dump.
   *
   * @param key - The content key to file under
   * @param result - The parse result to store
   * @returns True when the entry reached its final path
   */
  private async write(key: string, result: ParseResult): Promise<boolean> {
    const shardDir = this.shardDir(key);

    if (!(await this.prepareShard(shardDir))) {
      this.writeFailureCount += 1;
      return false;
    }

    tempFileCounter += 1;
    const tempPath = safePath.join(
      shardDir,
      `${key}.${String(process.pid)}.${String(threadId)}.${String(tempFileCounter)}.tmp`,
    );
    const entry: StoredEntry = { facts: dehydrate(result) };

    try {
      await fs.writeFile(tempPath, JSON.stringify(entry), 'utf-8');
      await renameFileAtomic(tempPath, this.entryPath(key));
    } catch (error) {
      // Fail-soft: EACCES on the directory, ENOSPC on the disk, EROFS on a
      // read-only mount — counted in `writeFailures` so it stays visible. A
      // bug in this class is not a persistence failure and stays loud. The
      // current run already holds the fresh result; only the persistence is
      // lost. Best-effort sweep of a temp file that was written but never
      // renamed, so a failing write cannot accumulate litter.
      if (fsFaultOf(error) === undefined) throw error;
      this.writeFailureCount += 1;
      await removeTempQuietly(tempPath);
      return false;
    }
    return true;
  }

  /**
   * Make one shard directory fit to write into — **once per cache instance**.
   *
   * ## 🔑 Why this is memoized and the write is not
   *
   * The safety `stat` and the `mkdir` are per-DIRECTORY questions that
   * {@link write} was asking per-ENTRY, and a cold run answers them thousands of
   * times over 256 directories. Measured on a 12.6k-file adopter, cold `vat
   * claude context`: `cache-write` is **1,640 ms for 2,157 entries** on the one
   * thread that cannot be parallelized, and two of its four syscalls per entry
   * are these. Asking them once per shard removes ~2 x (entries − shards) of
   * them — on that run, roughly 3,800 of 8,600 syscalls.
   *
   * The *promise* is memoized rather than its result, so concurrent writers
   * into one shard — which is exactly what a pooled run produces — share a
   * single preparation instead of racing to create the directory each for
   * themselves.
   *
   * ⚠️ **A memoized `true` can go stale, and that is handled by the write
   * failing rather than by re-checking.** If the directory is removed mid-run
   * (a concurrent `vat cache clear`, an OS tmpdir purge) the `writeFile` below
   * raises `ENOENT`, which is a filesystem access error, so the entry is counted
   * in `writeFailures` and the run keeps its fresh result — and so does every
   * later entry filed under that shard, because the memo is not re-asked.
   * Re-checking per entry to close that window is the trade this method exists
   * to refuse: a directory deleted under a running command is rare, and the
   * cost is uncached entries in one shard for the rest of the run, never a
   * wrong answer.
   *
   * ⛔ An OWNERSHIP verdict of `false` is memoized too, and just as
   * deliberately: an unsafe shard is unsafe for the run, and re-`stat`ing it per
   * entry would pay the full cost back to discover the same answer.
   *
   * 🪤 An ERRNO is not a verdict, so it is not memoized. `EMFILE`, `EAGAIN` or
   * `EBUSY` from the `lstat` or the `mkdir` says the process was short of
   * something at that instant, not that the directory is bad; memoizing it
   * would turn one transient refusal into every later entry in the shard going
   * uncached. The entry is evicted, so the next write into the shard asks
   * again. A persistent refusal (`EACCES`, `EROFS`) is therefore re-asked per
   * write — two syscalls per entry, on a run whose writes are all failing
   * anyway.
   *
   * @param shardDir - The directory {@link write} is about to write into
   * @returns True when it is safe and present
   */
  private prepareShard(shardDir: string): Promise<boolean> {
    const prepared = this.preparedShards.get(shardDir);
    if (prepared !== undefined) return prepared;

    const preparing = prepareShardDir(shardDir).then((outcome) => {
      // Evict only the promise this call stored: a `clear()` in between may
      // already have replaced it.
      if (outcome === 'refused' && this.preparedShards.get(shardDir) === preparing) {
        this.preparedShards.delete(shardDir);
      }
      return outcome === 'ready';
    });
    this.preparedShards.set(shardDir, preparing);
    return preparing;
  }

  /**
   * Delete this cache's entire tree.
   *
   * Runs regardless of {@link enabled}: turning reads off must not disarm an
   * explicit operator request to reclaim the space. And it THROWS when the
   * tree cannot be removed: an operator who asked for the space back is told
   * why they did not get it, rather than told nothing. A tree that is already
   * gone is not a failure. The cache is VAT's own state: the tree is moved off
   * its name whole, then deleted, so a concurrent writer that re-prepares its
   * shard starts a fresh tree rather than writing into one being removed.
   */
  async clear(): Promise<void> {
    // FIRST, so a concurrent writer that re-prepares mid-removal loses its
    // directory rather than keeping a memo of one that is being removed.
    this.preparedShards.clear();
    await applyTreePlan(await planTreeChanges([{ op: 'remove', dest: this.directory, ownership: { kind: 'vat-state' }, label: 'parse cache' }]));
  }

  /** Count a miss and return the value every miss path returns. */
  private miss(): null {
    this.missCount += 1;
    return null;
  }

  private shardDir(key: string): string {
    return safePath.join(this.directory, key.slice(-SHARD_LENGTH));
  }

  private entryPath(key: string): string {
    return safePath.join(this.shardDir(key), `${key}.json`);
  }
}

/**
 * The `code` every {@link ParserUnavailableError} carries.
 *
 * ⚠️ It must NEVER be an errno, and the original errno must NEVER be passed
 * through onto `.code`. Every outer error boundary in the toolkit classifies by
 * classifying errno strings — `fsFaultOf` in `packages/utils/src/errors/errno-table.ts`
 * (whose class table holds `EACCES`, `EPERM`, `EMFILE`, `ENOENT` and ~25 more), and every
 * site that classifies through it. An errno here means `vat audit` degrades a broken
 * INSTALL into a `SCAN_PATH_UNREADABLE` warning and exits 0, which is the exact
 * defect this type exists to close. Restoring the original code "so the errno
 * isn't lost" reopens it; the errno is kept in the MESSAGE and on
 * {@link ParserUnavailableError.loaderError} instead, where no allow-list reads it.
 */
const PARSER_UNAVAILABLE_CODE = 'VAT_PARSER_UNAVAILABLE';

/**
 * What a parse worker loads to run a job: a document parser by its kind, or a
 * harness's memory-file reader by the harness's id. Every one is a module the
 * worker imports lazily, so a load that fails is a broken install either way.
 */
export type ParserModuleKind = DocumentParserKind | HarnessId;

/**
 * A parser module could not be loaded — the INSTALL is broken, not a document.
 *
 * ## Why a dedicated type rather than letting the loader's error through
 *
 * Node's ESM loader reads the module through `fs`, so an unloadable parser
 * throws a raw filesystem errno: `EACCES` for a `chmod 000` or quarantined file,
 * `EMFILE` under fd pressure, `ENOENT` for a half-extracted tarball. That is
 * byte-for-byte the shape a genuinely unreadable *document* throws, and every
 * outer boundary that has to survive a hostile tree allow-lists exactly those
 * codes. Hoisting the load out of the per-document `try` (see `loadParser` in `parser-loader.ts`)
 * stopped the failure being blamed on individual documents, but it did not stop
 * the NEXT boundary out from degrading it: measured, `chmod 000` on the built
 * `link-parser.js` still exited 0 with a `SCAN_PATH_UNREADABLE` warning.
 *
 * Hoisting further is an unbounded chase. Making the error structurally
 * un-allow-listable at its origin is not: see {@link PARSER_UNAVAILABLE_CODE} for
 * why `.code` is the load-bearing field and why it must never be an errno.
 *
 * ## Why the original hangs off `loaderError` and NOT off `cause`
 *
 * `fsFaultOf` walks the `cause` chain — deliberately, because the
 * CLI config loader re-wraps read failures and a `code`-only check answered "not
 * a filesystem error" for a plain `EACCES`. So an original `EACCES` reachable via
 * `cause` is found by that walk and the wrapper is degraded anyway: setting
 * `cause` here silently cancels the entire fix. Verified — with `cause` set, the
 * predicate returns `true` for this error.
 *
 * What that costs, stated honestly: VAT never inspects `loaderError`. The CLI's
 * refusal prints `error.message`, and `--debug` prints the
 * WRAPPER's `.stack` — neither reaches an own non-standard property, and no
 * `util.inspect` of this error happens on any shipped path. What actually
 * survives to the operator is what {@link describeLoaderError} folds INTO the
 * message: the loader's own text and its code. `loaderError` is for a debugger,
 * a test, or an embedder that goes looking; the message is the shipped channel,
 * which is why the errno has to be in it.
 */
export class ParserUnavailableError extends VatError {
  /**
   * The loader's own failure, verbatim. Deliberately NOT `cause` — see the class
   * docstring; `cause` is walked by the very predicate this type must not match.
   */
  readonly loaderError: unknown;

  /**
   * @param kind - Which parser module failed to load
   * @param specifier - The module specifier that could not be imported
   * @param loaderError - Whatever the module loader threw
   */
  constructor(kind: ParserModuleKind, specifier: string, loaderError: unknown) {
    // The code is never an errno. See {@link PARSER_UNAVAILABLE_CODE} before changing it.
    super(
      PARSER_UNAVAILABLE_CODE,
      `Cannot load VAT's ${kind} parser module (${specifier}): ${describeLoaderError(loaderError)}. ` +
        'This is a broken VAT installation — the parser itself could not be read or evaluated. ' +
        'No document being scanned is at fault. Reinstall or rebuild VAT.',
    );
    this.loaderError = loaderError;
  }
}

/**
 * Whether a thrown value is a failed parser LOAD — i.e. a broken install.
 *
 * ## Why this is not the blocklist we deleted
 *
 * A previous fix guessed at Node's loader error codes (`ERR_MODULE_NOT_FOUND`,
 * `ERR_DLOPEN_FAILED`, …) and rethrew anything matching. That was a blocklist of
 * SOMEONE ELSE'S codes: its own docstring conceded it could not catch a module
 * that throws while evaluating, and two of its seven entries were CJS-only and
 * unreachable behind `await import()` in a `"type":"module"` package. It is gone,
 * and this is not it.
 *
 * This matches exactly one error type, constructed by VAT, at exactly one place
 * (`importParser` in `parser-loader.ts`). It is therefore **complete by construction**:
 * there is no error a parser load can produce that does not pass through that
 * wrap, so there is no code to enumerate and none to keep up to date.
 *
 * ⛔ Do not "simplify" this back into a list of loader codes, and do not widen it
 * to match anything else. Its value is precisely that its membership is decided
 * by a constructor call and not by a guess.
 *
 * ## Why the `code` check as well as `instanceof`
 *
 * `instanceof` is exact when there is one copy of this module in the process,
 * and silently false when there are two — a mocked instance beside the real one,
 * or a `src` and a `dist` resolution in the same test run. The `code` is VAT's
 * own constant (never an errno — see {@link PARSER_UNAVAILABLE_CODE}), so it
 * survives that split without widening what is matched.
 *
 * @param error - The thrown value a per-document catch received
 * @returns True only for a {@link ParserUnavailableError}
 */
export function isParserUnavailable(error: unknown): error is ParserUnavailableError {
  if (error instanceof ParserUnavailableError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === PARSER_UNAVAILABLE_CODE
  );
}

/**
 * The loader failure as text for {@link ParserUnavailableError}'s message.
 *
 * The errno is the actionable half of a broken install ("EACCES" tells an
 * operator to look at permissions; "ENOENT" at an incomplete extraction), so it
 * has to appear SOMEWHERE — and the message is the one place it can, because
 * `.code` is read by the allow-lists this error must not match.
 *
 * @param error - Whatever the module loader threw
 * @returns A one-line description, with the original code when there is one
 */
function describeLoaderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code: unknown = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code
    : undefined;
  return typeof code === 'string' ? `${message} (${code})` : message;
}

/**
 * Process-wide cache instance for callers with nowhere to keep one.
 *
 * Lazy rather than constructed at module load: `ParseCache` reads `VAT_CACHE`
 * once, per construction, so building it eagerly would bind the decision to
 * import time — an ordering no caller has reason to expect and no test can
 * control without mutating the real `process.env` before the first import.
 */
let sharedCache: ParseCache | undefined;

/**
 * The cache `parseFileCached` (`parse-dispatcher.ts`) uses when the caller supplies none.
 *
 * @returns The process-wide instance, created on first use
 */
export function defaultParseCache(): ParseCache {
  sharedCache ??= new ParseCache();
  return sharedCache;
}

/**
 * Parse an on-disk entry, returning `null` for anything that is not a
 * well-formed entry.
 *
 * There is no version field to check — see the {@link StoredEntry} docblock.
 * Validation is {@link ParseFactsSchema}, applied in full and to every element:
 * a `JSON.parse` failure, a missing or malformed `facts`, an unknown key on the
 * envelope, or one link whose `line` is a string are all misses, so no payload
 * this build cannot account for reaches {@link rehydrate}.
 *
 * This runs on every cache hit, which is the hottest read path in the toolkit —
 * the cost is deliberate and measured. A predicate that only checked array-ness
 * is what previously let a shape change be served back as a plausible answer;
 * "cheap enough to be wrong" was not a trade worth keeping.
 *
 * The returned object is Zod's own output, not the `JSON.parse` product: a
 * fresh graph either way, which is what the "never hand out a shared object"
 * constraint in the module docstring requires.
 */
function readFacts(raw: string): ParseFacts | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    // Not JSON — a truncated or corrupted entry — is a miss. Nothing else can
    // come out of `JSON.parse`, and nothing else is a miss.
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const parsed = ParseFactsSchema.safeParse((value as Partial<StoredEntry>).facts);
  return parsed.success ? parsed.data : null;
}

/**
 * How a shard preparation ended. `unsafe` is a verdict about the directory —
 * it exists and someone else owns it or can write to it — and holds for the
 * run. `refused` is an errno from the filesystem, which may not hold a moment
 * later.
 */
type ShardPreparation = 'ready' | 'unsafe' | 'refused';

/**
 * Make one shard directory safe and present, or report why it is not.
 *
 * The two per-directory syscalls {@link ParseCache.prepareShard} memoizes, in
 * the order they have always run: the POSIX ownership check answers about a
 * directory that ALREADY exists, so it has to precede the `mkdir` that would
 * otherwise create one and make the question moot.
 *
 * A free function because it holds nothing — the memo is the instance's, the
 * decision is not.
 *
 * @param shardDir - The directory to prepare
 * @returns `ready` when it is safe to write into; see {@link ShardPreparation}
 */
async function prepareShardDir(shardDir: string): Promise<ShardPreparation> {
  // POSIX hardening: a predictable, world-readable cache root means another
  // local user on a shared box could pre-create `shardDir` before VAT ever
  // touches it. `mkdir` below does NOT chmod a directory that already exists,
  // so without this check a hostile pre-created directory would be silently
  // written into. Meaningless on Windows — see the `ParseCache` docblock.
  if (process.platform !== 'win32') {
    const safety = await shardDirSafety(shardDir);
    if (safety !== 'ready') return safety;
  }

  try {
    await fs.mkdir(shardDir, { recursive: true, mode: CACHE_DIR_MODE });
  } catch (error) {
    // Fail-soft on exactly the errors the write itself is fail-soft on —
    // EACCES, EROFS, ENOSPC. Anything else is a bug in this module and stays
    // loud, which is the same split `write` keeps.
    if (fsFaultOf(error) === undefined) throw error;
    return 'refused';
  }
  return 'ready';
}

/**
 * Bits that make a directory writable by anyone other than its owner:
 * group-write (`0o020`) and other-write (`0o002`).
 */
const UNSAFE_WRITE_BITS = 0o022;

/**
 * POSIX-only hardening for `set()` (see the note at its call site): decide
 * whether an EXISTING shard directory is safe to write into.
 *
 * A directory that does not exist yet is always safe — `mkdir` will create it
 * fresh, owned by this process, at {@link CACHE_DIR_MODE}. One that already
 * exists is safe only if this process owns it AND it is not writable by
 * group or other; anything else could have been pre-created by another local
 * user on a shared box.
 *
 * Callers MUST guard with `process.platform !== 'win32'` — `stats.uid` and
 * `mode`'s write bits carry no meaningful security guarantee on Windows (see
 * the class docblock).
 *
 * @param dir - The shard directory `set()` is about to `mkdir`/write into
 * @returns `ready` if `dir` is absent, or present and safe to reuse; `unsafe`
 *   if it is present and not; `refused` if the OS would not describe it
 */
async function shardDirSafety(dir: string): Promise<ShardPreparation> {
  let stats: Stats;
  try {
    stats = await fs.lstat(dir);
  } catch (error) {
    // Absent: `mkdir` will create it fresh, owned by this process.
    if (isPathAbsentError(error)) return 'ready';
    // The OS will not describe it (EACCES on the parent, ELOOP, EMFILE): a
    // directory whose owner and mode cannot be checked is not one to write
    // into NOW. The caller counts this as a write failure, which it is, and
    // does not memoize it — an errno is not a verdict about the directory.
    if (fsFaultOf(error) !== undefined) return 'refused';
    throw error;
  }

  const uid = process.getuid?.();
  const ownedByThisProcess = uid === undefined || stats.uid === uid;
  const notGroupOrOtherWritable = (stats.mode & UNSAFE_WRITE_BITS) === 0;
  return ownedByThisProcess && notGroupOrOtherWritable ? 'ready' : 'unsafe';
}

/**
 * Sweep a temp file this module created, on the write path that has already
 * failed. A filesystem refusal here is absorbed — the write failure it follows
 * is already counted, and a second one adds nothing an operator can act on —
 * but a bug in the sweep itself is not a refusal and stays loud.
 */
async function removeTempQuietly(target: string): Promise<void> {
  try {
    await fs.rm(target, { force: true });
  } catch (error) {
    if (fsFaultOf(error) === undefined) throw error;
  }
}
