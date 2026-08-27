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
 * ⚠️ **"Path-independent" describes the KEY, not the routing that selects the
 * kind.** The second half of the pair is chosen by typing the path, and a
 * project's `resources.collections` may declare a `mimeType` that overrides the
 * built-in tables — so the kind, and therefore the key, is a function of
 * `vibe-agent-toolkit.config.yaml` as well as of the path. Two consequences a
 * caller must not be surprised by: editing that config invalidates parse-cache
 * entries for every file whose declared type moved (sound, and free, because the
 * kind is in the preimage), and a caller that types a path itself must route
 * through the run's `CollectionMimeResolver` rather than calling
 * {@link parserKindForPath} directly, or the two will disagree about the same
 * file. What stays true unconditionally is the property the key exists for:
 * given the same bytes AND the same kind, the key is the same everywhere.
 *
 * ## Three kinds, and why "no parser" is one of them
 *
 * {@link ParserKind} is `markdown | html | none`. The third names the **absence
 * of a document parser**: nothing is handed to remark or parse5, and the only
 * facts a `none` blob carries are the ones derivable from its bytes.
 *
 * It is a VALUE rather than a `null`, and {@link parserKindForPath} stays
 * non-nullable, because a file nothing parses still earns a `blobs` row —
 * without one there is no `tokenEstimate`, `whatLoadsAt` reports `tokens: null`,
 * and the context-accounting lane reports `unknown-size`. A row needs a content
 * key; a key needs a parser-kind prefix; so the absence of a parser has to be
 * spellable.
 *
 * ## Why the parser kind is IN the digest, not just in a prefix
 *
 * VAT selects its parser by TYPING the path — `mime-type.ts` answers *what this
 * is*, {@link parserKindForPath} turns that into *what runs over it* — so
 * identical bytes at `x.md` and `x.html` legitimately produce different parse
 * results. That is realizable on the **empty file**, which git keys as
 * `e69de29…` in both cases. A key that carried the parser kind only as a display
 * prefix would still let a caller that compares digests conflate the two. So the
 * parser kind is mixed into the hash preimage, and the prefix is a
 * human-readable convenience.
 *
 * That mixing is also what makes a **routing change** self-invalidating. When
 * `.ts` stopped routing to markdown and started routing to `none`, its bytes did
 * not change: a key over bytes alone would keep serving the stale remark facts
 * out of a cache that looks perfectly healthy. Because the kind is in the
 * preimage, every affected entry became unreachable the instant the routing
 * moved — and no hand-maintained schema or cache version decided it. That is
 * deliberate: a number someone must remember to bump is not a contract, and this
 * project prohibits them. The digest *is* the invalidation.
 *
 * ## Why there is no git rung here
 *
 * `git ls-files -s` hands back a blob SHA for free, which is tempting. It is
 * also wrong three ways: it returns the *index* SHA (naming committed bytes for
 * a tracked-but-dirty file); git stores a symlink as a blob containing the link
 * *target string*, so two symlinks with the same relative target that resolve to
 * different files share a SHA while VAT's crawler follows them and the parser
 * reads through; and any key derived at enumeration time and used to file a
 * parse performed later binds the old key to the new document if the file was
 * saved in between — a well-formed cache entry with the wrong contents, which
 * fail-soft does not cover.
 *
 * The rule this module enforces instead: **hash on read, in-process, over the
 * bytes handed to the parser.** {@link readContentWithKey} exists so a caller
 * cannot key one read and parse another. A git SHA may still be used as a
 * *lookup hint* whose miss is free — it must never be the key.
 *
 * A hint's **hit** is only free if the hint is one-to-one against working-tree
 * bytes, and a blob OID is not: it names the *cleaned* content, so one OID can
 * name two different working-tree byte strings in one repository at one instant.
 * What a hit then costs is mostly a key that does not describe this path's
 * bytes — a later fresh read of the path misses — and, only where `filter.*` or
 * `working-tree-encoding` config diverges between the sharing paths, the text
 * served as well. `RunContentCache.#byHint` in `projection/content-cache.ts`
 * holds the measurements, separates those two costs, and names the lane exposed
 * to it.
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
 * wrong contents: precisely the failure the git-SHA argument above rejects,
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
import { readFile } from 'node:fs/promises';

import { decodeTextContent, type TextProvenance } from '@vibe-agent-toolkit/utils/text';

import { type DocumentParserKind, mimeTypeForPath, parserKindForMimeType } from './mime-type.js';

/**
 * The kind that means "no document parser runs on this".
 *
 * Exported because `parserKindForMimeType` returns `null` for a type no parser
 * handles, and every caller that routes from a MIME type has to spell the
 * fallback. Spelling it as a literal at those call sites is how the two halves
 * of one decision drift: this constant and the `PARSER_KINDS` entry below are
 * the same value by construction.
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
const PARSER_KINDS = ['markdown', 'html', NO_PARSER_KIND] as const;

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

/** Domain separator, so this keyspace can never be confused with a git SHA-1. */
const KEY_DOMAIN = 'vat-content-key';

/**
 * The exact shape {@link computeContentKey} produces — `<parserKind>.<64
 * lowercase hex chars>`. Exported so every consumer that must recognize a
 * well-formed key (the parse cache's on-disk safety check, the projection
 * schema's `ContentKeySchema`) shares one definition instead of two regexes
 * that can silently drift apart.
 *
 * Built from {@link PARSER_KINDS} rather than spelling the alternation out, so
 * "two regexes that can drift" does not quietly become "a regex and a union that
 * can drift" the first time a kind is added.
 */
