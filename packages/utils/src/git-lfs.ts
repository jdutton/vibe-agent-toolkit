/**
 * Which snapshot entries are Git LFS pointers, and whether each one is pulled.
 *
 * Under `filter=lfs` git stores a POINTER blob (a few lines naming the content's sha256 and size),
 * so the snapshot's tree hash holds the pointer whether the disk holds the content (pulled) or the
 * pointer itself (not pulled). `gitTreeKey` keys the two apart from what this reads; nothing here
 * reads or hashes a working-tree file.
 *
 * 1. One `git check-attr --stdin -z filter` over the members: the paths whose `filter` is `lfs`.
 * 2. One `git cat-file --batch-check` over their blobs: a pointer is small (under
 *    {@link POINTER_CANDIDATE_BYTES}), so a larger blob is an ordinary file (one committed before
 *    its attribute) and is never read. One `git cat-file --batch` over the small ones; a blob is a
 *    pointer only when it parses strictly ({@link parsePointer}), else it is an ordinary file (a
 *    malformed small blob, an `ext-` extension pointer).
 * 3. One `lstat` per pointer: the disk's size is the content's (pulled) or the pointer's (not
 *    pulled). Any other answer, or the two sizes being equal, cannot tell: undecidable.
 *
 * No spawn beyond `check-attr` when no member is `filter=lfs`, and none at all with no member.
 */

import { lstatSync, type Stats } from 'node:fs';

import { compareCodeUnits } from './compare-code-units.js';
import { isPathAbsentError } from './errors/errno-table.js';
import { type GitBytesRunResult, runGitBytes } from './git-run.js';
import type { GitSnapshotEntry, GitTreeKeyFailure } from './git-snapshot.js';
import { decodeUtf8Exactly } from './text-content.js';

/** A blob at least this large is never a pointer (a real pointer is about 130 bytes). */
const POINTER_CANDIDATE_BYTES = 1024;

/** The modes of a regular file, the only entries a filter applies to. */
const BLOB_MODES: ReadonlySet<string> = new Set(['100644', '100755']);

/** A pointer, strictly: the spec line, then `oid` and `size` in key order, LF only, nothing else. */
const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (0|[1-9]\d*)\n$/;

/** One entry the snapshot holds as an LFS pointer. */
export interface LfsPointerEntry {
  /** git's spelling of the path, repository-relative. */
  readonly gitPath: string;
  /** Absolute, forward-slashed. */
  readonly absolutePath: string;
  /** The content's sha256, hex, as the pointer names it. */
  readonly lfsOid: string;
  /** The disk holds the content (`true`) or the pointer (`false`). */
  readonly pulled: boolean;
}

/** What the LFS pass read: the pointers it could decide, and the git paths it could not. */
interface LfsState {
  readonly ok: true;
  readonly pointers: readonly LfsPointerEntry[];
  /** git paths of pointers whose file is neither its pointer nor its content by size, sorted. */
  readonly undecidable: readonly string[];
}

/** Why the LFS pass gave no answer, without the key's `cwd` and root. */
type LfsStateFailure = DistributiveOmit<
  Extract<GitTreeKeyFailure, { kind: 'lfs-unlisted' | 'lfs-unreadable' }>,
  'cwd' | 'repositoryRoot'
>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A candidate pointer blob's facts, before the disk is looked at. */
interface ParsedPointer {
  readonly lfsOid: string;
  /** The content's size, as the pointer declares it. */
  readonly size: number;
  /** The pointer blob's own length. */
  readonly pointerBytes: number;
}

/**
 * The snapshot entries the LFS pass judges: regular files, absent ones excluded.
 *
 * @param entries - The snapshot's entries
 * @param absent - Absolute paths of entries absent from disk under skip-worktree
 * @returns The members, in the snapshot's order
 */
export function lfsMembersOf(entries: readonly GitSnapshotEntry[], absent: ReadonlySet<string>): GitSnapshotEntry[] {
  return entries.filter((entry) => BLOB_MODES.has(entry.mode) && !absent.has(entry.absolutePath));
}

/**
 * Parse a blob strictly as an LFS pointer.
 *
 * @param blob - The blob's bytes
 * @returns The pointer, or `undefined` when the bytes are not exactly one
 */
