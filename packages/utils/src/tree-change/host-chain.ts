/**
 * The link-chain resolver ({@link walkLinkChain}) bound to this host's filesystem: `lstat` and
 * `readlink`, and nothing that follows a link. Every `realpath` VAT asks the kernel goes through
 * {@link assertLocalChain} first (`path-utils.ts`), so no lane — a write lane, a read lane, an
 * untrusted tree or the user's own — hands the kernel a chain whose every text has not been read.
 */

import { lstatSync, readlinkSync } from 'node:fs';

import { fsFaultOf, isPathAbsentError, LINK_CHAIN_REFUSED_CODE } from '../errors/errno-table.js';
import { isVatError, VatError } from '../errors/vat-error.js';
import { safePath, toForwardSlash } from '../path-core.js';

import { type ChainProbe, type ChainRefusal, type ChainRule, type LinkChain, MAX_LINK_HOPS, namedPathRoot, type PathFlavor, type PlaceKind, walkLinkChain } from './link-chain.js';

/** What stands at `path`, a link there not followed. A probe the OS refuses is thrown raw, for the caller to classify. */
export function hostPlaceKind(path: string): PlaceKind {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return 'link';
    return stats.isDirectory() ? 'directory' : 'file';
  } catch (error: unknown) {
    if (isPathAbsentError(error)) return 'absent';
    throw error;
  }
}

/** The probe of this host's filesystem: `lstat` and `readlink` alone. */
const HOST_PROBE: ChainProbe = { kindAt: hostPlaceKind, textAt: (path) => readlinkSync(path) };

/**
 * Where `path` leads on this host's filesystem, under `rule` ({@link walkLinkChain}).
 *
 * @param path - Absolute, or relative to cwd; either separator
 * @param rule - The flavor (bound from the host at the edge), the tree, and what the chain may do outside it
 * @throws The raw errno of an `lstat` or `readlink` the OS refused, for the caller to classify
 */
export function walkHostChain(path: string, rule: ChainRule): LinkChain {
  return walkLinkChain(toForwardSlash(safePath.resolve(path)), rule, HOST_PROBE);
}

/** How each refusal reads, after "the symbolic link <link> ". */
function refusalClause(refusal: ChainRefusal): string {
  switch (refusal.why) {
    case 'network':
      return `leads to ${refusal.text}, a network or device path, which VAT never asks the OS to follow (a Windows host would offer the operator's credentials to it)`;
    case 'hop-limit':
      return `starts a chain of more than ${MAX_LINK_HOPS.toString()} symbolic links that is not a cycle, so where it ends was never read`;
    case 'absolute':
    case 'drive-relative':
    case 'climbs-out':
      return `leads outside the tree it is in (${refusal.text})`;
  }
}

/**
 * A path VAT would not resolve: a link on the way to it leads to a network path, or the chain is
 * longer than any kernel follows. A read lane records it as that one target's fault
 * (`linkResolutionFault`); a write lane stops, the input's refusal.
 */
class LinkChainRefusedError extends VatError {
  /** The path whose resolution was asked. */
  readonly path: string;
  /** Why, with the link whose text decided it. */
  readonly refusal: ChainRefusal;
  constructor(path: string, refusal: ChainRefusal) {
    super(LINK_CHAIN_REFUSED_CODE, `Refusing to resolve ${path}: the symbolic link ${refusal.link} ${refusalClause(refusal)} — replace the link with the files it names.`);
    this.path = path;
    this.refusal = refusal;
  }
}

/** Whether `error` is a {@link LinkChainRefusedError}, by its code (a `dist` copy never `instanceof`-matches a `src` one). */
export function isLinkChainRefusedError(error: unknown): error is VatError & { readonly path: string; readonly refusal: ChainRefusal } {
  return isVatError(error, LINK_CHAIN_REFUSED_CODE) && 'refusal' in error;
}

/**
 * Throw unless every link on the way to `path` has been read and leads somewhere local — the
 * check the kernel's `realpath` is the SECOND lock behind. The user's own paths: an absolute local
 * text is followed and walked by the same rules, so a later hop's network text is still caught.
 * A chain that leads to nothing (a dangle, a cycle) is not this check's to refuse: the kernel,
 * asked next, answers it with its own errno.
 *
 * Only a Windows kernel is guarded: it is the one that answers a link to `\\host\share` by
 * opening a session with the host (a POSIX kernel reads that text as a file name), and the walk
 * costs an `lstat` of every component from the drive root, ancestors of the tree included — on
 * POSIX that would be pure cost. A probe the OS refuses (an ancestor VAT may not look at) leaves
 * the answer to the kernel, exactly as before the check existed: the check cannot read that place,
 * and the kernel's own errno, classified where it is asked, is the true answer.
 *
 * @param path - Absolute, or relative to cwd; either separator
 * @param flavor - Whose kernel is about to be asked: bound from `process.platform` at the edge
 * @throws LinkChainRefusedError when a link on the way names a network or device path, or the chain never ends
 */
export function assertLocalChain(path: string, flavor: PathFlavor): void {
  if (flavor !== 'win32') return;
  const start = toForwardSlash(safePath.resolve(path));
  let chain: LinkChain;
  try {
    chain = walkLinkChain(start, { flavor, root: namedPathRoot(start, flavor), outside: 'follow' }, HOST_PROBE);
  } catch (error: unknown) {
    if (fsFaultOf(error) !== undefined) return;
    throw error;
  }
  if (chain.kind === 'refused') throw new LinkChainRefusedError(path, chain.refusal);
}
