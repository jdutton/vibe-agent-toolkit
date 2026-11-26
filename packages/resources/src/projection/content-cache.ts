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
 * bytes **and** the parser they route to — `computeContentKey` qualifies the key
 * with the parser kind, because identical bytes at `x.md` and `x.html`
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
 * order. What bounded the footprint was **not keying bytes nobody reads**, and
 * every resources lane now keys every non-ignored file, so a cold membership or
 * build run holds the whole tree's text — an open defect in
 * `docs/contributing/known-defects.md`, not a property to rely on.
 */

import { open } from 'node:fs/promises';

import { countWork, isVatError, memoized, relativeEscapesRoot, safePath, TextTooLargeError, toForwardSlash } from '@vibe-agent-toolkit/utils';
import type { GitMember, GitMembers } from '@vibe-agent-toolkit/utils/git';

import {
  type ContentKey,
  formatContentKey,
  type KeyedContent,
  keyedFromBytes,
  type ParserKind,
  readContentWithKey,
  readKeyedBytes,
  refuseContentBySize,
} from '../content-key.js';
import { isParseLimitError, type ParseLimits, resolveParseLimits } from '../parse-limits.js';

/**
 * The limits every population parses under. A population takes no limits of its own: its
 * dispatcher, its reads' input cap ({@link RunContentCache}) and the store key that says which
 * cap its rows were derived under all read this one value, so the three cannot disagree. Its
 * `inputBytes` is never above `MAX_DECODABLE_BYTES` (pinned by `projection-content-cache.test.ts`),
 * so a file too large to decode is always one past the cap.
 */
export const POPULATION_PARSE_LIMITS: ParseLimits = resolveParseLimits(undefined);

/**
 * Whether a read was refused by the file's size alone, before a byte was read: too large to
 * decode (`TextTooLargeError`), or a kind a parser reads past the run's input cap. The one test
 * for a realization's `oversize` state, so the eager and the demand-promoted read agree on it.
 *
 * @param error - What a read threw
 * @returns True for a refusal by size
 */
export function isSizeRefusal(error: unknown): boolean {
  return isVatError(error, TextTooLargeError.code) || (isParseLimitError(error) && error.limit === 'inputBytes');
}

/**
 * A run's git members under `root`, resolved once, at the cache's first key or read of a path
 * inside `root`: so membership is fixed before the run reads anything under it, and a run that
 * reads nothing there (a lone path outside the project) never takes the snapshot that decides
 * it. A path outside `root` is never a member: it keys from disk whatever the members are.
 * `resolve` answers `null` for a root whose files all key from disk (not a repository, a declined
 * key).
 */
export interface RunMembersSource {
  /** The root the members were built for. */
  readonly root: string;
  /** The members, asked for at most once. */
  readonly resolve: () => GitMembers | null;
}

/** A run's members ({@link RunMembersSource}), or `null` for a run whose files all key from disk. */
export type RunMembersOf = RunMembersSource | null;

/** A run with no members: every file keys from disk. */
export const NO_GIT_MEMBERS = null;

/** Why a file cannot be opened now: what its open threw. */
interface OpenRefusal {
  readonly refused: unknown;
}

/**
 * What refuses opening a file now, if anything: the one readability probe, made where no read of
 * the file's own bytes is (a member's bytes come from git; a warm admission's from the store),
 * counted as the stat it is. An open and a close, reading nothing: it fails exactly as a disk
 * read's own open would, a Windows sharing lock included, where a permission check (`access`)
 * succeeds.
 *
 * @param absolutePath - The file
 * @returns The refusal, or `null` when the file can be opened
 */
async function openRefusal(absolutePath: string): Promise<OpenRefusal | null> {
  countWork('fs.stat', 1);
  try {
    const handle = await open(absolutePath, 'r');
    await handle.close();
    return null;
  } catch (error) {
    return { refused: error };
  }
}

/** A path's member, and the members it was found in. */
interface FoundMember {
  readonly member: GitMember;
  readonly members: GitMembers;
}