function parsePointer(blob: Uint8Array): ParsedPointer | undefined {
  const match = POINTER.exec(decodeUtf8Exactly(blob) ?? '');
  if (match === null) return undefined;
  const [, lfsOid, declared] = match;
  const size = Number(declared);
  if (lfsOid === undefined || !Number.isSafeInteger(size)) return undefined;
  return { lfsOid, size, pointerBytes: blob.length };
}

/**
 * The options a pass spawn runs with: from the root, `input` on stdin, the whole answer however
 * large (the runner clamps it to its own cap). Every spawn is counted `git.calls` by the runner.
 */
function overInput(repositoryRoot: string, input: string): { cwd: string; input: string; maxBuffer: number } {
  return { cwd: repositoryRoot, input, maxBuffer: Number.MAX_SAFE_INTEGER };
}

/** The pass's failure for one command git did not answer. */
function unlisted(command: string, attempt: GitBytesRunResult): LfsStateFailure {
  return { ok: false, kind: 'lfs-unlisted', command, attempt };
}

/** The pass's failure for an answer VAT cannot read. */
function unreadable(command: string, what: string): LfsStateFailure {
  return { ok: false, kind: 'lfs-unreadable', command, reason: `${command} wrote ${what}.` };
}

/**
 * The paths `git check-attr -z` names `filter=lfs`, from its `path\0attr\0value\0` triples.
 *
 * @returns The paths, or `undefined` when the output is not whole triples
 */
function lfsPathsOf(stdout: Uint8Array): Set<string> | undefined {
  const fields = decodeUtf8Exactly(stdout)?.split('\0');
  if (fields?.pop() !== '' || fields.length % 3 !== 0) return undefined;
  const paths = new Set<string>();
  for (let at = 0; at < fields.length; at += 3) {
    if (fields[at + 2] === 'lfs') paths.add(fields[at] ?? '');
  }
  return paths;
}

/**
 * The blob sizes `git cat-file --batch-check` reports, by oid; a non-blob or missing object is absent.
 *
 * @returns The sizes, or `undefined` when a line is not `<oid> <type> <size>` or `<oid> missing`
 */
function blobSizesOf(stdout: Uint8Array): Map<string, number> | undefined {
  const text = decodeUtf8Exactly(stdout);
  if (text === undefined) return undefined;
  const sizes = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const [oid, type, size] = line.split(' ');
    if (oid === undefined || type === undefined) return undefined;
    if (type === 'missing') continue;
    if (size === undefined || !/^\d+$/.test(size)) return undefined;
    if (type === 'blob') sizes.set(oid, Number(size));
  }
  return sizes;
}

/**
 * The objects `git cat-file --batch` wrote: `<oid> <type> <size>\n<bytes>\n` each.
 *
 * @returns Each object's bytes by oid, or `undefined` when the stream is cut or malformed
 */
function batchObjectsOf(stdout: Buffer): Map<string, Uint8Array> | undefined {
  const objects = new Map<string, Uint8Array>();
  let at = 0;
  while (at < stdout.length) {
    const headerEnd = stdout.indexOf(0x0a, at);
    if (headerEnd === -1) return undefined;
    const [oid, , size] = (decodeUtf8Exactly(stdout.subarray(at, headerEnd)) ?? '').split(' ');
    const length = Number(size);
    const end = headerEnd + 1 + length;
    if (oid === undefined || !Number.isSafeInteger(length) || stdout[end] !== 0x0a) return undefined;
    objects.set(oid, stdout.subarray(headerEnd + 1, end));
    at = end + 1;
  }
  return objects;
}

/** Whether the file on disk is the pointer's content, the pointer, or neither by size. */
function pulledState(absolutePath: string, pointer: ParsedPointer): boolean | undefined {
  let stats: Stats;
  try {
    stats = lstatSync(absolutePath);
  } catch (error) {
    if (isPathAbsentError(error)) return undefined;
    throw error;
  }
  if (!stats.isFile() || pointer.size === pointer.pointerBytes) return undefined;
  if (stats.size === pointer.size) return true;
  return stats.size === pointer.pointerBytes ? false : undefined;
}

