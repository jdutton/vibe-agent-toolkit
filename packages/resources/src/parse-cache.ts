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
 * There is none here, on purpose. The content key covers the parser's *inputs*
 * and cannot see a change to the parser itself or to the shape stored here —
 * so both are handled one level up, by the namespace directory in
 * `cache-namespace.ts`. An installed VAT gets a namespace per release; a dev
 * checkout gets one per (worktree path, `PARSER_BEHAVIOR_REVISION`) pair.
 *
 * ⚠ Read `cache-namespace.ts` before changing `dehydrate`/`rehydrate` or any
 * parser behaviour: the dev namespace deliberately **survives a rebuild**, so a
 * shape change that is not accompanied by a `PARSER_BEHAVIOR_REVISION` bump
 * will meet entries written under the old shape. `isParseFacts` rejects a
 * structurally wrong payload, but a shape change that stays structurally valid
 * is invisible. `vat cache clear` is the local escape hatch.
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
 * (this one, and `parquet/` when it lands) sit under the namespace.
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

import { safePath } from '@vibe-agent-toolkit/utils';

import { parseCacheDirectory } from './cache-namespace.js';
import { CONTENT_KEY_PATTERN, type KeyedContent, type ParserKind, readContentWithKey } from './content-key.js';
import { parseHtmlContent } from './html-link-parser.js';
import { type ParseResult, parseFrontmatterSource, parseMarkdownContent } from './link-parser.js';
import { recordParseCacheHit, recordParseCacheMiss } from './parse-timing.js';
import type { ContentMeasures } from './projection/blob-facts.js';
import type { LexicalReference } from './reference-lexer.js';
import type { HtmlParseError } from './schemas/resource-metadata.js';
import type { HeadingNode, ResourceLink, UnresolvedReference } from './types.js';

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
 * Disambiguates concurrent temp files within one process. Combined with
 * `process.pid` this is collision-free without `Math.random()` or `Date.now()`,
 * neither of which is actually a uniqueness guarantee.
 */
let tempFileCounter = 0;

/**
 * The subset of {@link ParseResult} that is a function of the parsed bytes
 * alone — i.e. everything the cache is entitled to persist.
 *
 * Note what is missing: `content`, `sizeBytes` and `frontmatter`. See the table
 * in the module docstring for why each one is absent.
 */
export interface ParseFacts {
  links: ResourceLink[];
  headings: HeadingNode[];
  estimatedTokenCount: number;
  anchors?: string[];
  parseErrors?: HtmlParseError[];
  unresolvedReferences?: UnresolvedReference[];
  /** See `ParseResult.lexicalReferences`. Omitted when the document has none. */
  lexicalReferences?: LexicalReference[];
  /**
   * See `ParseResult.contentMeasures`. A function of the bytes alone, so it is
   * storable by the same rule as {@link estimatedTokenCount} — and it must be
   * stored, because recomputing `codeBlockBytes` needs the AST this cache
   * exists to avoid building.
   */
  contentMeasures?: ContentMeasures;
  /** Raw YAML of the frontmatter block, without the `---` delimiters. */
  frontmatterSource?: string;
  /**
   * Carried for producers that report a frontmatter error without a source.
   * When {@link frontmatterSource} IS present, {@link rehydrate} prefers the
   * value re-derived from it — the two agree by construction, since deriving is
   * what produced this field in the first place.
   */
  frontmatterError?: string;
}

