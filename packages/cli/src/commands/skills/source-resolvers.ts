/**
 * Shared source resolution helpers for skills commands (install, list).
 *
 * Handles extracting tarballs and downloading npm packages to temp directories.
 * Callers are responsible for cleaning up temp directories after use.
 *
 * Every refusal is coded where it is raised: a source that is not a skill
 * package is the invocation's mistake (`USAGE_INVALID`), one the OS or the
 * archive reader will not read is the input's (`INPUT_UNREADABLE`), and a
 * registry that will not hand the package over is `EXTERNAL_API_FAILED`
 * (`downloadNpmPackage`).
 */

import { existsSync, readdirSync, type Dirent } from 'node:fs';

import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { disposeTempDir, disposeTempDirAfterFailure, forEachInOrder, pathPresent, safePath, toForwardSlash, withFsFaultSync } from '@vibe-agent-toolkit/utils';

import { extractTarball, makeStagingDir } from '../../utils/archive-staging.js';
import { CommandRefusalError, errorMessageOf } from '../../utils/command-refusal.js';
import { leftoverIssue, leftoverIssueOf } from '../../utils/document-writer.js';
import { requireInputPath } from '../../utils/project-root-policy.js';
import { downloadNpmPackage } from '../claude/plugin/helpers.js';

/**
 * Whether `dir` holds a `SKILL.md`. Absent is `false`; a `stat` the OS refuses
 * is the source's refusal (`INPUT_UNREADABLE`) — never "no skill here", which
 * is what `existsSync` would have answered for both.
 *
 * @param dir - A source directory, or one of its immediate subdirectories
 */
export function holdsSkillMd(dir: string): boolean {
  return pathPresent(safePath.join(dir, 'SKILL.md'), 'follow', 'source', 'probe');
}

/**
 * The entries of a source directory, refused like a path argument when the OS
 * will not list it (`INPUT_UNREADABLE`).
 *
 * @param dir - The source directory to list
 */
export function readSourceDir(dir: string): Dirent[] {
  return withFsFaultSync({ side: 'source', origin: 'argument', action: 'list the source directory', path: dir }, () => readdirSync(dir, { withFileTypes: true }));
}

/**
 * Determine whether a source string is an npm: prefix or tarball path.
 */
export function isNpmOrTarballSource(source: string): boolean {
  return (
    source.startsWith('npm:') ||
    source.endsWith('.tgz') ||
    source.endsWith('.tar.gz')
  );
}

/**
 * Extract a tarball (.tgz / .tar.gz) to a new temp directory.
 * Returns the temp directory and the conventional "package/" subdirectory
 * that npm packs produce.
 *
 * Caller must clean up tempDir when finished.
 */
export async function extractTarballToTemp(
  tarballPath: string,
): Promise<{ tempDir: string; packageDir: string }> {
  // The argument first: absent is the invocation's mistake, unreadable the input's.
  requireInputPath(tarballPath, { origin: 'argument', message: `Path does not exist: ${tarballPath}` });
  const tempDir = await makeStagingDir('vat-skills-tgz-');
  const packageDir = await discardingOnFailure(tempDir, async () => {
    await extractTarball(tarballPath, tempDir);
    // A probe of the temp tree this process just extracted — VAT's own directory, not the user's path.
    const extracted = safePath.join(tempDir, 'package');
    if (!existsSync(extracted)) {
      throw new CommandRefusalError(
        'USAGE_INVALID',
        `Tarball does not contain a package/ directory (not an npm pack tarball): ${tarballPath}`,
      );
    }
    return extracted;
  });
  return { tempDir, packageDir };
}

/**
 * Run `work` over a temp directory this process minted, disposing of the
 * directory when `work` throws: the caller only learns about a temp directory
 * it is handed back, so one minted on a failing path is otherwise left behind.
 * The work's error is rethrown unchanged; a directory that will not go is
 * recorded beside it (`suppressedFaultsOf`), never thrown in its place.
 *
 * @param tempDir - The directory to dispose of on failure
 * @param work - What to do with it
 */
