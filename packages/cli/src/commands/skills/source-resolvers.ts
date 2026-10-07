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

import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';

import { isPathAbsentError, mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import * as tar from 'tar';

import { CommandRefusalError, errorMessageOf } from '../../utils/command-refusal.js';
import { unstatablePathRefusal } from '../../utils/project-root-policy.js';
import { downloadNpmPackage } from '../claude/plugin/helpers.js';

/**
 * Whether `dir` holds a `SKILL.md`. Absent is `false`; a `stat` the OS refuses
 * is the source's refusal (`INPUT_UNREADABLE`) — never "no skill here", which
 * is what `existsSync` would have answered for both.
 *
 * @param dir - A source directory, or one of its immediate subdirectories
 */
export function holdsSkillMd(dir: string): boolean {
  const skillMd = safePath.join(dir, 'SKILL.md');
  try {
    statSync(skillMd);
    return true;
  } catch (error) {
    if (isPathAbsentError(error)) return false;
    throw unstatablePathRefusal(skillMd, error);
  }
}

/**
 * The entries of a source directory, refused like a path argument when the OS
 * will not list it (`INPUT_UNREADABLE`).
 *
 * @param dir - The source directory to list
 */
export function readSourceDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw unstatablePathRefusal(dir, error);
  }
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
  try {
    statSync(tarballPath);
  } catch (error) {
    throw unstatablePathRefusal(tarballPath, error);
  }
  const tempDir = await mkdtemp(
    safePath.join(normalizedTmpdir(), 'vat-skills-tgz-'),
  );
  mkdirSyncReal(tempDir, { recursive: true });
  const packageDir = await discardingOnFailure(tempDir, async () => {
    try {
      await tar.extract({ file: tarballPath, cwd: tempDir });
    } catch (error) {
      throw new CommandRefusalError('INPUT_UNREADABLE', `Tarball cannot be read: ${tarballPath} (${errorMessageOf(error)})`, { cause: error });
    }
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
 * Run `work` over a temp directory this process minted, removing the
 * directory when `work` throws: the caller only learns about a temp directory
 * it is handed back, so one minted on a failing path is otherwise left behind.
 *
 * @param tempDir - The directory to remove on failure
 * @param work - What to do with it
 */
export async function discardingOnFailure<T>(tempDir: string, work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
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
    const tempDir = await mkdtemp(
      safePath.join(normalizedTmpdir(), 'vat-skills-npm-'),
    );
    mkdirSyncReal(tempDir, { recursive: true });
    const skillsDir = await discardingOnFailure(tempDir, () => findSkillsDirInNpmPackage(downloadNpmPackage(source, tempDir)));
    return { skillsDir, tempDirs: [tempDir] };
  }

  // Local .tgz / .tar.gz tarball
  const { tempDir, packageDir } = await extractTarballToTemp(source);
  const skillsDir = await discardingOnFailure(tempDir, () => findSkillsDirInNpmPackage(packageDir));
  return { skillsDir, tempDirs: [tempDir] };
}

/**
 * Remove the temp directories a resolved source left behind.
 *
 * Best-effort by design — the command's answer is already out, and a temp
 * directory that will not go (an `EBUSY` on Windows, a handle a scanner still
 * holds) must not turn a finished install into a failed one. But best-effort
 * is not silent: a directory left behind is named, so the operator can remove
 * what this run could not. `force: true` already tolerates one that is gone.
 *
 * @param tempDirs - What {@link resolveNpmOrTarballSource} minted
 * @param logger - Where a directory that stays is reported
 */
export async function removeResolvedTempDirs(
  tempDirs: readonly string[],
  logger: { warn: (message: string) => void },
): Promise<void> {
  // Independent removals; what stays is named in the order the dirs were minted.
  const outcomes = await Promise.allSettled(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === 'fulfilled') continue;
    const error: unknown = outcome.reason;
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`Could not remove temp directory ${toForwardSlash(tempDirs[index] ?? '')}: ${reason}`);
  }
}
