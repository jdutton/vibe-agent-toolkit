/**
 * Content keys: the identity a parse result is filed under.
 *
 * A parse result is a function of two things — the bytes handed to the parser,
 * and which parser was handed them. This module computes a key over exactly
 * that pair, and nothing else. It is deliberately path-independent: two copies
 * of the same document in different trees share a key, which is the whole point
 * (one parse serves every lane, and a historical blob that is not on disk is
 * still keyable).
 *
 * "Path-independent" describes the KEY, not the routing that selects the kind:
 * a collection's declared `mimeType` can change the kind (see
 * `projection/router.ts`), so editing that config invalidates the entries whose
 * type moved. Given the same bytes AND the same kind, the key is the same everywhere.
 *
 * ## Three kinds, and why "no parser" is one of them
 *
 * {@link ParserKind} is `markdown | html | none`. The third names the **absence
 * of a document parser**: nothing is handed to remark or parse5, and the only
 * facts a `none` blob carries are the ones derivable from its bytes.
 *
 * It is a VALUE rather than a `null`, and `parserKindForPath` stays
 * non-nullable, because a file nothing parses still earns a `blobs` row —
 * without one there is no `tokenEstimate`, `whatLoadsAt` reports `tokens: null`,
 * and the context-accounting lane reports `unknown-size`. A row needs a content
 * key; a key needs a parser-kind prefix; so the absence of a parser has to be
 * spellable.
 *
 * ## The key text: `<parserKind>.<keyKind>.<hex>`
 *
 * A key is a {@link ContentKey}: a branded string minted by
 * {@link formatContentKey} (and so by {@link computeContentKey}) or recognized by
 * {@link parseContentKey}, the one parser, or read back from a store this VAT
 * version wrote (see {@link ContentKey}). `keyKind` names how the hex was made:
 * `sha256` (64 lowercase hex, the plain SHA-256 of the raw bytes — the only kind
 * computed here), `git-sha1` (40) and `git-sha256` (64), git object IDs, which a
 * run's git members carry from the snapshot. Two keys are equal exactly when their text is (`===`), so
 * keys of different key kinds are never equal: one byte string has a key of each
 * kind, and they never group together.
 *
 * ## The parser kind is an unhashed qualifier, and that is still self-invalidating
 *
 * VAT selects its parser by TYPING the path — `mime-type.ts` answers *what this
 * is*, `parserKindForPath` turns that into *what runs over it*, so
 * identical bytes at `x.md` and `x.html` legitimately produce different parse
 * results. That is realizable on the **empty file**. So the parser kind is part
 * of the key's identity: it is IN the key text, and two keys are equal only when
 * their whole text is. Code compares keys by the full text (`===`), never the
 * hex alone; the hex is a field of the key, not the key.
 *
 * It is deliberately NOT in the hash preimage. A `sha256` key's hex is the plain
 * SHA-256 of the raw bytes, with no domain separator, so it can be compared with
 * a digest something else computed over the same bytes — a Git LFS pointer's
 * `oid sha256:` is exactly that, and the content check that a pulled file is the
 * pointer's object compares the two.
 *
 * A **routing change** is still self-invalidating. When `.ts` stopped routing to
 * markdown and started routing to `none`, its bytes did not change, but its key
 * did: `markdown.sha256.<hex>` became `none.sha256.<hex>`, a key no stored row is
 * filed under, so the stale remark facts became unreachable the instant the
 * routing moved — and no hand-maintained schema or cache version decided it. That
 * is deliberate: a number someone must remember to bump is not a contract, and
 * this project prohibits them. The key text *is* the invalidation.
 *
 * ## The git rung: an object ID keys the object's own bytes, never the disk's
 *
 * A run whose tree git keyed keys each snapshot member (a regular file the
 * snapshot lists; never a symlink, a submodule, an absent skip-worktree entry or
 * a Git LFS pointer path) by the object ID the dirty-corrected snapshot reports,
 * and reads its bytes from git's object store by that ID ({@link keyedFromBytes}
 * composes the decode with the key; {@link readContentByKey} reads by a key).
 * The three ways an OID goes wrong as a key for DISK bytes do not reach it: the
 * snapshot hashes a dirty file's edit, not the index's committed bytes; a
 * symlink is no member; and the bytes parsed are the object's, read under the
 * ID that names them, so no key is bound to bytes read at another moment. The
 * object's bytes are git's stored form (eol-normalized, clean-filtered), which
 * is what such a key means.
 *
 * Every other read hashes on read, in-process, over the bytes handed to the
 * parser. {@link readContentWithKey} exists so a caller cannot key one read and
 * parse another. A git OID never stands in for a DISK read: it names the
 * *cleaned* content, so one OID can name two different working-tree byte
 * strings in one repository at one instant (a per-path clean/smudge filter,
 * `working-tree-encoding` or `eol`), and serving one path the other's disk read
 * would file it under the wrong key with the wrong text.
 *
 * ## Why the preimage is RAW BYTES and not the decoded string
 *
 * It was the decoded string until schema version 2, and that was unsound.
 * UTF-8 decoding is many-to-one on invalid input: every malformed sequence
 * becomes U+FFFD. Measured —
 *
 * ```text
 * [c2]     statSize=1  decoded="�"   ┐
 * [e2 82]  statSize=2  decoded="�"   ├─ one key, three different files
 * [ff]     statSize=1  decoded="�"   ┘
 * ```
 *
 * `ParseResult.sizeBytes` is `stat().size` — a **raw byte** count — and it
 * reaches adopter-visible rule variables and link-rewriting templates. So a
 * cache keyed on the decoded string would serve a well-formed entry with the
 * wrong contents: precisely the failure the git rung above guards against,
 * reintroduced by a different route.
 *
 * Mixing the byte *length* into the key does not fix it — `[c2]` and `[ff]` are
 * both length 1. The preimage has to be the bytes.
 *
 * The general rule, for whoever extends this: **a key must cover every input
 * the cached value depends on.** Enumerate the cached struct's fields and ask of
 * each one, "is this a function of what I hashed?" Exactly one field was not,
 * and one was enough.
 *
 * ## Why the DECODE is somewhere else entirely
 *
 * This module owns the *identity* of a document. What its characters are is a
 * different question with a different answer, and `@vibe-agent-toolkit/utils`
 * owns it — `decodeTextContent` is a pure `utils` primitive precisely because a
 * decode knows nothing about keys, caches or the projection:
 * {@link readContentWithKey} reads bytes once, hands them to
 * `decodeTextContent` for the text and to {@link computeContentKey} for the key,
 * and those two consume the *same* byte string for opposite purposes.
 *
 * That split is the whole point. Decoding changes the content — a UTF-16BE file
 * that used to arrive as NUL-interleaved mojibake now arrives as the document it
 * is — and it must change nothing about the key, because the key's preimage is
 * what was on disk. So a decoder improvement is a change in what VAT can READ
 * and never a change in what a cache entry is FILED UNDER, and no cached parse
 * is invalidated by teaching the reader a new encoding.
 */

