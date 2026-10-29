/**
 * The rule for a tree whose links are KEPT: none of them may lead outside it.
 *
 * A copy that preserves links carries each link's text verbatim, so a link out of the tree
 * arrives pointing at whatever stands at that path beside the COPY — the installing user's own
 * files — and every reader of the copy that follows links reads them as the tree's content. So a
 * tree that came from somewhere VAT does not own (a cloned repository, a directory an operator
 * installs from) is checked here before anything reads it.
 */

import { readdirSync, readlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import { fsFaultOf } from '../errors/errno-table.js';
import { assertUnresolvableLink, type FsSide, withFsFaultSync } from '../errors/fs-fault.js';
import { VatError } from '../errors/vat-error.js';
import { requireFollowedStatSync } from '../link-following.js';
import { canonicalPath, isUnderRoot } from '../path-containment.js';
import { safePath, toForwardSlash } from '../path-core.js';

import { COPY_LINK_ESCAPES_SOURCE_CODE } from './followed-walk.js';
import { hostPlaceKind, walkHostChain } from './host-chain.js';
import { type ChainRefusal, type LinkChain, MAX_LINK_HOPS, type PathFlavor } from './link-chain.js';
import { type LinkTextRefusal, linkTextRefusal } from './link-walk.js';

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
   * - `in-place`: a link is judged by where it leads NOW. Its chain is read first, link by link,
   *   by the one resolver ({@link treeChain}), so nothing is resolved until every text on the way
   *   is: a network, absolute or drive-relative text anywhere on the way, a climb above the root,
   *   or a chain no kernel finishes, is refused. Then its real path must be inside. One that leads
   *   to nothing (a dangle, a cycle) reads nothing, so it is not refused.
   * - `relocated`: where a link leads now proves nothing about where its text leads once the tree
   *   is somewhere else, so the text itself is walked ({@link linkTextRefusal}): relative, never
   *   above the root, through no other link, and ending at something that exists. Then the chain
   *   from it is read as in place, and only then is the kernel asked ({@link kernelRefusal}).
   */
  readonly placement: 'in-place' | 'relocated';
  /** Which side the tree is on: every probe of it the OS refuses — a listing, an `lstat`, a `readlink`, a link's target — is that side's fault. */
  readonly side: FsSide;
  /** Whose kernel reads the tree: bound from `process.platform` at the edge (`HOST_PATH_FLAVOR`). */
  readonly flavor: PathFlavor;
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
  if (canonicalPath(candidate, root) === canonicalPath(root, root)) return 'inside';
  return isUnderRoot(root, candidate);
}

/**
 * Where `path` leads in an UNTRUSTED tree, read link by link by the one resolver — `lstat` and
 * `readlink` alone — before anything resolves it: an absolute, drive-relative or network text on
 * the way (under either flavor: the tree may be read on the other host), a climb above `root`,
 * or a chain longer than the hop limit that is not a cycle, is refused; a cycle leads to
 * nothing, as a dangling link does; nothing outside `root` is probed.
 *
 * @param root - The tree, spelled as `path` spells it (its own components are never probed)
 * @param path - A path below it (a link, or a subpath the operator named)
 * @param flavor - Whose kernel will resolve it: bound from the host at the edge
 * @throws The raw errno of an `lstat` or `readlink` the OS refused, for the caller to classify
 */
export function treeChain(root: string, path: string, flavor: PathFlavor): LinkChain {
  return walkHostChain(path, { flavor, root: safePath.resolve(root), outside: 'refuse' });
}

/** The refusal of the link at `link`, named relative to the tree as the filesystem spells it. */
function linkRefusal(check: LinkContainmentCheck, link: string, what: string): VatError {
  return new VatError(
    COPY_LINK_ESCAPES_SOURCE_CODE,
    `Refusing ${check.tree}: ${safePath.relative(canonicalPath(check.root, check.root), link)} is a symbolic link ${what}. ` +
      `${check.consequence} — replace the link with the files, or point it inside with a relative target.`,
  );
}

