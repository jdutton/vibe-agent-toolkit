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
  /** Resolved, and lands outside the root — carried as `relativize` spells it. */
  | { readonly kind: 'outside-root'; readonly path: string }
  /** The token named no file: an anchor-only href, or a dialect that declined it. */
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