import { createHash } from 'node:crypto';

import { countWork, safePath } from '@vibe-agent-toolkit/utils';
import { exceedsDecodableLength, readDecodableBytes, TextTooLargeError } from '@vibe-agent-toolkit/utils/fs';
import { gitFindRoot, GitObjectReadError, type GitObjectReaders } from '@vibe-agent-toolkit/utils/git';
import { decodeTextContent, type TextProvenance } from '@vibe-agent-toolkit/utils/text';
import { z } from 'zod';

import type { DocumentParserKind } from './mime-type.js';
import { inputBytesBreach } from './parse-limits.js';

/**
 * The kind that means "no document parser runs on this": the router's answer for
 * a type no parser handles, and the same value as the `PARSER_KINDS` entry below.
 */
export const NO_PARSER_KIND = 'none';

/**
 * Every parser kind, as values — and the ONE place they are enumerated.
 *
 * {@link ParserKind} and {@link CONTENT_KEY_PATTERN} are both derived from this
 * array, in that direction on purpose. Written the other way round — a
 * hand-written union plus a hand-written alternation — the two drift, and the
 * drift is silent in the direction that matters: a kind the type admits but the
 * pattern rejects produces keys the parse cache's on-disk safety check and the
 * projection's `ContentKeySchema` both throw away, so an entire class of
 * document becomes uncacheable and unstorable with nothing failing.
 *
 * The values are bare identifier words, which is why they can be spliced into a
 * regex below without escaping. Keep them that way.
 */
