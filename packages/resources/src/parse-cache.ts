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
 * | `anchors`, `parseErrors`, `unresolvedReferences` | stored when present |
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
 * The content key covers the parser's *inputs*; it cannot detect a change to
 * the *shape of what is stored here*. {@link PARSE_CACHE_SCHEMA_VERSION} rides
 * in the entry envelope for that. A missing or non-matching `v` is read as a
 * miss rather than misparsed — same discipline as `content-cache.ts` and
 * `external-link-cache.ts`.
 *
 * ## Layout
 *
 * `<normalizedTmpdir()>/.vat-cache/parse/<shard>/<key>.json`, where `<shard>`
 * is the last two characters of the key. Those are hex, so this is a clean
 * 256-way fan-out that needs no parsing of the key's internal structure. The
 * `parse/` level exists so a future `vat cache clear` — and the OS's own temp
 * purge — have a coarse handle on this tenant alone.
 *
 * `<tmpdir>/.vat-cache/` is **shared**: the external-link validation cache
 * already lives at `<tmpdir>/.vat-cache/external-links.json`, and linkAuth's
 * content cache at `<tmpdir>/.vat-cache/auth-<user>/`. This is a new tenant
 * beside them, not a replacement for either.
 *
 * ## Failure model
 *
 * Fail-soft, in both directions: any read failure (ENOENT, EACCES, corrupt
 * JSON, version mismatch, structurally wrong payload) is a **miss**; any write
 * failure (EACCES, ENOSPC, EROFS) is a **no-op**. A non-persisted entry costs
 * one cold parse on the next run; an exception costs the whole current run.
 *
 * Be precise about what that does *not* cover: fail-soft catches **corruption,
 * not wrongness**. A well-formed entry filed under the wrong key is
 * indistinguishable from a correct hit, and no amount of defensive IO handling
 * will notice. That is why the key rules in `content-key.ts` (hash the raw
 * bytes, hash on read, mix in the parser kind) are load-bearing rather than
 * fussy.
 */

import { promises as fs } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';

import type { KeyedContent } from './content-key.js';
import { type ParseResult, parseFrontmatterSource } from './link-parser.js';
import type { HtmlParseError } from './schemas/resource-metadata.js';
import type { HeadingNode, ResourceLink, UnresolvedReference } from './types.js';

/**
 * On-disk payload schema version.
 *
 * Bump by hand whenever {@link ParseFacts} or the entry envelope changes shape.
 * Deliberately separate from `CONTENT_KEY_SCHEMA_VERSION`: that one invalidates
 * when the parser's *output for given bytes* changes, this one when the
 * *serialization of that output* changes. They move independently.
 */
export const PARSE_CACHE_SCHEMA_VERSION = 1;

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
 * caller-supplied struct. Rejecting anything outside this charset means a key
 * can never contain a path separator or `..`, so the joins below cannot escape
 * the cache directory. An unexpected shape is treated as a miss/no-op.
 */
const SAFE_KEY = /^[\w.-]+$/;

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

/** The entry envelope. `v` is checked before `facts` is trusted. */
interface StoredEntry {
  v: number;
  facts: ParseFacts;
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

/**
 * The default cache root: `<tmpdir>/.vat-cache/parse`.
 *
 * @returns Absolute path, forward slashes (via `safePath.join`)
 */
export function parseCacheDirectory(): string {
  return safePath.join(normalizedTmpdir(), '.vat-cache', 'parse');
}

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
 * @example
 * ```typescript
 * const cache = new ParseCache();
 * const keyed = await readContentWithKey(filePath);
 * const hit = await cache.get(keyed);
 * const result = hit ?? parseMarkdownContent(keyed.content, keyed.byteLength);
 * if (hit === null) await cache.set(keyed, result);
 * ```
 */
export class ParseCache {
  /** Whether reads and writes touch the filesystem at all. */
  readonly enabled: boolean;

  private readonly cacheDir: string;

  constructor(options: ParseCacheOptions = {}) {
    // Read the env per construction, never at module load: a module-level read
    // is unobservable to a caller that sets the variable later, and untestable
    // without mutating the real `process.env`.
    const env = options.env ?? process.env;
    this.enabled = options.enabled ?? env['VAT_CACHE'] !== '0';
    this.cacheDir = options.cacheDir ?? parseCacheDirectory();
  }

  /**
   * Look up the parse facts for an already-read document.
   *
   * @param keyed - Content, key and byte length from one read
   * @returns A freshly-minted parse result, or `null` on any kind of miss
   */
  async get(keyed: KeyedContent): Promise<ParseResult | null> {
    if (!this.enabled || !SAFE_KEY.test(keyed.key)) return null;

    let raw: string;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is cacheDir + a charset-validated content key
      raw = await fs.readFile(this.entryPath(keyed.key), 'utf-8');
    } catch {
      // ENOENT (never written), EACCES (perms), EISDIR — all a miss.
      return null;
    }

    const facts = readFacts(raw);
    if (facts === null) return null;

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
    tempFileCounter += 1;
    const tempPath = safePath.join(
      shardDir,
      `${keyed.key}.${String(process.pid)}.${String(tempFileCounter)}.tmp`,
    );
    const entry: StoredEntry = { v: PARSE_CACHE_SCHEMA_VERSION, facts: dehydrate(result) };

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

  private shardDir(key: string): string {
    return safePath.join(this.cacheDir, key.slice(-SHARD_LENGTH));
  }

  private entryPath(key: string): string {
    return safePath.join(this.shardDir(key), `${key}.json`);
  }
}

/**
 * Parse an on-disk entry, returning `null` for anything that is not a
 * well-formed entry of the current schema version.
 *
 * Deliberately checks the version BEFORE the payload: an entry from a future
 * (or past) schema is a miss, not an error, and must never reach
 * {@link rehydrate}.
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
  if (entry.v !== PARSE_CACHE_SCHEMA_VERSION) return null;
  return isParseFacts(entry.facts) ? entry.facts : null;
}

/**
 * Shallow structural check on the payload.
 *
 * Not a full schema validation: the writer is this same module, so the realistic
 * failure is truncation or foreign content, both of which this catches. It
 * exists so a mangled payload becomes a miss instead of a `ParseResult` whose
 * `links` is a string.
 */
function isParseFacts(value: unknown): value is ParseFacts {
  if (typeof value !== 'object' || value === null) return false;
  const facts = value as Partial<ParseFacts>;
  return (
    Array.isArray(facts.links) &&
    Array.isArray(facts.headings) &&
    typeof facts.estimatedTokenCount === 'number'
  );
}

/** `fs.rm` that swallows everything — used only on paths this module created. */
async function removeQuietly(target: string, recursive = false): Promise<void> {
  try {
    await fs.rm(target, { force: true, recursive });
  } catch {
    // Nothing useful to do: this is already the cleanup path.
  }
}
