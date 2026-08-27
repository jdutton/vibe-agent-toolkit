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
 * | `frontmatterSource`, `frontmatterError` | stored when present |
 * | `content`, `sizeBytes` | **never stored** — re-attached from `KeyedContent` |
 * | `frontmatter` | **never stored** — re-derived from `frontmatterSource` |
 *
 * ## Why frontmatter is cached as YAML SOURCE, never as the parsed object
 *
 * Measured, against this repo's `yaml`: `.inf` parses to `Infinity`, `.nan` to
 * `NaN`, `!!binary` to a `Buffer`. `JSON.stringify` maps the first two to
 * `null`, rewrites the third as `{type,data}`, and **throws outright** on a
 * cyclic YAML anchor — so documents in that last class would silently never
 * cache at all. Re-parsing the source is lossless by construction, because it
 * is literally the computation the cold path runs: {@link rehydrate} calls
 * `parseFrontmatterSource`, the *same* function `parseMarkdownContent` uses.
 * There is deliberately no second implementation of "YAML source → frontmatter"
 * in this file.
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

import { safePath } from '@vibe-agent-toolkit/utils';

import { parseCacheDirectory } from './cache-namespace.js';
import { CONTENT_KEY_PATTERN, type KeyedContent, type ParsableContent, readContentWithKey } from './content-key.js';
import { parseFrontmatterSource } from './frontmatter-source.js';
import type { ParseResult } from './link-parser.js';
import type { DocumentParserKind } from './mime-type.js';
import {
  parseTimingStart,
  recordParseCacheHit,
  recordParseCacheMiss,
  recordTierPass,
  TierPass,
} from './parse-timing.js';
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
    ...(result.frontmatterError !== undefined && { frontmatterError: result.frontmatterError }),
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
 * `frontmatter` is re-derived by `parseFrontmatterSource` — the same function
 * the cold path uses — so a cache hit and a cold parse cannot disagree.
 *
 * @param facts - The stored facts
 * @param keyed - The fresh read whose key selected those facts
 * @returns A parse result equal to what the parser would have produced
 */
export function rehydrate(facts: ParseFacts, keyed: KeyedContent): ParseResult {
  const derived = deriveFrontmatter(facts);

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
    ...(derived.frontmatter !== undefined && { frontmatter: derived.frontmatter }),
    ...(derived.frontmatterError !== undefined && { frontmatterError: derived.frontmatterError }),
    content: keyed.content,
    sizeBytes: keyed.byteLength,
    estimatedTokenCount: facts.estimatedTokenCount,
  };
}

/**
 * The frontmatter half of {@link rehydrate}, kept separate so there is exactly
 * one place that decides where `frontmatter` / `frontmatterError` come from.
 *
 * When a source is stored, `parseFrontmatterSource` — the same function the
 * cold path runs — is the authority, so a hit and a cold parse cannot disagree.
 * The stored `frontmatterError` is only a fallback for a producer that reported
 * an error without a source; for markdown the no-source branch simply means
 * "this document had no frontmatter".
 */
function deriveFrontmatter(facts: ParseFacts): {
  frontmatter?: Record<string, unknown>;
  frontmatterError?: string;
} {
  if (facts.frontmatterSource !== undefined) {
    return parseFrontmatterSource(facts.frontmatterSource);
  }
  if (facts.frontmatterError !== undefined) {
    return { frontmatterError: facts.frontmatterError };
  }
  return {};
}