export const PARSER_KINDS = ['markdown', 'html', NO_PARSER_KIND] as const;

/**
 * Which parser a document is routed to. This is part of a document's identity,
 * not an incidental property of it — see the module docstring.
 *
 * `none` is the absence of a parser, not a parser. It is a member because a blob
 * nothing parses still needs a key, and a key needs a kind.
 */
export type ParserKind = (typeof PARSER_KINDS)[number];

/**
 * Every kind that routes to a real parser — {@link PARSER_KINDS} without `none`.
 *
 * Derived rather than written out, in that direction for the same reason
 * {@link ParserKind} is: a caller that has to enumerate the document kinds — the
 * parse pool's sizing weights one cost per kind — would otherwise carry a second
 * list, and a kind added to `PARSER_KINDS` alone would be silently unweighted
 * there while every type still checked.
 */
export const DOCUMENT_PARSER_KINDS: readonly DocumentParserKind[] = PARSER_KINDS.filter(
  (kind): kind is DocumentParserKind => kind !== NO_PARSER_KIND,
);

/**
 * Every key kind, as values, and how many lowercase hex characters each carries.
 *
 * The one place key kinds are enumerated: {@link KeyKind} and
 * {@link CONTENT_KEY_PATTERN} are derived from it, for the reason
 * {@link PARSER_KINDS} gives. Bare words of `[a-z0-9-]`, spliced into a regex
 * unescaped (a `-` outside a character class is literal). No kind word is a
 * proper prefix of another, which is what makes {@link orderContentKeys} (text
 * order) agree with the tuple order (parserKind, keyKind, hex); a test asserts it
 * over every pair.
 */
const KEY_KIND_HEX_LENGTHS = { sha256: 64, 'git-sha1': 40, 'git-sha256': 64 } as const;

/** How a key's hex was made: see {@link KEY_KIND_HEX_LENGTHS}. */
export type KeyKind = keyof typeof KEY_KIND_HEX_LENGTHS;

/** Every key kind, in declaration order. */
export const KEY_KINDS: readonly KeyKind[] = Object.keys(KEY_KIND_HEX_LENGTHS) as KeyKind[];

/**
 * A content key: `<parserKind>.<keyKind>.<hex>`. Branded so a plain string cannot
 * stand in for one. A value of this type is minted by {@link formatContentKey}
 * (and so {@link computeContentKey}), {@link parseContentKey} or `ContentKeySchema`,
 * all of which hold it to {@link CONTENT_KEY_PATTERN}; or it is a row read back
 * from a projection store that this same VAT version wrote. The store lives in
 * the cache namespace (the VAT version), in a directory named by its shape digest,
 * so its rows were minted by this code; their key columns are typed by a cast, not
 * re-parsed per row. The one check on that read is `storedKeyOf` in
 * `projection/stored-reads.ts`, a boundary check on the grouping column a blob
 * read is split by, which refuses a damaged store rather than mis-filing its rows.
 * Two keys are equal exactly when their text is.
 */
export type ContentKey = string & { readonly __brand: 'ContentKey' };

/** The three fields a {@link ContentKey}'s text spells. */
export interface ContentKeyParts {
  readonly parserKind: ParserKind;
  readonly keyKind: KeyKind;
  readonly hex: string;
}

/**
 * The exact shape of a {@link ContentKey}: `<parserKind>.<keyKind>.<hex>`, the hex
 * length fixed per key kind. Exported so every consumer that must recognize a
 * well-formed key in a non-TypeScript form (the projection schema's JSON-Schema
 * `pattern`) shares the one definition; TypeScript code recognizes a key with
 * {@link parseContentKey}.
 *
 * Built from {@link PARSER_KINDS} and {@link KEY_KIND_HEX_LENGTHS} rather than
 * spelling the alternations out, so a kind added to either reaches the pattern.
 */
export const CONTENT_KEY_PATTERN =
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from PARSER_KINDS and KEY_KIND_HEX_LENGTHS, module-private `as const` bare words and integers; no input reaches it
  new RegExp(String.raw`^(?:${PARSER_KINDS.join('|')})\.(?:${
    KEY_KINDS.map((keyKind) => String.raw`${keyKind}\.[0-9a-f]{${KEY_KIND_HEX_LENGTHS[keyKind]}}`).join('|')
  })$`);

