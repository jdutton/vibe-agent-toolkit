/**
 * Where one authored reference points, as a **path** — the half of resolution
 * that does not depend on who is asking.
 *
 * ## Why this is its own module
 *
 * Two consumers need the same answer and index their realizations differently.
 * `contributors/closure-extent.ts` walks an extent and looks a path up in the
 * walk's `byPath` map; the edge lens resolves every reference in a context and
 * holds its own index. Both were about to run the same four steps — resolve
 * under the dialect, relativize against the root, decide whether it escaped —
 * and a second copy would give the corpus **two answers to one question**, with
 * nothing to keep them in step. The steps live here once; each caller does its
 * own realization lookup, which is the part that genuinely differs.
 *
 * The split is at exactly the point where the answer stops being a fact about
 * the reference and starts being a fact about the *corpus*: a path either is or
 * is not inside the root, whoever asks; whether a realization holds that path
 * is a question only an index can answer.
 *
 * ## ⚠️ One filesystem call, inherited and stated
 *
 * `resolveLocalHref`'s root-absolute branch (`/foo.md`) canonicalizes through
 * `realpath`, so this is not I/O-free for that one href shape.
 * `closure-extent.ts` already carried that exception and documented it; moving
 * the code here moves the exception with it rather than introducing one. A
 * caller that needs a guaranteed-pure resolution must exclude root-absolute
 * hrefs itself — this module will not silently skip them, because refusing to
 * resolve a reference an author wrote is the worse error.
 */

import { isAbsoluteAnyPlatform } from '@vibe-agent-toolkit/utils';

import type { ReferenceDialect } from '../schemas/project-config.js';

import { resolveDialectRef } from './contributors/reference-dialect.js';
import { relativize } from './realizations.js';

/**
 * A scheme-bearing or protocol-relative reference, matched on the raw token.
 *
 * `//host/path` is protocol-relative and not a local file. A bare `mailto:`,
 * `tel:`, `https:` or any other scheme is caught by the scheme production of
 * RFC 3986 §3.1 — a letter followed by letters, digits, `+`, `-` or `.`, then
 * `:` — so `1:notes.md` and `docs/a:b.md` are paths, as the RFC says they are.
 * A Windows drive letter (`C:\…`) also matches, and excluding it is correct
 * here: an absolute drive path is not a corpus-relative reference either.
 */
const NON_LOCAL_REF = /^(?:\/\/|[a-z][\w+.-]*:)/iu;

/**
 * Is this reference something other than a path into the corpus?
 *
 * 🔑 The ONE answer, imported by every consumer — the closure contributor, the
 * edge lens and the discovery lens. It used to be three: two byte-identical
 * copies of the regex above, and a third predicate ("a colon before any
 * slash") that answered FALSE for `//cdn.example/lib.js` and handed it to the
 * path resolver, which reported a document nobody wrote. `blob_references`
 * records the raw token and not the link type, so without this test every
 * external URL resolves against the referring directory, finds nothing, and is
 * reported as a broken *local* reference. A second copy would give the corpus
 * two answers to one question, with nothing to keep them in step — the
 * argument this module's header makes for the path half.
 *
 * @param rawRef - The reference exactly as authored
 * @returns True when the token names an external or non-filesystem target
 */
export function isNonLocalRef(rawRef: string): boolean {
  return NON_LOCAL_REF.test(rawRef);
}

/**
 * Where a reference points, before anything asks whether a file is there.
 *
 * Three outcomes, and the reason they are three rather than two is that
 * `outside-root` and `unresolvable` are different reports: the first names a
 * real destination this corpus simply stops short of, and the second means the
 * token did not name a file at all. Collapsing them makes a dangling-link count
 * a fiction — the same objection zones.md §5 raises about `dstResource: null`.
 */
export type ReferencePathResolution =
  /** A root-relative path. Whether anything realizes it is the caller's question. */
  | { readonly kind: 'inside-root'; readonly path: string }
  /**
   * Resolved, and lands outside the root — carried as `relativize` spells it.
   * Both ways out land here: a relative reference that climbs past the root,
   * and a root-absolute one whose traversal escapes it.
   */
  | { readonly kind: 'outside-root'; readonly path: string }
  /**
   * The token named no file: an anchor-only href, or a dialect that declined
   * it. NOT a root-absolute reference that escapes the root — that names a real
   * destination, and folding it in here was exactly the collapse described
   * above.
   */
  | { readonly kind: 'unresolvable' };

/**
 * Resolve one reference token to a path, relative to the file that wrote it.
 *
 * @param dialect - How the token is to be read (`href`, `claude-import`)
 * @param rawRef - The reference exactly as authored, `@` and all
 * @param fromPath - Root-relative path of the file holding the reference;
 *   resolution is relative to the REFERRING file, never to the root
 * @param root - Absolute corpus root
 * @returns Which of the three outcomes this token has
 */
export function resolveReferencePath(
  dialect: ReferenceDialect,
  rawRef: string,
  fromPath: string,
  root: string,
): ReferencePathResolution {
  const resolution = resolveDialectRef(dialect, rawRef, joinRoot(root, fromPath), root);
  // 🚨 `absolute_escapes_root` is a destination, not a non-answer: `/../x.md`
  // resolved to a real path the corpus stops short of. The resolver carries the
  // candidate it computed, so this is spelled from THAT — no second resolution
  // here, against a containment rule this module does not own.
  if (resolution.kind === 'absolute_escapes_root') {
    return { kind: 'outside-root', path: relativize(resolution.resolvedPath, root) };
  }
  // `anchor_only` named no file; `absolute_no_root` cannot occur, since `root`
  // is always supplied — it is listed so the exhaustiveness is visible.
  if (resolution.kind !== 'resolved') return { kind: 'unresolvable' };
  const relative = relativize(resolution.resolvedPath, root);
  return escapesRoot(relative)
    ? { kind: 'outside-root', path: relative }
    : { kind: 'inside-root', path: relative };
}

/**
 * Does a path stated against the root fall OUTSIDE it?
 *
 * Two spellings, because `safePath.relative` has two ways of saying "not under
 * this root": a `..`-prefixed relative path in the ordinary case, and an
 * ABSOLUTE path when no relative route exists at all — which on Windows is what
 * a different drive letter produces. Testing only the first would silently admit
 * `D:/elsewhere/doc.md` as though it were a root-relative member, on the one
 * platform where nobody would see it fail.
 *
 * `..` alone is the root's own parent directory and is outside by the same rule;
 * it is spelled separately because it carries no trailing separator to match.
 *
 * The parameter is named `normalized…` because the name states the precondition
 * this function does not check, which is also what discharges
 * `local/no-path-startswith`.
 *
 * @param normalizedRelative - A root-relative path as `relativize` spells it
 * @returns True when the path names something the root does not contain
 */
function escapesRoot(normalizedRelative: string): boolean {
  return normalizedRelative === '..'
    || normalizedRelative.startsWith('../')
    || isAbsoluteAnyPlatform(normalizedRelative);
}

/**
 * The absolute path of a root-relative member.
 *
 * Deliberately string concatenation rather than `safePath.join`: the row's
 * `path` column is already forward-slashed and normalized, so `join` would only
 * re-do work while inviting a platform separator back into a value every other
 * column spells with `/`.
 *
 * @param root - Absolute corpus root, forward-slashed
 * @param path - Root-relative, forward-slashed path
 * @returns The absolute path
 */
function joinRoot(root: string, path: string): string {
  return `${root}/${path}`;
}
