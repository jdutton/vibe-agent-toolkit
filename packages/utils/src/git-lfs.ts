/**
 * Which snapshot entries are Git LFS pointers, and whether each one is pulled.
 *
 * Under `filter=lfs` git stores a POINTER blob (a few lines naming the content's sha256 and size),
 * so the snapshot's tree hash holds the pointer whether the disk holds the content (pulled) or the
 * pointer itself (not pulled). `gitTreeKey` keys the two apart from what this reads; the one
 * working-tree file it reads is a pointer's whose content is exactly as long as the pointer (step 3).
 *
 * 1. One `git check-attr --stdin -z filter` over the members: the paths whose `filter` is `lfs`.
 * 2. One `git cat-file --batch-check` over their blobs: a pointer is small (under
 *    {@link POINTER_CANDIDATE_BYTES}), so a larger blob is an ordinary file (one committed before
 *    its attribute) and is never read. One `git cat-file --batch` over the small ones; a blob is a
 *    pointer when it parses by git-lfs's own grammar ({@link readPointerBlob}: `ext-` extension
 *    lines and the older version URLs included). A small blob that opens with a version line naming
 *    a git-lfs spec but does not parse is malformed, and declines the key; any other is ordinary.
 * 3. One `lstat` per pointer: the disk's size is the content's (pulled) or the pointer's (not
 *    pulled). When the two sizes are equal, the file's bytes are read and compared with the
 *    pointer's. Any other answer cannot tell: undecidable. An `lstat` or read the OS refuses is its
 *    own failure, never a crash.
 *
 * Every git answer must name every object it was asked about; one that leaves any out is unreadable.
 * No spawn beyond `check-attr` when no member is `filter=lfs`, and none at all with no member.
 */

import { lstatSync, readFileSync, type Stats } from 'node:fs';

import { compareCodeUnits } from './compare-code-units.js';
import { fsFaultOf, isPathAbsentError } from './errors/errno-table.js';
import { type GitBytesRunResult, runGitBytes } from './git-run.js';
import type { GitSnapshotEntry, GitTreeKeyFailure } from './git-snapshot.js';
import { decodeTextContent, decodeUtf8Exactly } from './text-content.js';

/** A blob at least this large is never a pointer (a real pointer is about 130 bytes). */
const POINTER_CANDIDATE_BYTES = 1024;

/** The modes of a regular file, the only entries a filter applies to. */
const BLOB_MODES: ReadonlySet<string> = new Set(['100644', '100755']);

/*
 * git-lfs's pointer grammar, as `decodeKV` in its `lfs/pointer.go` reads one: the blob trimmed of
 * surrounding whitespace, then `key value` lines (a trailing CR dropped, blank lines skipped) with
 * `version`, `oid`, `size` in that order and `ext-<digit>-<name>` lines anywhere before `size`.
 */

/**
 * The version URLs git-lfs reads as its spec (`v1Aliases`): the alpha's, the pre-release's, the
 * public one's. Each is an identifier git-lfs compares as text and never fetches; they are held as
 * scheme and remainder because the alpha's scheme is `http`, which a scanner reads as a clear-text
 * request.
 */
const POINTER_VERSIONS: ReadonlySet<string> = new Set(
  ([['http', '//git-media.io/v/2'], ['https', '//hawser.github.com/spec/v1'], ['https', '//git-lfs.github.com/spec/v1']] as const)
    .map(([scheme, rest]) => `${scheme}:${rest}`),
);

/** The keys a pointer holds, in order (`pointerKeys`). */
const POINTER_KEYS = ['version', 'oid', 'size'] as const;

/** What a pointer must name somewhere before git-lfs reads it line by line (`matcherRE`). */
const POINTER_MATCHER = /git-media|hawser|git-lfs/;

/** An extension line's key, matched as a prefix as git-lfs matches it (`extRE`); its priority is the digit. */
const EXTENSION_KEY = /^ext-\d-\w+/;

/** An `oid` or extension value: `sha256:` and 64 lowercase hex (`parseOid`). */
const OID_VALUE = /^sha256:([0-9a-f]{64})$/;