export const CONTENT_KEY_PATTERN =
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from PARSER_KINDS, a module-private `as const` array of bare identifier words; no input reaches it
  new RegExp(String.raw`^(?:${PARSER_KINDS.join('|')})\.[0-9a-f]{64}$`);

/**
 * Decide which parser a path routes to.
 *
 * THE discriminator. `ResourceRegistry.addResource` calls this rather than
 * repeating the test, so the parser-selection rule and the parser-selection
 * component of the content key can never drift apart.
 *
 * ## Why this goes through a MIME type
 *
 * Because it used to be `endsWith('.html') ? html : markdown`, and that
 * else-branch handed every `.ts`, `.json`, `.lock` and `.snap` file in a
 * repository to remark. Measured on one adopter tree: 5,329 TypeScript files and
 * 713 JSON files parsed as CommonMark, producing 64.7% of all reference rows and
 * **100%** of dangling-reference warnings — a JSON-Schema `pattern` like
 * `"^[a-z][a-z0-9-]*$"` is two adjacent bracket groups, which is a reference
 * link. Routing now asks `mime-type.ts` what the file IS first, and only a type
 * that means prose or markup reaches a parser.
 *
 * Non-nullable, and `none` is the else-branch: see the module docstring for why
 * a blob nothing parses still needs a kind. The assignment of
 * `parserKindForMimeType`'s answer into a {@link ParserKind} is also the only
 * check binding the two modules' kind sets — a kind added over in `mime-type.ts`
 * and not to {@link PARSER_KINDS} fails to compile HERE, which is what keeps
 * {@link CONTENT_KEY_PATTERN} from going stale.
 *
 * @param filePath - Path the document was read from (need not exist)
 * @returns The parser kind VAT will hand this document to, or `none` when
 *   nothing parses it
 */
export function parserKindForPath(filePath: string): ParserKind {
  return parserKindForMimeType(mimeTypeForPath(filePath)) ?? NO_PARSER_KIND;
}

/**
 * Compute the content key for a document.
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
export function computeContentKey(bytes: Uint8Array, parserKind: ParserKind): string {
  const digest = createHash('sha256')
    .update(`${KEY_DOMAIN}\0${parserKind}\0`, 'utf-8')
    .update(bytes)
    .digest('hex');
  return `${parserKind}.${digest}`;
}

/**
 * A document's bytes and the key they were hashed under, from one read.
 *
 * Generic in the kind so {@link readContentWithKey} can hand back *the kind it
 * was asked for* rather than the whole union. That is what lets
 * {@link ParsableContent} be a type rather than a runtime assertion: a caller
 * that read with a literal `'markdown'` needs no narrowing to reach the parse
 * path, and a caller that read with {@link parserKindForPath}'s answer cannot
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
  key: string;
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
 * Content that routes to a real document parser — i.e. not `none`.
 *
 * The type `parseKeyed` takes, so "hand these bytes to a parser" is unreachable
 * for a blob that has no parser. Expressing it in the type rather than as a
 * runtime branch inside `parseKeyed` is the whole point: the alternative is a
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
 * The key must name the parser that will actually run, not the one the
 * extension implies, and those genuinely differ in shipped code:
 * `rag-lancedb/src/lancedb-rag-provider.ts` hands every resource — including the
 * `.html` ones the registry crawls — to the **markdown** parser. Defaulting to
 * {@link parserKindForPath} would file that document's markdown facts under
 * `k2.html.<digest>`, the same key the registry's genuine HTML parse uses, and
 * one lane would then be served the other's facts. That is a well-formed entry
 * with the wrong contents — the failure class fail-soft explicitly does not
 * cover (see parse-cache.ts).
 *
 * Making it required rather than defaulted is deliberate: a default here is
 * silent at every call site that gets it wrong, and correct at none that a
 * reviewer can see.
 *
 * @param filePath - Absolute path to read
 * @param parserKind - The parser this content will actually be handed to.
 *   Callers that route by extension pass `parserKindForPath(filePath)`.
 * @returns The content, its key, and the parser it routes to
 * @throws Whatever `readFile` throws — callers decide whether a read failure is
 *   fatal or a miss
 */
export async function readContentWithKey<K extends ParserKind>(
  filePath: string,
  parserKind: K,
): Promise<KeyedContent<K>> {
  // Read as bytes and decode here, rather than letting readFile decode: the key
  // must be over what was on disk, the decode is lossy, and `readFile(path,
  // 'utf-8')` offers no BOM or encoding handling at all.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied path, same trust level as the parsers this feeds
  const bytes = await readFile(filePath);
  // `decodeTextContent` is the ONE decoder — see `utils`' text-content.ts. The
  // bytes handed to `computeContentKey` are the same ones, undecoded, on purpose:
  // this function COMPOSES a decode with a raw-bytes key.
  //
  // Destructured rather than field-by-field so `decoding` IS whatever
  // `TextProvenance` holds. A decoder that learns to report a fourth fact about
  // its input then reaches the projection without an edit here — and, more to the
  // point, cannot be silently dropped here either.
  const { text, ...decoding } = decodeTextContent(bytes);
  return {
    content: text,
    decoding,
    key: computeContentKey(bytes, parserKind),
    parserKind,
    byteLength: bytes.byteLength,
  };
}
