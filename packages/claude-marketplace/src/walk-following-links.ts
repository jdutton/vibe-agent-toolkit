/**
 * One directory walk for the two compat lanes that enumerate a plugin's files
 * themselves — the settings checker and the compatibility analyzer.
 *
 * Symlinks are FOLLOWED, the way the audit's validator lane follows them
 * (`existsSync(skills/<name>/SKILL.md)` resolves through a link): a plugin
 * whose `skills/` points at a shared tree is a common layout, and a `Dirent`
 * for a link answers `false` to both `isFile()` and `isDirectory()`, which is
 * how a symlinked skill used to vanish from the settings check while the
 * validator read it and reported its `allowed-tools` — and how the analyzer
 * pushed a linked skill DIRECTORY as a file with no extension and never
 * descended it. Directories are tracked by real path so a link back into an
 * ancestor terminates.
 *
 * A directory the walk cannot list is RECORDED, not thrown: the caller says
 * what it skipped, per path, and reads everything else. The root itself is
 * the one exception — a root that cannot be listed is not a tree to walk, and
 * the refusal propagates with its `path` intact so the caller can name it.
 */

import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';

import { isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';

/** A path the walk could not list, and the OS message for it. Absolute. */
export interface WalkRefusal {
  path: string;
  reason: string;
}

export interface WalkedTree {
  /** Every regular file reached (through links), absolute, in walk order. */
  files: string[];
  /** Every path beneath the root the walk could not list or, for a link, resolve. */
  unlistable: WalkRefusal[];
}

export interface WalkOptions {
  /** Directories to leave unwalked, by entry name (e.g. `.claude-plugin`). */
  skipDirectory?: (name: string) => boolean;
}

/** The OS or parser message for a refusal, as a report carries it. */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The two answers the walk acts on; `isFile`/`isDirectory` on a `Dirent` or a `Stats`. */
interface FileKind {
  isFile(): boolean;
  isDirectory(): boolean;
}

/**
 * What a directory entry is, through a symlink when it is one. A link whose
 * target is gone is neither — there is nothing there to read. A link whose
 * target the OS REFUSES to examine (`EACCES` on a component, `ELOOP` on a link
 * chain) is recorded in `unlistable`, the same row a directory that cannot be
 * listed gets: it used to take the "gone" exit, and a refused skill directory
 * behind a link vanished from both compat lanes with no row saying so.
 */
async function entryKind(
  entry: Dirent<string>,
  entryPath: string,
  unlistable: WalkRefusal[],
): Promise<'file' | 'directory' | 'other'> {
  let target: FileKind = entry;
  if (entry.isSymbolicLink()) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- trusted plugin dir
      target = await fs.stat(entryPath);
    } catch (error) {
      if (!isPathAbsentError(error)) unlistable.push({ path: entryPath, reason: reasonOf(error) });
      return 'other';
    }
  }
  if (target.isFile()) return 'file';
  if (target.isDirectory()) return 'directory';
  return 'other';
}

/**
 * Every regular file under `rootDir`, following symlinks, cycle-safe, with
 * every directory beneath the root that could not be listed.
 *
 * @throws The listing error for `rootDir` itself (its `path` set by the OS).
 */
export async function walkFollowingLinks(rootDir: string, options: WalkOptions = {}): Promise<WalkedTree> {
  const files: string[] = [];
  const unlistable: WalkRefusal[] = [];
  const visited = new Set<string>();

  async function listDir(dir: string): Promise<Dirent<string>[]> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- trusted plugin dir
    const real = await fs.realpath(dir);
    if (visited.has(real)) return [];
    visited.add(real);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- trusted plugin dir
    return fs.readdir(dir, { withFileTypes: true, encoding: 'utf-8' });
  }

  async function scanEntries(dir: string, entries: Dirent<string>[]): Promise<void> {
    for (const entry of entries) {
      const entryPath = safePath.join(dir, entry.name);
      const kind = await entryKind(entry, entryPath, unlistable);
      if (kind === 'file') {
        files.push(entryPath);
      } else if (kind === 'directory' && options.skipDirectory?.(entry.name) !== true) {
        await scanDir(entryPath);
      }
    }
  }

  async function scanDir(dir: string): Promise<void> {
    let entries: Dirent<string>[];
    try {
      entries = await listDir(dir);
    } catch (error) {
      unlistable.push({ path: dir, reason: reasonOf(error) });
      return;
    }
    await scanEntries(dir, entries);
  }

  // The root is listed WITHOUT the catch: its refusal is the caller's whole answer.
  await scanEntries(rootDir, await listDir(rootDir));
  return { files, unlistable };
}
