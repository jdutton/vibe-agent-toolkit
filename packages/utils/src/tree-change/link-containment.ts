/**
 * The rule for a tree whose links are KEPT: none of them may lead outside it.
 *
 * A copy that preserves links carries each link's text verbatim, so a link out of the tree
 * arrives pointing at whatever stands at that path beside the COPY — the installing user's own
 * files — and every reader of the copy that follows links reads them as the tree's content. So a
 * tree that came from somewhere VAT does not own (a cloned repository, a directory an operator
 * installs from) is checked here before anything reads it.
 */

import { lstatSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { dirname, sep } from 'node:path';

import { fsFaultOf, isPathAbsentError } from '../errors/errno-table.js';
import { VatError } from '../errors/vat-error.js';
import { canonicalPath, isUnderRoot } from '../path-containment.js';
import { safePath, toForwardSlash } from '../path-core.js';

import { COPY_LINK_ESCAPES_SOURCE_CODE } from './followed-walk.js';
import { type LinkHost, type LinkTextRefusal, linkTextRefusal, type PlaceKind } from './link-walk.js';

/** The host whose kernel resolves the links of a tree VAT reads here. */
const THIS_HOST: LinkHost = sep === '\\' ? 'win32' : 'posix';

/** What {@link refuseEscapingLinks} checks, and how its refusal names it. */
export interface LinkContainmentCheck {
  /** The tree no link may lead out of. */
  readonly root: string;
  /** Where in it to look; the whole of `root` when omitted. */
  readonly subtree?: string;
  /** A directory under `root` that is never entered (a clone's `.git`). */
  readonly skip?: string;
  /**
   * Whether the tree is read where it stands, or will be RELOCATED (an install copies it, each
   * link's text verbatim).
   *
   * - `in-place`: a link is judged by where it leads NOW — its real path, and its own text
   *   resolved from where it is. One that dangles reads nothing, so it is not refused.
   * - `relocated`: where a link leads now proves nothing about where its text leads once the tree
   *   is somewhere else, so the text itself is walked ({@link linkTextRefusal}): relative, never
   *   above the root, through no other link, and ending at something that exists.
   */
  readonly placement: 'in-place' | 'relocated';
  /** What the tree is, for the refusal: `the cloned repository`. */
  readonly tree: string;
  /** What a link must stay inside, for the refusal: `the clone`. */
  readonly within: string;
  /** What keeping the link would do, for the refusal — a sentence without its full stop. */
  readonly consequence: string;
}

/**
 * Where `candidate` stands relative to `root`, on real paths. The root itself counts as inside
 * (`isUnderRoot` calls a root `outside` itself, which is right for a sink and wrong here).
 *
 * @param root - The tree
 * @param candidate - A path in any spelling, existing or not
 */
export function treeContainment(root: string, candidate: string): 'inside' | 'outside' | 'absent' {
  if (canonicalPath(candidate) === canonicalPath(root)) return 'inside';
  return isUnderRoot(root, candidate);
}

/** The refusal of the link at `link`, named relative to the tree as the filesystem spells it. */
function linkRefusal(check: LinkContainmentCheck, link: string, what: string): VatError {
  return new VatError(
    COPY_LINK_ESCAPES_SOURCE_CODE,
    `Refusing ${check.tree}: ${safePath.relative(canonicalPath(check.root), link)} is a symbolic link ${what}. ` +
      `${check.consequence} — replace the link with the files, or point it inside with a relative target.`,
  );
}

/** What stands at `path`, a link there not followed. A probe the OS refuses is thrown raw, for the caller to classify. */
function kindAt(path: string): PlaceKind {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return 'link';
    return stats.isDirectory() ? 'directory' : 'file';
  } catch (error: unknown) {
    if (isPathAbsentError(error)) return 'absent';
    throw error;
  }
}

/** How each refusal of a link's text reads, after "is a symbolic link ". */
function describedRefusal(check: LinkContainmentCheck, text: string, refusal: LinkTextRefusal): string {
  switch (refusal.why) {
    case 'absolute':
      return `with an absolute target (${text}), which would still point there once ${check.within} is copied`;
    case 'climbs-out':
      return `to a path outside ${check.within} (${text})`;
    case 'through-link':
      return `whose target passes through another symbolic link (${refusal.at}), so where ${text} leads depends on where ${check.within} is copied`;
    case 'dangling':
      return `to nothing (${refusal.at} does not exist), so where it would lead once ${check.within} is copied cannot be shown`;
  }
}