/** A `size` value as `strconv.ParseInt(value, 10, 64)` takes it. */
const SIZE_VALUE = /^[+-]?\d+$/;

/** A blob's first line that names a git-lfs spec version: a pointer, or a malformed one. */
const VERSION_LINE = /^version [^\n]*(?:git-media|hawser|git-lfs)/;

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

/** A pointer's file the OS would not let the pass `lstat` or read. */
interface LfsUnreadFile {
  /** git's spelling of the path, repository-relative. */
  readonly gitPath: string;
  readonly operation: 'lstat' | 'read';
  /** The errno the OS answered. */
  readonly errno: string;
}

/** What the LFS pass read: the pointers it could decide, and the git paths it could not. */
interface LfsState {
  readonly ok: true;
  readonly pointers: readonly LfsPointerEntry[];
  /** git paths of pointers whose file is neither its pointer nor its content by size, sorted. */
  readonly undecidable: readonly string[];
  /** git paths of small `filter=lfs` blobs that open with a spec version line and do not parse, sorted. */
  readonly malformed: readonly string[];
  /** Pointers' files the OS would not let the pass `lstat` or read, by git path. */
  readonly unread: readonly LfsUnreadFile[];
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
  /** The pointer blob's own bytes: a file not pulled holds exactly these. */
  readonly bytes: Uint8Array;
}

/** What one small `filter=lfs` blob is. */
type PointerRead =
  | { readonly kind: 'pointer'; readonly pointer: ParsedPointer }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'ordinary' };

/** A pointer's lines by key, before their values are checked. */
interface PointerFields {
  readonly keys: ReadonlyMap<string, string>;
  readonly extensions: ReadonlyMap<string, string>;
}

/** Whether a pointer's file holds its content, and why not when that cannot be told. */
type PulledState =
  | { readonly kind: 'decided'; readonly pulled: boolean }
  | { readonly kind: 'undecidable' }
  | { readonly kind: 'unread'; readonly operation: LfsUnreadFile['operation']; readonly errno: string };

const UNDECIDABLE: PulledState = { kind: 'undecidable' };

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
 * A pointer's `key value` lines, in git-lfs's order (`decodeKVData`).
 *
 * @param data - The blob's text, trimmed
 * @returns The lines by key, or `undefined` when git-lfs would refuse the layout
 */
function pointerFieldsOf(data: string): PointerFields | undefined {
  if (!POINTER_MATCHER.test(data)) return undefined;
  const keys = new Map<string, string>();
  const extensions = new Map<string, string>();
  for (const line of data.split('\n')) {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (text === '') continue;
    const space = text.indexOf(' ');
    const expected = POINTER_KEYS[keys.size];
    if (space === -1 || expected === undefined) return undefined;
    const key = text.slice(0, space);
    if (key === expected) keys.set(key, text.slice(space + 1));
    else if (EXTENSION_KEY.test(key)) extensions.set(key, text.slice(space + 1));
    else return undefined;
  }
  return { keys, extensions };
}

/** Whether every extension names an oid and no two share a priority (`validatePointerExtensions`). */
function extensionsValid(extensions: ReadonlyMap<string, string>): boolean {
  const priorities = new Set<string>();
  for (const [key, value] of extensions) {
    const priority = key.split('-')[1] ?? '';
    if (priorities.has(priority) || !OID_VALUE.test(value)) return false;
    priorities.add(priority);
  }
  return true;
}

/**
 * The pointer `fields` declare, when every value is one git-lfs takes (`decodeKV`).
 *
 * @param fields - The pointer's lines by key
 * @param blob - The blob's bytes
 * @returns The pointer, or `undefined`
 */
function pointerOfFields({ keys, extensions }: PointerFields, blob: Uint8Array): ParsedPointer | undefined {
  const lfsOid = OID_VALUE.exec(keys.get('oid') ?? '')?.[1];
  const declared = keys.get('size') ?? '';
  const size = Number(declared);
  if (!POINTER_VERSIONS.has(keys.get('version') ?? '') || lfsOid === undefined) return undefined;
  if (!SIZE_VALUE.test(declared) || !Number.isSafeInteger(size) || size < 0) return undefined;
  if (!extensionsValid(extensions)) return undefined;
  return { lfsOid, size, bytes: blob };
}

