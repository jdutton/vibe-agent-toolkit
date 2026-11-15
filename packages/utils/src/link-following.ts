/**
 * The ONE module that asks the kernel to FOLLOW a link — `stat`, `realpath` — and the only place
 * `local/no-link-following-fs` lets such a call stand (every other `packages/*\/src` file asks
 * here; the allowlist of operator's-own-path files is the rule's option, asserted both ways).
 *
 * The order is the guarantee. A Windows kernel asked to follow a link to `\\host\share` opens an
 * SMB session and offers the operator's NTLM credentials to that host before any answer comes
 * back, so every following call here first reads the chain of links to its path hop by hop, by
 * `lstat` and `readlink` alone ({@link assertLocalChain}), and asks the kernel only once the chain
 * is read and local. On every host: the walk is the same rule everywhere, its flavor bound from
 * `process.platform` here, at the edge.
 *
 * Each call names the tree its path is crawled in, `within` — the operator's own input (a project
 * root, a directory the operator named, VAT's own scratch). That root is resolved by the kernel
 * once, as the operator's input always was, and the walk reads only what lies beneath it: the
 * root's ancestors are the operator's, never probed and never blamed for a fault. A path that IS
 * the operator's own input passes itself as `within`, and the kernel answers it directly.
 *
 * A probe the OS refuses is never a pass: it is thrown, raw, for the caller's classifier — a read
 * lane records it as that one path's fault, a write lane stops on its own side.
 */

// Every kernel call is reached through the DEFAULT objects, never a named binding: Node snapshots a
// builtin's named ESM exports at import time, so a `vi.spyOn(fs, 'statSync')` cannot see a call made
// through one — it attaches, counts zero, and reads exactly like "no I/O here" (the guards on
// `pathSpellingFrom`/`realpathRowFrom` and the fault matrix are assertions of exactly that).
import nodeFs, { type BigIntStats, type Stats } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { promisify } from 'node:util';

import { isFinalPathUnanswerableError, isPathAbsentError, isUnresolvableLinkError } from './errors/errno-table.js';
import { relativeEscapesRoot, safePath, toForwardSlash } from './path-core.js';
import { LinkChainRefusedError, walkHostChain } from './tree-change/host-chain.js';
import { HOST_PATH_FLAVOR, type LinkChain, namedPathRoot, type PathFlavor } from './tree-change/link-chain.js';

/**
 * Whether a native realpath's failure must be asked again of Node's JS realpath before anyone
 * believes it — the ONE fallback rule every native site shares.
 *
 * - A volume whose driver does not implement final-path queries (a RAM disk, some redirectors and
 *   virtual drives) answers EVERY native realpath with `ERROR_INVALID_FUNCTION`, which libuv
 *   reports as `EISDIR` ({@link isFinalPathUnanswerableError}). That says nothing about the path.
 * - An absent answer ({@link isPathAbsentError}) is confirmed by the JS walk: on a musl libc
 *   without procfs the native `realpath(3)` reports `ENOENT` for a path that exists, and Windows
 *   answers `ENOENT` for a file on a volume mounted into a folder with no drive letter (pinned on a
 *   real host by `realpath-native-folder-mount.integration.test.ts`). A path the JS walk also finds
 *   absent throws the walk's own `ENOENT`, so nothing that is really missing reads as present.
 *
 * ⚠️ The JS answer is not the on-disk spelling: it keeps the casing the caller spelled (and, on
 * Windows, an 8.3 short name), and it expands only what `lstat` calls a link — a `subst` drive and
 * a volume mount point (which libuv reports as a plain directory) stay as spelled. A caller that
 * needs the kernel's own identity compares `stat` identities, not these strings.
 */
function nativeAnswerNeedsJsWalk(error: unknown): boolean {
  return isFinalPathUnanswerableError(error) || isPathAbsentError(error);
}

/**
 * The kernel's realpath of the operator's OWN path (an edge: a root the operator named, VAT's own
 * scratch), in the host's separators — the one place the kernel follows a link no walk read.
 *
 * @throws The resolution's own error: the caller classifies it
 */
export function edgeRealpathSync(path: string): string {
  try {
    return nodeFs.realpathSync.native(path);
  } catch (error: unknown) {
    if (!nativeAnswerNeedsJsWalk(error)) throw error;
    return nodeFs.realpathSync(path);
  }
}

/** Where the walk of `path` begins: beneath `within`'s real path, or — for a path outside it — from its own root. */
type Walked = { readonly kind: 'edge' } | LinkChain;

/**
 * Read the chain to `path`, hop by hop, beneath the tree `within`.
 *
 * - `path` is `within` itself: the operator's own input, answered by the kernel (`edge`).
 * - `path` lies beneath `within`: the walk starts at `within`'s real path and reads only the
 *   components below it — never the root's own ancestors.
 * - `path` lies outside `within` (a link target named by content, a path a caller built): the whole
 *   of it is walked from its own root, ancestors included, as any link target is.
 */