/**
 * The entry envelope.
 *
 * No version field: the namespace directory (see `cache-namespace.ts`) carries
 * the discrimination instead — per release when installed, and per
 * `PARSER_BEHAVIOR_REVISION` in a dev checkout. A serialization change must
 * therefore bump that constant; the namespace no longer moves on its own after
 * a rebuild. What remains is corruption, which `isParseFacts` rejects
 * structurally.
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

  private readonly cacheDir: string;

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
    this.cacheDir = options.cacheDir ?? parseCacheDirectory();
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
    if (!this.enabled || !SAFE_KEY.test(keyed.key)) return this.miss();

    let raw: string;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is cacheDir + a charset-validated content key
      raw = await fs.readFile(this.entryPath(keyed.key), 'utf-8');
    } catch {
      // ENOENT (never written), EACCES (perms), EISDIR — all a miss.
      return this.miss();
    }

    const facts = readFacts(raw);
    if (facts === null) return this.miss();

    this.hitCount += 1;

    // `readFacts` returns the product of a fresh `JSON.parse`, so this graph is
    // not shared with any previous caller. See the standing constraint in the
    // module docstring — do NOT memoize this object.
    return rehydrate(facts, keyed);
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
   */
  async set(keyed: KeyedContent, result: ParseResult): Promise<void> {
    if (!this.enabled || !SAFE_KEY.test(keyed.key)) return;

    const shardDir = this.shardDir(keyed.key);

    // POSIX hardening: a predictable, world-readable cache root means another
    // local user on a shared box could pre-create `shardDir` before VAT ever
    // touches it. `mkdir` below does NOT chmod a directory that already
    // exists, so without this check a hostile pre-created directory would be
    // silently written into. Meaningless on Windows — see the class docblock.
    if (process.platform !== 'win32' && !(await isSafeShardDir(shardDir))) {
      this.writeFailureCount += 1;
      return;
    }

    tempFileCounter += 1;
    const tempPath = safePath.join(
      shardDir,
      `${keyed.key}.${String(process.pid)}.${String(tempFileCounter)}.tmp`,
    );
    const entry: StoredEntry = { facts: dehydrate(result) };

    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is cacheDir + a charset-validated content key
      await fs.mkdir(shardDir, { recursive: true, mode: CACHE_DIR_MODE });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is cacheDir + a charset-validated content key
      await fs.writeFile(tempPath, JSON.stringify(entry), 'utf-8');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths are cacheDir + a charset-validated content key
      await fs.rename(tempPath, this.entryPath(keyed.key));
    } catch {
      // Fail-soft: EACCES on the directory, ENOSPC on the disk, EROFS on a
      // read-only mount. The current run already holds the fresh result; only
      // the persistence is lost. Best-effort sweep of a temp file that was
      // written but never renamed, so a failing write cannot accumulate litter.
      this.writeFailureCount += 1;
      await removeQuietly(tempPath);
    }
  }

  /**
   * Delete this cache's entire tree.
   *
   * Runs regardless of {@link enabled}: turning reads off must not disarm an
   * explicit operator request to reclaim the space.
   */
  async clear(): Promise<void> {
    await removeQuietly(this.cacheDir, true);
  }

  /** Count a miss and return the value every miss path returns. */
  private miss(): null {
    this.missCount += 1;
    return null;
  }

  private shardDir(key: string): string {
    return safePath.join(this.cacheDir, key.slice(-SHARD_LENGTH));
  }

  private entryPath(key: string): string {
    return safePath.join(this.shardDir(key), `${key}.json`);
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
 * @param keyed - Content, key and byte length from ONE read
 * @param cache - The store to consult and file into
 * @returns Parse facts equal to what the parser would have produced
 */
export async function parseKeyed(keyed: KeyedContent, cache: ParseCache): Promise<ParseResult> {
  const hit = await cache.get(keyed);
  if (hit !== null) {
    // Feeds the sub-phase timing dump (`parse-timing.ts`), never this cache's
    // own per-instance `ParseCacheStats`. Without it a dump from a fully warm
    // run would show zero parse invocations and read as a dead seam.
    recordParseCacheHit();
    return hit;
  }
  recordParseCacheMiss();

  // The `sizeBytes` argument is `keyed.byteLength` — the raw byte count of what
  // was read — never a length derived from `keyed.content`, since decoding is
  // lossy on malformed UTF-8 and a re-encoded count diverges from what is on
  // disk (see link-parser.ts and content-key.ts).
  const result =
    keyed.parserKind === 'html'
      ? parseHtmlContent(keyed.content, keyed.byteLength)
      : parseMarkdownContent(keyed.content, keyed.byteLength);

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
 * extension, because at least one shipped caller deliberately parses `.html`
 * documents as markdown. Pass `parserKindForPath(filePath)` only if that is
 * genuinely the rule you want; otherwise pass the kind you actually parse with,
 * or the entry lands under a key another lane will read (see content-key.ts).
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
  parserKind: ParserKind,
  cache: ParseCache = defaultParseCache(),
): Promise<ParseResult> {
  return parseKeyed(await readContentWithKey(filePath, parserKind), cache);
}

/**
 * Parse an on-disk entry, returning `null` for anything that is not a
 * well-formed entry.
 *
 * There is no version field to check — see the {@link StoredEntry} docblock.
 * Validation is purely structural, via {@link isParseFacts}: a `JSON.parse`
 * failure, a missing/malformed `facts`, or a `facts` whose `links`, `headings`
 * or `estimatedTokenCount` are the wrong shape are all misses, so a mangled or
 * foreign payload can never reach {@link rehydrate}.
 */
function readFacts(raw: string): ParseFacts | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Partial<StoredEntry>;
  return isParseFacts(entry.facts) ? entry.facts : null;
}

/**
 * Shallow structural check on the payload.
 *
 * Not a full schema validation: the writer is this same module, so the realistic
 * failure is truncation or foreign content, both of which this catches. It
 * exists so a mangled payload becomes a miss instead of a `ParseResult` whose
 * `links` is a string.
 *
 * An OPTIONAL field is checked as "absent, or the right shape" — never as "the
 * right shape". Requiring it would reject every entry written from a document
 * that legitimately has none, turning the common case into a permanent miss.
 *
 * Every optional field is checked, not just one: a truncated payload can end
 * anywhere, and a field that goes unchecked is one whose corruption reaches
 * {@link rehydrate} as a plausible-looking value.
 */
function isParseFacts(value: unknown): value is ParseFacts {
  if (typeof value !== 'object' || value === null) return false;
  const facts = value as Partial<ParseFacts>;
  return (
    Array.isArray(facts.links) &&
    Array.isArray(facts.headings) &&
    typeof facts.estimatedTokenCount === 'number' &&
    isAbsentOrArray(facts.anchors) &&
    isAbsentOrArray(facts.parseErrors) &&
    isAbsentOrArray(facts.unresolvedReferences) &&
    isAbsentOrArray(facts.lexicalReferences) &&
    isAbsentOrMeasures(facts.contentMeasures)
  );
}

/** An optional array field: absent, or an array. */
function isAbsentOrArray(value: unknown): boolean {
  return value === undefined || Array.isArray(value);
}

/** An optional {@link ContentMeasures}: absent, or an object carrying all three counts. */
function isAbsentOrMeasures(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  const measures = value as Partial<ContentMeasures>;
  return (
    typeof measures.wordCount === 'number' &&
    typeof measures.proseBytes === 'number' &&
    typeof measures.codeBlockBytes === 'number'
  );
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
