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
export const CONTENT_KEY_SCHEMA_VERSION = 1;

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
 * @param content - The exact string handed to the parser (decoded, not raw bytes —
 *   VAT's parsers take a UTF-8 decoded string, so that is what identity is over)
 * @param parserKind - Which parser receives it
 * @returns An opaque, stable, path-independent key
 *
 * @example
 * ```typescript
 * computeContentKey('', 'markdown') !== computeContentKey('', 'html'); // true
 * ```
 */
export function computeContentKey(content: string, parserKind: ParserKind): string {
  const digest = createHash('sha256')
    .update(`${KEY_DOMAIN}\0${String(CONTENT_KEY_SCHEMA_VERSION)}\0${parserKind}\0`, 'utf-8')
    .update(content, 'utf-8')
    .digest('hex');
  return `k${String(CONTENT_KEY_SCHEMA_VERSION)}.${parserKind}.${digest}`;
}

/** A document's bytes and the key they were hashed under, from one read. */
export interface KeyedContent {
  /** The decoded content, exactly as it must be handed to the parser. */
  content: string;
  /** The key computed over {@link content}. */
  key: string;
  /** The parser this content routes to. */
  parserKind: ParserKind;
}

/**
 * Read a file and key it in one step.
 *
 * Prefer this over calling {@link computeContentKey} on separately-read bytes:
 * the gap between "derive the key" and "read what gets parsed" is the window in
 * which a save produces a valid entry filed under the wrong key.
 *
 * @param filePath - Absolute path to read
 * @returns The content, its key, and the parser it routes to
 * @throws Whatever `readFile` throws — callers decide whether a read failure is
 *   fatal or a miss
 */
export async function readContentWithKey(filePath: string): Promise<KeyedContent> {
  const parserKind = parserKindForPath(filePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied path, same trust level as the parsers this feeds
  const content = await readFile(filePath, 'utf-8');
  return { content, key: computeContentKey(content, parserKind), parserKind };
}