/**
 * Read a small blob by git-lfs's pointer grammar (the module header).
 *
 * @param blob - The blob's bytes
 * @returns A pointer; malformed, when it opens with a version line naming a git-lfs spec and does
 *   not parse; otherwise ordinary
 */
function readPointerBlob(blob: Uint8Array): PointerRead {
  const text = decodeUtf8Exactly(blob)?.trim();
  const fields = text === undefined ? undefined : pointerFieldsOf(text);
  const pointer = fields === undefined ? undefined : pointerOfFields(fields, blob);
  if (pointer !== undefined) return { kind: 'pointer', pointer };
  return VERSION_LINE.test(decodeTextContent(blob).text.trimStart()) ? { kind: 'malformed' } : { kind: 'ordinary' };
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
 * The paths `git check-attr -z` names, and those it names `filter=lfs`, from its
 * `path\0attr\0value\0` triples.
 *
 * @returns The paths, or `undefined` when the output is not whole triples
 */
function lfsPathsOf(stdout: Uint8Array): { listed: Set<string>; lfs: Set<string> } | undefined {
  const fields = decodeUtf8Exactly(stdout)?.split('\0');
  if (fields?.pop() !== '' || fields.length % 3 !== 0) return undefined;
  const listed = new Set<string>();
  const lfs = new Set<string>();
  for (let at = 0; at < fields.length; at += 3) {
    const path = fields[at] ?? '';
    listed.add(path);
    if (fields[at + 2] === 'lfs') lfs.add(path);
  }
  return { listed, lfs };
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

/** A pointer's file the OS refused: its errno, or the error itself when it is no filesystem fault. */
function unreadFile(operation: LfsUnreadFile['operation'], error: unknown): PulledState {
  const fault = fsFaultOf(error);
  if (fault === undefined) throw error;
  return { kind: 'unread', operation, errno: fault.errno };
}

/** A file exactly as long as its pointer: pulled when its bytes are not the pointer's. */
function pulledByBytes(absolutePath: string, pointer: ParsedPointer): PulledState {
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolutePath);
  } catch (error) {
    return unreadFile('read', error);
  }
  return { kind: 'decided', pulled: !bytes.equals(pointer.bytes) };
}

/** Whether the file on disk is the pointer's content, the pointer, or neither. */
function pulledState(absolutePath: string, pointer: ParsedPointer): PulledState {
  let stats: Stats;
  try {
    stats = lstatSync(absolutePath);
  } catch (error) {
    return isPathAbsentError(error) ? UNDECIDABLE : unreadFile('lstat', error);
  }
  const pointerBytes = pointer.bytes.length;
  if (!stats.isFile()) return UNDECIDABLE;
  if (pointer.size === pointerBytes) return stats.size === pointerBytes ? pulledByBytes(absolutePath, pointer) : UNDECIDABLE;
  if (stats.size === pointer.size) return { kind: 'decided', pulled: true };
  return stats.size === pointerBytes ? { kind: 'decided', pulled: false } : UNDECIDABLE;
}

/** The `filter=lfs` members, by one `check-attr` that must name every member. */
function filteredMembers(
  repositoryRoot: string,
  members: readonly GitSnapshotEntry[],
): { readonly ok: true; readonly filtered: GitSnapshotEntry[] } | LfsStateFailure {
  const command = 'git check-attr';
  const paths = members.map((entry) => entry.gitPath).toSorted(compareCodeUnits);
  const listed = runGitBytes(['check-attr', '--stdin', '-z', 'filter'], overInput(repositoryRoot, paths.map((path) => `${path}\0`).join('')));
  if (!listed.ok) return unlisted(command, listed);
  const read = lfsPathsOf(listed.stdout);
  if (read === undefined) return unreadable(command, 'an attribute listing that is not whole path, attribute, value triples');
  if (paths.some((path) => !read.listed.has(path))) return unreadable(command, 'an attribute listing that leaves out a path it was asked about');
  return { ok: true, filtered: members.filter((entry) => read.lfs.has(entry.gitPath)) };
}

