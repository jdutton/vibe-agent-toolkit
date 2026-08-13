/**
 * Realization rows for the resource projection — **one path in one extent**.
 *
 * The cheap per-path attributes a population records once, so later stages do
 * not go and compute them per link, per check, per lane. Moved down here from
 * the CLI's enumeration oracle: the oracle asked exactly the same questions of
 * exactly the same `lstat`, and one fact must have one implementation.
 */

import { lstatSync, realpathSync, statSync } from 'node:fs';

import { type GitTracker, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { parserKindForPath, readContentWithKey } from '../content-key.js';
import type { ResourceRealizationRow } from '../schemas/projection-resources.js';

/**
 * Render an absolute path relative to a root, forward-slashed.
 *
 * Every path a realization row or a snapshot prints goes through here. An
 * absolute path in a golden file makes the golden machine-specific and leaks
 * `$HOME`; both have bitten this repo before.
 *
 * @param absolutePath - Path to render
 * @param root - Root the path is rendered relative to
 * @returns Forward-slashed relative path (or the forward-slashed absolute path
 *   when the target lies outside the root, which is itself worth seeing)
 */
export function relativize(absolutePath: string, root: string): string {
  const rel = safePath.relative(root, absolutePath);
  return rel === '' ? '.' : toForwardSlash(rel);
}

/** Everything needed to answer the realization questions for a path. */
export interface RealizationContext {
  /** Root every `path` in the resulting rows is relative to. */
  root: string;
  /** The extent this realization is observed in — `resource_realizations.extentId`. */
  extentId: string;
  /** Absent (or unusable) when the root is not a git repository. */
  gitTracker?: GitTracker | undefined;
}

/**
 * Collect the realization row for one absolute path in one extent.
 *
 * `lstat` first, deliberately: `stat` follows symlinks, so a `stat`-only
 * implementation cannot tell a symlink from what it points at, and reports a
 * dangling link as simply absent. That single `lstat` also supplies `mtime` —
 * there is deliberately no second `stat` call for it.
 *
 * @param absolutePath - Path to describe
 * @param resourceId - The identity this path realizes, from `ResourceIdentityMap`
 * @param context - Root, extent and (optional) git oracle
 * @returns The realization row, with the content key filled in when readable
 */
export async function collectRealization(
  absolutePath: string,
  resourceId: string,
  context: RealizationContext,
): Promise<ResourceRealizationRow> {
  let isSymlink = false;
  let exists = false;
  let isDirectory = false;
  let symlinkResolves: boolean | null = null;
  let mtime: Date | null = null;

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- enumerated corpus path
    const link = lstatSync(absolutePath);
    exists = true;
    mtime = link.mtime;
    isSymlink = link.isSymbolicLink();
    if (isSymlink) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- enumerated corpus path
        const target = statSync(absolutePath);
        symlinkResolves = true;
        isDirectory = target.isDirectory();
      } catch {
        symlinkResolves = false;
      }
    } else {
      isDirectory = link.isDirectory();
    }
  } catch {
    // Genuinely absent — `exists` stays false and every other column stays at
    // its "we could not look" default rather than a guess.
  }

  const gitignored = context.gitTracker?.isUsable() === true
    ? context.gitTracker.isIgnored(absolutePath)
    : false;

  const contentKey = exists && !isDirectory && symlinkResolves !== false
    ? await keyOrNull(absolutePath)
    : null;

  const rel = relativize(absolutePath, context.root);
  const lastSlash = rel.lastIndexOf('/');
  const basename = lastSlash === -1 ? rel : rel.slice(lastSlash + 1);
  const dot = basename.lastIndexOf('.');

  return {
    resourceId,
    extentId: context.extentId,
    path: rel,
    pathLower: rel.toLowerCase(),
    basenameLower: basename.toLowerCase(),
    dir: lastSlash === -1 ? '' : rel.slice(0, lastSlash),
    // eslint-disable-next-line local/no-hardcoded-path-split -- relativize() has already forward-slashed this
    depth: rel.split('/').length,
    ext: dot <= 0 ? '' : basename.slice(dot).toLowerCase(),
    contentKey,
    mtime,
    exists,
    isDirectory,
    gitignored,
    isSymlink,
    symlinkResolves,
  };
}

/**
 * A path's real location, or `null` when it cannot be resolved.
 *
 * Exported so a population pass can group by identity without resolving twice,
 * and because "two paths are the same file" is a question only the real path
 * can answer — comparing content keys would conflate an alias with two files
 * that merely have identical bytes, which any corpus with two empty files
 * already contains.
 *
 * Distinct from `identity.ts`'s ancestor-walking fallback on purpose: this one
 * reports unresolvability as `null` rather than inventing a spelling, because
 * its callers are asking *whether* a path resolves.
 *
 * @param absolutePath - Path to resolve
 * @returns Forward-slashed real path, or null
 */
export function realPathOrNull(absolutePath: string): string | null {
  try {
    return toForwardSlash(realpathSync.native(absolutePath));
  } catch {
    return null;
  }
}

/**
 * Key a path's contents, or report `null` if it cannot be read.
 *
 * A read failure is a fact about the corpus, not an error in the harness — an
 * unreadable file must show up as a row with a null key, not abort the
 * population, or one permissions quirk on one CI host destroys the whole gate.
 */
async function keyOrNull(absolutePath: string): Promise<string | null> {
  try {
    return (await readContentWithKey(absolutePath, parserKindForPath(absolutePath))).key;
  } catch {
    return null;
  }
}
