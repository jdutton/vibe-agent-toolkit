/**
 * The link-chain resolver ({@link walkLinkChain}) bound to this host's filesystem: `lstat` and
 * `readlink`, and nothing that follows a link. Every call VAT makes that FOLLOWS a link — a
 * `stat`, a `realpath` — reads the chain here first (`link-following.ts`, `assertLocalChain`), so
 * no lane — a write lane, a read lane, an untrusted tree or the user's own — hands the kernel a
 * chain whose every text has not been read.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, readlinkSync } from 'node:fs';

import { isInvalidArgumentError, isPathAbsentError, LINK_CHAIN_REFUSED_CODE } from '../errors/errno-table.js';
import { isVatError, VatError } from '../errors/vat-error.js';
import { safePath, toForwardSlash } from '../path-core.js';
import { shownName, visibleText } from '../shown-text.js';
import { countWork } from '../work-counters.js';

import { type ChainProbe, type ChainRefusal, type ChainRule, type LinkChain, MAX_LINK_HOPS, type PlaceKind, walkLinkChain } from './link-chain.js';

/** The place kinds read inside one {@link withPlaceKindMemo} bracket, and the trees they may be kept for. */
interface PlaceKindMemo {
  /** Each tree root's `${root}/`, forward-slashed, precomputed once: a path kept is strictly beneath one. */
  readonly prefixes: readonly string[];
  /** What stood at each path when first read, `absent` included; never a refusal. */
  readonly kinds: Map<string, PlaceKind>;
  /**
   * Each walk's answer ({@link walkHostChain}), keyed by its rule and start, kept only for a walk
   * that read no link and every place it read is one {@link PlaceKindMemo.kinds} keeps: such an
   * answer is a function of kept kinds alone, so walking again could only answer the same. Not a
   * second memo of what stands where, the same one read whole.
   */
  readonly chains: Map<string, LinkChain>;
}

/**
 * The memo of the bracket now open. `AsyncLocalStorage`, never a module-level `Map`, for the reason
 * `withGitSnapshotCache` gives: a process-wide memo would hand a stale kind to anything that changes
 * a tree and walks it again in one process (a vitest worker, a long-lived host). `null` is the
 * explicit "walk afresh" bracket ({@link withoutPlaceKindMemo}) a writer opens, which shadows any
 * memo of an enclosing reader; `undefined` is no bracket at all. Both ask the kernel every time.
 */
const placeKindsInBracket = new AsyncLocalStorage<PlaceKindMemo | null>();

/**
 * Run `run` with {@link hostPlaceKind} answering a path strictly beneath any of `roots` from a memo
 * after its first `lstat`. Reached through `withPlaceKindSnapshot` (`link-following.ts`), which
 * names each root in the spelling the walk under it uses.
 *
 * Inside an open memo that already keeps every path beneath `roots`, `run` uses that memo: one run,
 * one memo, however many brackets its work opens. Otherwise (no bracket, a writer's
 * {@link withoutPlaceKindMemo}, or a memo over other trees) it opens an empty one.
 *
 * @param roots - Absolute tree roots, forward-slashed, exactly as the walk spells the paths beneath them
 * @param run - The work; its return value is passed straight through, so an async `run` keeps the memo for its whole promise
 */
export function withPlaceKindMemo<T>(roots: readonly string[], run: () => T): T {
  const prefixes = roots.map((root) => (root.endsWith('/') ? root : `${root}/`));
  const open = placeKindsInBracket.getStore();
  if (open !== undefined && open !== null && prefixes.every((prefix) => isKeptBy(open, prefix) || open.prefixes.includes(prefix))) return run();
  return placeKindsInBracket.run({ prefixes, kinds: new Map<string, PlaceKind>(), chains: new Map<string, LinkChain>() }, run);
}

/**
 * Run `run` with {@link hostPlaceKind} asking the kernel for every path, whatever memo an enclosing
 * {@link withPlaceKindMemo} bracket holds. Reached through `withoutPlaceKindSnapshot`
 * (`link-following.ts`).
 *
 * @param run - The work; its return value is passed straight through, so an async `run` walks afresh for its whole promise
 */
export function withoutPlaceKindMemo<T>(run: () => T): T {
  return placeKindsInBracket.run(null, run);
}

/**
 * What stands at `path`, a link there not followed. A probe the OS refuses is thrown raw, for the
 * caller to classify. Inside a {@link withPlaceKindMemo} bracket a path beneath its root is
 * `lstat`ed once and its kind reused, an `absent` answer included (the bracket is opened only
 * around work that creates nothing beneath its roots); a memo hit counts no `fs.lstat`.
 *
 * ⚠️ "Not followed" is `lstat`'s word, and on Windows libuv keeps it only for what it calls a
 * symbolic link: a junction to a volume (`\??\Volume{…}\`) and a reparse point of another tag
 * (cloud files, dedup, WCI) are retried as a link-FOLLOWING `stat` and reported as the directory
 * or file they lead to. Their targets are local — the kernel refuses a remote mount point — so no
 * credential leaves the host, but the walk reads such a place as a plain directory where the
 * kernel reparses it.
 */