/** What one run's cache did, for anyone measuring it. */
export interface ContentCacheStats {
  /** Reads served from an entry already held for the same path. */
  readonly hits: number;
  /** Reads that were not held: each one read its bytes, a member's from git, any other file's from disk. */
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
  /**
   * Each size refusal this run gave, by the same key: a file past the cap is
   * refused once per run, by its size and before a byte is read, and every later
   * lane that asks is handed the same refusal rather than a second `stat` and a
   * second count of it. Any other read failure is not held (see {@link read}).
   */
  readonly #refused = new Map<string, unknown>();
  #hits = 0;
  #misses = 0;
  #bytesHeld = 0;
  readonly #membersOf: RunMembersOf;
  /** The members, or why resolving them threw: asked once per run, a failure held and rethrown, never retried. */
  #members: { readonly members: GitMembers | null } | { readonly failed: unknown } | undefined;
  /**
   * The bytes of each held entry whose decode is not plain UTF-8 (a BOM, UTF-16, UTF-32), by the
   * entry's key: kept from the read that filled the entry, so {@link readWithBytes} never reads a
   * file a second time. A plain UTF-8 entry's content is its bytes' own reading, so it holds none.
   */
  readonly #undecodedBytes = new Map<string, Uint8Array>();
  /** {@link openRefusal}'s answer by resolved path: one probe (one `fs.stat`) per file per run, whichever lane asks. */
  readonly #openRefusals = new Map<string, Promise<OpenRefusal | null>>();

  /**
   * @param membersOf - The run's git members ({@link RunMembersOf}). Required: a run that keys
   *   every file from disk says so with {@link NO_GIT_MEMBERS}
   */
  constructor(membersOf: RunMembersOf) {
    this.#membersOf = membersOf;
  }

  /**
   * How this run keys a file git holds: by its object ID (`'git'`, a run with members) or by a hash
   * of its disk bytes (`'disk'`, a run built with {@link NO_GIT_MEMBERS}). Two runs that differ here
   * file one path under different content keys, so a stored extent answers only runs of its own kind.
   */
  get memberKeys(): 'git' | 'disk' {
    return this.#membersOf === NO_GIT_MEMBERS ? 'disk' : 'git';
  }

  /**
   * The content key of a path, reading as little as it can.
   *
   * A git member is keyed by its object name, `<parserKind>.<git-sha1|git-sha256>.<oid>`, with no
   * read and no hash. A parsed kind is still refused by size first, by its object's size, with the
   * same error and count a disk read gives ({@link refuseContentBySize}); that refusal is held as
   * {@link read}'s is. Any other path is {@link read} and its key.
   *
   * @param absolutePath - Absolute path to key
   * @param parserKind - The parser these bytes will actually be handed to
   * @returns The key
   * @throws What {@link read} throws, and a member's `GitObjectMissingError` when git does not hold
   *   its object
   */
  async key(absolutePath: string, parserKind: ParserKind): Promise<ContentKey> {
    const found = this.#memberAt(absolutePath);
    if (found === undefined) return (await this.read(absolutePath, parserKind)).key;
    await this.#admitMember(found, absolutePath, cacheKey(absolutePath, parserKind), parserKind);
    return memberKey(found.member, parserKind);
  }