/** The small blobs among `oids`: one `batch-check` that must size every one as a blob. */
function candidateBlobs(repositoryRoot: string, oids: readonly string[]): { readonly ok: true; readonly candidates: string[] } | LfsStateFailure {
  const command = 'git cat-file --batch-check';
  const checked = runGitBytes(['cat-file', '--batch-check'], overInput(repositoryRoot, oids.map((oid) => `${oid}\n`).join('')));
  if (!checked.ok) return unlisted(command, checked);
  const sizes = blobSizesOf(checked.stdout);
  if (sizes === undefined) return unreadable(command, 'a line that is not an object\'s oid, type and size');
  if (oids.some((oid) => !sizes.has(oid))) return unreadable(command, 'no blob size for an object it was asked about');
  return { ok: true, candidates: oids.filter((oid) => (sizes.get(oid) ?? POINTER_CANDIDATE_BYTES) < POINTER_CANDIDATE_BYTES) };
}

/** What each blob among `oids` is, by one `batch-check` and, for the small ones, one `batch` that must hold every one. */
function pointerBlobs(
  repositoryRoot: string,
  oids: readonly string[],
): { readonly ok: true; readonly blobs: ReadonlyMap<string, PointerRead> } | LfsStateFailure {
  const sized = candidateBlobs(repositoryRoot, oids);
  if (!sized.ok) return sized;
  const { candidates } = sized;
  const blobs = new Map<string, PointerRead>();
  if (candidates.length === 0) return { ok: true, blobs };
  const command = 'git cat-file --batch';
  const read = runGitBytes(['cat-file', '--batch'], overInput(repositoryRoot, candidates.map((oid) => `${oid}\n`).join('')));
  if (!read.ok) return unlisted(command, read);
  const objects = batchObjectsOf(read.stdout);
  if (objects === undefined) return unreadable(command, 'an object stream VAT cannot read');
  for (const oid of candidates) {
    const blob = objects.get(oid);
    if (blob === undefined) return unreadable(command, 'no bytes for an object it was asked about');
    blobs.set(oid, readPointerBlob(blob));
  }
  return { ok: true, blobs };
}

/**
 * Read which `members` are LFS pointers and whether each is pulled (see the module header).
 *
 * @param repositoryRoot - The repository root, forward-slashed
 * @param members - The entries to judge ({@link lfsMembersOf})
 * @returns The pointers and the undecidable paths, or why git gave no usable answer
 */
export function readLfsState(repositoryRoot: string, members: readonly GitSnapshotEntry[]): LfsState | LfsStateFailure {
  const none: LfsState = { ok: true, pointers: [], undecidable: [], malformed: [], unread: [] };
  if (members.length === 0) return none;
  const attributed = filteredMembers(repositoryRoot, members);
  if (!attributed.ok) return attributed;
  const { filtered } = attributed;
  if (filtered.length === 0) return none;
  const read = pointerBlobs(repositoryRoot, [...new Set(filtered.map((entry) => entry.oid))].toSorted(compareCodeUnits));
  if (!read.ok) return read;
  const pointers: LfsPointerEntry[] = [];
  const undecidable: string[] = [];
  const malformed: string[] = [];
  const unread: LfsUnreadFile[] = [];
  for (const entry of filtered) {
    const blob = read.blobs.get(entry.oid);
    if (blob?.kind === 'malformed') malformed.push(entry.gitPath);
    if (blob?.kind !== 'pointer') continue;
    const state = pulledState(entry.absolutePath, blob.pointer);
    if (state.kind === 'undecidable') undecidable.push(entry.gitPath);
    else if (state.kind === 'unread') unread.push({ gitPath: entry.gitPath, operation: state.operation, errno: state.errno });
    else pointers.push({ gitPath: entry.gitPath, absolutePath: entry.absolutePath, lfsOid: blob.pointer.lfsOid, pulled: state.pulled });
  }
  return {
    ok: true,
    pointers,
    undecidable: undecidable.toSorted(compareCodeUnits),
    malformed: malformed.toSorted(compareCodeUnits),
    unread: unread.toSorted((left, right) => compareCodeUnits(left.gitPath, right.gitPath)),
  };
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
