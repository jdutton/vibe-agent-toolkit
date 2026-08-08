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
 * ## Why the parser kind is IN the digest, not just in a prefix
 *
 * VAT selects its parser from the path extension
 * ({@link parserKindForPath}), so identical bytes at `x.md` and `x.html`
 * legitimately produce different parse results. That is realizable on the
 * **empty file**, which git keys as `e69de29…` in both cases. A key that
 * carried the parser kind only as a display prefix would still let a caller
 * that compares digests conflate the two. So the parser kind is mixed into the
 * hash preimage, and the prefix is a human-readable convenience.
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
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Which parser a document is routed to. This is part of a document's identity,
 * not an incidental property of it — see the module docstring.
 */
export type ParserKind = 'markdown' | 'html';

/**
 * Bumped by hand when a change to the parsers alters the facts they produce
 * from unchanged bytes.
 *
 * This is the only invalidation lever a content-addressed cache has. Deriving
 * it from the package version sounds cleaner and does not work: every worktree
 * on a machine reads the same version out of the same manifest, so parser edits
 * on a branch — precisely when invalidation is needed — would share a namespace
 * with `main` and with the published release of the same number. Matches the
 * `CACHE_VERSION` discipline already used by `external-link-cache.ts` and
 * `content-cache.ts`.
 */
export const CONTENT_KEY_SCHEMA_VERSION = 2;

/** Domain separator, so this keyspace can never be confused with a git SHA-1. */
const KEY_DOMAIN = 'vat-content-key';

/**
 * Decide which parser a path routes to.
 *
 * THE discriminator. `ResourceRegistry.addResource` calls this rather than
 * repeating the extension test, so the parser-selection rule and the
 * parser-selection component of the content key can never drift apart.
 *
 * @param filePath - Path the document was read from (need not exist)
 * @returns The parser kind VAT will hand this document to
 */
export function parserKindForPath(filePath: string): ParserKind {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm') ? 'html' : 'markdown';
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
    .update(`${KEY_DOMAIN}\0${String(CONTENT_KEY_SCHEMA_VERSION)}\0${parserKind}\0`, 'utf-8')
    .update(bytes)
    .digest('hex');
  return `k${String(CONTENT_KEY_SCHEMA_VERSION)}.${parserKind}.${digest}`;
}

/** A document's bytes and the key they were hashed under, from one read. */
export interface KeyedContent {
  /** The decoded content, exactly as it must be handed to the parser. */
  content: string;
  /** The key computed over the RAW BYTES this content was decoded from. */
  key: string;
  /** The parser this content routes to. */
  parserKind: ParserKind;
  /**
   * Length of the raw bytes.
   *
   * Carried because it is NOT derivable from {@link content}: decoding is lossy
   * on malformed UTF-8, so `Buffer.byteLength(content)` can differ from what was
   * actually on disk. `ParseResult.sizeBytes` is this number, and a cache must
   * store it rather than recompute it from the decoded string.
   */
  byteLength: number;
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
export async function readContentWithKey(
  filePath: string,
  parserKind: ParserKind,
): Promise<KeyedContent> {
  // Read as bytes and decode here, rather than letting readFile decode: the key
  // must be over what was on disk, and the decode is lossy.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied path, same trust level as the parsers this feeds
  const bytes = await readFile(filePath);
  return {
    content: bytes.toString('utf-8'),
    key: computeContentKey(bytes, parserKind),
    parserKind,
    byteLength: bytes.byteLength,
  };
}