export function hostPlaceKind(path: string): PlaceKind {
  const snapshot = placeKindsInBracket.getStore();
  if (snapshot === undefined || snapshot === null) return lstatPlaceKind(path);
  // Compared and keyed in one spelling, so a path named either way is one entry.
  const spelled = toForwardSlash(path);
  if (!isKeptBy(snapshot, spelled)) return lstatPlaceKind(path);
  const known = snapshot.kinds.get(spelled);
  if (known !== undefined) return known;
  // A refusal throws here: never kept, asked again next time.
  const kind = lstatPlaceKind(path);
  snapshot.kinds.set(spelled, kind);
  return kind;
}

/** Whether `memo` keeps the kind at the forward-slashed `spelled`: strictly beneath one of its roots. */
function isKeptBy(memo: PlaceKindMemo, spelled: string): boolean {
  return memo.prefixes.some((prefix) => spelled.startsWith(prefix));
}

/**
 * Whether `error` is `readlink` refusing, as not a link (`EINVAL`), a place the open memo answered
 * `link` — another process replaced it after the memo's one `lstat` — and the memo entry is now
 * dropped, so a walk taken again reads what stands there. Any other error is the walk's own.
 */
function forgotStaleLink(error: unknown): boolean {
  const snapshot = placeKindsInBracket.getStore();
  if (snapshot === undefined || snapshot === null || !isInvalidArgumentError(error)) return false;
  const path = (error as { path?: unknown }).path;
  if (typeof path !== 'string') return false;
  const spelled = toForwardSlash(path);
  return snapshot.kinds.get(spelled) === 'link' && snapshot.kinds.delete(spelled);
}

/** {@link hostPlaceKind}'s own `lstat`, no snapshot consulted. */
function lstatPlaceKind(path: string): PlaceKind {
  try {
    // Counted at the call, refused or not: `fs.lstat` counts syscalls.
    countWork('fs.lstat', 1);
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
  const resolved = toForwardSlash(safePath.resolve(path));
  const snapshot = placeKindsInBracket.getStore();
  if (snapshot === undefined || snapshot === null) return walkAfresh(resolved, rule, HOST_PROBE);
  const key = `${rule.flavor}\0${rule.outside}\0${rule.root}\0${resolved}`;
  const known = snapshot.chains.get(key);
  if (known !== undefined) return known;
  // Every place the walk reads is checked against the memo's roots, and any link text read: either
  // makes the answer more than a function of the kinds the memo keeps, so it is not kept.
  let keepable = true;
  const probe: ChainProbe = {
    kindAt: (at) => {
      keepable &&= isKeptBy(snapshot, toForwardSlash(at));
      return hostPlaceKind(at);
    },
    textAt: (at) => {
      keepable = false;
      return readlinkSync(at);
    },
  };
  const chain = walkAfresh(resolved, rule, probe);
  if (keepable) snapshot.chains.set(key, chain);
  return chain;
}

/** {@link walkLinkChain} on this host, taken once more when a link the memo kept was replaced mid-run. */
function walkAfresh(resolved: string, rule: ChainRule, probe: ChainProbe): LinkChain {
  try {
    return walkLinkChain(resolved, rule, probe);
  } catch (error: unknown) {
    // A link the memo kept, replaced mid-run (`readlink` says "not a link"): the walk is taken once
    // more, reading that place afresh. Re-read rather than a coded error, so the walk answers what
    // stands there now and any refusal stays the raw errno every caller's classifier reads.
    if (!forgotStaleLink(error)) throw error;
    return walkLinkChain(resolved, rule, probe);
  }
}

/**
 * How each refusal reads, after "the symbolic link <link> "; the link's text shown, never raw —
 * set off by the message, so unquoted ({@link visibleText}), except where the refusal is about the
 * text's own last character: a trailing dot or space shows only between quotes ({@link shownName}).
 */
function refusalClause(refusal: ChainRefusal): string {
  switch (refusal.why) {
    case 'network':
      return `leads to ${visibleText(refusal.text)}, a network or device path, which VAT never asks the OS to follow (a Windows host would offer the operator's credentials to it)`;
    case 'hop-limit':
      return `starts a chain of more than ${MAX_LINK_HOPS.toString()} symbolic links that is not a cycle, so where it ends was never read`;
    case 'unportable':
      return `has a text no kernel resolves as written (${shownName(refusal.text)}: a NUL, or a name ending in a dot or a space)`;
    case 'absolute':
    case 'drive-relative':
    case 'climbs-out':
      return `leads outside the tree it is in (${visibleText(refusal.text)})`;
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
    super(LINK_CHAIN_REFUSED_CODE, `Refusing to resolve ${visibleText(path)}: the symbolic link ${visibleText(refusal.link)} ${refusalClause(refusal)} — replace the link with the files it names.`);
    this.path = path;
    this.refusal = refusal;
  }
}

/** Whether `error` is a {@link LinkChainRefusedError}, by its code (a `dist` copy never `instanceof`-matches a `src` one). */
export function isLinkChainRefusedError(error: unknown): error is VatError & { readonly path: string; readonly refusal: ChainRefusal } {
  return isVatError(error, LINK_CHAIN_REFUSED_CODE) && 'refusal' in error;
}
