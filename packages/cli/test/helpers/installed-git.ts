/**
 * The installed git's version, for a test whose expected spawns depend on it: `--no-lazy-fetch`
 * from git 2.45, one `cat-file --batch-command` reader from git 2.36.
 *
 * A second parse beside production's (`probeGitVersion` and `atLeast` in `git-object-reader.ts`),
 * kept on purpose: neither is exported, and exporting them for a test would grow the shipped utils
 * API. The only exported answer is `GitObjectReaders.guardsLazyFetch()`, which covers 2.45 and not
 * 2.36. An independent parse is also what an expectation should be: a test that asked production
 * which mode to expect would agree with production whatever it got wrong.
 */

import { runGitOrThrow } from '@vibe-agent-toolkit/utils/git';

/** This git's (major, minor), from `git --version`. */
function installedGitVersion(): readonly [number, number] {
  const [major, minor] = runGitOrThrow(['--version']).replace(/^git version /, '').split('.').map(Number);
  return [major ?? 0, minor ?? 0];
}

/** Whether the installed git is at least `major.minor`. */
export function gitAtLeast(major: number, minor: number): boolean {
  const [installedMajor, installedMinor] = installedGitVersion();
  return installedMajor > major || (installedMajor === major && installedMinor >= minor);
}
