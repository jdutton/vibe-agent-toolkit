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

import { parserKindForPath } from '../content-key.js';
import type { ContentState, ResourceRealizationRow } from '../schemas/projection-resources.js';

import { readKeyedContent, type RunContentCache } from './content-cache.js';

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

/**
 * When a realization should pay to read and hash a path's bytes.
 *
 * Three literals rather than a predicate callback, deliberately: a policy has
 * to stay inspectable and serializable — readable off the contributor that set
 * it and reproducible from a recorded population — and a closure here would be
 * a rule nobody can read back out of the projection.
 *
 * - `eager` — key the bytes now. The **default** when the field is absent, so
 *   every caller that has not opted in (including `collectRealization`'s caller
 *   outside any population, the CLI's enumeration-snapshot oracle) is unchanged.
 * - `deferred` — never key here; the row lands as `deferred` and no read
 *   happens.
 * - `deferGitignored` — key unless the row's own `gitignored` column is true.
 */
export type ContentDemand = 'eager' | 'deferred' | 'deferGitignored';

/** Everything needed to answer the realization questions for a path. */
export interface RealizationContext {
  /** Root every `path` in the resulting rows is relative to. */
  root: string;
  /** The extent this realization is observed in — `resource_realizations.extentId`. */
  extentId: string;
  /** Absent (or unusable) when the root is not a git repository. */
  gitTracker?: GitTracker | undefined;
  /**
   * The run's content cache, so one path keyed in two extents is read once.
   *
   * Optional because this function is also called outside a population — the
   * CLI's enumeration oracle keys a single path with no run to belong to — and a
   * cache with a lifetime of one call would be a pure cost. Inside `populate` it
   * is always present, threaded from the builder through
   * {@link ProjectionBase.contentCache}.
   */
  contentCache?: RunContentCache | undefined;
  /**
   * Whether this extent wants the bytes keyed. Absent means {@link ContentDemand}
   * `'eager'` — the historical behaviour, and the reason no existing caller had
   * to change.
   */
  contentDemand?: ContentDemand | undefined;
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
 * @param context - Root, extent, (optional) git oracle, cache and demand policy
 * @returns The realization row, with `contentKey` filled in when the bytes were
 *   read and `contentState` always saying why it was or was not
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

  const { contentKey, contentState } = await keyOrState(absolutePath, context, {
    hasBytes: exists && !isDirectory && symlinkResolves !== false,
    gitignored,
  });

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
    contentState,
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

/** What `lstat` already established about whether there are bytes to key. */
interface ObservedPath {
  /** False for an absent path, a directory, or a dangling symlink. */
  hasBytes: boolean;
  /** The row's own `gitignored` column — the input `deferGitignored` reads. */
  gitignored: boolean;
}

/**
 * Key a path's contents, or say why there is no key — the `(contentKey,
 * contentState)` pair, computed together because they are one decision and two
 * columns.
 *
 * Precedence is fixed and the order matters:
 *
 * 1. **No bytes** wins over everything. A directory is not "deferred", it is a
 *    thing with no content, and no demand policy may relabel it — otherwise a
 *    consumer could not tell a corpus of directories from one it declined to
 *    read.
 * 2. **The demand policy defers.** No read happens at all; that is the saving.
 * 3. **Otherwise read.** Success keys it; a throw is `unreadable`.
 *
 * A read failure is a fact about the corpus, not an error in the harness — an
 * unreadable file must show up as a row with a null key, not abort the
 * population, or one permissions quirk on one CI host destroys the whole gate.
 *
 * The read goes through the run's cache when there is one, so the same file
 * realized in the git extent, the filesystem extent and a package extent costs
 * one `readFile` and one SHA-256 rather than three.
 *
 * @param absolutePath - Path to read and key
 * @param context - Supplies the demand policy and the run's cache
 * @param observed - What `lstat` already established about this path
 * @returns The content key (or null) and the state explaining it
 */
async function keyOrState(
  absolutePath: string,
  context: RealizationContext,
  observed: ObservedPath,
): Promise<{ contentKey: string | null; contentState: ContentState }> {
  if (!observed.hasBytes) {
    return { contentKey: null, contentState: 'none' };
  }
  if (defers(context.contentDemand ?? 'eager', observed.gitignored)) {
    return { contentKey: null, contentState: 'deferred' };
  }
  try {
    const keyed = await readKeyedContent(
      absolutePath,
      parserKindForPath(absolutePath),
      context.contentCache,
    );
    return { contentKey: keyed.key, contentState: 'keyed' };
  } catch {
    return { contentKey: null, contentState: 'unreadable' };
  }
}

/**
 * Whether a demand policy declines to key this row.
 *
 * @param demand - The extent's policy
 * @param gitignored - The row's own `gitignored` column
 * @returns True when the bytes must not be read
 */
function defers(demand: ContentDemand, gitignored: boolean): boolean {
  return demand === 'deferred' || (demand === 'deferGitignored' && gitignored);
}