function walkWithin(path: string, within: string, flavor: PathFlavor): Walked {
  const start = toForwardSlash(safePath.resolve(path));
  const root = toForwardSlash(safePath.resolve(within));
  const below = safePath.relative(root, start);
  if (below === '') return { kind: 'edge' };
  if (relativeEscapesRoot(below)) return walkWhole(start, flavor);
  let real: string;
  try {
    real = realRootOf(root);
  } catch (error: unknown) {
    // Nothing is beneath a root that is not there.
    if (isPathAbsentError(error)) return { kind: 'nothing', at: root, cause: 'absent' };
    throw error;
  }
  return walkHostChain(safePath.join(real, below), { flavor, root: real, outside: 'follow' });
}

/** The whole chain to `start` (forward-slashed, absolute), ancestors included, from the root it hangs from. */
function walkWhole(start: string, flavor: PathFlavor): LinkChain {
  return walkHostChain(start, { flavor, root: namedPathRoot(start, flavor), outside: 'follow' });
}

/**
 * Each tree root's real path, resolved by the kernel ONCE per process — at the edge, as the operator's
 * input always was — not once per path crawled beneath it. Only an answer is kept: a root the OS
 * refused, or one not there yet, is asked again next time.
 */
const REAL_ROOTS = new Map<string, string>();

function realRootOf(root: string): string {
  const known = REAL_ROOTS.get(root);
  if (known !== undefined) return known;
  const real = toForwardSlash(edgeRealpathSync(root));
  REAL_ROOTS.set(root, real);
  return real;
}

/**
 * Throw unless every link on the way to `path` beneath `within` has been read and leads somewhere
 * local — the check the kernel's following call is the SECOND lock behind. The user's own paths:
 * an absolute local text is followed and walked by the same rules, so a later hop's network text
 * is still caught. A chain that leads to nothing (a dangle, a cycle) is answered so — the kernel is
 * not asked about it.
 *
 * @param path - Absolute, or relative to cwd; either separator
 * @param within - The tree `path` is crawled in: the operator's own input (or `path` itself, for the operator's own path)
 * @param flavor - Whose kernel is about to be asked: bound from `process.platform` at the edge
 * @returns `'local'` when the kernel may now be asked; `'nothing'` when the chain leads to nothing
 * @throws LinkChainRefusedError when a link on the way names a network or device path, or the chain
 *   never ends; the raw errno of an `lstat`/`readlink` (or the root's realpath) the OS refused
 */
export function assertLocalChain(path: string, within: string, flavor: PathFlavor): 'local' | 'nothing' {
  return nothingOnTheWay(path, within, flavor) === undefined ? 'local' : 'nothing';
}

/** {@link assertLocalChain}, naming why a chain leads to nothing: `undefined` when the kernel may be asked. */
function nothingOnTheWay(path: string, within: string, flavor: PathFlavor): 'absent' | 'cycle' | undefined {
  const walked = walkWithin(path, within, flavor);
  if (walked.kind === 'refused') throw new LinkChainRefusedError(path, walked.refusal);
  return walked.kind === 'nothing' ? walked.cause : undefined;
}

/**
 * Throw what the kernel's own `syscall` would have thrown for a chain that leads to nothing — `ENOENT`
 * for a dangle, `ELOOP` for a cycle — so the caller's classifier reads it as it always did; return
 * when the chain is read, local, and the kernel may be asked.
 */
export function requireSomethingAt(path: string, within: string, syscall: string): void {
  const cause = nothingOnTheWay(path, within, HOST_PATH_FLAVOR);
  if (cause === undefined) return;
  const [code, words] = cause === 'cycle' ? ['ELOOP', 'too many symbolic links encountered'] : ['ENOENT', 'no such file or directory'];
  throw Object.assign(new Error(`${code}: ${words}, ${syscall} '${path}'`), { code, syscall, path });
}

/**
 * The native realpath of a path crawled beneath `within` — the canonical ON-DISK spelling,
 * forward-slashed — asked of the kernel only once the chain is read and local.
 *
 * @throws LinkChainRefusedError for a chain through a network path, or one that never ends; the
 *   `ENOENT` of a chain that leads to nothing; else the resolution's own error — the caller classifies it
 */
export function realpathNativeSync(path: string, within: string): string {
  requireSomethingAt(path, within, 'realpath');
  return toForwardSlash(edgeRealpathSync(path));
}

/** The asynchronous {@link realpathNativeSync}. */
export async function realpathNative(path: string, within: string): Promise<string> {
  requireSomethingAt(path, within, 'realpath');
  try {
    return toForwardSlash(await promisify(nodeFs.realpath.native)(path));
  } catch (error: unknown) {
    if (!nativeAnswerNeedsJsWalk(error)) throw error;
    return toForwardSlash(await promisify(nodeFs.realpath)(path));
  }
}

