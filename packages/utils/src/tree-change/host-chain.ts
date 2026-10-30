/**
 * The link-chain resolver ({@link walkLinkChain}) bound to this host's filesystem: `lstat` and
 * `readlink`, and nothing that follows a link. Every call VAT makes that FOLLOWS a link — a
 * `stat`, a `realpath` — reads the chain here first (`link-following.ts`, `assertLocalChain`), so
 * no lane — a write lane, a read lane, an untrusted tree or the user's own — hands the kernel a
 * chain whose every text has not been read.
 */

import { lstatSync, readlinkSync } from 'node:fs';

import { isPathAbsentError, LINK_CHAIN_REFUSED_CODE } from '../errors/errno-table.js';
import { isVatError, VatError } from '../errors/vat-error.js';
import { safePath, toForwardSlash } from '../path-core.js';

import { type ChainProbe, type ChainRefusal, type ChainRule, type LinkChain, MAX_LINK_HOPS, type PlaceKind, walkLinkChain } from './link-chain.js';

/**
 * What stands at `path`, a link there not followed. A probe the OS refuses is thrown raw, for the
 * caller to classify.
 *
 * ⚠️ "Not followed" is `lstat`'s word, and on Windows libuv keeps it only for what it calls a
 * symbolic link: a junction to a volume (`\??\Volume{…}\`) and a reparse point of another tag
 * (cloud files, dedup, WCI) are retried as a link-FOLLOWING `stat` and reported as the directory
 * or file they lead to. Their targets are local — the kernel refuses a remote mount point — so no
 * credential leaves the host, but the walk reads such a place as a plain directory where the
 * kernel reparses it.
 */
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
    case 'unportable':
      return `has a text no kernel resolves as written (${JSON.stringify(refusal.text)}: a NUL, or a name ending in a dot or a space)`;
    case 'absolute':
    case 'drive-relative':
    case 'climbs-out':
      return `leads outside the tree it is in (${refusal.text})`;
  }
}

/**
 * A path VAT would not resolve: a link on the way to it leads to a network path, or the chain is
 * longer than any kernel follows. A read lane records it as that one target's fault
 * (`linkResolutionFault`); a lane that stops classifies it on its own side, like any refusal
 * (`classifyFsFault`), so a destination's refused chain reads as the destination's.
 */
export class LinkChainRefusedError extends VatError {
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
