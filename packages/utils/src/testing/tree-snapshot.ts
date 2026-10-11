/**
 * `snapshotTree` — a comparable, content-addressed picture of a directory tree.
 *
 * The fault matrix asks one question of every injected run: did the tree end
 * byte-equal to BEFORE or to GOLDEN, never a third state? Answering it needs the
 * trees as values: a map from relative path to what is there (kind, mode, content
 * hash, link target), and a diff that names every difference in words.
 *
 * ## What it will not do
 *
 * - It never follows a link: a link is `{ kind: 'link', target }` and nothing under it is
 *   walked, so a snapshot cannot wander out of its root or loop.
 * - It never opens a special file (FIFO, socket, device): `lstat` decides the kind first and
 *   only a regular file is opened, `O_NONBLOCK`, so a FIFO that slipped in between cannot hang it.
 * - It never swallows an unreadable entry. A directory the OS refuses is a loud error naming
 *   it, because a gap in the picture would read as "unchanged".
 *
 * ⛔ Framework-free, like everything under `testing/`: no `vitest` import, so the `./testing`
 * subpath keeps the empty third-party set its purity pin asserts.
 */

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';

import { isPathAbsentError } from '../errors/errno-table.js';
import { safePath } from '../path-core.js';
import { decodeTextContent } from '../text-content.js';

export type SnapshotEntry =
  | { kind: 'file'; mode: number; sha256: string }
  | { kind: 'dir'; mode: number }
  | { kind: 'link'; target: string }
  | { kind: 'special' };

/** Forward-slash path relative to the snapshot root (the root itself is `.`) to what is there. */
export type TreeSnapshot = ReadonlyMap<string, SnapshotEntry>;

/**
 * Rewrite a file before it is hashed, so content that legitimately differs between two
 * runs (a per-case root in a registry path, a timestamp, an archive's entry times) does
 * not read as a difference. A text file is rewritten as text; a binary one (an archive)
 * as bytes, which no text decoding has touched.
 */
export type SnapshotRewrite =
  | {
    /** Whether the file at this snapshot key is rewritten. */
    readonly applies: (key: string) => boolean;
    readonly rewrite: (text: string) => string;
  }
  | {
    /** Whether the file at this snapshot key is rewritten. */
    readonly applies: (key: string) => boolean;
    readonly rewriteBytes: (bytes: Buffer) => Buffer;
  };

export interface SnapshotOptions {
  readonly rewrites?: readonly SnapshotRewrite[];
  /** Prefix every key with this, the root entry becoming the prefix itself: lets several roots share one map. */
  readonly keyPrefix?: string;
}

const NON_BLOCKING = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
const PERMISSION_BITS = 0o7777;
const ROOT_KEY = '.';

function unreadable(path: string, error: unknown): Error {
  return new Error(`snapshotTree: cannot read ${path}: ${(error as Error).message}`, { cause: error });
}

/** The file's content as it is hashed: byte rewrites first, then (decoded once) text rewrites. */
function rewritten(content: Buffer, key: string, rewrites: readonly SnapshotRewrite[]): Buffer | string {
  const applicable = rewrites.filter((rule) => rule.applies(key));
  let bytes = content;
  for (const rule of applicable) if ('rewriteBytes' in rule) bytes = rule.rewriteBytes(bytes);
  const textRules = applicable.filter((rule) => 'rewrite' in rule);
  return textRules.length === 0 ? bytes : textRules.reduce((text, rule) => rule.rewrite(text), decodeTextContent(bytes).text);
}

function hashFile(path: string, key: string, rewrites: readonly SnapshotRewrite[]): { mode: number; sha256: string } | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NON_BLOCKING);
  } catch (error) {
    if (isPathAbsentError(error)) return undefined;
    throw unreadable(path, error);
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return undefined;
    return { mode: stats.mode & PERMISSION_BITS, sha256: createHash('sha256').update(rewritten(readFileSync(fd), key, rewrites)).digest('hex') };
  } catch (error) {
    throw unreadable(path, error);
  } finally {
    closeSync(fd);
  }
}

