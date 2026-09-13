/**
 * Shared source resolution helpers for skills commands (install, list).
 *
 * Handles extracting tarballs and downloading npm packages to temp directories.
 * Callers are responsible for cleaning up temp directories after use.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';

import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import * as tar from 'tar';

import { downloadNpmPackage } from '../claude/plugin/helpers.js';

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
  const tempDir = await mkdtemp(
    safePath.join(normalizedTmpdir(), 'vat-skills-tgz-'),
  );
  mkdirSyncReal(tempDir, { recursive: true });
  await tar.extract({ file: tarballPath, cwd: tempDir });
  const packageDir = safePath.join(tempDir, 'package');
  if (!existsSync(packageDir)) {
    throw new Error(
      `Tarball does not contain a package/ directory: ${tarballPath}`,
    );
  }
  return { tempDir, packageDir };
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
  throw new Error(
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
    const packageDir = downloadNpmPackage(source, tempDir);
    return {
      skillsDir: findSkillsDirInNpmPackage(packageDir),
      tempDirs: [tempDir],
    };
  }

  // Local .tgz / .tar.gz tarball
  const { tempDir, packageDir } = await extractTarballToTemp(source);
  return {
    skillsDir: findSkillsDirInNpmPackage(packageDir),
    tempDirs: [tempDir],
  };
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
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(`Could not remove temp directory ${toForwardSlash(dir)}: ${reason}`);
    }
  }
}