/**
 * A content key as a projection row column: `<parserKind>.<keyKind>.<hex>`, as
 * {@link computeContentKey} produces it —
 * `<parserKind>.<keyKind>.<hex>`. This is the primary key of the `blobs` table and
 * the foreign key every blob-keyed and path-dependent table joins through.
 *
 * Still a `ZodString` at runtime, so the emitted JSON Schema carries the same
 * `pattern` and the shape digest sees the same declaration; typed to parse to the
 * branded {@link ContentKey}, which the regex is exactly the proof of, so every
 * row type inferred from it carries the brand. Declared here, beside the parser,
 * because it is one of the format's mints.
 */
export const ContentKeySchema = z.string().regex(CONTENT_KEY_PATTERN)
  .describe('A content key: "<parserKind>.<keyKind>.<hex>" (keyKind sha256 | git-sha1 | git-sha256)') as unknown as z.ZodType<ContentKey, z.ZodStringDef, string>;

/**
 * The one parser: `text` as a {@link ContentKey} when it is one, else `undefined`.
 *
 * @param text - Any string
 * @returns The key, or `undefined` for anything {@link CONTENT_KEY_PATTERN} refuses
 */
export function parseContentKey(text: string): ContentKey | undefined {
  return CONTENT_KEY_PATTERN.test(text) ? (text as ContentKey) : undefined;
}

/**
 * Spell a key from its parts.
 *
 * @param parts - The parser kind, key kind and hex
 * @returns The key
 * @throws {Error} When the parts do not spell a well-formed key (a hex of the wrong length or case)
 */
export function formatContentKey(parts: ContentKeyParts): ContentKey {
  const text = `${parts.parserKind}.${parts.keyKind}.${parts.hex}`;
  const key = parseContentKey(text);
  if (key === undefined) throw new Error(`"${text}" is not a well-formed ${parts.keyKind} content key`);
  return key;
}

/**
 * Read a key's three fields back off its text.
 *
 * @param key - A key
 * @returns Its parser kind, key kind and hex
 */
export function contentKeyParts(key: ContentKey): ContentKeyParts {
  const first = key.indexOf('.');
  const second = key.indexOf('.', first + 1);
  return {
    parserKind: key.slice(0, first) as ParserKind,
    keyKind: key.slice(first + 1, second) as KeyKind,
    hex: key.slice(second + 1),
  };
}

/**
 * The one order over keys: code-unit order of the text, which is the tuple order (parserKind,
 * keyKind, hex) because no kind word is a proper prefix of another. It is also SQLite's `BINARY`
 * collation over the stored text, so an `ORDER BY` and this order agree.
 *
 * @param a - A key
 * @param b - Another key
 * @returns Negative, zero or positive, as `Array.prototype.sort` takes
 */
export function orderContentKeys(a: ContentKey, b: ContentKey): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Compute the content key for a document: `<parserKind>.sha256.<SHA-256 of the raw bytes>`.
 *
 * Takes **raw bytes**, not a decoded string, and the type is the enforcement:
 * a caller holding only a decoded string cannot reach this function without
 * re-encoding, and re-encoding a string that came from lossy decoding does not
 * reproduce the original bytes. See the module docstring for the measurement.
 *
 * @param bytes - The exact bytes read from disk, before decoding
 * @param parserKind - Which parser receives the decoded form
 * @returns An opaque, stable, path-independent key
 *
 * @example
 * ```typescript
 * const empty = new Uint8Array();
 * computeContentKey(empty, 'markdown') !== computeContentKey(empty, 'html'); // true
 * ```
 */
export function computeContentKey(bytes: Uint8Array, parserKind: ParserKind): ContentKey {
  countWork('content.hashed', 1);
  countWork('content.hashedBytes', bytes.byteLength);
  const hex = createHash('sha256').update(bytes).digest('hex');
  return formatContentKey({ parserKind, keyKind: 'sha256', hex });
}

/**
 * A document's bytes and the key they were hashed under, from one read.
 *
 * Generic in the kind so {@link readContentWithKey} can hand back *the kind it
 * was asked for* rather than the whole union. That is what lets
 * {@link ParsableContent} be a type rather than a runtime assertion: a caller
 * that read with a literal `'markdown'` needs no narrowing to reach the parse
 * path, and a caller that read with `parserKindForPath`'s answer cannot
 * reach it without one.
 */