function linkTarget(path: string): string {
  try {
    return readlinkSync(path);
  } catch (error) {
    throw unreadable(path, error);
  }
}

/** The entry at `path`, or undefined when it vanished between listing and looking. */
function entryAt(path: string, key: string, rewrites: readonly SnapshotRewrite[]): SnapshotEntry | undefined {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (isPathAbsentError(error)) return undefined;
    throw unreadable(path, error);
  }
  if (stats.isSymbolicLink()) return { kind: 'link', target: linkTarget(path) };
  if (stats.isDirectory()) return { kind: 'dir', mode: stats.mode & PERMISSION_BITS };
  if (!stats.isFile()) return { kind: 'special' };
  const hashed = hashFile(path, key, rewrites);
  return hashed === undefined ? { kind: 'special' } : { kind: 'file', ...hashed };
}

function walk(path: string, key: string, rewrites: readonly SnapshotRewrite[], out: Map<string, SnapshotEntry>): void {
  const entry = entryAt(path, key, rewrites);
  if (entry === undefined) return;
  out.set(key, entry);
  if (entry.kind !== 'dir') return;
  let names: string[];
  try {
    names = readdirSync(path);
  } catch (error) {
    throw unreadable(path, error);
  }
  for (const name of names) {
    walk(safePath.join(path, name), key === ROOT_KEY ? name : `${key}/${name}`, rewrites, out);
  }
}

/**
 * Snapshot the tree at `root`.
 *
 * @param root - A directory, a file or a link; absent yields the empty map
 * @param options - Content rewrites applied before hashing; a key prefix for merging roots
 * @returns Entries in walk order; compare with {@link diffSnapshots}
 */
export function snapshotTree(root: string, options: SnapshotOptions = {}): TreeSnapshot {
  const out = new Map<string, SnapshotEntry>();
  walk(root, options.keyPrefix ?? ROOT_KEY, options.rewrites ?? [], out);
  return out;
}

function describeEntry(entry: SnapshotEntry): string {
  switch (entry.kind) {
    case 'file': return `file mode ${entry.mode.toString(8)} sha256 ${entry.sha256.slice(0, 12)}`;
    case 'dir': return `dir mode ${entry.mode.toString(8)}`;
    case 'link': return `link -> ${entry.target}`;
    case 'special': return 'special file';
  }
}

/** Everything an entry is compared by: what a diff line prints shows only the head of a file's hash. */
function stateOf(entry: SnapshotEntry): string {
  return entry.kind === 'file' ? `${describeEntry(entry)} ${entry.sha256}` : describeEntry(entry);
}

function compareKeys(x: string, y: string): number {
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

/**
 * Every difference between two snapshots, in words: `+ key (…)` added, `- key (…)`
 * removed, `~ key: … => …` changed. Sorted by key; empty means identical.
 */
export function diffSnapshots(a: TreeSnapshot, b: TreeSnapshot): string[] {
  const lines: { key: string; line: string }[] = [];
  for (const [key, before] of a) {
    const after = b.get(key);
    if (after === undefined) lines.push({ key, line: `- ${key} (${describeEntry(before)})` });
    else if (stateOf(before) !== stateOf(after)) lines.push({ key, line: `~ ${key}: ${describeEntry(before)} => ${describeEntry(after)}` });
  }
  for (const [key, after] of b) {
    if (!a.has(key)) lines.push({ key, line: `+ ${key} (${describeEntry(after)})` });
  }
  return lines.toSorted((x, y) => compareKeys(x.key, y.key)).map((item) => item.line);
}

/** The entries at `prefix` and under it (keys unchanged); a sibling sharing the spelling is not under it. */
export function subtree(s: TreeSnapshot, prefix: string): TreeSnapshot {
  return new Map([...s].filter(([key]) => key === prefix || key.startsWith(`${prefix}/`)));
}
