/**
 * The installed git's version, for a test whose expected spawns depend on it: `--no-lazy-fetch`
 * from git 2.45, one `cat-file --batch-command` reader from git 2.36.
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