export interface KeyedContent<K extends ParserKind = ParserKind> {
  /**
   * The decoded content, exactly as it must be handed to the parser.
   *
   * Decoded through `decodeTextContent` (`@vibe-agent-toolkit/utils/text`) —
   * BOM-announced UTF-8/UTF-16/UTF-32 honoured, BOM stripped, UTF-8 assumed
   * otherwise.
   */
  content: string;
  /**
   * What that decode knew, guessed, and lost.
   *
   * Carried rather than discarded because this is the only place the knowledge
   * exists: by the time any consumer sees {@link content} it is a JS string, and
   * a string mis-decoded from BOM-less UTF-16 or from windows-1252 is
   * indistinguishable from a string that says what it means. The projection's
   * `blobs` row spells these three out as columns — see
   * `schemas/projection-blobs.ts` — so a corpus can be *asked* how much of its
   * indexed text is garbage instead of being silently poisoned by it.
   *
   * A function of the bytes alone, exactly like {@link key} and
   * {@link byteLength}, so a run cache holding this struct memoizes the
   * provenance as soundly as it memoizes the content.
   */
  decoding: TextProvenance;
  /** The key computed over the RAW BYTES this content was decoded from. */
  key: ContentKey;
  /** The parser this content routes to. */
  parserKind: K;
  /**
   * Length of the raw bytes.
   *
   * Carried because it is NOT derivable from {@link content}, for two
   * independent reasons: decoding is lossy on malformed UTF-8, and the encoding
   * need not be UTF-8 at all — a 40-byte UTF-16BE document decodes to 19 UTF-8
   * bytes' worth of characters. `Buffer.byteLength(content)` recovers neither.
   * `ParseResult.sizeBytes` is this number, and a cache must store it rather
   * than recompute it from the decoded string.
   */
  byteLength: number;
}

/**
 * Content and the size of the bytes it came from — what a lane holds content to the parse input
 * cap by. A read's {@link KeyedContent} is one, measured in its raw bytes; content that was never
 * read is one through {@link inMemoryContent}. Required wherever content is held to the cap, so a
 * lane holding a read cannot re-measure its text in another unit.
 */
export type MeasuredContent = Pick<KeyedContent, 'content' | 'byteLength'>;

/**
 * Content that was never read from bytes (a string built or handed over in memory), measured as
 * its UTF-8 bytes, the unit a key over it is computed in.
 *
 * @param content - The text
 * @returns The text, measured
 */
export function inMemoryContent(content: string): MeasuredContent {
  return { content, byteLength: Buffer.byteLength(content, 'utf8') };
}

/**
 * Content that routes to a real document parser — i.e. not `none`.
 *
 * The type a parse dispatcher takes, so "hand these bytes to a parser" is unreachable
 * for a blob that has no parser. Expressing it in the type rather than as a
 * runtime branch inside the dispatcher is the whole point: the alternative is a
 * throw, or an empty `ParseResult` invented on the caller's behalf, at a place
 * that has no idea what the caller wanted. A producer that silently emits
 * nothing is a bug nursery; a compile error at the call site is not.
 */
export type ParsableContent = KeyedContent<DocumentParserKind>;

/**
 * Whether a parser runs over this content at all.
 *
 * A type guard rather than a bare `kind !== 'none'` comparison because narrowing
 * a property does not narrow the object: only a predicate turns a
 * {@link KeyedContent} into a {@link ParsableContent} the parse path will accept.
 *
 * @param keyed - Content of any kind
 * @returns `true` when a document parser is defined for its kind
 */
export function isParsableContent(keyed: KeyedContent): keyed is ParsableContent {
  return keyed.parserKind !== NO_PARSER_KIND;
}

