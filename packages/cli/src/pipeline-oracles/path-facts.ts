/**
 * The cheap per-path attributes an enumeration records so later stages do not
 * go and compute them per link, per check, per lane.
 */

import { lstatSync, statSync } from 'node:fs';

import { readContentWithKey } from '@vibe-agent-toolkit/resources';
import { type GitTracker, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import type { EnumerationRow } from './types.js';

/**
 * Render an absolute path relative to a corpus root, forward-slashed.
 *
 * Everything a snapshot prints goes through here. An absolute path in a golden
 * file makes the golden machine-specific and leaks `$HOME`; both have bitten
 * this repo before.
 *
 * @param absolutePath - Path to render
 * @param corpusRoot - Root the snapshot is relative to
 * @returns Forward-slashed relative path (or the forward-slashed absolute path
 *   when the target lies outside the root, which is itself worth seeing)
 */
export function relativize(absolutePath: string, corpusRoot: string): string {
  const rel = safePath.relative(corpusRoot, absolutePath);
  return rel === '' ? '.' : toForwardSlash(rel);
}

/** Everything needed to answer the attribute questions for a path set. */
export interface PathFactContext {
  corpusRoot: string;
  /** Absent (or unusable) when the corpus is not a git repository. */
  gitTracker?: GitTracker | undefined;
}

/**
 * Collect the attribute row for one absolute path.
 *
 * `lstat` first, deliberately: `stat` follows symlinks, so a `stat`-only
 * implementation cannot tell a symlink from what it points at, and reports a
 * dangling link as simply absent.
 *
 * @param absolutePath - Path to describe
 * @param context - Corpus root and (optional) git oracle
 * @returns The attribute row, with the content key filled in when readable
 */
export async function collectPathFacts(
  absolutePath: string,
  context: PathFactContext,
): Promise<EnumerationRow> {
  const path = relativize(absolutePath, context.corpusRoot);

  let isSymlink = false;
  let exists = false;
  let isDirectory = false;
  let symlinkResolves: boolean | null = null;

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- enumerated corpus path
    const link = lstatSync(absolutePath);
    exists = true;
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

  return { path, contentKey, exists, isDirectory, gitignored, isSymlink, symlinkResolves };
}

/**
 * Key a path's contents, or report `null` if it cannot be read.
 *
 * A read failure is a fact about the corpus, not an error in the harness — an
 * unreadable file must show up as a row with a null key, not abort the
 * snapshot, or one permissions quirk on one CI host destroys the whole gate.
 */
async function keyOrNull(absolutePath: string): Promise<string | null> {
  try {
    return (await readContentWithKey(absolutePath)).key;
  } catch {
    return null;
  }
}