export async function discardingOnFailure<T>(tempDir: string, work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await disposeTempDirAfterFailure(tempDir, error);
    throw error;
  }
}

/**
 * Find the dist/skills/ directory inside a downloaded npm package.
 * Throws if the package was not built with "vat skills build".
 */
export function findSkillsDirInNpmPackage(packageDir: string): string {
  const distSkills = safePath.join(packageDir, 'dist', 'skills');
  if (existsSync(distSkills)) {
    return distSkills;
  }
  throw new CommandRefusalError(
    'USAGE_INVALID',
    `npm package does not contain dist/skills/: ${packageDir}\n` +
      `Was the package built with "vat skills build"?`,
  );
}

export interface ResolvedNpmSource {
  /** The resolved dist/skills/ directory (or package dir root for tarballs). */
  skillsDir: string;
  /** Temp directories to clean up after use. */
  tempDirs: string[];
}

/**
 * Resolve an npm: or .tgz/.tar.gz source to a local directory tree.
 * The returned skillsDir points to the dist/skills/ directory inside the package.
 * Caller must clean up all entries in tempDirs when finished.
 */
export async function resolveNpmOrTarballSource(
  source: string,
): Promise<ResolvedNpmSource> {
  if (source.startsWith('npm:')) {
    const tempDir = await makeStagingDir('vat-skills-npm-');
    const skillsDir = await discardingOnFailure(tempDir, () => findSkillsDirInNpmPackage(downloadNpmPackage(source, tempDir)));
    return { skillsDir, tempDirs: [tempDir] };
  }

  // Local .tgz / .tar.gz tarball
  const { tempDir, packageDir } = await extractTarballToTemp(source);
  const skillsDir = await discardingOnFailure(tempDir, () => findSkillsDirInNpmPackage(packageDir));
  return { skillsDir, tempDirs: [tempDir] };
}

/**
 * Dispose of the temp directories a resolved source left behind, once the work on it is done.
 *
 * Best-effort by design — the command's answer is already decided, and a temp
 * directory that will not go (an `EBUSY` on Windows, a handle a scanner still
 * holds) must not turn a finished install into a failed one. But best-effort
 * is not silent: each directory left behind is returned as the one
 * `TREE_CLEANUP_INCOMPLETE` warning naming it, for the report. One already gone
 * is not a failure; one outside the temp directory is never removed, only named.
 *
 * @param tempDirs - What {@link resolveNpmOrTarballSource} minted
 * @returns A warning per directory that stays, in the order the dirs were minted
 */
export async function removeResolvedTempDirs(tempDirs: readonly string[]): Promise<ValidationIssue[]> {
  // Independent removals; what stays is named in the order the dirs were minted.
  const outcomes = await Promise.allSettled(tempDirs.map((dir) => disposeTempDir(dir)));
  return outcomes.flatMap((outcome, index) => {
    if (outcome.status === 'fulfilled') return outcome.value === undefined ? [] : [leftoverIssueOf(outcome.value)];
    const dir = toForwardSlash(tempDirs[index] ?? '');
    return [leftoverIssue(`Could not remove temp directory ${dir}: ${errorMessageOf(outcome.reason)}`, dir)];
  });
}

/**
 * Run `work` over a resolved source's temp directories, then dispose of them. A failure of
 * `work` is rethrown unchanged, a directory that will not go recorded beside it
 * (`suppressedFaultsOf`); once `work` succeeded, what stays comes back as `leftovers` — the
 * warnings for the report beside its value.
 *
 * @param tempDirs - What {@link resolveNpmOrTarballSource} minted
 * @param work - What to do while they exist
 */
export async function withResolvedTempDirs<T>(
  tempDirs: readonly string[],
  work: () => T | Promise<T>,
): Promise<{ readonly value: T; readonly leftovers: ValidationIssue[] }> {
  let value: T;
  try {
    value = await work();
  } catch (error) {
    await forEachInOrder(tempDirs, (dir) => disposeTempDirAfterFailure(dir, error));
    throw error;
  }
  return { value, leftovers: await removeResolvedTempDirs(tempDirs) };
}