  /**
   * What refuses reading a file now, if anything: {@link openRefusal} once per resolved path per
   * run, so every lane asking about one file (a member's key or read, a warm admission, a stored
   * document) pays one probe between them and gets one answer.
   *
   * @param absolutePath - The file
   * @returns The refusal, or `null` when the file can be read
   */
  openRefusal(absolutePath: string): Promise<OpenRefusal | null> {
    return memoized(this.#openRefusals, safePath.resolve(absolutePath), () => openRefusal(absolutePath));
  }

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
   * Both guards deliberately stay: `populateBlobs` also derives from rows that
   * reached a builder without a read through its cache (rows assembled by hand),
   * where a target's bytes genuinely were not read by this run, and a fresh read
   * there can still disagree with the key the row carries. Filing *those* bytes under *this* key would be the well-formed-
   * entry-wrong-contents failure, cache or no cache.
   *
   * Pinned by `projection-blob-population.test.ts` — "serves the bytes the base
   * read" (rows keyed through the cache) alongside "refuses to derive a blob from
   * bytes that no longer key to it" (rows that were not). The pair is what stops either semantics
   * drifting silently.
   *
   * A read failure is **not** cached: it is not a value, and a caller that
   * treats an unreadable file as a fact about the corpus (`collectRealization`
   * records a null key) has already handled it.
   *
   * A file of a parsed kind past the run's input cap is refused by its size and never read, as
   * the parse would refuse it ({@link isSizeRefusal}); that refusal is held, so the run refuses the
   * file once and every later lane is handed the same refusal.
   *
   * @param absolutePath - Absolute path to read
   * @param parserKind - The parser these bytes will actually be handed to
   * @returns The content, its key, and the parser it routes to
   * @throws Whatever `readFile` throws — callers decide whether that is fatal — and a
   *   `ParseLimitError` (`inputBytes`) for a parsed kind past the run's input cap
   */
  async read(absolutePath: string, parserKind: ParserKind): Promise<KeyedContent> {
    const key = cacheKey(absolutePath, parserKind);
    const held = this.#entries.get(key);
    if (held !== undefined) {
      this.#hits += 1;
      return held;
    }

    if (this.#refused.has(key)) throw this.#refused.get(key);

    const found = this.#memberAt(absolutePath);
    this.#misses += 1;
    if (found !== undefined) {
      const member = await this.#readMember(found, absolutePath, key, parserKind);
      return this.#hold(key, member.keyed, member.bytes);
    }

    // The population's own cap, never a caller's: the dispatcher, the store key and the refusal
    // sentence read the same {@link POPULATION_PARSE_LIMITS}, so no run reads past the cap on one
    // lane and refuses at it on the next.
    let read: { readonly keyed: KeyedContent; readonly bytes: Uint8Array };
    try {
      read = await readKeyedBytes(absolutePath, parserKind, POPULATION_PARSE_LIMITS.inputBytes);
    } catch (error) {
      if (isSizeRefusal(error)) this.#refused.set(key, error);
      throw error;
    }
    return this.#hold(key, read.keyed, read.bytes);
  }

  /**
   * {@link read}, with the bytes the content was decoded from when its decode is not plain UTF-8
   * (`null` when it is: the content is then exactly the bytes' UTF-8 reading), for a lane that
   * scans a file's undecoded text rather than its decoded content. The same one read per file per
   * run: a member's bytes from git, any other file's from disk, held to the same cap and refused the
   * same way.
   *
   * @param absolutePath - Absolute path to read
   * @param parserKind - The parser its content routes to, which files the read
   * @returns The read, and its bytes when its decode is not plain UTF-8
   * @throws What {@link read} throws
   */
  async readWithBytes(absolutePath: string, parserKind: ParserKind): Promise<{ readonly keyed: KeyedContent; readonly bytes: Uint8Array | null }> {
    const keyed = await this.read(absolutePath, parserKind);
    return { keyed, bytes: this.#undecodedBytes.get(cacheKey(absolutePath, parserKind)) ?? null };
  }

  /**
   * The member at `absolutePath`'s snapshot spelling, asking for the run's members on the first use
   * of a path inside their root. A path outside it asks nothing: it is no member.
   */
  #memberAt(absolutePath: string): FoundMember | undefined {
    const source = this.#membersOf;
    if (source === null || relativeEscapesRoot(safePath.relative(source.root, absolutePath))) return undefined;
    this.#members ??= resolvedMembers(source);
    if ('failed' in this.#members) throw this.#members.failed;
    const { members } = this.#members;
    const member = members?.memberAt(toForwardSlash(safePath.resolve(absolutePath)));
    return members === null || member === undefined ? undefined : { member, members };
  }

  /**
   * Admit a member as a disk read would: refused if its file cannot be opened now (readability is
   * about the file now, not its bytes, so a file git still holds but the run may not open is
   * unreadable store-on as store-off), then by its object's size, holding that refusal under `key`
   * as a disk read's is.
   */
  async #admitMember({ member, members }: FoundMember, absolutePath: string, key: string, parserKind: ParserKind): Promise<void> {
    if (this.#refused.has(key)) throw this.#refused.get(key);
    const refusal = await this.openRefusal(absolutePath);
    if (refusal !== null) throw refusal.refused;
    const size = await members.sizeOf(member);
    try {
      refuseContentBySize(size, parserKind, POPULATION_PARSE_LIMITS.inputBytes);
    } catch (error) {
      this.#refused.set(key, error);
      throw error;
    }
  }

  /** A member's bytes from git, decoded under its member key once its size is admitted. */
  async #readMember(
    found: FoundMember,
    absolutePath: string,
    key: string,
    parserKind: ParserKind,
  ): Promise<{ readonly keyed: KeyedContent; readonly bytes: Uint8Array }> {
    await this.#admitMember(found, absolutePath, key, parserKind);
    const bytes = await found.members.bytesOf(found.member);
    return { keyed: keyedFromBytes(bytes, parserKind, memberKey(found.member, parserKind)), bytes };
  }

  /** Hold one read for the rest of the run, with its bytes when its decode is not plain UTF-8. */
  #hold(key: string, keyed: KeyedContent, bytes: Uint8Array): KeyedContent {
    this.#entries.set(key, keyed);
    this.#bytesHeld += keyed.byteLength;
    if (!isPlainUtf8Decoding(keyed.decoding)) {
      this.#undecodedBytes.set(key, bytes);
    }
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
 * Read through a run's cache, or, for a caller outside a population that wants
 * the bytes themselves, straight from disk with no cap.
 *
 * One function rather than the same three-line conditional at every call site:
 * `collectRealization` and the blob-derivation stage must read *identically* or
 * the second one is not reusing the first one's read.
 *
 * @param absolutePath - Absolute path to read
 * @param parserKind - The parser these bytes will actually be handed to
 * @param cache - The run's cache, or `null` for a caller outside a population that parses nothing it reads
 * @returns The content, its key, and the parser it routes to
 */
export function readKeyedContent(
  absolutePath: string,
  parserKind: ParserKind,
  cache: RunContentCache | null,
): Promise<KeyedContent> {
  // `null` is a caller outside a population whose read no parse of this run follows (the CLI's
  // enumeration oracle): it is for the bytes themselves, so it has no cap.
  return cache === null
    ? readContentWithKey(absolutePath, parserKind, null)
    : cache.read(absolutePath, parserKind);
}

/**
 * Key a path, through a run's cache, or, for a caller outside a population, from disk with no cap:
 * {@link readKeyedContent}'s rule for a caller that needs only the key.
 *
 * @param absolutePath - Absolute path to key
 * @param parserKind - The parser these bytes will actually be handed to
 * @param cache - The run's cache, or `null` for a caller outside a population that parses nothing it reads
 * @returns The key
 */
export async function keyOfContent(
  absolutePath: string,
  parserKind: ParserKind,
  cache: RunContentCache | null,
): Promise<ContentKey> {
  return cache === null
    ? (await readContentWithKey(absolutePath, parserKind, null)).key
    : cache.key(absolutePath, parserKind);
}

/**
 * Whether a decode is the plain UTF-8 reading of its bytes: UTF-8 assumed, with no BOM. Any other
 * (a BOM-marked UTF-8, UTF-16 or UTF-32 file) decodes to other text than `readFileSync(path, 'utf-8')`.
 *
 * @param decoding - How the bytes were decoded
 * @returns `true` for plain UTF-8
 */
export function isPlainUtf8Decoding(decoding: Pick<KeyedContent['decoding'], 'encoding' | 'encodingSource'>): boolean {
  return decoding.encoding === 'utf-8' && decoding.encodingSource === 'assumed';
}

/** A members source's answer, or why it threw: held, so a failed resolve is never asked again. */
function resolvedMembers(source: RunMembersSource): { readonly members: GitMembers | null } | { readonly failed: unknown } {
  try {
    return { members: source.resolve() };
  } catch (error) {
    return { failed: error };
  }
}

/** A member's key: its object name, under the parser kind its content routes to. */
function memberKey(member: GitMember, parserKind: ParserKind): ContentKey {
  return formatContentKey({ parserKind, keyKind: member.keyKind, hex: member.oid });
}

/** The `(path, parserKind)` pair an entry is filed under. */
function cacheKey(absolutePath: string, parserKind: ParserKind): string {
  // The space is a separator, not decoration — the same construction
  // `mintResourceId` uses. A parser kind is `markdown` or `html` and contains no
  // space, so no two distinct pairs can spell one key.
  return `${parserKind} ${toForwardSlash(safePath.resolve(absolutePath))}`;
}