/**
 * The second lock on a link of a tree that will be relocated: the KERNEL's resolution of it, at
 * the source, must exist and be inside the tree. The walk of the text ({@link linkTextRefusal})
 * shows the text stays inside wherever the tree goes; this shows the walk's reading of the text
 * is the kernel's. A link the kernel cannot resolve — it dangles, it is part of a cycle, anything
 * — is a refusal of the link, never a filesystem fault: nothing can be shown about where it leads.
 *
 * @returns Why the link is refused, after "is a symbolic link ", or `undefined` when the kernel agrees
 */
function kernelRefusal(check: LinkContainmentCheck, root: string, link: string, text: string): string | undefined {
  try {
    // Followed to the end, as a reader of the link would: this fails where the kernel finds nothing.
    statSync(link);
  } catch (error: unknown) {
    const fault = fsFaultOf(error);
    if (fault === undefined) throw error;
    return `to nothing (${text} does not resolve: ${fault.errno}), so where it would lead once ${check.within} is copied cannot be shown`;
  }
  // It resolves, so its canonical path is its real one.
  return treeContainment(root, link) === 'inside' ? undefined : `to a path outside ${check.within} (${text} resolves outside it)`;
}

/**
 * Throw when the link at `link` may not be kept; otherwise answer the directory it leads to, for
 * the walk to enter, or `undefined`. `link` is spelled by its REAL directory, so its text is read
 * from where the link is — never from an alias of that directory, which reads a climbing text as
 * staying inside.
 *
 * In place, the target is judged from the text as well as its real path, so a DANGLING link aimed
 * outside is refused too: it names a path the tree does not own. Relocated, the text is walked
 * AND the kernel is asked ({@link kernelRefusal}): two locks, both of which must pass.
 */
function followLink(check: LinkContainmentCheck, root: string, link: string): string | undefined {
  const text = readlinkSync(link);
  if (check.placement === 'relocated') {
    const below = safePath.relative(root, dirname(link));
    const refusal = linkTextRefusal(below === '' ? [] : toForwardSlash(below).split('/'), text, (place) => kindAt(safePath.join(root, ...place)), THIS_HOST);
    if (refusal !== undefined) throw linkRefusal(check, link, describedRefusal(check, text, refusal));
    const unresolved = kernelRefusal(check, root, link, text);
    if (unresolved !== undefined) throw linkRefusal(check, link, unresolved);
  } else if (treeContainment(root, safePath.resolve(dirname(link), text)) === 'outside' || treeContainment(root, link) === 'outside') {
    throw linkRefusal(check, link, `to a path outside ${check.within}`);
  }
  try {
    return statSync(link).isDirectory() ? canonicalPath(link) : undefined;
  } catch (error: unknown) {
    if (isPathAbsentError(error)) return undefined;
    throw error;
  }
}

/**
 * Refuse a tree holding a symbolic link that may not be kept: one leading outside it, and — for a
 * tree that will be relocated — one whose text cannot be shown to stay inside wherever the tree
 * goes ({@link LinkContainmentCheck.placement}). Every directory is walked at its REAL path, once: a link that stays inside is followed to the directory it names,
 * so a link into a sibling cannot smuggle out a second hop, a link cycle ends, and a directory
 * first reached through an alias still has its own links judged where they live.
 *
 * @param check - The tree, where in it to look, and how the refusal names it
 * @throws VatError `COPY_LINK_ESCAPES_SOURCE` — the tree's own link, so the input's refusal —
 *   naming the first link found leading out; the raw errno of a listing or a `readlink` the OS
 *   refuses, for the caller to classify on the side it knows the tree is on
 */
export function refuseEscapingLinks(check: LinkContainmentCheck): void {
  const skipped = check.skip === undefined ? undefined : canonicalPath(check.skip);
  const visited = new Set<string>();
  const root = canonicalPath(check.root);
  const pending = [canonicalPath(check.subtree ?? check.root)];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    if (dir === skipped || visited.has(dir)) continue;
    visited.add(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = safePath.join(dir, entry.name);
      const next = entry.isSymbolicLink() ? followLink(check, root, entryPath) : entry.isDirectory() && entryPath;
      if (typeof next === 'string') pending.push(next);
    }
  }
}