/**
 * Read a file and key it in one step.
 *
 * Prefer this over calling {@link computeContentKey} on separately-read bytes:
 * the gap between "derive the key" and "read what gets parsed" is the window in
 * which a save produces a valid entry filed under the wrong key.
 *
 * ## Why `parserKind` is a REQUIRED argument and not defaulted to the extension
 *
 * The key must name the parser that will actually run, and a collection's
 * declared `mimeType` can route a file to a parser its extension does not name.
 * Defaulting to the path-only `parserKindForPath` would file one parser's facts
 * under the other's key: a well-formed entry with the wrong contents, which
 * fail-soft does not cover (see parse-cache.ts). A default is silent at every
 * call site that gets it wrong.
 *
 * ## Why `inputBytes` is REQUIRED too
 *
 * Every read made for a parse holds the file to the run's parse input cap here, by its `fstat`
 * size, before a byte is read (a lane parsing for a route reads through
 * `readContentForParse`), and the comparison is `inputBytesBreach`'s, so a file past the cap is the
 * same `ParseLimitError` (`inputBytes`, naming the cap alone) on every one. `null` says the read is for the bytes themselves (a content key no parse
 * follows), and each caller says which it is: an optional cap was omitted by every caller that
 * never thought about it. The cap applies only to a kind a parser reads; a `none` read is never
 * parsed, so it is never capped. Accepted: re-reads that hand nothing to a parser read the file
 * directly and are not held to the cap — the compat detectors' re-read of a linked file the skill validator already parsed under the cap, its implicit-reference scan, the packager's read-back of a packaged markdown file for its links, and the compatibility analyzer's Python import scan.
 *
 * @param filePath - Absolute path to read
 * @param parserKind - The parser this content will actually be handed to.
 *   Callers that route by extension pass `parserKindForPath(filePath)`.
 * @param inputBytes - The run's parse input cap, or `null` when the read is for the bytes themselves
 * @returns The content, its key, and the parser it routes to
 * @throws Whatever `readFile` throws — callers decide whether a read failure is
 *   fatal or a miss — `TextTooLargeError` (`TEXT_TOO_LARGE`) for a file too
 *   large to decode, which is neither: the bytes are readable, just not as one
 *   string — and a `ParseLimitError` (`inputBytes`) for a parsed kind past `inputBytes`
 */
export async function readContentWithKey<K extends ParserKind>(
  filePath: string,
  parserKind: K,
  inputBytes: number | null,
): Promise<KeyedContent<K>> {
  // Read as bytes and decode here, rather than letting readFile decode: the key
  // must be over what was on disk, the decode is lossy, and `readFile(path,
  // 'utf-8')` offers no BOM or encoding handling at all.
  //
  // The one read path, `readDecodableBytes` (a pipe or device is refused, never waited on; sized
  // by `fstat` on the handle it reads, so a rename cannot substitute another file): a file past the
  // input cap, or too large to become a string at all (`TextTooLargeError`), is refused before a
  // byte is read, rather than read whole (up to 2 GiB) only for the parse or the decode to refuse it.
  const bytes = await readDecodableBytes(filePath, (size) => {
    refuseContentBySize(size, parserKind, inputBytes);
  });
  countWork('content.read', 1);
  // `decodeTextContent` is the ONE decoder — see `utils`' text-content.ts. The
  // bytes handed to `computeContentKey` are the same ones, undecoded, on purpose:
  // this function COMPOSES a decode with a raw-bytes key.
  //
  // Destructured rather than field-by-field so `decoding` IS whatever
  // `TextProvenance` holds. A decoder that learns to report a fourth fact about
  // its input then reaches the projection without an edit here — and, more to the
  // point, cannot be silently dropped here either.
  return keyBytes(bytes, parserKind);
}

/**
 * Refuse content by its size alone, before a byte of it is read: a kind a parser reads past the
 * input cap (a `ParseLimitError`, `inputBytes`, counted as `parse.refused.inputCap.read`), and any
 * kind too large to decode (`TextTooLargeError`).
 *
 * The one size rule for every read made for a parse: {@link readContentWithKey} applies it to the
 * file's `fstat` size, and the run cache to a git member's object size, so a file refused on disk
 * is refused from git with the same error and the same count. A refused read never reaches
 * `ParseDispatcher.parse`, so the refusal is never counted twice.
 *
 * @param size - The content's size in bytes
 * @param parserKind - The parser the content routes to; `none` is never held to the cap
 * @param inputBytes - The run's parse input cap, or `null` when the read is for the bytes themselves
 * @throws A `ParseLimitError` (`inputBytes`) past the cap, and `TextTooLargeError` past what decodes
 */