/**
 * Disk-backed store of parse facts, keyed by content.
 *
 * Most callers want {@link parseFileCached} or {@link parseKeyed} rather than
 * driving `get`/`set` by hand.
 *
 * @example
 * ```typescript
 * const cache = new ParseCache();
 * const keyed = await readContentWithKey(filePath, 'markdown');
 * const hit = await cache.get(keyed);
 * const result = hit ?? parseMarkdownContent(keyed.content, keyed.byteLength);
 * if (hit === null) await cache.set(keyed, result);
 * ```
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
   * They live on the cache rather than on each caller because every caller of
   * {@link parseKeyed} would otherwise keep its own pair, and the eight direct
   * parse sites bite 2 migrates have nowhere to keep one.
   */
  private hitCount = 0;
  private missCount = 0;
  private writeFailureCount = 0;

  constructor(options: ParseCacheOptions = {}) {
    // Read the env per construction, never at module load: a module-level read
    // is unobservable to a caller that sets the variable later, and untestable
    // without mutating the real `process.env`.
    const env = options.env ?? process.env;
    this.enabled = options.enabled ?? env['VAT_CACHE'] !== '0';
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

      // eslint-disable-next-line security/detect-non-literal-fs-filename, local/no-raw-text-decode -- reading back this cache's own entry, written as UTF-8 by `set()`; a corpus document never lands here
      raw = await fs.readFile(this.entryPath(keyed.key), 'utf-8');
    } catch {
      // ENOENT (never written), EACCES (perms), EISDIR — all a miss.
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
      return rehydrate(facts, keyed);
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
  async set(keyed: KeyedContent, result: ParseResult): Promise<boolean> {
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
   * @param key - The content key to file under
   * @param result - The parse result whose facts to store
   * @returns True when the entry was persisted. A write failure is REPORTED
   *   here as well as counted, never thrown — see below.
   */
  async setByKey(key: string, result: ParseResult): Promise<boolean> {
    // Outside the bracket for the same reason `get`'s guards are — see there.
    if (!this.enabled || !SAFE_KEY.test(key)) return false;

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

    // POSIX hardening: a predictable, world-readable cache root means another
    // local user on a shared box could pre-create `shardDir` before VAT ever
    // touches it. `mkdir` below does NOT chmod a directory that already
    // exists, so without this check a hostile pre-created directory would be
    // silently written into. Meaningless on Windows — see the class docblock.
    if (process.platform !== 'win32' && !(await isSafeShardDir(shardDir))) {
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
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is cacheDir + a charset-validated content key
      await fs.mkdir(shardDir, { recursive: true, mode: CACHE_DIR_MODE });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is cacheDir + a charset-validated content key
      await fs.writeFile(tempPath, JSON.stringify(entry), 'utf-8');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths are cacheDir + a charset-validated content key
      await fs.rename(tempPath, this.entryPath(key));
    } catch {
      // Fail-soft: EACCES on the directory, ENOSPC on the disk, EROFS on a
      // read-only mount. The current run already holds the fresh result; only
      // the persistence is lost. Best-effort sweep of a temp file that was
      // written but never renamed, so a failing write cannot accumulate litter.
      this.writeFailureCount += 1;
      await removeQuietly(tempPath);
      return false;
    }
    return true;
  }

  /**
   * Delete this cache's entire tree.
   *
   * Runs regardless of {@link enabled}: turning reads off must not disarm an
   * explicit operator request to reclaim the space.
   */
  async clear(): Promise<void> {
    await removeQuietly(this.directory, true);
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
 * The one thing a parser module contributes: content of a known byte length in,
 * parse facts out.
 *
 * Both parsers already have this shape (`parseMarkdownContent`,
 * `parseHtmlContent`); naming it lets {@link loadParser} return one type for
 * either kind, so no caller has to re-derive which export belongs to which kind.
 */
export interface LoadedParser {
  /**
   * @param content - The decoded document
   * @param sizeBytes - The RAW byte count of what was read, never a length
   *   derived from `content` — decoding is lossy on malformed UTF-8
   * @returns The parse facts for those bytes
   */
  parseContent(content: string, sizeBytes: number): ParseResult;
}

/**
 * In-flight or settled loads, one per kind. Memoizing the PROMISE (not the
 * module) is what makes concurrent first callers share a single import.
 */
const parserLoads = new Map<DocumentParserKind, Promise<LoadedParser>>();

/**
 * The module specifier {@link importParser} loads for each kind, for the error
 * message only.
 *
 * Kept beside the `import()` calls rather than derived from them because the
 * specifiers there MUST stay static literals — a computed specifier is invisible
 * to a bundler and to the module-mocking these are tested through. Duplicating
 * them here is the cost of naming the module in the message; both entries are
 * exercised by the message tests, so a specifier changed on one side without the
 * other shows up as a message naming a module the loader never touched.
 *
 * ## Why this is keyed on `DocumentParserKind` and not on `ParserKind`
 *
 * `ParserKind` grew a third member, `none`, which names the ABSENCE of a parser
 * (see content-key.ts). There is no module specifier for it — not `null`, not a
 * placeholder — so widening this record would have forced an entry that is a
 * lie, and every reader of that entry would then be handling a case that cannot
 * happen. Narrowing the key instead pushes the impossibility one level up, into
 * the types of {@link loadParser} and {@link parseKeyed}, where a caller holding
 * a `none` blob gets a compile error at the call site rather than an invented
 * answer far from it.
 *
 * The record therefore stays compile-exhaustive over exactly the kinds that HAVE
 * a parser, which is the property that made it worth having: a fourth real
 * parser cannot be added without a specifier for it.
 */
const PARSER_MODULE_SPECIFIERS: Record<DocumentParserKind, string> = {
  html: './html-link-parser.js',
  markdown: './link-parser.js',
};

/**
 * The `code` every {@link ParserUnavailableError} carries.
 *
 * ⚠️ It must NEVER be an errno, and the original errno must NEVER be passed
 * through onto `.code`. Every outer error boundary in the toolkit classifies by
 * allow-listing errno strings — `isFilesystemAccessError` in
 * `packages/utils/src/fs-utils.ts` (whose `FILESYSTEM_ACCESS_ERRNOS` holds
 * `EACCES`, `EPERM`, `EMFILE`, `ENOENT` and ~20 more) and `READ_FAILURE_CODES`
 * in `resource-registry.ts`. An errno here means `vat audit` degrades a broken
 * INSTALL into a `SCAN_PATH_UNREADABLE` warning and exits 0, which is the exact
 * defect this type exists to close. Restoring the original code "so the errno
 * isn't lost" reopens it; the errno is kept in the MESSAGE and on
 * {@link ParserUnavailableError.loaderError} instead, where no allow-list reads it.
 */
const PARSER_UNAVAILABLE_CODE = 'VAT_PARSER_UNAVAILABLE';

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
 * codes. Hoisting the load out of the per-document `try` (see {@link loadParser})
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
 * `isFilesystemAccessError` walks the `cause` chain — deliberately, because the
 * CLI config loader re-wraps read failures and a `code`-only check answered "not
 * a filesystem error" for a plain `EACCES`. So an original `EACCES` reachable via
 * `cause` is found by that walk and the wrapper is degraded anyway: setting
 * `cause` here silently cancels the entire fix. Verified — with `cause` set, the
 * predicate returns `true` for this error.
 *
 * What that costs, stated honestly: VAT never inspects `loaderError`. The CLI's
 * `handleCommandError` prints `error.message`, and `--debug` prints the
 * WRAPPER's `.stack` — neither reaches an own non-standard property, and no
 * `util.inspect` of this error happens on any shipped path. What actually
 * survives to the operator is what {@link describeLoaderError} folds INTO the
 * message: the loader's own text and its code. `loaderError` is for a debugger,
 * a test, or an embedder that goes looking; the message is the shipped channel,
 * which is why the errno has to be in it.
 */
export class ParserUnavailableError extends Error {
  /**
   * Never an errno. See {@link PARSER_UNAVAILABLE_CODE} before changing this.
   */
  readonly code = PARSER_UNAVAILABLE_CODE;

  /**
   * The loader's own failure, verbatim. Deliberately NOT `cause` — see the class
   * docstring; `cause` is walked by the very predicate this type must not match.
   */
  readonly loaderError: unknown;

  /**
   * @param kind - Which parser failed to load
   * @param specifier - The module specifier that could not be imported
   * @param loaderError - Whatever the module loader threw
   */
  constructor(kind: DocumentParserKind, specifier: string, loaderError: unknown) {
    super(
      `Cannot load VAT's ${kind} parser module (${specifier}): ${describeLoaderError(loaderError)}. ` +
        'This is a broken VAT installation — the parser itself could not be read or evaluated. ' +
        'No document being scanned is at fault. Reinstall or rebuild VAT.',
    );
    this.name = 'ParserUnavailableError';
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
 * ({@link importParserModule}). It is therefore **complete by construction**:
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
 * Load the parser for one kind, once per process.
 *
 * ## Why the load is DEFERRED and not hoisted
 *
 * Called from exactly one place: {@link parseKeyed}, past its cache-hit return.
 * That position is the whole point. The remark stack behind
 * `parseMarkdownContent` costs ~730 ms of module load on Windows, and a fully
 * warm run — every document a hit, nothing ever parsed — must not pay it.
 * Measured on a warm `vat resources scan docs/contributing`: 779 scripts loaded
 * with the parser absent, against 962 with it present.
 *
 * ⚠️ It has been hoisted above the cache twice, both times to fix the
 * attribution problem below, and both times it silently cancelled the deferral —
 * the warm run went straight back to 963 scripts and the measured ~1.0 s saving
 * disappeared while every test stayed green. `parse-cache`'s own tests cannot see
 * it; `packages/cli/test/integration/module-load-budget.integration.test.ts` can,
 * and its warm-scan case is what fails if this moves.
 *
 * ## How a load failure is kept off the documents WITHOUT a hoist
 *
 * Loading the parser is an INSTALL-level operation; parsing is a DOCUMENT-level
 * one. Since the import sits inside `parseKeyed`, every caller that wraps
 * `parseKeyed` in a per-document `try` — and they all do, because a corpus
 * contains documents that legitimately fail to parse — would otherwise blame a
 * broken install on each innocent file in turn (measured: 8 ×
 * `RESOURCE_UNREADABLE`, `filesScanned: 0`, on `chmod 000` of the built parser).
 *
 * That is closed at the origin instead of by position: the import is wrapped in
 * {@link ParserUnavailableError}, which wears a code no errno allow-list holds,
 * and each of those catches rethrows it via {@link isParserUnavailable}. The
 * predicate is safe where the deleted `isModuleLoadFailure` blocklist was not,
 * because it matches one type this file constructs rather than guessing at
 * Node's codes — see its docstring.
 *
 * ## Why the exit code needed the type too
 *
 * Attribution and exit code are separate failures. One boundary further out —
 * `vat audit`'s per-entry scan catch — degrades ANY error carrying a filesystem
 * errno into a `SCAN_PATH_UNREADABLE` warning, so a `chmod 000` parser still
 * exited 0 even when no document was blamed. Every such boundary allow-lists
 * errnos, so no amount of hoisting reaches it; only a non-errno code does.
 *
 * A rejected load is dropped from the memo rather than retained: a loader
 * failure can be transient (`EMFILE` under fd pressure), and caching the
 * rejection would turn one bad moment into a dead process.
 *
 * @param kind - Which parser to load
 * @returns The parser for that kind
 * @throws {ParserUnavailableError} If the parser module cannot be imported. The
 *   loader's own error is carried on `loaderError`, never re-thrown bare — see
 *   {@link PARSER_UNAVAILABLE_CODE}.
 */
export async function loadParser(kind: DocumentParserKind): Promise<LoadedParser> {
  const pending = parserLoads.get(kind);
  if (pending !== undefined) return pending;

  const loading = importParser(kind).catch((error: unknown) => {
    parserLoads.delete(kind);
    throw error;
  });
  parserLoads.set(kind, loading);
  return loading;
}

/**
 * The `import()`s of a parser in this package, and nothing else.
 *
 * ⚠️ This only pays off while `index.ts` keeps `parseMarkdown` / `parseHtml` as
 * LAZY WRAPPERS. They were plain value re-exports until this was measured: the
 * package publishes only `"."`, so every consumer goes through the barrel, and
 * the barrel evaluated both parser modules before this line ever ran. Verified
 * then with NODE_V8_COVERAGE on a warm `vat resources scan` — remark-parse
 * loaded, `parseMarkdownContent` called zero times. Restore either re-export and
 * this deferral silently buys nothing again.
 *
 * Only the markdown half actually saves anything. parse5 (~38 ms) is loaded
 * eagerly regardless, because `html-transform.ts` imports html-link-parser
 * statically for the SYNCHRONOUS `rewriteHtmlLinks`; deferring that needs it to
 * become async first.
 *
 * The export read is INSIDE the callback, and so inside
 * {@link importParserModule}'s `try`, deliberately: a module can fail by throwing
 * while it evaluates, which surfaces at the destructure rather than at the
 * `import()` itself.
 *
 * @param kind - Which parser to load
 * @returns The parser for that kind
 * @throws {ParserUnavailableError} If the module cannot be imported
 */
async function importParser(kind: DocumentParserKind): Promise<LoadedParser> {
  if (kind === 'html') {
    return importParserModule(kind, async () => ({
      parseContent: (await import('./html-link-parser.js')).parseHtmlContent,
    }));
  }
  return importParserModule(kind, async () => ({
    parseContent: (await import('./link-parser.js')).parseMarkdownContent,
  }));
}

/**
 * Run one parser-module import so its failure is a {@link ParserUnavailableError}
 * rather than a bare loader errno.
 *
 * The wrap lives HERE, at the single boundary where a loader error originates,
 * rather than at the parse sites that would otherwise have to classify one: an
 * outer boundary cannot tell a loader `EACCES` from a document `EACCES` by
 * inspection, so a classification added further out is guesswork. Inside this
 * `try` there is nothing to classify — anything it catches came from loading a
 * parser module.
 *
 * Takes the import as a CALLBACK rather than performing it, because the
 * specifiers must stay static literals: a computed specifier is invisible to a
 * bundler and to the module-mocking these are tested through. Two callers pass
 * one — {@link importParser} here, and the lazy `parseMarkdown`/`parseHtml`
 * wrappers in `index.ts`, which import the same two modules by a different route
 * (they read the file themselves) and so cannot go through {@link loadParser}.
 * Both must produce the same error type or a boundary guarded by
 * {@link isParserUnavailable} covers only one of them.
 *
 * @param kind - Which parser is being loaded, for the message
 * @param importModule - Performs the `import()` and reads what it needs off it
 * @returns Whatever `importModule` resolves to
 * @throws {ParserUnavailableError} If `importModule` throws
 */
export async function importParserModule<T>(
  kind: DocumentParserKind,
  importModule: () => Promise<T>,
): Promise<T> {
  try {
    return await importModule();
  } catch (error) {
    throw new ParserUnavailableError(kind, PARSER_MODULE_SPECIFIERS[kind], error);
  }
}

/**
 * Produce the parse facts for an already-read document, from the cache when one
 * is filed under its content key and from the parser otherwise.
 *
 * THE interception point: it sits between the single read that keyed the bytes
 * and the parser that would otherwise consume them, so on a hit the parser does
 * not run at all. Nothing downstream changes — `rehydrate` re-attaches
 * `content`/`sizeBytes` from the caller's own fresh read rather than from the
 * entry, so a caller that publishes `stat().size` separately (as
 * `ResourceRegistry.addResource` does) is unaffected.
 *
 * The `set` is **awaited**, not fired and forgotten. `vat validate`, `vat verify`
 * and `vat build` each `spawnSync` the vat binary once per phase, so an entry
 * that has not reached disk by process exit buys nothing; the write is measured
 * at ~30 ms for 265 documents and `set` never throws.
 *
 * The parser is chosen by `keyed.parserKind`, which is the same value that went
 * into the key — that is the whole reason `readContentWithKey` takes the kind as
 * an argument rather than re-deriving it. Running the discriminator twice is how
 * the parse route and the key's parse-route component drift apart.
 *
 * ## Why the parameter is `ParsableContent` and not `KeyedContent`
 *
 * A `none` blob has no parser, so there is no honest answer this function could
 * give for one. Both alternatives to a type are worse: a throw turns a routing
 * fact into a runtime surprise, and an empty `ParseResult` fabricated here would
 * be indistinguishable from "a document with no links" at every consumer that
 * counts rows. Requiring the narrowed type moves the decision to the caller,
 * which is the only place that knows whether a blob with no parser is expected —
 * and makes forgetting to decide a compile error. `isParsableContent` in
 * content-key.ts is the narrowing.
 *
 * @param keyed - Content, key and byte length from ONE read, of a kind that has
 *   a parser
 * @param cache - The store to consult and file into
 * @returns Parse facts equal to what the parser would have produced
 */
export async function parseKeyed(keyed: ParsableContent, cache: ParseCache): Promise<ParseResult> {
  const hit = await cache.get(keyed);
  if (hit !== null) {
    // Feeds the sub-phase timing dump (`parse-timing.ts`), never this cache's
    // own per-instance `ParseCacheStats`. Without it a dump from a fully warm
    // run would show zero parse invocations and read as a dead seam.
    recordParseCacheHit();
    return hit;
  }
  recordParseCacheMiss();

  // ⛔ Past the hit-path return, and it must stay there: this line is the ONLY
  // reason a fully warm run loads no parser at all. Hoisting it — here, or into
  // any caller's pre-loop — costs every warm invocation the ~730 ms remark load
  // for a parse that never happens, and no test in this package can see that.
  // It has regressed twice; see {@link loadParser}. A load failure is kept off
  // the innocent documents by the error TYPE, not by this line's position.
  //
  // The parser is chosen by `keyed.parserKind` — the same value that went into
  // the key.
  const parser = await loadParser(keyed.parserKind);

  // The `sizeBytes` argument is `keyed.byteLength` — the raw byte count of what
  // was read — never a length derived from `keyed.content`, since decoding is
  // lossy on malformed UTF-8 and a re-encoded count diverges from what is on
  // disk (see link-parser.ts and content-key.ts).
  const result = parser.parseContent(keyed.content, keyed.byteLength);

  await cache.set(keyed, result);
  return result;
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
 * The cache {@link parseFileCached} uses when the caller supplies none.
 *
 * @returns The process-wide instance, created on first use
 */
export function defaultParseCache(): ParseCache {
  sharedCache ??= new ParseCache();
  return sharedCache;
}

/**
 * Read, key and parse a file, consulting the cache.
 *
 * The cached replacement for `parseMarkdown(path)` / `parseHtml(path)`: those
 * two read the file themselves and hand the bytes straight to a parser, so they
 * bypass the cache entirely. Every call site that does not go through
 * `ResourceRegistry` uses this instead.
 *
 * ⚠ `parserKind` states which parser runs — it is **not** derived from the
 * path, because at least one shipped caller deliberately parses `.html`
 * documents as markdown. Pass the kind you actually parse with, or the entry
 * lands under a key another lane will read (see content-key.ts).
 *
 * It is a {@link DocumentParserKind}, so `parserKindForPath(filePath)` is not
 * directly passable any more: that function can answer `none`, and this one has
 * no parser to run for it. A caller routing by path decides what to do with a
 * `none` blob first — see `parseKeyed`.
 *
 * One difference from `parseMarkdown`/`parseHtml`, deliberate: `sizeBytes` is
 * the length of the bytes this call read, not a separate `stat().size`. For a
 * regular file the two agree; where they can disagree — a file rewritten between
 * the read and the stat — the byte count of what was actually parsed is the
 * honest one, and it is also the number the key covers.
 *
 * @param filePath - Absolute path to the document
 * @param parserKind - The parser to hand the content to
 * @param cache - Store to use; defaults to the process-wide instance
 * @returns The parse result, from an entry or from the parser
 * @throws Whatever `readFile` throws — a read failure is the caller's to handle,
 *   exactly as it was with `parseMarkdown`
 */
export async function parseFileCached(
  filePath: string,
  parserKind: DocumentParserKind,
  cache: ParseCache = defaultParseCache(),
): Promise<ParseResult> {
  return parseKeyed(await readContentWithKey(filePath, parserKind), cache);
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
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const parsed = ParseFactsSchema.safeParse((value as Partial<StoredEntry>).facts);
  return parsed.success ? parsed.data : null;
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
 * @returns `true` if `dir` is absent, or present and safe to reuse
 */
async function isSafeShardDir(dir: string): Promise<boolean> {
  let stats: Stats;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is cacheDir + a charset-validated content key
    stats = await fs.lstat(dir);
  } catch {
    return true;
  }

  const uid = process.getuid?.();
  const ownedByThisProcess = uid === undefined || stats.uid === uid;
  const notGroupOrOtherWritable = (stats.mode & UNSAFE_WRITE_BITS) === 0;
  return ownedByThisProcess && notGroupOrOtherWritable;
}

/** `fs.rm` that swallows everything — used only on paths this module created. */
async function removeQuietly(target: string, recursive = false): Promise<void> {
  try {
    await fs.rm(target, { force: true, recursive });
  } catch {
    // Nothing useful to do: this is already the cleanup path.
  }
}