/** How a refused chain reads, after "is a symbolic link "; `text` is the link's own. */
function describedChainRefusal(check: LinkContainmentCheck, text: string, refusal: ChainRefusal): string {
  switch (refusal.why) {
    case 'network':
    case 'absolute':
    case 'drive-relative':
      return `whose target leads through an absolute path (${refusal.text}), which names a place outside ${check.within}`;
    case 'climbs-out':
      return `to a path outside ${check.within} (${text})`;
    case 'hop-limit':
      return `whose target starts a chain of more than ${MAX_LINK_HOPS.toString()} symbolic links that is not a cycle, so where it ends cannot be shown`;
    case 'unportable':
      return `whose target names a component no Windows host can spell (${refusal.text}): a NUL, or a name ending in a dot or a space that Windows strips`;
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
 * The last lock on a link of a tree that will be relocated: the KERNEL's resolution of it, at
 * the source, must exist and be inside the tree. Asked only once the chain from the link has been
 * read and shown local ({@link treeChain}). The walk of the text ({@link linkTextRefusal}) shows
 * the text stays inside wherever the tree goes; this shows the walk's reading of the text is the
 * kernel's. A probe that failed because the link resolves to nothing
 * (`isUnresolvableLinkError`: it dangles, it is part of a cycle, Windows cannot follow its reparse
 * data) is a refusal of the link on every host: nothing can be shown about where it leads. Every
 * other failure — the OS declining (`EACCES`, `EPERM`), running short (`EMFILE`), held (`EBUSY`) or
 * unable to look (`EIO`, `ETIMEDOUT`, Windows' ambiguous `UNKNOWN`) — says nothing about the link:
 * a fault on the tree, thrown classified by the one write-lane catch body
 * (`assertUnresolvableLink`, on the side the caller names in `check.side`, found as content).
 *
 * Exported apart from the walk so the lock can be shown to hold ALONE: with a correct walk, a
 * link the kernel resolves outside never reaches it from a real tree.
 *
 * @param root - The tree, as its canonical path
 * @param link - The link, spelled by its real directory
 * @param text - The link's own text, for the refusal
 * @returns Why the link is refused, after "is a symbolic link ", or `undefined` when the kernel agrees
 * @throws FsFaultError on `check.side` for a probe that failed for any other reason; an error that carries no errno as it was
 */
export function kernelRefusal(check: LinkContainmentCheck, root: string, link: string, text: string): string | undefined {
  try {
    // Followed to the end, as a reader of the link would: this fails where the kernel finds nothing.
    requireFollowedStatSync(link, root);
  } catch (error: unknown) {
    const fault = fsFaultOf(error);
    if (fault === undefined) throw error;
    // The action names the link: a refusal on its chain names the place refused, which may be its target.
    assertUnresolvableLink(error, { side: check.side, origin: 'content', action: `resolve the symbolic link ${link}`, path: link });
    return `to nothing (${text} does not resolve: ${fault.errno}), so where it would lead once ${check.within} is copied cannot be shown`;
  }
  // It resolves, so its canonical path is its real one.
  return treeContainment(root, link) === 'inside' ? undefined : `to a path outside ${check.within} (${text} resolves outside it)`;
}

/** Why one link may not be kept, or the directory it leads to for the walk to enter (`enter`), or neither. */
type LinkVerdict = { readonly refusal: string } | { readonly enter: string | undefined };

/**
 * Judge the link at `link` under `check.placement` — spelled by its REAL directory, so its text is
 * read from where the link is, never from an alias of that directory, which reads a climbing text
 * as staying inside.
 *
 * Either way the CHAIN is read first ({@link treeChain}) and the kernel last, so nothing the text
 * names is resolved until every text on the way has been read. Relocated, the text is walked
 * through no link before that ({@link linkTextRefusal}) and the kernel is asked after it
 * ({@link kernelRefusal}); in place, the kernel's real path must be inside.
 */
function judgeLink(check: LinkContainmentCheck, root: string, link: string): LinkVerdict {
  const text = readlinkSync(link);
  if (check.placement === 'relocated') {
    const below = safePath.relative(root, dirname(link));
    const textRefusal = linkTextRefusal(below === '' ? [] : toForwardSlash(below).split('/'), text, (place) => hostPlaceKind(safePath.join(root, ...place)), check.flavor);
    if (textRefusal !== undefined) return { refusal: describedRefusal(check, text, textRefusal) };
  }
  const chain = treeChain(root, link, check.flavor);
  if (chain.kind === 'refused') return { refusal: describedChainRefusal(check, text, chain.refusal) };
  if (check.placement === 'relocated') {
    // Every text on the way was read and is local: the kernel may now be asked, as the last lock.
    const refusal = kernelRefusal(check, root, link, text);
    if (refusal !== undefined) return { refusal };
  } else if (chain.kind === 'nothing') {
    // A dangle or a cycle, every text read: in place it reads nothing.
    return { enter: undefined };
  } else if (treeContainment(root, link) === 'outside') {
    return { refusal: `to a path outside ${check.within}` };
  }
  return { enter: chain.kind === 'resolved' && chain.final === 'directory' ? canonicalPath(link, root) : undefined };
}

/**
 * Refuse a tree holding a symbolic link that may not be kept: one leading outside it, and — for a
 * tree that will be relocated — one whose text cannot be shown to stay inside wherever the tree
 * goes ({@link LinkContainmentCheck.placement}). Every directory is walked at its REAL path, once: a
 * link that stays inside is followed to the directory it names, so a link into a sibling cannot
 * smuggle out a second hop, a link cycle ends, and a directory first reached through an alias still
 * has its own links judged where they live.
 *
 * @param check - The tree, where in it to look, and how the refusal names it
 * @throws VatError `COPY_LINK_ESCAPES_SOURCE` — the tree's own link, so the input's refusal —
 *   naming the first link found leading out; FsFaultError on `check.side`, found as content, for
 *   every probe of the tree the OS refused (a listing, an `lstat`, a `readlink`, a relocated link's
 *   target)
 */
export function refuseEscapingLinks(check: LinkContainmentCheck): void {
  withFsFaultSync({ side: check.side, origin: 'content', action: `examine the links of ${check.tree}`, path: check.subtree ?? check.root }, () => {
    const skipped = check.skip === undefined ? undefined : canonicalPath(check.skip, check.root);
    const visited = new Set<string>();
    const root = canonicalPath(check.root, check.root);
    const pending = [canonicalPath(check.subtree ?? check.root, check.root)];
    for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
      if (dir === skipped || visited.has(dir)) continue;
      visited.add(dir);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const entryPath = safePath.join(dir, entry.name);
        const next = entry.isSymbolicLink() ? enterOrThrow(check, root, entryPath) : entry.isDirectory() && entryPath;
        if (typeof next === 'string') pending.push(next);
      }
    }
  });
}

/** The directory a kept link leads to, for the walk to enter; throws the link's refusal. */
function enterOrThrow(check: LinkContainmentCheck, root: string, link: string): string | undefined {
  const verdict = judgeLink(check, root, link);
  if ('refusal' in verdict) throw linkRefusal(check, link, verdict.refusal);
  return verdict.enter;
}