/** The `filter=lfs` members, by one `check-attr`. */
function filteredMembers(
  repositoryRoot: string,
  members: readonly GitSnapshotEntry[],
): { readonly ok: true; readonly filtered: GitSnapshotEntry[] } | LfsStateFailure {
  const command = 'git check-attr';
  const paths = members.map((entry) => entry.gitPath).toSorted(compareCodeUnits);
  const listed = runGitBytes(['check-attr', '--stdin', '-z', 'filter'], overInput(repositoryRoot, paths.map((path) => `${path}\0`).join('')));
  if (!listed.ok) return unlisted(command, listed);
  const lfs = lfsPathsOf(listed.stdout);
  if (lfs === undefined) return unreadable(command, 'an attribute listing that is not whole path, attribute, value triples');
  return { ok: true, filtered: members.filter((entry) => lfs.has(entry.gitPath)) };
}

/** The pointer blobs among `oids`, by one `batch-check` and, for the small ones, one `batch`. */
function pointerBlobs(
  repositoryRoot: string,
  oids: readonly string[],
): { readonly ok: true; readonly pointers: ReadonlyMap<string, ParsedPointer> } | LfsStateFailure {
  const checked = runGitBytes(['cat-file', '--batch-check'], overInput(repositoryRoot, oids.map((oid) => `${oid}\n`).join('')));
  if (!checked.ok) return unlisted('git cat-file --batch-check', checked);
  const sizes = blobSizesOf(checked.stdout);
  if (sizes === undefined) return unreadable('git cat-file --batch-check', 'a line that is not an object\'s oid, type and size');
  const candidates = oids.filter((oid) => (sizes.get(oid) ?? POINTER_CANDIDATE_BYTES) < POINTER_CANDIDATE_BYTES);
  const pointers = new Map<string, ParsedPointer>();
  if (candidates.length === 0) return { ok: true, pointers };
  const read = runGitBytes(['cat-file', '--batch'], overInput(repositoryRoot, candidates.map((oid) => `${oid}\n`).join('')));
  if (!read.ok) return unlisted('git cat-file --batch', read);
  const objects = batchObjectsOf(read.stdout);
  if (objects === undefined) return unreadable('git cat-file --batch', 'an object stream VAT cannot read');
  for (const [oid, blob] of objects) {
    const pointer = parsePointer(blob);
    if (pointer !== undefined) pointers.set(oid, pointer);
  }
  return { ok: true, pointers };
}

/**
 * Read which `members` are LFS pointers and whether each is pulled (see the module header).
 *
 * @param repositoryRoot - The repository root, forward-slashed
 * @param members - The entries to judge ({@link lfsMembersOf})
 * @returns The pointers and the undecidable paths, or why git gave no usable answer
 */
export function readLfsState(repositoryRoot: string, members: readonly GitSnapshotEntry[]): LfsState | LfsStateFailure {
  if (members.length === 0) return { ok: true, pointers: [], undecidable: [] };
  const attributed = filteredMembers(repositoryRoot, members);
  if (!attributed.ok) return attributed;
  const { filtered } = attributed;
  if (filtered.length === 0) return { ok: true, pointers: [], undecidable: [] };
  const blobs = pointerBlobs(repositoryRoot, [...new Set(filtered.map((entry) => entry.oid))].toSorted(compareCodeUnits));
  if (!blobs.ok) return blobs;
  const pointers: LfsPointerEntry[] = [];
  const undecidable: string[] = [];
  for (const entry of filtered) {
    const pointer = blobs.pointers.get(entry.oid);
    if (pointer === undefined) continue;
    const pulled = pulledState(entry.absolutePath, pointer);
    if (pulled === undefined) undecidable.push(entry.gitPath);
    else pointers.push({ gitPath: entry.gitPath, absolutePath: entry.absolutePath, lfsOid: pointer.lfsOid, pulled });
  }
  return { ok: true, pointers, undecidable: undecidable.toSorted(compareCodeUnits) };
}

/**
 * Whether the repository configures an LFS filter (`git config --get-regexp ^filter\.lfs\.`).
 * Exit 1 is git's "no such key": not configured.
 *
 * @param repositoryRoot - The repository root
 * @returns Whether any `filter.lfs.*` key is set, or why git gave no answer
 */
export function lfsFilterConfigured(repositoryRoot: string): { readonly ok: true; readonly configured: boolean } | LfsStateFailure {
  const asked = runGitBytes(['config', '--get-regexp', String.raw`^filter\.lfs\.`], { cwd: repositoryRoot });
  if (asked.ok) return { ok: true, configured: true };
  if (asked.error === undefined && asked.status === 1) return { ok: true, configured: false };
  return unlisted('git config', asked);
}
