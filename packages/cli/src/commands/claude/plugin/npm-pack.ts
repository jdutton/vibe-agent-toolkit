/**
 * The one network call of an npm install lane: `npm pack <spec>`, which downloads a package's
 * tarball into a directory. Its own module so that a test replaces exactly this — the download —
 * and everything after it, extraction included, is the real code.
 */

import { pathPresent, safePath } from '@vibe-agent-toolkit/utils';
import { safeExecSync } from '@vibe-agent-toolkit/utils/process';

import { CommandRefusalError } from '../../../utils/command-refusal.js';

/**
 * Download `packageName`'s tarball into `tempDir` with `npm pack`.
 *
 * @param packageName - The npm spec, without an `npm:` prefix
 * @param tempDir - The directory `npm pack` writes the tarball into
 * @returns The tarball's path
 * @throws CommandRefusalError `EXTERNAL_API_FAILED` — the registry's or the network's answer, not VAT's defect
 */
export function packNpmPackage(packageName: string, tempDir: string): string {
  let packOutput: string | Buffer;
  try {
    packOutput = safeExecSync('npm', ['pack', packageName], {
      cwd: tempDir,
      encoding: 'utf-8',
    });
  } catch (error) {
    throw new CommandRefusalError('EXTERNAL_API_FAILED', `npm pack failed for package ${packageName}: ${String(error)}`, { cause: error });
  }

  if (!packOutput) {
    throw new CommandRefusalError('EXTERNAL_API_FAILED', `npm pack failed for package: ${packageName}`);
  }

  // npm pack outputs the filename (e.g., "package-1.0.0.tgz")
  const tarballPath = safePath.join(tempDir, packOutput.toString().trim());
  // The download directory is VAT's own staging: a probe the OS refuses is the environment's, never "no tarball".
  if (!pathPresent(tarballPath, 'follow', 'environment', 'confirmed')) {
    throw new CommandRefusalError('EXTERNAL_API_FAILED', `npm pack succeeded but tarball not found: ${tarballPath}`);
  }
  return tarballPath;
}