/**
 * Node's JS realpath (`fs.realpath`, not `.native`: the spelling the caller wrote is kept, so it
 * stays in the namespace of a lexical fallback) of a path crawled beneath `within`, asked only once
 * the chain is read and local. Read off the `node:fs` default object per call, so a spy installed
 * after import still sees it.
 *
 * @throws as {@link realpathNativeSync}
 */
export async function followedRealpath(path: string, within: string): Promise<string> {
  requireSomethingAt(path, within, 'realpath');
  return await promisify(nodeFs.realpath)(path);
}

/** The synchronous {@link followedRealpath} (`fs.realpathSync`, the JS walk). */
export function followedRealpathSync(path: string, within: string): string {
  requireSomethingAt(path, within, 'realpath');
  return nodeFs.realpathSync(path);
}

/**
 * The kernel's `stat` of the operator's OWN path (an edge: the base a crawl was asked to start
 * from), raw: the caller classifies its error.
 */
export function edgeStatSync(path: string): Stats {
  return nodeFs.statSync(path);
}

/** {@link edgeStatSync} with `bigint` fields — the `dev`/`ino` an entry identity is built from. */
export function edgeBigintStatSync(path: string): BigIntStats {
  return nodeFs.statSync(path, { bigint: true });
}

/**
 * What `path` (crawled beneath `within`) resolves to, its links followed — `undefined` when it
 * resolves to nothing: absent, a dangling link, a cycle, or a chain the kernel itself calls a loop.
 *
 * @throws LinkChainRefusedError for a chain VAT will not hand the kernel; the raw errno of any probe
 *   the OS refused (never folded into "absent")
 */
export function followedStatSync(path: string, within: string): Stats | undefined {
  if (assertLocalChain(path, within, HOST_PATH_FLAVOR) === 'nothing') return undefined;
  try {
    return nodeFs.statSync(path);
  } catch (error: unknown) {
    if (isUnresolvableLinkError(error)) return undefined;
    throw error;
  }
}

/** The asynchronous {@link followedStatSync}. */
export async function followedStat(path: string, within: string): Promise<Stats | undefined> {
  if (assertLocalChain(path, within, HOST_PATH_FLAVOR) === 'nothing') return undefined;
  try {
    return await fsPromises.stat(path);
  } catch (error: unknown) {
    if (isUnresolvableLinkError(error)) return undefined;
    throw error;
  }
}

/**
 * {@link followedStatSync} for a caller that cannot go on without an answer: a path that resolves
 * to nothing is the `ENOENT` (or, for a cycle, `ELOOP`) the kernel's own `stat` would have thrown,
 * for the caller's classifier.
 */
export function requireFollowedStatSync(path: string, within: string): Stats {
  requireSomethingAt(path, within, 'stat');
  return nodeFs.statSync(path);
}

/** The asynchronous {@link requireFollowedStatSync}. */
export async function requireFollowedStat(path: string, within: string): Promise<Stats> {
  requireSomethingAt(path, within, 'stat');
  return await fsPromises.stat(path);
}

/**
 * The `type` a link made to copy the link at `path` (crawled beneath `within`) is created with —
 * `'dir'` when its chain, read by text, ends at a directory; `'file'` otherwise, a dangle or a cycle
 * included (what Node itself picks for a target it cannot `stat`). Read by `lstat` and `readlink`
 * alone: a `symlink` with no type has Node on Windows ask the KERNEL to follow the target to pick
 * one, and a link text no walk read must never reach the kernel.
 *
 * @throws LinkChainRefusedError for a chain through a network or device path, or one that never
 *   ends; the raw errno of an `lstat`/`readlink` the OS refused
 */
export function linkCopyType(path: string, within: string): 'dir' | 'file' {
  const walked = walkWithin(path, within, HOST_PATH_FLAVOR);
  // The link IS the tree's root: its chain is walked whole, from its own root, as any link target is.
  const chain = walked.kind === 'edge' ? walkWhole(toForwardSlash(safePath.resolve(path)), HOST_PATH_FLAVOR) : walked;
  if (chain.kind === 'refused') throw new LinkChainRefusedError(path, chain.refusal);
  return chain.kind === 'resolved' && chain.final === 'directory' ? 'dir' : 'file';
}

/** What a followed path resolves to. */
export type FollowedPathKind = 'directory' | 'file' | 'other' | 'absent';

function kindOf(stats: Stats | undefined): FollowedPathKind {
  if (stats === undefined) return 'absent';
  if (stats.isDirectory()) return 'directory';
  return stats.isFile() ? 'file' : 'other';
}

/** What `path` beneath `within` resolves to ({@link followedStatSync}): `absent` for nothing. */
export function followedKindSync(path: string, within: string): FollowedPathKind {
  return kindOf(followedStatSync(path, within));
}

/** The asynchronous {@link followedKindSync}. */
export async function followedKind(path: string, within: string): Promise<FollowedPathKind> {
  return kindOf(await followedStat(path, within));
}