export function refuseContentBySize(size: number, parserKind: ParserKind, inputBytes: number | null): void {
  const breach = inputBytes === null || parserKind === NO_PARSER_KIND ? undefined : inputBytesBreach(size, inputBytes);
  if (breach !== undefined) {
    countWork('parse.refused.inputCap.read', 1);
    throw breach;
  }
  if (exceedsDecodableLength(size)) throw new TextTooLargeError(size);
}

/**
 * Read the bytes a key names, from where the key says they are, and key them again.
 *
 * - A git key (`git-sha1`, `git-sha256`) names an object: it is read from the object store of the
 *   repository holding `absolutePath`, through `objects`, and decoded under that same key. The
 *   working tree is not read, so the bytes are git's stored form (eol-normalized, clean-filtered).
 * - A `sha256` key names bytes on disk: the file is read and keyed afresh, so a file changed since
 *   it was keyed comes back under another key, and the caller's comparison says so.
 *
 * For a caller that holds a key a population minted and needs the bytes behind it (a build, an
 * index), never for a parse: nothing is held to the parse input cap.
 *
 * @param absolutePath - The file the key was minted for
 * @param contentKey - Its key
 * @param objects - The caller's object readers, which a git key's read goes through
 * @returns The content, keyed: `contentKey` itself for a git key
 * @throws What the object read rejects with (`GitObjectMissingError` for an object git does not
 *   hold), `GitObjectReadError` when no repository holds the path, and what a disk read throws
 */
export async function readContentByKey(
  absolutePath: string,
  contentKey: ContentKey,
  objects: GitObjectReaders,
): Promise<KeyedContent> {
  const { parserKind, keyKind, hex } = contentKeyParts(contentKey);
  if (keyKind === 'sha256') return readContentWithKey(absolutePath, parserKind, null);
  const directory = safePath.resolve(absolutePath, '..');
  const repositoryRoot = gitFindRoot(directory);
  if (repositoryRoot === null) throw new GitObjectReadError(directory, `no git repository holds ${absolutePath}, so ${contentKey} names nothing to read`);
  return keyedFromBytes(await objects.read(repositoryRoot, hex), parserKind, contentKey);
}

/**
 * Key a document a caller already holds as a string — the same struct
 * {@link readContentWithKey} builds from a file.
 *
 * The bytes keyed are the string's UTF-8 encoding, and they are decoded back
 * through the one decoder, so what is parsed is exactly what the key covers: a
 * leading U+FEFF is stripped as a BOM and a lone surrogate becomes U+FFFD, the
 * same as for those bytes read from disk.
 *
 * @param text - The document
 * @param parserKind - The parser this content will actually be handed to
 * @returns The content, its key, and the parser it routes to
 */
export function keyContent<K extends ParserKind>(text: string, parserKind: K): KeyedContent<K> {
  return keyBytes(Buffer.from(text, 'utf-8'), parserKind);
}

/**
 * Hash and key one buffer of raw bytes: the composition the disk read and {@link keyContent} share.
 *
 * @param bytes - The raw bytes
 * @param parserKind - The parser they route to
 * @returns The keyed content
 */
function keyBytes<K extends ParserKind>(bytes: Uint8Array, parserKind: K): KeyedContent<K> {
  return keyedFromBytes(bytes, parserKind, computeContentKey(bytes, parserKind));
}

/**
 * Decode one buffer of raw bytes through the one decoder, filed under a key the caller already
 * holds for exactly those bytes: the sha256 of them ({@link keyBytes}), or the git object name they
 * were read by.
 *
 * @param bytes - The raw bytes
 * @param parserKind - The parser they route to
 * @param key - Their key, whose parser kind is `parserKind`
 * @returns The keyed content
 * @throws {Error} When `key` names another parser kind: a key must name the parser its content goes to
 */
export function keyedFromBytes<K extends ParserKind>(bytes: Uint8Array, parserKind: K, key: ContentKey): KeyedContent<K> {
  const named = contentKeyParts(key).parserKind;
  if (named !== parserKind) throw new Error(`${key} names the ${named} parser, not ${parserKind}`);
  const { text, ...decoding } = decodeTextContent(bytes);
  return {
    content: text,
    decoding,
    key,
    parserKind,
    byteLength: bytes.byteLength,
  };
}
